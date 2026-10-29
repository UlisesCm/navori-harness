//! `navori adopt <path>` (spec 0058 T26): preview by default, `--apply` writes after a backup.
//!
//! Native inside the manifest entry's flags (`apply`, `cwd`) with exactly one positional, a
//! config `readConfig` accepts (or none), a usable backup root and a colorless stdout; anything
//! else is handed to the TS before any output or effect.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::adopt::{AdoptPlan, apply_adoption, plan_adoption};
use navori_core::backup::{BackupStore, backup_root, local_now};
use navori_core::config::{self, Config, HarnessRecord, record_harness_version};
use navori_core::fs::{RealFs, write_file_atomic};
use navori_core::i18n;
use navori_core::manifest::Command;
use navori_core::render::context::Lang;
use navori_core::render::report::Clack;

use crate::render::{colorless, resolve};
use crate::{NativeCall, Outcome};

/// The arguments of a native `adopt`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptArgs {
    /// The positional `path`, verbatim.
    pub path: String,
    /// `resolve(args.cwd ?? process.cwd())`.
    pub cwd: PathBuf,
    /// `--apply`.
    pub apply: bool,
}

/// Parses `args` (`adopt …`) against the entry's flags, resolving `--cwd` against `base`.
/// `None` delegates.
#[must_use]
pub fn parse_args(args: &[OsString], entry: &Command, base: &Path) -> Option<AdoptArgs> {
    if args.iter().any(|arg| arg == "--") {
        return None;
    }
    let declared = |name: &str| entry.flags.iter().any(|flag| flag == name);
    let mut parser = lexopt::Parser::from_args(args.iter().cloned());
    match parser.next().ok()?? {
        Arg::Value(value) if value == "adopt" => {}
        _ => return None,
    }
    let mut path: Option<String> = None;
    let mut cwd: Option<OsString> = None;
    let mut apply = false;
    while let Some(arg) = parser.next().ok()? {
        match arg {
            Arg::Value(value) if path.is_none() => {
                let text = value.into_string().ok()?;
                if text.is_empty() {
                    return None;
                }
                path = Some(text);
            }
            Arg::Long("cwd") if declared("cwd") && cwd.is_none() => {
                let value = parser.value().ok()?;
                let text = value.to_str()?;
                if text.is_empty() || text.starts_with('-') {
                    return None;
                }
                cwd = Some(value);
            }
            Arg::Long("apply") if declared("apply") && !apply => {
                parser.optional_value().is_none().then_some(())?;
                apply = true;
            }
            _ => return None,
        }
    }
    let cwd = match cwd {
        Some(value) => resolve(base, Path::new(&value)),
        None => base.to_path_buf(),
    };
    Some(AdoptArgs {
        path: path?,
        cwd,
        apply,
    })
}

/// `readConfigOrExit` when the config exists: `Ok(None)` without one, `Err` to delegate.
fn read_config(cwd: &Path) -> Result<Option<Config>, ()> {
    let path = cwd.join("navori.config.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| ())?;
    config::read(&bytes).map(Some).map_err(|_| ())
}

/// The native `adopt`.
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    let Ok(base) = std::env::current_dir() else {
        return Outcome::Delegate;
    };
    let Some(args) = parse_args(call.args, call.entry, &base) else {
        return Outcome::Delegate;
    };
    if !colorless(
        |name| std::env::var_os(name),
        std::io::stdout().is_terminal(),
    ) {
        return Outcome::Delegate;
    }
    let Some(cwd_text) = args.cwd.to_str() else {
        return Outcome::Delegate;
    };
    let Ok(config) = read_config(&args.cwd) else {
        return Outcome::Delegate;
    };
    let lang = config.as_ref().map_or(Lang::Es, Config::lang);
    let Ok(plan) = plan_adoption(cwd_text, &args.path, navori_core::STAMP_VERSION) else {
        return Outcome::Delegate;
    };
    let root = backup_root();
    if args.apply && matches!(plan, AdoptPlan::Adopt { .. }) && root.is_err() {
        return Outcome::Delegate;
    }

    let mut stderr: String = config
        .iter()
        .flat_map(|c| c.warnings.iter())
        .map(|w| format!("{w}\n"))
        .collect();
    let clack = Clack::from_env();
    let mut out = clack.intro(&format!("navori adopt {}", args.path));
    let mut code = ExitCode::SUCCESS;
    match plan {
        AdoptPlan::Refuse { reason, path } => {
            out.push_str(&clack.cancel(&i18n::adopt_refused(lang, reason, &path)));
            code = ExitCode::FAILURE;
        }
        AdoptPlan::Noop { path } => {
            out.push_str(&clack.outro(&i18n::adopt_already_adopted(lang, &path)));
        }
        AdoptPlan::Adopt {
            rel_path,
            marker_id,
            ..
        } if !args.apply => {
            out.push_str(&clack.info(&i18n::adopt_preview(lang, &rel_path, &marker_id)));
            out.push_str(&clack.outro(i18n::adopt_preview_hint(lang)));
        }
        AdoptPlan::Adopt {
            path,
            rel_path,
            marker_id,
            content,
        } => {
            let mut fs = RealFs::default();
            let mut backups = BackupStore::new(root, std::process::id());
            let now = local_now();
            let backup = match apply_adoption(
                &mut fs,
                &mut backups,
                &args.cwd,
                &path,
                &rel_path,
                &content,
                &now,
            ) {
                Ok(backup) => backup,
                Err(error) => {
                    let _ = std::io::stdout().write_all(out.as_bytes());
                    let _ = writeln!(std::io::stderr(), "{stderr}{}", error.message);
                    return Outcome::Exit(ExitCode::FAILURE);
                }
            };
            // `recordHarnessVersionIfWritten`: the adopted block is a real write.
            if config.is_some() {
                let config_path = args.cwd.join("navori.config.json");
                let record = std::fs::read_to_string(&config_path)
                    .map_or(HarnessRecord::Unreadable, |text| {
                        record_harness_version(&text, navori_core::STAMP_VERSION)
                    });
                match &record {
                    HarnessRecord::Recorded(text) => {
                        if let Err(error) = write_file_atomic(&mut fs, &config_path, text) {
                            let _ = std::io::stdout().write_all(out.as_bytes());
                            let _ = writeln!(std::io::stderr(), "{stderr}{}", error.message);
                            return Outcome::Exit(ExitCode::FAILURE);
                        }
                    }
                    HarnessRecord::NonCanonical | HarnessRecord::Unreadable => {
                        stderr.push_str(&i18n::harness_version_not_recorded(record.as_str()));
                        stderr.push('\n');
                    }
                    HarnessRecord::Unchanged => {}
                }
            }
            out.push_str(&clack.success(&i18n::adopt_adopted(lang, &rel_path, &marker_id)));
            out.push_str(&clack.outro(&i18n::adopt_backup_at(lang, &backup.display().to_string())));
        }
    }
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    let _ = std::io::stdout().write_all(out.as_bytes());
    Outcome::Exit(code)
}
