//! `navori remove <plugin> --yes` (spec 0058 T30, R48).
//!
//! Native inside the manifest entry: one positional plugin id, `--yes` (required, so no native
//! run reaches `p.confirm`) and `--cwd`; a config `readConfig` accepts before and after the
//! plugin is disabled, both within `when.engines` and without workspaces; a colorless stdout;
//! and a render that plans natively over the disabled config. The `engram` refusal, a missing
//! config and everything else are handed to the TS before any output or effect.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::backup::{BackupStore, backup_root, local_now};
use navori_core::config::{self, Config, HarnessRecord};
use navori_core::fs::{RealFs, write_file_atomic};
use navori_core::i18n;
use navori_core::manifest::Command;
use navori_core::remove::{declared, disable, prune};
use navori_core::render::claude_md::has_monorepo_workspaces;
use navori_core::render::collect::DiskView;
use navori_core::render::command::{Apply, RenderOptions, plan_render, run_render};
use navori_core::render::report::Clack;

use crate::render::{
    colorless, config_name, configured_engines, home, registry_needs_refresh, resolve,
};
use crate::{NativeCall, Outcome};

/// The arguments of a native `remove`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveArgs {
    /// The positional plugin id, verbatim.
    pub plugin: String,
    /// `resolve(args.cwd ?? process.cwd())`.
    pub cwd: PathBuf,
}

/// Parses `args` (`remove …`): one positional, `--yes` (required) and `--cwd`. `None` delegates.
#[must_use]
pub fn parse_args(args: &[OsString], entry: &Command, base: &Path) -> Option<RemoveArgs> {
    if args.iter().any(|arg| arg == "--") {
        return None;
    }
    let declared_flag = |name: &str| entry.flags.iter().any(|flag| flag == name);
    let mut parser = lexopt::Parser::from_args(args.iter().cloned());
    match parser.next().ok()?? {
        Arg::Value(value) if value == "remove" => {}
        _ => return None,
    }
    let mut plugin: Option<String> = None;
    let mut cwd: Option<OsString> = None;
    let mut yes = false;
    while let Some(arg) = parser.next().ok()? {
        match arg {
            Arg::Value(value) if plugin.is_none() => {
                let text = value.into_string().ok()?;
                if text.is_empty() {
                    return None;
                }
                plugin = Some(text);
            }
            Arg::Long("cwd") if declared_flag("cwd") && cwd.is_none() => {
                let value = parser.value().ok()?;
                let text = value.to_str()?;
                if text.is_empty() || text.starts_with('-') {
                    return None;
                }
                cwd = Some(value);
            }
            Arg::Long("yes") if declared_flag("yes") && !yes => {
                parser.optional_value().is_none().then_some(())?;
                yes = true;
            }
            _ => return None,
        }
    }
    if !yes {
        return None;
    }
    let cwd = match cwd {
        Some(value) => resolve(base, Path::new(&value)),
        None => base.to_path_buf(),
    };
    Some(RemoveArgs {
        plugin: plugin?,
        cwd,
    })
}

/// A config inside the entry's subset.
fn within(config: &Config, entry: &Command) -> bool {
    if let Some(allowed) = entry.when.as_ref().and_then(|w| w.engines.as_ref()) {
        let configured = configured_engines(&config.data);
        if configured.is_empty() || !configured.iter().all(|e| allowed.contains(e)) {
            return false;
        }
    }
    !has_monorepo_workspaces(&config.data)
}

fn warnings(config: &Config) -> String {
    config.warnings.iter().map(|w| format!("{w}\n")).collect()
}

/// The native `remove`.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "one function per `removeCommand.run`, branch for branch"
)]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    let Ok(base) = std::env::current_dir() else {
        return Outcome::Delegate;
    };
    let Some(args) = parse_args(call.args, call.entry, &base) else {
        return Outcome::Delegate;
    };
    if args.plugin == "engram"
        || !colorless(
            |name| std::env::var_os(name),
            std::io::stdout().is_terminal(),
        )
    {
        return Outcome::Delegate;
    }
    if args.cwd.to_str().is_none() {
        return Outcome::Delegate;
    }
    let config_path = args.cwd.join("navori.config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return Outcome::Delegate;
    };
    let Ok(config) = config::read(text.as_bytes()) else {
        return Outcome::Delegate;
    };
    if !within(&config, call.entry) {
        return Outcome::Delegate;
    }
    let lang = config.lang();
    let clack = Clack::from_env();
    let mut out = clack.intro(&format!("navori remove {}", args.plugin));
    let mut stderr = warnings(&config);
    let id = &args.plugin;

    let Some(native_hook) = declared(&config, id) else {
        out.push_str(&clack.info(&i18n::remove_not_declared(lang, id)));
        out.push_str(&clack.outro(i18n::remove_done(lang)));
        let _ = std::io::stderr().write_all(stderr.as_bytes());
        let _ = std::io::stdout().write_all(out.as_bytes());
        return Outcome::Exit(ExitCode::SUCCESS);
    };

    // Everything the run will need is decided before the first write.
    let Ok(disabled_text) = disable(&text, id, native_hook) else {
        return Outcome::Delegate;
    };
    let Ok(disabled) = config::read(disabled_text.as_bytes()) else {
        return Outcome::Delegate;
    };
    let view = DiskView(&args.cwd);
    let Some(home) = home() else {
        return Outcome::Delegate;
    };
    let root = backup_root();
    if !within(&disabled, call.entry)
        || root.is_err()
        || registry_needs_refresh(&home, &args.cwd, config_name(&disabled).as_deref())
        || plan_render(&view, &disabled, &args.cwd, &RenderOptions::default()).is_err()
    {
        return Outcome::Delegate;
    }

    let mut fs = RealFs::default();
    let fail = |out: &str, stderr: &str, message: &str| {
        let _ = std::io::stderr().write_all(format!("{stderr}{message}\n").as_bytes());
        let _ = std::io::stdout().write_all(out.as_bytes());
        Outcome::Exit(ExitCode::FAILURE)
    };
    // Phase 1: disabled, then the render that strips the plugin's artifacts.
    if let Err(error) = write_file_atomic(&mut fs, &config_path, &disabled_text) {
        return fail(&out, &stderr, &error.message);
    }
    stderr.push_str(&warnings(&disabled));
    let mut backups = BackupStore::new(root, std::process::id());
    let now = local_now();
    let mut apply = Apply {
        fs: &mut fs,
        backups: &mut backups,
        now: &now,
    };
    match run_render(
        &view,
        &disabled,
        &args.cwd,
        &RenderOptions::default(),
        Some(&mut apply),
    ) {
        Ok(plan) => {
            if let Some(outcome @ (HarnessRecord::NonCanonical | HarnessRecord::Unreadable)) =
                plan.applied.as_ref().and_then(|a| a.harness.as_ref())
            {
                stderr.push_str(&i18n::harness_version_not_recorded(outcome.as_str()));
                stderr.push('\n');
            }
        }
        Err(error) => {
            out.push_str(&clack.error(&error.message()));
            out.push_str(&clack.outro(i18n::remove_render_crashed(lang)));
            let _ = std::io::stderr().write_all(stderr.as_bytes());
            let _ = std::io::stdout().write_all(out.as_bytes());
            return Outcome::Exit(ExitCode::FAILURE);
        }
    }

    // Phase 2: drop the key, over the file the render may have restamped.
    let after = std::fs::read_to_string(&config_path).unwrap_or_default();
    let Ok(pruned) = prune(&after, id) else {
        return fail(
            &out,
            &stderr,
            "navori.config.json: cannot drop the plugin entry",
        );
    };
    if let Err(error) = write_file_atomic(&mut fs, &config_path, &pruned) {
        return fail(&out, &stderr, &error.message);
    }
    out.push_str(&clack.success(&i18n::remove_removed(lang, id)));
    out.push_str(&clack.outro(i18n::remove_done(lang)));
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    let _ = std::io::stdout().write_all(out.as_bytes());
    Outcome::Exit(ExitCode::SUCCESS)
}
