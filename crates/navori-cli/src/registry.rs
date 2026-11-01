//! `navori registry ls|scan|add|remove|prune`, native (spec 0060 M12, R73).
//!
//! The machine-local registry of navori repos (`~/.navori/registry.json`) of
//! `lib/workspace/registry.ts`, with the clack output of [`crate::clack`]. Writes take
//! `~/.navori/.registry.lock` and go through [`Fs`]. A registry or config Rust does not model, a
//! path order outside the modeled collation, a held lock and colored output stay with the TS.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use navori_core::collate::{compare_ascii, default_locale_modeled};
use navori_core::fs::{Fs, RealFs};
use navori_core::js_json::{JsObject, JsValue, parse};
use navori_core::posix::resolve;
use navori_core::workspace::registry::canonical;

use crate::backup::{PROTOTYPE_KEYS, int_flag, parse_leaf};
use crate::clack::{Clack, Symbol, plain_output};
use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::{Output, member, read_config};
use crate::{NativeCall, Outcome};

const fn path_arg(description: &'static str) -> [ArgDef; 1] {
    [ArgDef {
        name: "path",
        kind: ArgKind::Positional,
        description,
    }]
}

const LS: CommandDef = CommandDef {
    name: "ls",
    description: "List every repo in the global registry",
    args: &[],
    sub_commands: &[],
};
const SCAN: CommandDef = CommandDef {
    name: "scan",
    description: "Walk one or more directories and register every navori repo found",
    args: &[
        ArgDef {
            name: "dirs",
            kind: ArgKind::Positional,
            description: "Directory(ies) to scan",
        },
        ArgDef {
            name: "depth",
            kind: ArgKind::String,
            description: "Max directory depth to descend (default 4)",
        },
    ],
    sub_commands: &[],
};
const ADD_ARGS: [ArgDef; 1] = path_arg("Path to the repo root");
const ADD: CommandDef = CommandDef {
    name: "add",
    description: "Register a single repo by path",
    args: &ADD_ARGS,
    sub_commands: &[],
};
const REMOVE: CommandDef = CommandDef {
    name: "remove",
    description: "Unregister a repo by path (leaves its files untouched)",
    args: &ADD_ARGS,
    sub_commands: &[],
};
const PRUNE: CommandDef = CommandDef {
    name: "prune",
    description: "Drop registry entries whose repo no longer exists",
    args: &[],
    sub_commands: &[],
};
const REGISTRY: CommandDef = CommandDef {
    name: "registry",
    description: "Global registry of every navori repo on this machine (for 'render --all')",
    args: &[],
    sub_commands: &[
        ("ls", LS.description),
        ("scan", SCAN.description),
        ("add", ADD.description),
        ("remove", REMOVE.description),
        ("prune", PRUNE.description),
    ],
};

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};
const PARENT: Parent<'static> = Parent {
    name: "registry",
    version: None,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    Ls,
    Scan,
    Add,
    Remove,
    Prune,
}

macro_rules! entry {
    ($name:ident, $row:expr) => {
        #[must_use]
        pub fn $name(call: &NativeCall<'_>) -> Outcome {
            outcome(run(call.args, $row))
        }
    };
}
entry!(run_group, Row::Group);
entry!(run_ls, Row::Ls);
entry!(run_scan, Row::Scan);
entry!(run_add, Row::Add);
entry!(run_remove, Row::Remove);
entry!(run_prune, Row::Prune);

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "registry" || rest.contains(&"--") {
        return None;
    }
    let is_help = |a: &&str| *a == "--help" || *a == "-h";
    let help = rest.iter().any(is_help);
    let at = rest.iter().position(|a| !a.starts_with('-'));
    if rest[..at.unwrap_or(rest.len())].iter().any(|a| !is_help(a)) {
        return None;
    }
    let Some(at) = at else {
        if row != Row::Group {
            return None;
        }
        let error = (!help).then(|| "No command specified.".to_owned());
        return Some(Output::usage(&REGISTRY, ROOT, error).emit());
    };
    let (def, leaf_row) = match rest[at] {
        "ls" => (&LS, Row::Ls),
        "scan" => (&SCAN, Row::Scan),
        "add" => (&ADD, Row::Add),
        "remove" => (&REMOVE, Row::Remove),
        "prune" => (&PRUNE, Row::Prune),
        name if row != Row::Group || PROTOTYPE_KEYS.contains(&name) => return None,
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&REGISTRY, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(def, PARENT, None).emit());
    }
    let tokens = &rest[at + 1..];
    let strings: &[&str] = if row == Row::Scan { &["depth"] } else { &[] };
    let options = parse_leaf(tokens, strings, &[])?;
    let required = match row {
        Row::Scan => Some("DIRS"),
        Row::Add | Row::Remove => Some("PATH"),
        _ => None,
    };
    if let Some(name) = required
        && options.positional.is_none()
    {
        let error = format!("Missing required positional argument: {name}");
        return Some(Output::usage(def, PARENT, Some(error)).emit());
    }
    if !plain_output() {
        return None;
    }
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    // Paths are ordered by `localeCompare`; only the shape `compare_ascii` models is native.
    if !default_locale_modeled(&env) {
        return None;
    }
    let home = std::env::home_dir().filter(|h| h.is_absolute())?;
    let store = Store {
        root: home.join(".navori"),
    };
    let process_cwd = std::env::current_dir().ok()?;
    let cwd = process_cwd.to_str()?;
    let out = match row {
        Row::Ls => ls(&store)?,
        Row::Scan => {
            // `rawArgs.filter(a => !a.startsWith("-"))`: a `--depth` value counts as a directory.
            let mut dirs: Vec<&str> = Vec::new();
            for token in tokens.iter().filter(|t| !t.starts_with('-')) {
                if !dirs.contains(token) {
                    dirs.push(token);
                }
            }
            scan(&store, cwd, &dirs, options.get("depth"))?
        }
        Row::Add => add(&store, cwd, options.positional?)?,
        Row::Remove => remove(&store, cwd, options.positional?)?,
        Row::Prune => prune(&store)?,
        Row::Group => return None,
    };
    Some(out.emit())
}

/// One `RegistryEntry` as zod returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Repo {
    path: String,
    name: Option<String>,
}

/// `~/.navori`, the registry and its lock.
struct Store {
    root: PathBuf,
}

impl Store {
    fn registry(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    /// `readRegistry()`: a missing or corrupt file reads as empty; `None` where Rust cannot
    /// tell which.
    fn read(&self) -> Option<Vec<Repo>> {
        let path = self.registry();
        if !path.exists() {
            return Some(Vec::new());
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return Some(Vec::new());
        };
        let text = String::from_utf8(bytes).ok()?;
        let raw = parse(&text)?;
        let JsValue::Object(o) = raw else {
            return Some(Vec::new());
        };
        let items = match o.get("repos") {
            None => return Some(Vec::new()),
            Some(JsValue::Array(items)) => items,
            Some(_) => return Some(Vec::new()),
        };
        let mut repos = Vec::new();
        for item in items {
            let JsValue::Object(entry) = item else {
                return Some(Vec::new());
            };
            let path = match entry.get("path") {
                Some(JsValue::String(s)) if !s.units().is_empty() => s.to_rust()?,
                _ => return Some(Vec::new()),
            };
            let name = match entry.get("name") {
                None => None,
                Some(JsValue::String(s)) => Some(s.to_rust()?),
                Some(_) => return Some(Vec::new()),
            };
            repos.push(Repo { path, name });
        }
        Some(repos)
    }

    /// `writeRegistry(repos)`: sorted by `localeCompare`, as `writeFileSync` writes it.
    fn write(&self, fs: &mut dyn Fs, repos: &[Repo]) -> Option<()> {
        let mut sorted = repos.to_vec();
        let mut unmodeled = false;
        sorted.sort_by(|a, b| {
            compare_ascii(&a.path, &b.path).unwrap_or_else(|| {
                unmodeled = true;
                std::cmp::Ordering::Equal
            })
        });
        if unmodeled {
            return None;
        }
        let entries = sorted
            .iter()
            .map(|r| {
                let mut o = JsObject::new();
                o.insert("path", JsValue::string(&r.path));
                if let Some(name) = &r.name {
                    o.insert("name", JsValue::string(name));
                }
                JsValue::Object(o)
            })
            .collect();
        let mut doc = JsObject::new();
        doc.insert("repos", JsValue::Array(entries));
        let text = format!("{}\n", JsValue::Object(doc).stringify(Some(2))?);
        fs.mkdir_all(&self.root).ok()?;
        let file = fs.create(&self.registry(), 0o666).ok()?;
        let written = fs.write(file, text.as_bytes());
        fs.close(file).ok()?;
        written.ok()
    }

    /// Runs `body` under `withFileLock(.registry.lock)`; `None` when the lock is held.
    fn locked<T>(&self, body: impl FnOnce(&Self) -> Option<T>) -> Option<T> {
        std::fs::create_dir_all(&self.root).ok()?;
        let lock = self.root.join(".registry.lock");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(&lock)
            .ok()?;
        let _ =
            std::io::Write::write_all(&mut file, format!("{}\n", std::process::id()).as_bytes());
        let result = body(self);
        drop(file);
        let _ = std::fs::remove_file(&lock);
        result
    }

    /// `registerRepo(path, name)`: `"added"`, `"updated"` or `"unchanged"`.
    fn register(&self, path: &str, name: Option<&str>) -> Option<&'static str> {
        self.locked(|store| {
            let mut repos = store.read()?;
            let mut fs = RealFs::default();
            if let Some(existing) = repos.iter_mut().find(|r| r.path == path) {
                if let Some(name) =
                    name.filter(|n| !n.is_empty() && existing.name.as_deref() != Some(*n))
                {
                    existing.name = Some(name.to_owned());
                    store.write(&mut fs, &repos)?;
                    return Some("updated");
                }
                return Some("unchanged");
            }
            repos.push(Repo {
                path: path.to_owned(),
                name: name.filter(|n| !n.is_empty()).map(str::to_owned),
            });
            store.write(&mut fs, &repos)?;
            Some("added")
        })
    }
}

/// Plans every lock and registry write before the first one: a held lock or an unreadable
/// registry delegates.
fn writable(store: &Store) -> Option<()> {
    if store.root.join(".registry.lock").exists() {
        return None;
    }
    store.read().map(drop)
}

/// `repoName(path)`: the config's `name`, printing its warnings; `None` to delegate.
fn repo_name(out: &mut Output, path: &str) -> Option<Option<String>> {
    let Some(config) = read_config(path)? else {
        return Some(None);
    };
    for warning in &config.warnings {
        out.stderr.push_str(&format!("{warning}\n"));
    }
    match member(Some(&config.data), "name") {
        Some(JsValue::String(s)) => Some(Some(s.to_rust()?)),
        _ => Some(None),
    }
}

fn has_config(path: &str) -> bool {
    Path::new(&format!("{path}/navori.config.json")).exists()
}

fn ls(store: &Store) -> Option<Output> {
    let mut clack = Clack::default();
    clack.intro("navori registry ls");
    let repos = store.read()?;
    if repos.is_empty() {
        clack.log(
            Symbol::Info,
            "No hay repos registrados. Arranca con 'navori registry scan <dir>'.",
        );
        clack.outro(store.registry().to_str()?);
        return Some(clack.out);
    }
    let lines: Vec<String> = repos
        .iter()
        .map(|r| {
            let present = has_config(&r.path);
            format!(
                "  {} {}{}\n      {}",
                if present { "✓" } else { "✗" },
                r.name.as_deref().unwrap_or("(desconocido)"),
                if present { "" } else { "  faltante" },
                r.path
            )
        })
        .collect();
    clack.log(Symbol::Bar, &lines.join("\n"));
    let missing = repos.iter().filter(|r| !has_config(&r.path)).count();
    let tail = if missing > 0 {
        format!(" · {missing} faltante(s) (corre 'registry prune')")
    } else {
        String::new()
    };
    clack.outro(&format!("{} repo(s){tail}", repos.len()));
    Some(clack.out)
}

/// `isGitWorktree(dir)`: `.git` is a file.
fn is_worktree(dir: &str) -> bool {
    std::fs::metadata(format!("{dir}/.git")).is_ok_and(|m| m.is_file())
}

const SKIP: [&str; 9] = [
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
    "vendor",
    ".git",
];

/// `scanForRepos(root, maxDepth)`: `(repos, worktrees)` as canonical paths.
fn scan_for_repos(
    dir: &str,
    depth: u64,
    max: u64,
    out: &mut (Vec<String>, Vec<String>),
) -> Option<()> {
    if has_config(dir) {
        let path = canonical("/", dir).ok()?;
        if is_worktree(dir) {
            out.1.push(path);
        } else {
            out.0.push(path);
        }
        return Some(());
    }
    if depth >= max {
        return Some(());
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Some(());
    };
    let mut children = Vec::new();
    for entry in entries {
        let entry = entry.ok()?;
        // `Dirent.isDirectory()` does not follow symlinks.
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let name = entry.file_name().into_string().ok()?;
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        children.push(name);
    }
    children.sort();
    for name in children {
        scan_for_repos(&format!("{dir}/{name}"), depth + 1, max, out)?;
    }
    Some(())
}

fn scan(store: &Store, cwd: &str, dirs: &[&str], depth: Option<&str>) -> Option<Output> {
    writable(store)?;
    let mut clack = Clack::default();
    clack.intro("navori registry scan");
    let max = int_flag(depth, Some(4))?.unwrap_or(4);
    let (mut added, mut unchanged, mut skipped) = (0, 0, 0);
    let mut rows = Vec::new();
    for dir in dirs {
        let root = resolve(cwd, dir);
        if !Path::new(&root).exists() {
            rows.push(format!("  ✗ {dir} (no encontrado)"));
            continue;
        }
        let mut found = (Vec::new(), Vec::new());
        scan_for_repos(&root, 0, max, &mut found)?;
        for repo in &found.0 {
            let name = repo_name(&mut clack.out, repo)?;
            let result = store.register(repo, name.as_deref())?;
            if result == "added" {
                added += 1;
            } else {
                unchanged += 1;
            }
            let badge = if result == "added" {
                "+ agregado"
            } else {
                "· conocido"
            };
            let shown = repo_name(&mut clack.out, repo)?.unwrap_or_else(|| repo.clone());
            rows.push(format!("  {badge}  {shown}  {repo}"));
        }
        for worktree in &found.1 {
            skipped += 1;
            rows.push(format!("  ~ worktree  {worktree}"));
        }
    }
    if !rows.is_empty() {
        clack.log(Symbol::Bar, &rows.join("\n"));
    }
    if skipped > 0 {
        clack.log(
            Symbol::Info,
            &format!("{skipped} worktree(s) de git omitido(s): traen el árbol del repo padre, harness incluido, así que registrarlos haría que 'render --all' escriba en las ramas de sus tickets. Si de verdad quieres uno, 'navori registry add <ruta>'."),
        );
    }
    clack.outro(&format!(
        "Listo {added} agregado(s) · {unchanged} ya registrado(s)"
    ));
    Some(clack.out)
}

fn add(store: &Store, cwd: &str, path: &str) -> Option<Output> {
    writable(store)?;
    let mut clack = Clack::default();
    clack.intro("navori registry add");
    let repo = resolve(cwd, path);
    if !has_config(&repo) {
        clack.cancel(&format!(
            "No es un repo navori (sin navori.config.json): {repo}"
        ));
        return Some(clack.out);
    }
    let name = repo_name(&mut clack.out, &repo)?;
    let result = store.register(&canonical("/", &repo).ok()?, name.as_deref())?;
    let verb = if result == "added" {
        "Registré"
    } else {
        "Ya estaba registrado"
    };
    let shown = repo_name(&mut clack.out, &repo)?.unwrap_or_else(|| repo.clone());
    clack.outro(&format!("{verb} {shown} {repo}"));
    Some(clack.out)
}

fn remove(store: &Store, cwd: &str, path: &str) -> Option<Output> {
    writable(store)?;
    let mut clack = Clack::default();
    clack.intro("navori registry remove");
    let repo = resolve(cwd, path);
    let canonical_path = canonical("/", &repo).ok()?;
    let removed = store.locked(|store| {
        let repos = store.read()?;
        let next: Vec<Repo> = repos
            .iter()
            .filter(|r| r.path != canonical_path)
            .cloned()
            .collect();
        if next.len() == repos.len() {
            return Some(false);
        }
        store.write(&mut RealFs::default(), &next)?;
        Some(true)
    })?;
    clack.outro(&if removed {
        format!("Quité {repo}")
    } else {
        format!("No está en el registry: {repo}")
    });
    Some(clack.out)
}

fn prune(store: &Store) -> Option<Output> {
    writable(store)?;
    let mut clack = Clack::default();
    clack.intro("navori registry prune");
    let (removed, kept) = store.locked(|store| {
        let repos = store.read()?;
        let (kept, removed): (Vec<Repo>, Vec<Repo>) =
            repos.into_iter().partition(|r| has_config(&r.path));
        if !removed.is_empty() {
            store.write(&mut RealFs::default(), &kept)?;
        }
        Some((removed, kept))
    })?;
    if removed.is_empty() {
        clack.outro(&format!(
            "Nada que limpiar · {} repo(s) registrado(s)",
            kept.len()
        ));
        return Some(clack.out);
    }
    let lines: Vec<String> = removed.iter().map(|r| format!("  ✗ {}", r.path)).collect();
    clack.log(Symbol::Bar, &lines.join("\n"));
    clack.outro(&format!(
        "Limpié {} quitado(s) · {} conservado(s)",
        removed.len(),
        kept.len()
    ));
    Some(clack.out)
}
