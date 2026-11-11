//! `navori migrations [list|restore]`, native (spec 0060 T27, M11, R73).
//!
//! The command layer of `commands/migrations.ts`, sharing the store walk and clack output with
//! [`crate::backup`]. Like the TS, `migrations` without a subcommand runs `list` (`default:
//! "list"`). `restore` without `--yes` prompts and stays with the TS.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use navori_core::fs::{Fs, RealFs};
use navori_core::js_json::{JsObject, JsValue};

use crate::backup::{Leaf, PROTOTYPE_KEYS, collect_files, int_flag, iso, mtime_ms, parse_leaf};
use crate::clack::{Clack, Symbol, plain_output};
use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::Output;
use crate::{NativeCall, Outcome};

const JSON: ArgDef = ArgDef {
    name: "json",
    kind: ArgKind::Boolean,
    description: "Output as JSON",
};

const LIST: CommandDef = CommandDef {
    name: "list",
    description: "List init replace-mode migrations stored in ~/.navori/migrations/",
    args: &[
        JSON,
        ArgDef {
            name: "limit",
            kind: ArgKind::String,
            description: "Show only the N most recent (default: 20)",
        },
    ],
    sub_commands: &[],
};

const RESTORE: CommandDef = CommandDef {
    name: "restore",
    description: "Restore an init replace-mode migration back to the original repo",
    args: &[
        ArgDef {
            name: "timestamp",
            kind: ArgKind::Positional,
            description: "Migration timestamp",
        },
        ArgDef {
            name: "repo",
            kind: ArgKind::Positional,
            description: "Repo name (from 'migrations list')",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Target directory (default: current)",
        },
        ArgDef {
            name: "yes",
            kind: ArgKind::Boolean,
            description: "Skip confirmation",
        },
    ],
    sub_commands: &[],
};

const MIGRATIONS: CommandDef = CommandDef {
    name: "migrations",
    description: "List and restore init replace-mode migrations",
    args: &[JSON],
    sub_commands: &[("list", LIST.description), ("restore", RESTORE.description)],
};

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};

const PARENT: Parent<'static> = Parent {
    name: "migrations",
    version: None,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    List,
    Restore,
}

/// `migrations` alone: usage, `--help`, unknown subcommands and the default `list`.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `migrations list`.
#[must_use]
pub fn run_list(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::List))
}

/// `migrations restore`.
#[must_use]
pub fn run_restore(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Restore))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "migrations" || rest.contains(&"--") {
        return None;
    }
    let is_help = |a: &&str| *a == "--help" || *a == "-h";
    let help = rest.iter().any(is_help);
    let at = rest.iter().position(|a| !a.starts_with('-'));
    let Some(at) = at else {
        if row != Row::Group {
            return None;
        }
        if help {
            return Some(Output::usage(&MIGRATIONS, ROOT, None).emit());
        }
        // `default: "list"`: `list` reads the same flags.
        let options = parse_leaf(rest, &["limit"], &["json"])?;
        if !plain_output() {
            return None;
        }
        return Some(list(&migrations_root()?, &options)?.emit());
    };
    if rest[..at].iter().any(|a| !is_help(a)) {
        return None;
    }
    let (def, leaf_row) = match rest[at] {
        "list" => (&LIST, Row::List),
        "restore" => (&RESTORE, Row::Restore),
        name if row != Row::Group || PROTOTYPE_KEYS.contains(&name) => return None,
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&MIGRATIONS, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(def, PARENT, None).emit());
    }
    let (strings, booleans): (&[&str], &[&str]) = match row {
        Row::List => (&["limit"], &["json"]),
        _ => (&["cwd"], &["yes"]),
    };
    let options = parse_leaf(&rest[at + 1..], strings, booleans)?;
    if row == Row::Restore && options.positionals.len() < 2 {
        let missing = if options.positionals.is_empty() {
            "TIMESTAMP"
        } else {
            "REPO"
        };
        let error = format!("Missing required positional argument: {missing}");
        return Some(Output::usage(def, PARENT, Some(error)).emit());
    }
    if !plain_output() {
        return None;
    }
    let root = migrations_root()?;
    let out = match row {
        Row::List => list(&root, &options)?,
        Row::Restore => restore(&root, &options)?,
        Row::Group => return None,
    };
    Some(out.emit())
}

/// `migrationsRoot()`: `~/.navori/migrations` for an absolute home.
fn migrations_root() -> Option<PathBuf> {
    let home = std::env::home_dir().filter(|h| h.is_absolute())?;
    Some(home.join(".navori").join("migrations"))
}

struct Entry {
    timestamp: String,
    repo: String,
    path: String,
    files: Vec<String>,
    mtime_ms: f64,
}

fn sorted_names(dir: &Path) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).ok()? {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }
    names.sort();
    Some(names)
}

/// `listMigrations()`.
fn list_migrations(root: &Path) -> Option<Vec<Entry>> {
    if !root.exists() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    for ts in sorted_names(root)? {
        let ts_dir = root.join(&ts);
        if !std::fs::metadata(&ts_dir).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Some(repos) = sorted_names(&ts_dir) else {
            continue;
        };
        for repo in repos {
            let repo_dir = ts_dir.join(&repo);
            let Ok(meta) = std::fs::metadata(&repo_dir) else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let mut files = Vec::new();
            if collect_files(&repo_dir, &repo_dir, &mut files).is_none() {
                continue;
            }
            out.push(Entry {
                timestamp: ts.clone(),
                repo,
                path: repo_dir.to_str()?.to_owned(),
                files,
                mtime_ms: mtime_ms(&meta)?,
            });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms));
    Some(out)
}

fn list(root: &Path, options: &Leaf<'_>) -> Option<Output> {
    let migrations = list_migrations(root)?;
    let limit = int_flag(options.get("limit"), Some(20))?.unwrap_or(20);
    let shown = usize::try_from(limit)
        .unwrap_or(usize::MAX)
        .min(migrations.len());
    let truncated = &migrations[..shown];
    let mut clack = Clack::default();
    if options.flag("json") {
        let entries = truncated
            .iter()
            .map(|m| {
                let mut o = JsObject::new();
                o.insert("timestamp", JsValue::string(&m.timestamp));
                o.insert("repoName", JsValue::string(&m.repo));
                o.insert("path", JsValue::string(&m.path));
                o.insert(
                    "files",
                    JsValue::Array(m.files.iter().map(|f| JsValue::string(f)).collect()),
                );
                o.insert("mtimeMs", JsValue::Number(m.mtime_ms));
                JsValue::Object(o)
            })
            .collect();
        let mut doc = JsObject::new();
        doc.insert("migrations", JsValue::Array(entries));
        #[expect(
            clippy::cast_precision_loss,
            reason = "a migration count is far below 2^53"
        )]
        doc.insert("totalAvailable", JsValue::Number(migrations.len() as f64));
        clack.out.stdout = format!("{}\n", JsValue::Object(doc).stringify(Some(2))?);
        return Some(clack.out);
    }
    clack.intro("navori migrations list");
    if migrations.is_empty() {
        clack.log(
            Symbol::Info,
            "No hay migraciones. Se crean cuando 'init' adopta navori en modo replace (el wizard interactivo) en un repo con infraestructura Claude previa.",
        );
        clack.outro("Listo");
        return Some(clack.out);
    }
    let mut lines = vec![format!(
        "{} migración(es) en total. Mostrando {}:",
        migrations.len(),
        truncated.len()
    )];
    for m in truncated {
        lines.push(format!(
            "  · {}  repo='{}'  {}",
            m.timestamp,
            m.repo,
            iso(m.mtime_ms)?
        ));
        for f in &m.files {
            lines.push(format!("      · {f}"));
        }
    }
    if migrations.len() > truncated.len() {
        lines.push(format!(
            "  ... {} más (usa --limit para mostrarlas)",
            migrations.len() - truncated.len()
        ));
    }
    clack.log(Symbol::Bar, &lines.join("\n"));
    clack.outro("Listo");
    Some(clack.out)
}

fn restore(root: &Path, options: &Leaf<'_>) -> Option<Output> {
    if !options.flag("yes") {
        return None;
    }
    let (ts, repo) = (options.positionals[0], options.positionals[1]);
    // Names that walk out of the store are left to the TS's own (lack of) checks.
    if [ts, repo]
        .iter()
        .any(|p| p.contains('/') || p.starts_with('.'))
    {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd: PathBuf =
        navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or("")).into();
    let dir = root.join(ts).join(repo);
    let shown = dir.to_str()?.to_owned();
    let mut clack = Clack::default();
    clack.intro(&format!("navori migrations restore {ts}/{repo}"));
    let Ok(meta) = std::fs::metadata(&dir) else {
        clack.cancel(&format!("Migración no encontrada: {shown}"));
        return Some(clack.out);
    };
    if !meta.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    collect_files(&dir, &dir, &mut files)?;
    if files.is_empty() {
        clack.cancel(&format!("La migración está vacía: {shown}"));
        return Some(clack.out);
    }
    clack.log(
        Symbol::Bar,
        &format!(
            "Se restaurarán {} archivo(s) de {shown} en {}:",
            files.len(),
            cwd.to_str()?
        ),
    );
    for f in files.iter().take(10) {
        clack.log(Symbol::Bar, &format!("  · {f}"));
    }
    if files.len() > 10 {
        clack.log(Symbol::Bar, &format!("  ... {} más", files.len() - 10));
    }
    let mut fs = RealFs::default();
    for rel in &files {
        let dest = cwd.join(rel);
        if fs.mkdir_all(dest.parent()?).is_err() || fs.copy(&dir.join(rel), &dest).is_err() {
            clack.out.stderr = format!("navori-rust: cannot restore {rel}\n");
            clack.out.code = 1;
            return Some(clack.out);
        }
    }
    clack.outro(&format!("Restauré {} archivo(s)", files.len()));
    Some(clack.out)
}
