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

use navori_core::plan::gate::{Context, Outcome, evaluate};

use crate::delegate;

/// Runs `plan gate`, or `None` to hand an unexpected argv to the TS untouched.
#[must_use]
pub fn run(args: &[OsString]) -> Option<ExitCode> {
    if args.len() != 2 {
        return None;
    }
    let mut stdin = Vec::new();
    if std::io::stdin().read_to_end(&mut stdin).is_err() {
        return Some(delegate::run_with_stdin(args, "plan", &stdin));
    }
    let Ok(process_cwd) = std::env::current_dir() else {
        return Some(delegate::run_with_stdin(args, "plan", &stdin));
    };
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
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
    let decision = evaluate(&stdin, codex, &ctx);
    let code = match decision.outcome {
        Outcome::Delegate(_) => return Some(delegate::run_with_stdin(args, "plan", &stdin)),
        Outcome::Allow => 0,
        Outcome::Deny(_) => 2,
    };
    for line in &decision.warnings {
        eprintln!("{line}");
    }
    if let Outcome::Deny(reason) = decision.outcome {
        eprintln!("[navori] BLOCKED by plan-gate: {reason}");
    }
    Some(ExitCode::from(code))
}
