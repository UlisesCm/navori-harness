//! The version notices of the native CLI (spec 0062 T9, R85).
//!
//! While the migration is open they stay off (Q6 of 0058): the TS prints its own notice whenever
//! it runs, and the oracle compares both CLIs without them. The cutover (T11) flips [`ENABLED`],
//! which turns on, in `index.ts`'s order, the two private workers and then the update notice
//! before every command but `gate`. Both CLIs share `~/.navori/update-notice`, so a notice Rust
//! printed is stamped and a delegated TS run does not repeat it.

use std::ffi::OsString;
use std::io::{IsTerminal as _, Write as _};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, ExitCode, Stdio};
use std::time::Instant;

use navori_core::http::CurlClient;
use navori_core::process::RealRunner;
use navori_core::tools::cache::now_ms;
use navori_core::tools::notice::{self, Plugins};
use navori_core::tools::update_notice;

/// R85: off until the cutover.
pub const ENABLED: bool = false;

/// The binary a reserved refresh runs: this one once the notices are native, the TS on `PATH`
/// before.
pub(crate) fn spawn_worker(flag: &str, token: &str) {
    let program = if ENABLED {
        std::env::current_exe().map_or_else(|_| OsString::from("navori"), OsString::from)
    } else {
        OsString::from("navori")
    };
    let _ = Command::new(program)
        .args([flag, token])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
}

fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// `navori <worker flag> <token>`: the native worker, always exit 0 like the TS's. `None` for any
/// other argv, or while the notices are off (the TS answers it).
#[must_use]
pub fn worker(args: &[OsString]) -> Option<ExitCode> {
    if !ENABLED {
        return None;
    }
    let flag = args.first()?.to_str()?;
    let token = args.get(1).and_then(|t| t.to_str());
    let env = process_env();
    let cwd = std::env::current_dir().ok()?;
    let runner = RealRunner;
    let http = CurlClient {
        runner: &runner,
        env: &env,
        cwd: &cwd,
    };
    match flag {
        update_notice::WORKER_ARG => update_notice::run_update_worker(&env, token, &http, &now_ms),
        notice::WORKER_ARG => {
            let started = Instant::now();
            notice::run_tool_version_worker(
                &env,
                token,
                &http,
                &mut Plugins::default(),
                &now_ms,
                &|| started.elapsed(),
            );
        }
        _ => return None,
    }
    Some(ExitCode::SUCCESS)
}

/// `runUpdateNotice(version, argv)` before a command (never before `gate`, as in the TS). Writes
/// the notice on stderr; silent on any failure.
pub fn before_command(args: &[OsString]) {
    if !ENABLED || args.first().is_some_and(|a| a == "gate") {
        return;
    }
    let Some(argv) = args.iter().map(|a| a.to_str()).collect::<Option<Vec<_>>>() else {
        return;
    };
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let text = update_notice::run_update_notice(
        &process_env(),
        &cwd,
        navori_core::STAMP_VERSION,
        &argv,
        std::io::stdout().is_terminal(),
        std::io::stderr().is_terminal(),
        now_ms(),
        &spawn_worker,
    );
    if let Some(text) = text {
        let _ = std::io::stderr().write_all(text.as_bytes());
    }
}
