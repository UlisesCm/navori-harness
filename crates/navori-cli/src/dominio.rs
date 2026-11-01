//! `navori dominio init|list|show|reindex|doctor`, native (spec 0060 T15, R73).
//!
//! The command layer of `commands/dominio.ts` over `navori_core::workspace`. The TS prints with
//! `@clack/prompts` and picocolors; Rust reproduces that output only where it has no color and no
//! terminal width to adapt to: stdout is not a TTY, no `FORCE_COLOR`, no `CI` without `NO_COLOR`,
//! and clack's Unicode symbols (`TERM` is not `linux`). A note whose text could wrap or whose width
//! Rust does not measure like `fast-string-width` delegates too. Everything else that only the TS
//! answers returns `None` before any output or write: a workspace name it rejects or a missing
//! workspace for `init`/`reindex` (both throw uncaught), a registry or entry Rust does not model.
//! `dominio inject` has its own row (spec 0059).

use std::ffi::OsString;
use std::io::IsTerminal as _;
use std::path::Path;
use std::process::ExitCode;

use navori_core::fs::{RealFs, write_file_atomic};
use navori_core::process::Env;
use navori_core::render::context::Lang;
use navori_core::workspace::dominio::{self, Entry, Status};
use navori_core::workspace::dominio_store::{self, INDEX_NAME};
use navori_core::workspace::registry::{self, Stop};

use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::Output;
use crate::{NativeCall, Outcome};

const WORKSPACE: ArgDef = ArgDef {
    name: "workspace",
    kind: ArgKind::String,
    description: "Workspace name (default: from cwd)",
};

const fn leaf(name: &'static str, description: &'static str) -> CommandDef {
    CommandDef {
        name,
        description,
        args: &[WORKSPACE],
        sub_commands: &[],
    }
}

const INIT: CommandDef = leaf("init", "Create the Dominio store for a workspace");
const LIST: CommandDef = leaf("list", "List the Dominio entries of a workspace");
const REINDEX: CommandDef = leaf("reindex", "Rebuild DOMINIO.md from the entry files");
const DOCTOR: CommandDef = leaf("doctor", "Validate a workspace's Dominio (warnings only)");
const SHOW: CommandDef = CommandDef {
    name: "show",
    description: "Print a Dominio entry",
    args: &[
        ArgDef {
            name: "id",
            kind: ArgKind::Positional,
            description: "Entry id",
        },
        WORKSPACE,
    ],
    sub_commands: &[],
};

const DOMINIO: CommandDef = CommandDef {
    name: "dominio",
    description: "Manage the workspace knowledge base (canonical cross-repo facts)",
    args: &[],
    sub_commands: &[
        ("init", INIT.description),
        ("list", LIST.description),
        ("show", SHOW.description),
        ("reindex", REINDEX.description),
        (
            "inject",
            "Emit the workspace Dominio index for the SessionStart hook",
        ),
        ("doctor", DOCTOR.description),
    ],
};

/// Names `name in subCommands` finds on `Object.prototype`: citty would run them as commands.
const PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};

const DOMINIO_PARENT: Parent<'static> = Parent {
    name: "dominio",
    version: None,
};

/// Which manifest entry selected the invocation: each row runs only its own subcommand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    Init,
    List,
    Show,
    Reindex,
    Doctor,
}

/// `dominio` alone: usage, `--help` and unknown subcommands.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `dominio init`.
#[must_use]
pub fn run_init(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Init))
}

/// `dominio list`.
#[must_use]
pub fn run_list(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::List))
}

/// `dominio show`.
#[must_use]
pub fn run_show(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Show))
}

/// `dominio reindex`.
#[must_use]
pub fn run_reindex(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Reindex))
}

/// `dominio doctor`.
#[must_use]
pub fn run_doctor(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Doctor))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "dominio" || rest.contains(&"--") {
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
        return Some(Output::usage(&DOMINIO, ROOT, error).emit());
    };
    let (def, leaf_row) = match rest[at] {
        "init" => (&INIT, Row::Init),
        "list" => (&LIST, Row::List),
        "show" => (&SHOW, Row::Show),
        "reindex" => (&REINDEX, Row::Reindex),
        "doctor" => (&DOCTOR, Row::Doctor),
        name if row != Row::Group
            || PROTOTYPE_KEYS.contains(&name)
            || DOMINIO.sub_commands.iter().any(|(sub, _)| *sub == name) =>
        {
            return None;
        }
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&DOMINIO, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(def, DOMINIO_PARENT, None).emit());
    }
    let (positional, workspace) = parse_leaf(&rest[at + 1..])?;
    if row == Row::Show && positional.is_none() {
        let error = "Missing required positional argument: ID".to_owned();
        return Some(Output::usage(def, DOMINIO_PARENT, Some(error)).emit());
    }
    if !plain_output() {
        return None;
    }
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let out = match command(row, &env, workspace, positional) {
        Ok(out) => out,
        Err(Stop::Throw | Stop::Delegate(_)) => return None,
    };
    Some(out.emit())
}

/// The first positional and `--workspace`; `None` for any shape citty could read differently.
fn parse_leaf<'a>(tokens: &[&'a str]) -> Option<(Option<&'a str>, Option<&'a str>)> {
    let mut positional = None;
    let mut workspace = None;
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if let Some(body) = token.strip_prefix("--") {
            let (name, inline) = body
                .split_once('=')
                .map_or((body, None), |(n, v)| (n, Some(v)));
            if name != "workspace" || workspace.is_some() {
                return None;
            }
            let value = if let Some(inline) = inline {
                inline
            } else {
                let next = *tokens.get(index)?;
                index += 1;
                next
            };
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            workspace = Some(value);
        } else if token.starts_with('-') {
            return None;
        } else if positional.is_none() {
            positional = Some(token);
        }
    }
    Some((positional, workspace))
}

/// Whether picocolors and Node's `styleText` both print without color, and clack draws its
/// Unicode symbols at its default 80 columns.
fn plain_output() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some();
    !std::io::stdout().is_terminal()
        && !set("FORCE_COLOR")
        && (set("NO_COLOR") || !set("CI"))
        && std::env::var_os("TERM").is_none_or(|t| t != "linux")
}

// ---------------------------------------------------------------------------------------------
// clack, without color, at 80 columns

/// `fast-string-width` for the characters Rust measures as one column; `None` for any other
/// (wide, combining, control or unassigned), which delegates.
fn width(text: &str) -> Option<usize> {
    text.chars()
        .map(|c| {
            let narrow = matches!(c,
                ' '..='~'
                | '\u{a1}'..='\u{2ff}'
                | '\u{370}'..='\u{3ff}'
                | '\u{400}'..='\u{482}'
                | '\u{2010}'..='\u{2027}'
                | '\u{2190}'..='\u{21ff}'
                | '\u{2713}'
            );
            narrow.then_some(1)
        })
        .sum()
}

/// What clack would print, accumulated.
#[derive(Default)]
struct Clack {
    out: Output,
}

impl Clack {
    fn intro(&mut self, title: &str) {
        self.out.stdout.push_str(&format!("┌  {title}\n"));
    }

    fn outro(&mut self, message: &str) {
        self.out.stdout.push_str(&format!("│\n└  {message}\n\n"));
    }

    fn cancel(&mut self, message: &str) {
        self.out.stdout.push_str(&format!("└  {message}\n\n"));
        self.out.code = 1;
    }

    /// `note(message, title)`; `None` when a line could wrap at 74 columns or Rust cannot
    /// measure it.
    fn note(&mut self, message: &str, title: &str) -> Option<()> {
        let mut lines = vec![""];
        lines.extend(message.split('\n'));
        lines.push("");
        let widths: Vec<usize> = lines.iter().map(|l| width(l)).collect::<Option<_>>()?;
        if widths.iter().any(|w| *w > 74) {
            return None;
        }
        let n = width(title)?;
        let t = widths.iter().copied().max().unwrap_or(0).max(n) + 2;
        let mut text = format!(
            "│\n◇  {title} {}╮\n",
            "─".repeat(t.saturating_sub(n + 1).max(1))
        );
        for (line, w) in lines.iter().zip(widths) {
            text.push_str(&format!("│  {line}{}│\n", " ".repeat(t - w)));
        }
        text.push_str(&format!("├{}╯\n", "─".repeat(t + 2)));
        self.out.stdout.push_str(&text);
        Some(())
    }
}

// ---------------------------------------------------------------------------------------------
// messages (`tc(lang).dominio`)

fn no_workspace(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "Este directorio no pertenece a ningún workspace. Pasa --workspace <nombre> o corre desde un repo registrado."
        }
        Lang::En => {
            "This directory isn't part of any workspace. Pass --workspace <name> or run from a registered repo."
        }
    }
}

fn ambiguous(lang: Lang, names: &str) -> String {
    match lang {
        Lang::Es => format!(
            "El directorio pertenece a varios workspaces ({names}). Especifica --workspace <nombre>."
        ),
        Lang::En => format!(
            "This directory belongs to several workspaces ({names}). Specify --workspace <name>."
        ),
    }
}

/// `entr${count === 1 ? "y" : "ies"}`.
fn entries_en(count: usize) -> &'static str {
    if count == 1 { "entry" } else { "entries" }
}

// ---------------------------------------------------------------------------------------------
// the subcommands

/// `resolveTarget(explicit)`: `Err(out)` once the cancel is in `out`.
fn resolve_target(
    env: &Env,
    explicit: Option<&str>,
    clack: &mut Clack,
) -> Result<Option<String>, Stop> {
    if let Some(name) = explicit {
        return Ok(Some(name.to_owned()));
    }
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|d| d.into_os_string().into_string().ok())
        .ok_or(Stop::Delegate("working directory is not UTF-8"))?;
    let matches = registry::for_cwd(env, &cwd)?;
    // `tc(resolveLang(undefined))`: the default language.
    let lang = Lang::resolve(None);
    match matches.as_slice() {
        [one] => Ok(Some(one.clone())),
        [] => {
            clack.cancel(no_workspace(lang));
            Ok(None)
        }
        many => {
            clack.cancel(&ambiguous(lang, &many.join(", ")));
            Ok(None)
        }
    }
}

fn utf8(path: &Path) -> Result<String, Stop> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(Stop::Delegate("path is not UTF-8"))
}

/// `loadWorkspace(ws)` must find it: `ensureDominio` and `reindex` throw uncaught otherwise.
fn require_workspace(env: &Env, workspace: &str) -> Result<(), Stop> {
    match registry::load(env, workspace)? {
        Some(_) => Ok(()),
        None => Err(Stop::Delegate("workspace not found")),
    }
}

/// The directories `mkdirSync(dir, { recursive: true })` creates and the index write.
fn write_index(dir: &Path, index: &Path, content: &str) -> Result<(), Stop> {
    let mut fs = RealFs::default();
    navori_core::fs::Fs::mkdir_all(&mut fs, dir).map_err(|_| Stop::Delegate("mkdir failed"))?;
    write_file_atomic(&mut fs, index, content).map_err(|_| Stop::Delegate("index write failed"))
}

fn entry_row(e: &Entry) -> String {
    let scope = match &e.applies_to {
        None => "all".to_owned(),
        Some(list) if list.is_empty() => "—".to_owned(),
        Some(list) => list.join(", "),
    };
    let tag = match e.status {
        Status::Canonical => "",
        Status::Deprecated => " (deprecated)",
        Status::Superseded => " (superseded)",
    };
    let summary = if e.summary.is_empty() {
        String::new()
    } else {
        format!(" — {}", e.summary)
    };
    format!("  · {}{tag} [{} · {scope}]{summary}", e.title, e.id)
}

fn command(row: Row, env: &Env, explicit: Option<&str>, id: Option<&str>) -> Result<Output, Stop> {
    let mut clack = Clack::default();
    let name = match row {
        Row::Init => "init",
        Row::List => "list",
        Row::Reindex => "reindex",
        Row::Doctor => "doctor",
        Row::Show | Row::Group => "",
    };
    if !name.is_empty() {
        clack.intro(&format!("navori dominio {name}"));
    }
    let Some(ws) = resolve_target(env, explicit, &mut clack)? else {
        return Ok(clack.out);
    };
    let lang = dominio::workspace_lang(env, &ws)?;
    let es = lang == Lang::Es;
    match row {
        Row::Init => {
            require_workspace(env, &ws)?;
            let dir = dominio_store::dominio_dir(env, &ws)?;
            let index = dir.join(INDEX_NAME);
            let created = !index.exists();
            let content = if created {
                let entries = dominio::list_entries(env, &ws)?;
                Some(dominio_store::build_index(&ws, &entries, lang))
            } else {
                None
            };
            let shown = utf8(&dir)?;
            match &content {
                Some(text) => write_index(&dir, &index, text)?,
                None => {
                    let mut fs = RealFs::default();
                    navori_core::fs::Fs::mkdir_all(&mut fs, &dir)
                        .map_err(|_| Stop::Delegate("mkdir failed"))?;
                }
            }
            clack.outro(&match (created, es) {
                (true, true) => format!("Dominio creado en {shown}."),
                (true, false) => format!("Dominio created at {shown}."),
                (false, true) => format!("El Dominio ya existe en {shown}."),
                (false, false) => format!("Dominio already exists at {shown}."),
            });
        }
        Row::List => {
            let entries = dominio::list_entries(env, &ws)?;
            if entries.is_empty() {
                clack.outro(&if es {
                    format!("El Dominio de '{ws}' no tiene entradas todavía.")
                } else {
                    format!("The Dominio for '{ws}' has no entries yet.")
                });
                return Ok(clack.out);
            }
            let count = entries.len();
            let title = if es {
                format!("Dominio de '{ws}' — {count} entrada(s)")
            } else {
                format!("Dominio for '{ws}' — {count} {}", entries_en(count))
            };
            let rows: Vec<String> = entries.iter().map(entry_row).collect();
            clack
                .note(&rows.join("\n"), &title)
                .ok_or(Stop::Delegate("note outside the measured width"))?;
            clack.outro(if es {
                "Lee una entrada completa con 'navori dominio show <id>'."
            } else {
                "Read a full entry with 'navori dominio show <id>'."
            });
        }
        Row::Show => {
            let id = id.unwrap_or_default();
            let found = dominio::list_entries(env, &ws)?
                .into_iter()
                .any(|e| e.id == id);
            let path = dominio_store::dominio_dir(env, &ws)?.join(format!("{id}.md"));
            match found.then(|| std::fs::read(&path)) {
                Some(Ok(bytes)) => {
                    clack.out.stdout = String::from_utf8(bytes)
                        .map_err(|_| Stop::Delegate("entry is not UTF-8"))?;
                }
                _ => clack.cancel(&if es {
                    format!("No existe la entrada '{id}' en el Dominio.")
                } else {
                    format!("No entry '{id}' in the Dominio.")
                }),
            }
        }
        Row::Reindex => {
            require_workspace(env, &ws)?;
            let entries = dominio::list_entries(env, &ws)?;
            let dir = dominio_store::dominio_dir(env, &ws)?;
            let index = dir.join(INDEX_NAME);
            let shown = utf8(&index)?;
            write_index(
                &dir,
                &index,
                &dominio_store::build_index(&ws, &entries, lang),
            )?;
            let count = entries.len();
            clack.outro(&if es {
                format!("Índice reconstruido ({count} entrada(s)): {shown}")
            } else {
                format!("Index rebuilt ({count} {}): {shown}", entries_en(count))
            });
        }
        Row::Doctor => {
            let findings = dominio_store::validate(env, &ws, lang)?;
            let title = if es {
                format!("Dominio de '{ws}'")
            } else {
                format!("Dominio for '{ws}'")
            };
            if findings.is_empty() {
                let clean = if es {
                    "Dominio consistente."
                } else {
                    "Dominio is consistent."
                };
                clack
                    .note(&format!("  ✓ {clean}"), &title)
                    .ok_or(Stop::Delegate("note outside the measured width"))?;
                clack.outro("OK");
            } else {
                let lines: Vec<String> = findings
                    .iter()
                    .map(|f| format!("  ⇡ [{}] {}", f.id, f.message))
                    .collect();
                clack
                    .note(&lines.join("\n"), &title)
                    .ok_or(Stop::Delegate("note outside the measured width"))?;
                let count = findings.len();
                clack.outro(&if es {
                    format!("{count} aviso(s) — revisa lo anterior")
                } else {
                    format!("{count} warning(s) — check the above")
                });
            }
        }
        Row::Group => return Err(Stop::Delegate("group")),
    }
    Ok(clack.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn notes_draw_like_clack_and_refuse_what_could_wrap() {
        let mut clack = Clack::default();
        assert_eq!(clack.note("  · a", "T"), Some(()));
        assert_eq!(
            clack.out.stdout,
            "│\n◇  T ─────╮\n│         │\n│    · a  │\n│         │\n├─────────╯\n"
        );
        assert_eq!(Clack::default().note(&"x".repeat(75), "T"), None);
        assert_eq!(Clack::default().note("界", "T"), None);
        assert_eq!(width("⇡ ✓"), Some(3));
        assert_eq!(width("✔"), None);
        assert_eq!(width("—·ñ"), Some(3));
    }

    // Covers: R73
    #[test]
    fn leaf_args_delegate_every_uncertain_shape() {
        assert_eq!(
            parse_leaf(&["x", "--workspace=acme", "y"]),
            Some((Some("x"), Some("acme")))
        );
        for argv in [
            &["--workspace"][..],
            &["--workspace="],
            &["--workspace", "a", "--workspace", "b"],
            &["--json"],
            &["-w", "a"],
        ] {
            assert_eq!(parse_leaf(argv), None, "{argv:?}");
        }
    }
}
