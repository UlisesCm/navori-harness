//! `navori tools notice` and `navori tools session-context`, native (spec 0059 D34, R56, R59).
//!
//! The argv shapes citty reads one way only are native; any other goes to the TS before stdin,
//! output or a write. The refresh worker is [`crate::notices::spawn_worker`]: the TS's, on
//! `PATH`, until the cutover turns the native notices on (spec 0062 R85).

use std::ffi::OsString;
use std::io::Write as _;
use std::process::ExitCode;

use navori_core::tools::{Printed, notice::notice_reserve, notice_command, session_context};
use navori_core::workspace::registry::Stop;

use crate::notices::spawn_worker;

fn emit(printed: &Printed) -> ExitCode {
    let mut stderr = std::io::stderr().lock();
    for line in &printed.stderr {
        let _ = writeln!(stderr, "{line}");
    }
    let _ = std::io::stdout()
        .lock()
        .write_all(printed.stdout.as_bytes());
    if printed.failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn context() -> Option<(Vec<(OsString, OsString)>, std::path::PathBuf)> {
    Some((std::env::vars_os().collect(), std::env::current_dir().ok()?))
}

/// A flag value citty reads the same way: not empty and not another flag.
fn plain(value: &OsString) -> Option<&str> {
    value
        .to_str()
        .filter(|v| !v.is_empty() && !v.starts_with('-'))
}

/// `tools notice [--ack <pairs>]`, or `None` for the TS.
pub fn notice(call: &crate::NativeCall<'_>) -> crate::Outcome {
    crate::outcome(notice_args(call.args))
}

/// The argv-level implementation of [`notice`].
fn notice_args(args: &[OsString]) -> Option<ExitCode> {
    let ack = match args {
        [_, _] => None,
        [_, _, flag, value] if flag == "--ack" => Some(plain(value)?),
        _ => return None,
    };
    let (env, cwd) = context()?;
    match notice_command(&env, &cwd, ack, &spawn_worker) {
        Ok(printed) => Some(emit(&printed)),
        Err(Stop::Delegate(_)) => None,
        Err(Stop::Throw) => Some(ExitCode::SUCCESS),
    }
}

/// `tools session-context [--notice-reserve <bytes>]`, or `None` for the TS.
pub fn session_context_command(call: &crate::NativeCall<'_>) -> crate::Outcome {
    crate::outcome(session_context_command_args(call.args))
}

/// The argv-level implementation of [`session_context_command`].
fn session_context_command_args(args: &[OsString]) -> Option<ExitCode> {
    let reserve = match args {
        [_, _] => None,
        [_, _, flag, value] if flag == "--notice-reserve" => Some(notice_reserve(plain(value)?)),
        _ => return None,
    };
    let (env, cwd) = context()?;
    match session_context(&env, &cwd, reserve, &spawn_worker) {
        Ok(printed) => Some(emit(&printed)),
        Err(Stop::Delegate(_)) => None,
        Err(Stop::Throw) => Some(ExitCode::FAILURE),
    }
}
