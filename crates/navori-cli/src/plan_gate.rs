//! `navori plan gate`, native (spec 0059 D33, R56, R57): reads the `PreToolUse(Agent)` payload
//! from stdin and allows (exit 0) or blocks (exit 2, one stderr line) like `applyPlanGate`.
//!
//! An argv with anything after `plan gate` goes to the TS before stdin is read. Once stdin is
//! read, every branch [`navori_core::plan::gate`] cannot reproduce exactly is handed to the TS
//! with the same bytes, before any output and before the dispatch claim.

use std::ffi::OsString;
use std::io::Read as _;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use navori_core::plan::gate::{Context, audit_identity_in_env, audit_log_present, evaluate};

use crate::delegate;

/// Runs `plan gate`, or `None` to hand an unexpected argv to the TS untouched.
pub fn run(call: &crate::NativeCall<'_>) -> crate::Outcome {
    crate::outcome(run_args(call.args))
}

/// The argv-level implementation of [`run`].
fn run_args(args: &[OsString]) -> Option<ExitCode> {
    if args.len() != 2 {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    // Audit mode (D33, R58): the TS writes the dispatch outcome, so the whole invocation goes to
    // it before stdin is read when the environment names a session and the repo has a log.
    if audit_identity_in_env(&env) && audit_log_present(&process_cwd.to_string_lossy(), &env) {
        return None;
    }
    let mut stdin = Vec::new();
    if std::io::stdin().read_to_end(&mut stdin).is_err() {
        return Some(delegate::run_with_stdin(args, "plan", &stdin));
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let ctx = Context {
        process_cwd: &process_cwd,
        env: &env,
        now_ms: now_ms as f64,
        pid: std::process::id(),
    };
    let codex = std::env::var_os("NAVORI_HOOK_ENGINE").is_some_and(|v| v == "codex");
    let Some((code, stderr)) = evaluate(&stdin, codex, &ctx).report() else {
        return Some(delegate::run_with_stdin(args, "plan", &stdin));
    };
    eprint!("{stderr}");
    Some(ExitCode::from(code))
}
