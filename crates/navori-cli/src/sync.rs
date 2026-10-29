//! `navori sync` without prompts (spec 0058 T29, R48).
//!
//! Native inside the manifest entry: its flags, at least one of the `requires` alternatives (so no
//! native run can reach `p.select`/`p.confirm`), `when.engines`, no enabled monorepo workspaces, a
//! config `readConfig` accepts, a usable backup root and a colorless stdout (unless `--json`).
//! `--accept-new` with `--keep-mine` (the TS's contradiction error) and every other form are
//! handed to the TS before any output or effect.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::backup::{BackupStore, backup_root, local_now};
use navori_core::commit::CommitError;
use navori_core::config::{self, Config};
use navori_core::fs::RealFs;
use navori_core::manifest::Command;
use navori_core::render::claude_md::has_monorepo_workspaces;
use navori_core::render::collect::DiskView;
use navori_core::render::command::{Apply, RenderError};
use navori_core::render::report::Clack;
use navori_core::sync::{SyncFlags, SyncRun, run_sync};

use crate::render::{colorless, configured_engines, resolve};
use crate::{NativeCall, Outcome};

/// The arguments of a native `sync`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncArgs {
    /// `resolve(args.cwd ?? process.cwd())`.
    pub cwd: PathBuf,
    /// The boolean flags.
    pub flags: SyncFlags,
}

/// Parses `args` (`sync …`) against the entry's flags, resolving `--cwd` against `base`.
/// `None` delegates.
#[must_use]
pub fn parse_args(args: &[OsString], entry: &Command, base: &Path) -> Option<SyncArgs> {
    let declared = |name: &str| entry.flags.iter().any(|flag| flag == name);
    let mut parser = lexopt::Parser::from_args(args.iter().cloned());
    match parser.next().ok()?? {
        Arg::Value(value) if value == "sync" => {}
        _ => return None,
    }
    let mut cwd: Option<OsString> = None;
    let mut flags = SyncFlags::default();
    while let Some(arg) = parser.next().ok()? {
        let Arg::Long(name) = arg else {
            return None;
        };
        if name == "cwd" && declared("cwd") && cwd.is_none() {
            let value = parser.value().ok()?;
            let text = value.to_str()?;
            if text.is_empty() || text.starts_with('-') {
                return None;
            }
            cwd = Some(value);
            continue;
        }
        let slot = match name {
            "dry-run" => &mut flags.dry_run,
            "apply" => &mut flags.apply,
            "yes" => &mut flags.yes,
            "json" => &mut flags.json,
            "accept-new" => &mut flags.accept_new,
            "keep-mine" => &mut flags.keep_mine,
            _ => return None,
        };
        if !declared(name) || *slot {
            return None;
        }
        parser.optional_value().is_none().then_some(())?;
        *slot = true;
    }
    if flags.accept_new && flags.keep_mine {
        return None;
    }
    let cwd = match cwd {
        Some(value) => resolve(base, Path::new(&value)),
        None => base.to_path_buf(),
    };
    Some(SyncArgs { cwd, flags })
}

/// A config inside the entry's subset, or `None` to delegate.
fn admit(cwd: &Path, entry: &Command) -> Option<Config> {
    if !cwd.is_dir() {
        return None;
    }
    let config = config::read(&std::fs::read(cwd.join("navori.config.json")).ok()?).ok()?;
    if let Some(allowed) = entry.when.as_ref().and_then(|w| w.engines.as_ref()) {
        let configured = configured_engines(&config.data);
        if configured.is_empty() || !configured.iter().all(|e| allowed.contains(e)) {
            return None;
        }
    }
    (!has_monorepo_workspaces(&config.data)).then_some(config)
}

/// The native `sync`.
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    let Ok(base) = std::env::current_dir() else {
        return Outcome::Delegate;
    };
    let Some(args) = parse_args(call.args, call.entry, &base) else {
        return Outcome::Delegate;
    };
    if !args.flags.json
        && !colorless(
            |name| std::env::var_os(name),
            std::io::stdout().is_terminal(),
        )
    {
        return Outcome::Delegate;
    }
    let Some(config) = admit(&args.cwd, call.entry) else {
        return Outcome::Delegate;
    };
    let root = backup_root();
    if (args.flags.apply || args.flags.yes) && root.is_err() {
        return Outcome::Delegate;
    }
    let mut fs = RealFs::default();
    let mut backups = BackupStore::new(root, std::process::id());
    let now = local_now();
    let mut apply = Apply {
        fs: &mut fs,
        backups: &mut backups,
        now: &now,
    };
    let warnings: String = config.warnings.iter().map(|w| format!("{w}\n")).collect();
    let run = run_sync(
        &DiskView(&args.cwd),
        &config,
        &args.cwd,
        args.flags,
        Clack::from_env(),
        &mut apply,
    );
    match run {
        Ok(SyncRun::Delegate) | Err(RenderError::Delegate) => Outcome::Delegate,
        Ok(SyncRun::Done {
            stdout,
            stderr,
            code,
        }) => {
            let _ = std::io::stderr().write_all(format!("{warnings}{stderr}").as_bytes());
            let _ = std::io::stdout().write_all(stdout.as_bytes());
            Outcome::Exit(ExitCode::from(code))
        }
        Err(error) => {
            let message = match error {
                RenderError::Commit(CommitError::Backup(e)) | RenderError::Record(e) => e.message,
                RenderError::Commit(CommitError::Write { message, .. }) => message,
                RenderError::Delegate => String::new(),
            };
            let _ = std::io::stderr().write_all(format!("{warnings}{message}\n").as_bytes());
            Outcome::Exit(ExitCode::FAILURE)
        }
    }
}
