//! `navori render` in preview (spec 0058 E3 M6, D23).
//!
//! Native only inside the subset the manifest entry declares (R39): its `flags`, its
//! `when.engines`, a root without enabled monorepo workspaces and a config `readConfig` accepts.
//! Everything else is handed to the TS **before any output or effect**, so the decision reads the
//! argv and the config and nothing more.
//!
//! The argv is parsed strictly: an option form whose meaning in citty is not obvious (a short or
//! `--no-` flag, a boolean with a value, a repeated option, a value that looks like an option, a
//! positional) delegates instead of guessing.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use lexopt::Arg;
use navori_core::config::{self, Config};
use navori_core::js_json::JsValue;
use navori_core::manifest::Command;
use navori_core::render::claude_md::has_monorepo_workspaces;

use crate::{NativeCall, Outcome};

/// The arguments of a native `render`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderArgs {
    /// `resolve(args.cwd ?? process.cwd())`.
    pub cwd: PathBuf,
    /// `--dry-run`: preview, which is also the default.
    pub dry_run: bool,
    /// `--json`.
    pub json: bool,
}

/// A `render` invocation the native subset admits.
#[derive(Debug, Clone, PartialEq)]
pub struct Admitted {
    /// The arguments.
    pub args: RenderArgs,
    /// The accepted config.
    pub config: Config,
}

/// `path.resolve(base, value)`: lexical, without touching the disk.
fn resolve(base: &Path, value: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in base.join(value).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Parses `args` (`render …`) against the entry's flags, resolving `--cwd` against `base`.
/// `None` delegates.
#[must_use]
pub fn parse_args(args: &[OsString], entry: &Command, base: &Path) -> Option<RenderArgs> {
    let declared = |name: &str| entry.flags.iter().any(|flag| flag == name);
    let mut parser = lexopt::Parser::from_args(args.iter().cloned());
    match parser.next().ok()?? {
        Arg::Value(value) if value == "render" => {}
        _ => return None,
    }
    let mut cwd: Option<OsString> = None;
    let mut dry_run = false;
    let mut json = false;
    while let Some(arg) = parser.next().ok()? {
        let Arg::Long(name) = arg else {
            return None;
        };
        match name {
            "cwd" if declared("cwd") && cwd.is_none() => {
                let value = parser.value().ok()?;
                let text = value.to_str()?;
                if text.is_empty() || text.starts_with('-') {
                    return None;
                }
                cwd = Some(value);
            }
            "dry-run" if declared("dry-run") && !dry_run => {
                parser.optional_value().is_none().then_some(())?;
                dry_run = true;
            }
            "json" if declared("json") && !json => {
                parser.optional_value().is_none().then_some(())?;
                json = true;
            }
            _ => return None,
        }
    }
    let cwd = match cwd {
        Some(value) => resolve(base, Path::new(&value)),
        None => base.to_path_buf(),
    };
    Some(RenderArgs { cwd, dry_run, json })
}

/// `config.engines ?? ["claude"]`, its strings.
fn engines(config: &JsValue) -> Vec<String> {
    let JsValue::Object(root) = config else {
        return vec!["claude".to_owned()];
    };
    match root.get("engines") {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(s) => s.to_rust(),
                _ => None,
            })
            .collect(),
        _ => vec!["claude".to_owned()],
    }
}

/// Admits a parsed invocation: an existing directory, a config `readConfig` accepts, engines
/// within `when.engines` and no enabled monorepo workspaces. `None` delegates.
#[must_use]
pub fn admit(args: RenderArgs, entry: &Command) -> Option<Admitted> {
    if !args.cwd.is_dir() {
        return None;
    }
    let bytes = std::fs::read(args.cwd.join("navori.config.json")).ok()?;
    let config = config::read(&bytes).ok()?;
    if let Some(allowed) = entry.when.as_ref().and_then(|w| w.engines.as_ref()) {
        let configured = engines(&config.data);
        if configured.is_empty() || !configured.iter().all(|e| allowed.contains(e)) {
            return None;
        }
    }
    if has_monorepo_workspaces(&config.data) {
        return None;
    }
    Some(Admitted { args, config })
}

/// The admitted invocation of `call`, or `None` to delegate.
#[must_use]
pub fn gate(call: &NativeCall<'_>, base: &Path) -> Option<Admitted> {
    admit(parse_args(call.args, call.entry, base)?, call.entry)
}

/// The native `render`. The preview body is not ported yet, so every invocation is handed to the
/// TS; no manifest entry selects `render` either.
#[must_use]
pub fn run(_: &NativeCall<'_>) -> Outcome {
    Outcome::Delegate
}
