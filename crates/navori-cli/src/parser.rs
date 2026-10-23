//! Minimal citty-compatible argument parser on `lexopt` (D2).
//!
//! It extracts what the manifest needs to select an invocation (D3): the command path and the
//! set of normalized flag names. Values are never interpreted here; a command that is ported
//! parses its own arguments with the same table.

use std::collections::BTreeSet;
use std::ffi::OsString;

use lexopt::Arg;

/// What the manifest sees of an argv.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Invocation {
    /// Positionals before the first option (`spec check`), or `--version` / `--help` when that is
    /// the sole argument (citty answers them only then).
    pub path: Vec<String>,
    /// Option names with dashes stripped and `--no-x` folded into `x`.
    pub flags: BTreeSet<String>,
}

/// Normalizes a long option name the way the manifest stores it (D4).
fn normalize(name: &str) -> String {
    name.strip_prefix("no-").unwrap_or(name).to_owned()
}

/// Parses `args` (without the program name).
///
/// An argv that `lexopt` rejects yields an empty path, which never matches the manifest and is
/// therefore delegated.
#[must_use]
pub fn parse(args: &[OsString]) -> Invocation {
    if let [only] = args {
        match only.to_str() {
            Some("--version") => return sole("--version"),
            Some("--help" | "-h") => return sole("--help"),
            _ => {}
        }
    }

    let mut invocation = Invocation::default();
    let mut parser = lexopt::Parser::from_args(args.iter().cloned());
    let mut in_path = true;
    loop {
        match parser.next() {
            Ok(Some(Arg::Value(value))) => {
                if in_path {
                    invocation.path.push(value.to_string_lossy().into_owned());
                }
            }
            Ok(Some(Arg::Short(c))) => {
                in_path = false;
                invocation.flags.insert(c.to_string());
            }
            Ok(Some(Arg::Long(name))) => {
                in_path = false;
                invocation.flags.insert(normalize(name));
                // `--key=value`: the value is not part of the selection.
                let _ = parser.optional_value();
            }
            Ok(None) => return invocation,
            Err(_) => return Invocation::default(),
        }
    }
}

fn sole(token: &str) -> Invocation {
    Invocation {
        path: vec![token.to_owned()],
        flags: BTreeSet::new(),
    }
}
