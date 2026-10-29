//! `navori gate probe [--index|--clean] [--cwd <dir>]`, native (spec 0059 D33, R56).
//!
//! Exit 0 on a cached green `fast` (or covering `full`) for these bytes, 1 otherwise; it never
//! runs the chain and writes nothing. The only output is the advisory config warnings
//! `readConfig` prints on stderr. Whatever Rust cannot reproduce exactly — an argv citty might
//! read differently, a config or record [`js_json`](navori_core::js_json) does not model —
//! returns `None` before any output, and the invocation goes to the TS.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::config;
use navori_core::gate::cache::{self, Commands, Context, GATE_DIR, Probe, ProbeMode};
use navori_core::js_json::JsValue;
use navori_core::process::Env;
use navori_core::state_root::{checkout_root, contained_dir};

/// What the TS command reads from the flags.
#[derive(Debug, Default, PartialEq, Eq)]
struct Options {
    index: bool,
    clean: bool,
    cwd: Option<OsString>,
}

impl Options {
    fn mode(&self) -> ProbeMode {
        if self.clean {
            ProbeMode::Clean
        } else if self.index {
            ProbeMode::Index
        } else {
            ProbeMode::Working
        }
    }
}

/// Flags after `gate probe`; `None` for any shape whose citty reading is not certain.
fn parse(rest: &[OsString]) -> Option<Options> {
    let mut options = Options::default();
    let mut parser = lexopt::Parser::from_args(rest.iter().cloned());
    while let Some(arg) = parser.next().ok()? {
        let name = match arg {
            Arg::Long(name) => name.to_owned(),
            _ => return None,
        };
        match name.as_str() {
            "index" | "clean" => {
                if parser.optional_value().is_some() {
                    return None;
                }
                if name == "index" {
                    options.index = true;
                } else {
                    options.clean = true;
                }
            }
            "cwd" if options.cwd.is_none() => {
                let value = parser.value().ok()?;
                let text = value.as_encoded_bytes();
                if text.is_empty() || text.starts_with(b"-") {
                    return None;
                }
                options.cwd = Some(value);
            }
            _ => return None,
        }
    }
    Some(options)
}

/// `qualityGate.<kind>` of the parsed config; `Err` for a string Rust would re-encode.
fn command(data: &JsValue, kind: &str) -> Result<Option<String>, ()> {
    let JsValue::Object(root) = data else {
        return Ok(None);
    };
    let Some(JsValue::Object(gate)) = root.get("qualityGate") else {
        return Ok(None);
    };
    match gate.get(kind) {
        Some(JsValue::String(text)) => text.to_rust().map(Some).ok_or(()),
        _ => Ok(None),
    }
}

/// Exit code and stderr lines, or `None` to delegate.
fn probe(cwd: &Path, process_cwd: &Path, env: &Env, mode: ProbeMode) -> Option<(u8, Vec<String>)> {
    let miss = Some((1, Vec::new()));
    let Ok(repo) = checkout_root(cwd, process_cwd, env) else {
        return miss;
    };
    if contained_dir(&repo, GATE_DIR).is_err() {
        return miss;
    }
    let Ok(bytes) = fs::read(repo.join("navori.config.json")) else {
        return miss;
    };
    let config = config::read(&bytes).ok()?;
    let commands = Commands {
        fast: command(&config.data, "fast").ok()?,
        full: command(&config.data, "full").ok()?,
    };
    let ctx = Context {
        repo: &repo,
        process_cwd,
        env,
    };
    let code = match cache::probe_green(mode, &commands, &ctx) {
        Probe::Hit => 0,
        Probe::Miss => 1,
        Probe::Delegate => return None,
    };
    Some((code, config.warnings))
}

/// Runs `args` (`gate probe …`), or `None` to hand them to the TS.
#[must_use]
pub fn run(args: &[OsString]) -> Option<ExitCode> {
    let options = parse(args.get(2..)?)?;
    let process_cwd = std::env::current_dir().ok()?;
    let env = cache::probe_env(std::env::vars_os());
    let cwd = options
        .cwd
        .as_ref()
        .map_or_else(|| process_cwd.clone(), PathBuf::from);
    let (code, warnings) = probe(&cwd, &process_cwd, &env, options.mode())?;
    for line in warnings {
        eprintln!("{line}");
    }
    Some(ExitCode::from(code))
}

#[cfg(test)]
mod tests {
    use super::{Options, parse};
    use std::ffi::OsString;

    fn argv(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    // Covers: R56
    #[test]
    fn reads_only_the_flags_citty_reads_the_same_way() {
        assert_eq!(parse(&argv(&[])), Some(Options::default()));
        let both = parse(&argv(&["--index", "--clean", "--cwd", "x"]));
        assert_eq!(
            both,
            Some(Options {
                index: true,
                clean: true,
                cwd: Some("x".into()),
            })
        );
        assert_eq!(
            parse(&argv(&["--cwd=y"])).and_then(|o| o.cwd),
            Some("y".into())
        );
        for delegated in [
            &["extra"][..],
            &["--clean=false"],
            &["--no-clean"],
            &["--cwd"],
            &["--cwd", "--clean"],
            &["--cwd="],
            &["--cwd", "a", "--cwd", "b"],
            &["-c"],
            &["--force"],
        ] {
            assert_eq!(parse(&argv(delegated)), None, "{delegated:?}");
        }
    }
}
