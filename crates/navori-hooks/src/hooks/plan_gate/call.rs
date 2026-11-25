//! The one effect of plan-gate.sh: `navori plan gate` (spec 0059 D30, R52, R53). It runs in
//! process when the `navori` of `PATH` prints this build's TS version, and otherwise as the
//! shell runs it, through that `navori`. The in-process lane also hands every call it does not
//! reproduce (an audit target, an [`Outcome::Delegate`](navori_core::plan::gate::Outcome)) to
//! the subprocess, before anything is written.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use navori_core::plan::gate::{self as core_gate, audit_identity_in_env, audit_log_present};

use super::Call;
use crate::runner::Failure;
use crate::shell::prepare::env_value;
use crate::shell::subcommand::{self, Capture, Input, substitution};

/// The `navori` the script would run, and the facts that pick the lane.
#[derive(Debug, Clone, Copy)]
pub struct Navori<'a> {
    /// The first executable `navori` along `PATH` from the shell's directory.
    pub program: &'a Path,
    /// First line of that program's `navori --version`, trimmed; `None` when unknown.
    pub version: Option<&'a str>,
    /// The hook's environment, unchanged.
    pub env: &'a [(OsString, OsString)],
    /// The hook's working directory (physical).
    pub cwd: &'a Path,
    /// The shell's `$PWD`.
    pub pwd: &'a OsStr,
}

/// Which lane answered the call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// [`navori_core::plan::gate`] in this process.
    InProcess,
    /// The `navori` of `PATH` as a child process.
    Subprocess,
}

/// `$?` and the merged output of `navori plan gate 2>&1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// The shell's `$?`.
    pub status: i32,
    /// stdout and stderr in write order.
    pub output: Vec<u8>,
    /// The lane that produced it.
    pub lane: Lane,
}

impl Navori<'_> {
    /// Whether this `navori` is the TS CLI this binary was built from (D30).
    #[must_use]
    pub fn same_version(&self) -> bool {
        self.version == Some(navori_core::STAMP_VERSION)
    }

    /// The environment Bash gives the call.
    fn child_env(&self, extra: &[(&str, &OsStr)]) -> Vec<(OsString, OsString)> {
        subcommand::child_env(self.env, self.pwd, None, self.program, extra)
    }

    fn spawn(
        &self,
        args: &[OsString],
        env: &[(OsString, OsString)],
        input: Input<'_>,
        capture: Capture,
    ) -> Result<subcommand::Finished, Failure> {
        subcommand::run(&subcommand::Call {
            program: self.program,
            args,
            cwd: self.cwd,
            env,
            input,
            capture,
            timeout: None,
        })
        .map_err(|error| Failure(format!("navori could not run: {error}")))
    }
}

/// The call in process, `None` when only the TS reproduces it.
fn in_process(navori: &Navori<'_>, call: &Call, env: &[(OsString, OsString)]) -> Option<Answer> {
    let cwd = navori.cwd.to_str()?;
    // R58: the TS writes the dispatch outcome to an armed audit log.
    if audit_identity_in_env(env) && audit_log_present(cwd, env) {
        return None;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let ctx = core_gate::Context {
        process_cwd: navori.cwd,
        env,
        now_ms: now_ms as f64,
        pid: std::process::id(),
    };
    let codex = env_value(env, "NAVORI_HOOK_ENGINE").is_some_and(|v| v == "codex");
    let (code, stderr) = core_gate::evaluate(&call.payload, codex, &ctx).report()?;
    Some(Answer {
        status: i32::from(code),
        output: stderr.into_bytes(),
        lane: Lane::InProcess,
    })
}

/// Run `navori plan gate` for `call`.
///
/// # Errors
/// The subprocess cannot be spawned.
pub fn run(navori: &Navori<'_>, call: &Call) -> Result<Answer, Failure> {
    let codex = OsStr::new("codex");
    let extra: &[(&str, &OsStr)] = if call.codex {
        &[("NAVORI_HOOK_ENGINE", codex)]
    } else {
        &[]
    };
    let env = navori.child_env(extra);
    if navori.same_version()
        && let Some(answer) = in_process(navori, call, &env)
    {
        return Ok(answer);
    }
    let args = [OsString::from("plan"), OsString::from("gate")];
    let finished = navori.spawn(&args, &env, Input::Bytes(&call.payload), Capture::Merged)?;
    Ok(Answer {
        status: finished.status,
        output: finished.stdout,
        lane: Lane::Subprocess,
    })
}

/// `$(navori --version 2>/dev/null </dev/null | head -n 1)` for the stale-CLI hint; in process
/// it is this build's TS version.
///
/// # Errors
/// The subprocess cannot be spawned, or printed a NUL the shell would drop.
pub fn cli_version(navori: &Navori<'_>, lane: Lane) -> Result<String, Failure> {
    if lane == Lane::InProcess {
        return Ok(navori_core::STAMP_VERSION.to_owned());
    }
    let finished = navori.spawn(
        &[OsString::from("--version")],
        &navori.child_env(&[]),
        Input::Null,
        Capture::Separate,
    )?;
    let first = finished
        .stdout
        .split_inclusive(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let line = substitution(first);
    if line.contains(&0) {
        return Err(Failure("navori --version printed a NUL byte".to_owned()));
    }
    String::from_utf8(line.to_vec())
        .map_err(|_| Failure("navori --version is not UTF-8".to_owned()))
}
