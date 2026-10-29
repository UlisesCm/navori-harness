//! `navori dominio inject`, native (spec 0059 D34, R56): the Dominio index of the workspace(s)
//! the working directory belongs to, or nothing. Like the TS it never fails: a broken store prints
//! nothing and exits 0. Any argv beyond `dominio inject`, and every branch the port does not model
//! (a legacy layout to migrate, a title order outside the modeled collation), goes to the TS
//! before any output.

use std::ffi::OsString;
use std::io::Write as _;
use std::process::ExitCode;

use navori_core::workspace::dominio::inject_text;
use navori_core::workspace::registry::Stop;

/// Runs `dominio inject`, or `None` to hand it to the TS untouched.
#[must_use]
pub fn run(args: &[OsString]) -> Option<ExitCode> {
    if args.len() != 2 {
        return None;
    }
    let cwd = std::env::current_dir()
        .ok()?
        .into_os_string()
        .into_string()
        .ok()?;
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    match inject_text(&env, &cwd) {
        Ok(text) => {
            // A closed stdout is the TS's unhandled EPIPE too; nothing else is printed.
            let _ = std::io::stdout().lock().write_all(text.as_bytes());
        }
        Err(Stop::Throw) => {}
        Err(Stop::Delegate(_)) => return None,
    }
    Some(ExitCode::SUCCESS)
}
