//! `navori render` in preview and with `--apply` (spec 0058 E3 M6 and M8, D23, D27).
//!
//! Native only inside the subset the manifest entry declares (R39): its `flags`, its
//! `when.engines`, a root without enabled monorepo workspaces and a config `readConfig` accepts.
//! Everything else is handed to the TS **before any output or effect**, so the decision reads the
//! argv and the config and nothing more.
//!
//! The argv is parsed strictly: an option form whose meaning in citty is not obvious (a short or
//! `--no-` flag, a boolean with a value, a repeated option, a value that looks like an option, a
//! positional) delegates instead of guessing.
//!
//! An apply is planned in preview first, so a step that delegates does so before any write. It
//! also delegates when `refreshRepoName` would rewrite `~/.navori/registry.json` (the TS sorts it
//! with `localeCompare`) or when `HOME` is not usable, both before any output or effect.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::backup::{BackupStore, backup_root, local_now};
use navori_core::config::{self, Config, HarnessRecord};
use navori_core::fs::RealFs;
use navori_core::i18n;
use navori_core::js_json::{self, JsValue};
use navori_core::manifest::Command;
use navori_core::render::claude_md::has_monorepo_workspaces;
use navori_core::render::collect::DiskView;
use navori_core::render::command::{
    Apply, RenderError, RenderOptions, RenderPlan, human_report, plan_render, render_json,
    run_render,
};
use navori_core::render::report::Clack;

use crate::{NativeCall, Outcome};

/// The arguments of a native `render`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderArgs {
    /// `resolve(args.cwd ?? process.cwd())`.
    pub cwd: PathBuf,
    /// `--dry-run`: preview, which is also the default and wins over `--apply`.
    pub dry_run: bool,
    /// `--json`.
    pub json: bool,
    /// `--apply`.
    pub apply: bool,
    /// `--force`.
    pub force: bool,
}

impl RenderArgs {
    /// `!args.apply || Boolean(args["dry-run"])`.
    #[must_use]
    pub const fn preview(&self) -> bool {
        !self.apply || self.dry_run
    }
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
pub(crate) fn resolve(base: &Path, value: &Path) -> PathBuf {
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
    let mut apply = false;
    let mut force = false;
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
            "apply" if declared("apply") && !apply => {
                parser.optional_value().is_none().then_some(())?;
                apply = true;
            }
            "force" if declared("force") && !force => {
                parser.optional_value().is_none().then_some(())?;
                force = true;
            }
            _ => return None,
        }
    }
    let cwd = match cwd {
        Some(value) => resolve(base, Path::new(&value)),
        None => base.to_path_buf(),
    };
    Some(RenderArgs {
        cwd,
        dry_run,
        json,
        apply,
        force,
    })
}

/// `config.engines ?? ["claude"]`, its strings.
pub(crate) fn configured_engines(config: &JsValue) -> Vec<String> {
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
        let configured = configured_engines(&config.data);
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

/// Whether the TS human report would print without any escape: picocolors (`isColorSupported`)
/// and `util.styleText` (clack) both off. Only a non-TTY stdout without `FORCE_COLOR` and without
/// a non-empty `CI` (unless `NO_COLOR` is non-empty) qualifies; a terminal always delegates, so
/// the colored report stays the TS's.
#[must_use]
pub fn colorless(var: impl Fn(&str) -> Option<OsString>, stdout_tty: bool) -> bool {
    let set = |name: &str| var(name).is_some_and(|value| !value.is_empty());
    var("FORCE_COLOR").is_none() && !stdout_tty && (set("NO_COLOR") || !set("CI"))
}

/// `readRegistry()`'s entries as `(path, name)`: empty when the file is absent, unreadable, not
/// JSON or not of `RegistrySchema`'s shape (`{ repos?: { path: non-empty string, name?: string
/// }[] }`, extra keys allowed).
fn registry_entries(text: Option<&str>) -> Vec<(String, Option<String>)> {
    let Some(JsValue::Object(root)) = text.and_then(js_json::parse) else {
        return Vec::new();
    };
    let repos = match root.get("repos") {
        None | Some(JsValue::Undefined) => return Vec::new(),
        Some(JsValue::Array(repos)) => repos,
        Some(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for repo in repos {
        let JsValue::Object(entry) = repo else {
            return Vec::new();
        };
        let Some(JsValue::String(path)) = entry.get("path") else {
            return Vec::new();
        };
        let name = match entry.get("name") {
            None | Some(JsValue::Undefined) => None,
            Some(JsValue::String(name)) => match name.to_rust() {
                Some(name) => Some(name),
                None => return Vec::new(),
            },
            Some(_) => return Vec::new(),
        };
        match path.to_rust() {
            Some(path) if !path.is_empty() => out.push((path, name)),
            _ => return Vec::new(),
        }
    }
    out
}

/// Whether `refreshRepoName(cwd, name)` would rewrite the registry under `home`: the first entry
/// for the repo's canonical path carries another name.
#[must_use]
pub fn registry_needs_refresh(home: &Path, cwd: &Path, name: Option<&str>) -> bool {
    let text = std::fs::read_to_string(home.join(".navori/registry.json")).ok();
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let Some(canonical) = canonical.to_str() else {
        return true;
    };
    registry_entries(text.as_deref())
        .into_iter()
        .find(|(path, _)| path == canonical)
        .is_some_and(|(_, current)| current.as_deref() != name)
}

/// `config.name`.
pub(crate) fn config_name(config: &Config) -> Option<String> {
    match &config.data {
        JsValue::Object(root) => match root.get("name") {
            Some(JsValue::String(name)) => name.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

/// `HOME` as `safeHomedir()` accepts it: set and absolute.
pub(crate) fn home() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    home.is_absolute().then_some(home)
}

/// What an apply printed besides the report: the error that stopped it, or the stderr of
/// `recordHarnessVersionIfWritten`.
fn apply_render(
    cwd: &Path,
    config: &Config,
    options: &RenderOptions,
) -> Result<(RenderPlan, String), String> {
    let mut fs = RealFs::default();
    let mut backups = BackupStore::new(backup_root(), std::process::id());
    let now = local_now();
    let mut apply = Apply {
        fs: &mut fs,
        backups: &mut backups,
        now: &now,
    };
    match run_render(&DiskView(cwd), config, cwd, options, Some(&mut apply)) {
        Ok(plan) => {
            let stderr = match plan.applied.as_ref().and_then(|a| a.harness.as_ref()) {
                Some(outcome @ (HarnessRecord::NonCanonical | HarnessRecord::Unreadable)) => {
                    format!("{}\n", i18n::harness_version_not_recorded(outcome.as_str()))
                }
                _ => String::new(),
            };
            Ok((plan, stderr))
        }
        Err(RenderError::Delegate) => {
            Err("render: a step declined after the preview accepted it".to_owned())
        }
        Err(error) => Err(error.message()),
    }
}

/// The native `render`: the plan of `runRenderCore` (committed with `--apply`), the config
/// warnings `readConfig` writes on each of its two reads, then the report. Any step that
/// delegates does so before the first byte of output or the first write.
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    let Ok(base) = std::env::current_dir() else {
        return Outcome::Delegate;
    };
    let Some(admitted) = gate(call, &base) else {
        return Outcome::Delegate;
    };
    let json = admitted.args.json;
    if !json
        && !colorless(
            |name| std::env::var_os(name),
            std::io::stdout().is_terminal(),
        )
    {
        return Outcome::Delegate;
    }
    let preview_only = admitted.args.preview();
    let cwd = admitted.args.cwd;
    let Some(cwd_text) = cwd.to_str() else {
        return Outcome::Delegate;
    };
    let options = RenderOptions {
        force: admitted.args.force,
        ..RenderOptions::default()
    };
    let Ok(preview) = plan_render(&DiskView(&cwd), &admitted.config, &cwd, &options) else {
        return Outcome::Delegate;
    };
    let mut stderr = String::new();
    for _ in 0..2 {
        for warning in &admitted.config.warnings {
            stderr.push_str(warning);
            stderr.push('\n');
        }
    }
    let plan = if preview_only {
        preview
    } else {
        let Some(home) = home() else {
            return Outcome::Delegate;
        };
        if registry_needs_refresh(&home, &cwd, config_name(&admitted.config).as_deref()) {
            return Outcome::Delegate;
        }
        let _ = std::io::stderr().write_all(stderr.as_bytes());
        stderr.clear();
        match apply_render(&cwd, &admitted.config, &options) {
            Ok((plan, record)) => {
                stderr = record;
                plan
            }
            Err(message) => {
                // The TS printed its intro before failing; the error itself escapes citty as an
                // uncaught exception with a stack trace, which Rust does not reproduce.
                if !json {
                    let _ = std::io::stdout()
                        .write_all(Clack::from_env().intro("navori render").as_bytes());
                }
                let _ = writeln!(std::io::stderr(), "{message}");
                return Outcome::Exit(ExitCode::FAILURE);
            }
        }
    };
    let stdout = if json {
        let Some(text) = render_json(cwd_text, &plan).stringify(Some(2)) else {
            return Outcome::Delegate;
        };
        format!("{text}\n")
    } else {
        human_report(Clack::from_env(), cwd_text, &plan)
    };
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    let _ = std::io::stdout().write_all(stdout.as_bytes());
    Outcome::Exit(ExitCode::SUCCESS)
}
