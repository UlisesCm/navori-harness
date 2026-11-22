//! `navori gate foreign [--cwd <toplevel>]`, native (#1097): runs the destination repo's
//! `qualityGate.fast` for the `quality-gate-pre-commit` hook, which reads only the exit code and
//! the first stdout line. The decision lives in [`navori_core::gate::run`]; this file is argv,
//! environment and output. Anything citty might read differently, or that Rust does not model,
//! returns `None` before the first byte and the invocation goes to the TS.

use std::ffi::OsString;
use std::io::Write as _;
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::gate::run::{FOREIGN_REFUSED_EXIT, Prepared, now, prepare_foreign, run_foreign};
use navori_core::process::RealRunner;

/// The value of `--cwd`, if given; `None` (outer) for any shape whose citty reading is not certain.
fn parse(rest: &[OsString]) -> Option<Option<OsString>> {
    let mut cwd = None;
    let mut parser = lexopt::Parser::from_args(rest.iter().cloned());
    while let Some(arg) = parser.next().ok()? {
        match arg {
            Arg::Long("cwd") if cwd.is_none() => {
                let value = parser.value().ok()?;
                let text = value.as_encoded_bytes();
                if text.is_empty() || text.starts_with(b"-") {
                    return None;
                }
                cwd = Some(value);
            }
            _ => return None,
        }
    }
    Some(cwd)
}

/// Runs `args` (`gate foreign …`), or `None` to hand them to the TS.
pub fn run(call: &crate::NativeCall<'_>) -> crate::Outcome {
    crate::outcome(run_args(call.args))
}

fn exit(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn run_args(args: &[OsString]) -> Option<ExitCode> {
    let cwd = parse(args.get(2..)?)?;
    let process_cwd = std::env::current_dir()
        .ok()?
        .into_os_string()
        .into_string()
        .ok()?;
    let cwd_arg = match cwd {
        Some(value) => value.into_string().ok()?,
        None => process_cwd.clone(),
    };
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    match prepare_foreign(&env, &process_cwd, &cwd_arg, now(), &RealRunner) {
        Prepared::Delegate(_) => None,
        Prepared::Refuse { warnings, message } => {
            let mut text = String::new();
            for line in warnings.iter().chain([&message]) {
                text.push_str(line);
                text.push('\n');
            }
            let _ = std::io::stderr().write_all(text.as_bytes());
            Some(exit(FOREIGN_REFUSED_EXIT))
        }
        Prepared::Ready {
            warnings,
            gate,
            top,
            log,
        } => {
            if !warnings.is_empty() {
                let text: String = warnings.iter().map(|line| format!("{line}\n")).collect();
                let _ = std::io::stderr().write_all(text.as_bytes());
            }
            let verdict = run_foreign(&gate, &top, log, &env);
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(format!("{}\n", verdict.stdout).as_bytes());
            let _ = stdout.flush();
            Some(exit(verdict.exit_code))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse;
    use std::ffi::OsString;

    fn argv(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn reads_only_cwd_the_way_citty_does() {
        assert_eq!(parse(&argv(&[])), Some(None));
        assert_eq!(parse(&argv(&["--cwd", "x"])), Some(Some("x".into())));
        assert_eq!(parse(&argv(&["--cwd=y"])), Some(Some("y".into())));
        for delegated in [
            &["extra"][..],
            &["--cwd"],
            &["--cwd", "--force"],
            &["--cwd="],
            &["--cwd", "a", "--cwd", "b"],
            &["--force"],
            &["--index"],
            &["-c"],
        ] {
            assert_eq!(parse(&argv(delegated)), None, "{delegated:?}");
        }
    }
}
