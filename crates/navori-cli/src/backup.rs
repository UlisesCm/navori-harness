//! `navori backup list|restore|prune`, native (spec 0060 T27, M11, R73).
//!
//! The command layer of `commands/backup.ts` over `navori_core::backup`, with the clack output
//! of [`crate::clack`]. `restore` without `--yes` asks with an interactive confirm and stays
//! with the TS; so does a flag value `Number()` would read differently from plain digits, a
//! backup root the TS cannot resolve, a name that is not UTF-8 and colored output.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::UNIX_EPOCH;

use navori_core::backup::{backup_repo_label, backup_root, purge_old_backups};
use navori_core::fs::{Fs, RealFs};
use navori_core::js_json::{JsObject, JsValue, number_to_js};

use crate::clack::{Clack, Symbol, plain_output};
use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::Output;
use crate::{NativeCall, Outcome};

const LIST: CommandDef = CommandDef {
    name: "list",
    description: "List available backups in ~/.navori/backups/",
    args: &[
        ArgDef {
            name: "json",
            kind: ArgKind::Boolean,
            description: "Output as JSON",
        },
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
    description: "Restore files from a backup snapshot to the current directory",
    args: &[
        ArgDef {
            name: "timestamp",
            kind: ArgKind::Positional,
            description: "Backup timestamp (from 'backup list')",
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

const PRUNE: CommandDef = CommandDef {
    name: "prune",
    description: "Delete backups past retention, then oldest-first down to the size cap",
    args: &[
        ArgDef {
            name: "days",
            kind: ArgKind::String,
            description: "Retention in days (default: 30)",
        },
        ArgDef {
            name: "max-mb",
            kind: ArgKind::String,
            description: "Total size cap in MB (default: 2048)",
        },
    ],
    sub_commands: &[],
};

const BACKUP: CommandDef = CommandDef {
    name: "backup",
    description: "List and restore navori backups",
    args: &[],
    sub_commands: &[
        ("list", LIST.description),
        ("restore", RESTORE.description),
        ("prune", PRUNE.description),
    ],
};

pub(crate) const PROTOTYPE_KEYS: &[&str] = &[
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

const BACKUP_PARENT: Parent<'static> = Parent {
    name: "backup",
    version: None,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    List,
    Restore,
    Prune,
}

/// `backup` alone.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `backup list`.
#[must_use]
pub fn run_list(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::List))
}

/// `backup restore`.
#[must_use]
pub fn run_restore(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Restore))
}

/// `backup prune`.
#[must_use]
pub fn run_prune(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Prune))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "backup" || rest.contains(&"--") {
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
        return Some(Output::usage(&BACKUP, ROOT, error).emit());
    };
    let (def, leaf_row) = match rest[at] {
        "list" => (&LIST, Row::List),
        "restore" => (&RESTORE, Row::Restore),
        "prune" => (&PRUNE, Row::Prune),
        name if row != Row::Group || PROTOTYPE_KEYS.contains(&name) => return None,
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&BACKUP, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(def, BACKUP_PARENT, None).emit());
    }
    let (strings, booleans): (&[&str], &[&str]) = match row {
        Row::List => (&["limit"], &["json"]),
        Row::Restore => (&["cwd"], &["yes"]),
        _ => (&["days", "max-mb"], &[]),
    };
    let options = parse_leaf(&rest[at + 1..], strings, booleans)?;
    if row == Row::Restore && options.positional.is_none() {
        let error = "Missing required positional argument: TIMESTAMP".to_owned();
        return Some(Output::usage(def, BACKUP_PARENT, Some(error)).emit());
    }
    if !plain_output() {
        return None;
    }
    let root = backup_root().ok()?;
    let out = match row {
        Row::List => list(&root, &options)?,
        Row::Restore => restore(&root, &options)?,
        Row::Prune => prune(&root, &options)?,
        Row::Group => return None,
    };
    Some(out.emit())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Leaf<'a> {
    pub(crate) positional: Option<&'a str>,
    pub(crate) positionals: Vec<&'a str>,
    pub(crate) strings: Vec<(&'static str, &'a str)>,
    pub(crate) booleans: Vec<&'static str>,
}

impl<'a> Leaf<'a> {
    pub(crate) fn get(&self, name: &str) -> Option<&'a str> {
        self.strings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
    }

    pub(crate) fn flag(&self, name: &str) -> bool {
        self.booleans.contains(&name)
    }
}

/// `None` for any shape citty could read differently.
pub(crate) fn parse_leaf<'a>(
    tokens: &[&'a str],
    strings: &[&'static str],
    booleans: &[&'static str],
) -> Option<Leaf<'a>> {
    let mut leaf = Leaf::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        let Some(body) = token.strip_prefix("--") else {
            if token.starts_with('-') {
                return None;
            }
            if leaf.positional.is_none() {
                leaf.positional = Some(token);
            }
            leaf.positionals.push(token);
            continue;
        };
        if let Some(name) = booleans.iter().find(|b| **b == body) {
            leaf.booleans.push(name);
            continue;
        }
        let (name, inline) = body
            .split_once('=')
            .map_or((body, None), |(n, v)| (n, Some(v)));
        let name = *strings.iter().find(|known| **known == name)?;
        if leaf.get(name).is_some() {
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
        leaf.strings.push((name, value));
    }
    Some(leaf)
}

/// `intFlagOrExit(raw, flag, fallback)` for plain digits; anything else `Number()` would read
/// (spaces, hex, exponents, a sign) is the TS's.
pub(crate) fn int_flag(raw: Option<&str>, fallback: Option<u64>) -> Option<Option<u64>> {
    match raw {
        None => Some(fallback),
        Some(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse().ok().map(Some)
        }
        Some(_) => None,
    }
}

/// `stat.mtimeMs`: `sec * 1e3 + nsec / 1e6`, as Node computes it.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    #[expect(clippy::cast_precision_loss, reason = "the same doubles Node computes")]
    Some(since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6)
}

pub(crate) fn now_ms() -> Option<f64> {
    let since = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?;
    #[expect(clippy::cast_precision_loss, reason = "Date.now() is a double too")]
    Some(since.as_millis() as f64)
}

/// `collectFiles(root, dir)`; `None` where `readdirSync` throws.
pub(crate) fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) -> Option<()> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).ok()? {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }
    names.sort();
    for name in names {
        let full = dir.join(&name);
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            collect_files(root, &full, out)?;
        } else if meta.is_file() {
            out.push(full.strip_prefix(root).ok()?.to_str()?.to_owned());
        }
    }
    Some(())
}

struct Entry {
    timestamp: String,
    path: String,
    files: Vec<String>,
    mtime_ms: f64,
}

/// `listBackups()`: every readable directory of the root, newest first.
fn list_backups(root: &Path) -> Option<Vec<Entry>> {
    if !root.exists() {
        return Some(Vec::new());
    }
    // `readdirSync` of a root that exists but cannot be listed throws uncaught.
    let entries = std::fs::read_dir(root).ok()?;
    let mut names = Vec::new();
    for entry in entries {
        names.push(entry.ok()?.file_name().into_string().ok()?);
    }
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let full = root.join(&name);
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        if collect_files(&full, &full, &mut files).is_none() {
            continue;
        }
        out.push(Entry {
            timestamp: name,
            path: full.to_str()?.to_owned(),
            files,
            mtime_ms: mtime_ms(&meta)?,
        });
    }
    out.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms));
    Some(out)
}

pub(crate) fn iso(ms: f64) -> Option<String> {
    navori_core::backup::iso_from_ms(ms)
}

/// `humanAge(mtimeMs)`.
fn human_age(mtime: f64, now: f64) -> String {
    let minutes = ((now - mtime) / 60_000.0).floor();
    if minutes < 1.0 {
        return "(recién)".to_owned();
    }
    if minutes < 60.0 {
        return format!("(hace {} min)", number_to_js(minutes));
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return format!("(hace {} h)", number_to_js(hours));
    }
    format!("(hace {} d)", number_to_js((hours / 24.0).floor()))
}

fn list(root: &Path, options: &Leaf<'_>) -> Option<Output> {
    let backups = list_backups(root)?;
    let limit = int_flag(options.get("limit"), Some(20))?.unwrap_or(20);
    let shown = usize::try_from(limit)
        .unwrap_or(usize::MAX)
        .min(backups.len());
    let truncated = &backups[..shown];
    let mut clack = Clack::default();
    if options.flag("json") {
        let entries = truncated
            .iter()
            .map(|b| {
                let mut o = JsObject::new();
                o.insert("timestamp", JsValue::string(&b.timestamp));
                o.insert("path", JsValue::string(&b.path));
                o.insert(
                    "files",
                    JsValue::Array(b.files.iter().map(|f| JsValue::string(f)).collect()),
                );
                o.insert("mtimeMs", JsValue::Number(b.mtime_ms));
                JsValue::Object(o)
            })
            .collect();
        let mut doc = JsObject::new();
        doc.insert("backups", JsValue::Array(entries));
        #[expect(
            clippy::cast_precision_loss,
            reason = "a backup count is far below 2^53"
        )]
        doc.insert("totalAvailable", JsValue::Number(backups.len() as f64));
        clack.out.stdout = format!("{}\n", JsValue::Object(doc).stringify(Some(2))?);
        return Some(clack.out);
    }
    clack.intro("navori backup list");
    if backups.is_empty() {
        clack.log(
            Symbol::Info,
            "No hay backups. Se crean automáticamente antes de cada 'sync' o 'render' que modifica archivos.",
        );
        clack.outro("Listo");
        return Some(clack.out);
    }
    let now = now_ms()?;
    let mut lines = vec![format!(
        "{} backup(s) en total. Mostrando {}:",
        backups.len(),
        truncated.len()
    )];
    for b in truncated {
        lines.push(format!(
            "  · {}  {}  {}",
            b.timestamp,
            iso(b.mtime_ms)?,
            human_age(b.mtime_ms, now)
        ));
        for f in &b.files {
            lines.push(format!("      · {f}"));
        }
    }
    if backups.len() > truncated.len() {
        lines.push(format!(
            "  ... {} más (usa --limit para mostrarlos)",
            backups.len() - truncated.len()
        ));
    }
    clack.log(Symbol::Bar, &lines.join("\n"));
    clack.outro("Listo");
    Some(clack.out)
}

/// `BACKUP_ID_RE`'s repo label.
fn backup_id_repo_label(id: &str) -> Option<&str> {
    // `-YYYY-MM-DDTHH-mm-ss-SSS-p<pid>-<seq>` at the end.
    let (head, seq) = id.rsplit_once('-')?;
    if seq.is_empty() || !seq.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (head, pid) = head.rsplit_once("-p")?;
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let stamp_len = "YYYY-MM-DDTHH-mm-ss-SSS".len();
    let split = head.len().checked_sub(stamp_len + 1)?;
    let (label, stamp) = head.split_at(split);
    let stamp = stamp.strip_prefix('-')?;
    let shape = stamp.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 | 13 | 16 | 19 => b == b'-',
        10 => b == b'T',
        _ => b.is_ascii_digit(),
    });
    (shape && !label.is_empty()).then_some(label)
}

fn restore(root: &Path, options: &Leaf<'_>) -> Option<Output> {
    // Without `--yes` the TS asks with an interactive confirm.
    if !options.flag("yes") {
        return None;
    }
    let ts = options.positional?;
    // A timestamp that walks out of the backup root is left to the TS's own (lack of) checks.
    if ts.contains('/') || ts.starts_with('.') {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd: PathBuf =
        navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or("")).into();
    let backup_dir = root.join(ts);
    let shown_dir = backup_dir.to_str()?.to_owned();
    let mut clack = Clack::default();
    clack.intro(&format!("navori backup restore {ts}"));
    let Ok(meta) = std::fs::metadata(&backup_dir) else {
        clack.cancel(&format!("Backup no encontrado: {shown_dir}"));
        return Some(clack.out);
    };
    if !meta.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    collect_files(&backup_dir, &backup_dir, &mut files)?;
    if files.is_empty() {
        clack.cancel(&format!("El backup está vacío: {shown_dir}"));
        return Some(clack.out);
    }
    let dest_label = backup_repo_label(&cwd);
    if let Some(repo) = backup_id_repo_label(ts)
        && repo != dest_label
    {
        clack.log(
            Symbol::Warn,
            &format!(
                "Este backup es del repo '{repo}' pero el destino es '{dest_label}'. Verifica que sea el correcto antes de continuar."
            ),
        );
    }
    clack.log(
        Symbol::Bar,
        &format!(
            "Se restaurarán {} archivo(s) de {shown_dir} en {}:",
            files.len(),
            cwd.to_str()?
        ),
    );
    for f in &files {
        clack.log(Symbol::Bar, &format!("  · {f}"));
    }
    let mut fs = RealFs::default();
    for rel in &files {
        let dest = cwd.join(rel);
        let parent = dest.parent()?;
        if fs.mkdir_all(parent).is_err() || fs.copy(&backup_dir.join(rel), &dest).is_err() {
            // `copyFileSync` throws uncaught after the checks: only stderr reports it.
            clack.out.stderr = format!("navori-rust: cannot restore {rel}\n");
            clack.out.code = 1;
            return Some(clack.out);
        }
    }
    clack.outro(&format!("Restauré {} archivo(s)", files.len()));
    Some(clack.out)
}

fn prune(root: &Path, options: &Leaf<'_>) -> Option<Output> {
    let days = int_flag(options.get("days"), None)?;
    let max_mb = int_flag(options.get("max-mb"), None)?;
    #[expect(
        clippy::cast_precision_loss,
        reason = "flag values far below 2^53 days"
    )]
    let retention = days.map_or(30.0, |d| d as f64);
    let max_bytes = max_mb.map_or(Some(2048 * 1024 * 1024), |mb| mb.checked_mul(1024 * 1024))?;
    let mut clack = Clack::default();
    clack.intro("navori backup prune");
    let mut fs = RealFs::default();
    let pruned = purge_old_backups(&mut fs, root, now_ms()?, retention, max_bytes, None).ok()?;
    if pruned.is_empty() {
        clack.outro(
            "Nada que podar — los backups están dentro de la retención y del tope de tamaño",
        );
        return Some(clack.out);
    }
    for dir in &pruned {
        clack.log(Symbol::Bar, &format!("  · {}", dir.to_str()?));
    }
    clack.outro(&format!("Limpié {} backup(s)", pruned.len()));
    Some(clack.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn helpers_follow_the_ts() {
        assert_eq!(
            backup_id_repo_label("my-repo-2026-10-31T10-00-00-123-p42-1"),
            Some("my-repo")
        );
        assert_eq!(backup_id_repo_label("my-repo-2026-10-31"), None);
        assert_eq!(int_flag(Some("12"), None), Some(Some(12)));
        assert_eq!(int_flag(Some("0x1"), None), None);
        assert_eq!(int_flag(None, Some(20)), Some(Some(20)));
        assert_eq!(human_age(0.0, 59_999.0), "(recién)");
        assert_eq!(human_age(0.0, 3_600_000.0 * 25.0), "(hace 1 d)");
        assert_eq!(iso(1.9).as_deref(), Some("1970-01-01T00:00:00.001Z"));
    }
}
