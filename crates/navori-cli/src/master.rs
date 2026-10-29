//! `navori master status --json|--line [--cwd <dir>]`, native without an active stage and with an
//! active legacy one (spec 0060 T8, layers 1 and 2; `master::status` lists what still delegates).
//!
//! Read-only, like those two forms in the TS (`commands/master.ts`): `master status` without them
//! regenerates `STATUS.md` and `INDEX.md`, and the manifest entry's `requires` keeps it on the TS.
//! Everything is computed before the first byte of output; whatever is not reproduced yet
//! returns [`Outcome::Delegate`]: an argv citty might read differently, a missing or invalid
//! config, an index `readMasterIndex` would reject, and an active stage (the next layers).

use std::path::Path;

use navori_core::js_json::JsValue;
use navori_core::master::check_part::PartConfig;
use navori_core::master::index::{self, MasterIndex};
use navori_core::master::status;

use crate::help::{ArgDef, ArgKind, CommandDef, Parent};
use crate::js_path::js_resolve;
use crate::native_io::{self, Output, json_line, member, object, read_config};
use crate::{NativeCall, Outcome};

const STATUS: CommandDef = CommandDef {
    name: "status",
    description: "Show or regenerate derived master-plan status",
    args: &[
        ArgDef {
            name: "json",
            kind: ArgKind::Boolean,
            description: "Read-only JSON status",
        },
        ArgDef {
            name: "line",
            kind: ArgKind::Boolean,
            description: "Read-only SessionStart line",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const MASTER_PARENT: Parent<'static> = Parent {
    name: "master",
    version: None,
};

/// The flags of `master status` as citty would read them.
#[derive(Debug, Default, PartialEq, Eq)]
struct StatusOptions<'a> {
    json: bool,
    line: bool,
    cwd: Option<&'a str>,
}

/// `None` for any shape whose citty reading is not certain: positionals, unknown or short
/// options, `--no-*`, `--json=<v>`, a repeated `--cwd`, or a `--cwd` value that looks like one.
fn parse_status<'a>(tokens: &[&'a str]) -> Option<StatusOptions<'a>> {
    let mut options = StatusOptions::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        match token {
            "--json" => options.json = true,
            "--line" => options.line = true,
            _ if token == "--cwd" || token.starts_with("--cwd=") => {
                if options.cwd.is_some() {
                    return None;
                }
                let value = if let Some(inline) = token.strip_prefix("--cwd=") {
                    inline
                } else {
                    let next = *tokens.get(index)?;
                    index += 1;
                    next
                };
                if value.starts_with('-') {
                    return None;
                }
                options.cwd = Some(value);
            }
            _ => return None,
        }
    }
    Some(options)
}

/// `master status`.
#[must_use]
pub fn run_status(call: &NativeCall<'_>) -> Outcome {
    status(call.args).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

fn status(args: &[std::ffi::OsString]) -> Option<Output> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let rest = match argv.as_slice() {
        ["master", "status", rest @ ..] => rest,
        _ => return None,
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&STATUS, MASTER_PARENT, None));
    }
    let options = parse_status(rest)?;
    if options.json && options.line {
        return Some(Output {
            stderr: "--json and --line are mutually exclusive\n".to_owned(),
            code: 1,
            ..Output::default()
        });
    }
    if !options.json && !options.line {
        // `writeMasterStatus`: regenerates the derived files.
        return None;
    }
    let cwd = std::env::current_dir().ok()?;
    let cwd = js_resolve(&[cwd.to_str()?, options.cwd.unwrap_or_default()]);
    // `readMasterStatus` reads the config unconditionally: without one the TS throws.
    let config = read_config(&cwd)??;
    let mut out = Output::default();
    for warning in &config.warnings {
        out.stderr.push_str(warning);
        out.stderr.push('\n');
    }
    let specs_dir = native_io::specs_dir(Some(&config))?;
    let master_dir = js_resolve(&[&cwd, &specs_dir, index::MASTER_DIR_NAME]);
    let index = index::read(Path::new(&master_dir)).ok()?;
    if let Some((index, stage)) = index
        .as_ref()
        .and_then(|i| i.active().map(|stage| (i, stage)))
    {
        let part_config = PartConfig {
            english: matches!(member(Some(&config.data), "language"), Some(JsValue::String(l)) if l.is("en")),
            master_plan: truthy(member(member(Some(&config.data), "harness"), "masterPlan")),
        };
        let legacy = status::legacy(
            &cwd,
            &specs_dir,
            Path::new(&master_dir),
            index,
            stage,
            part_config,
        )
        .ok()?;
        // Each `checkPart` read the config again: its warnings printed once per read.
        for _ in 0..legacy.config_reads {
            for warning in &config.warnings {
                out.stderr.push_str(warning);
                out.stderr.push('\n');
            }
        }
        if options.json {
            json_line(&mut out, &legacy.to_json());
            return Some(out);
        }
        // `--line` reads the config a second time for `specsDir`: its warnings print again.
        let again = read_config(&cwd)??;
        for warning in &again.warnings {
            out.stderr.push_str(warning);
            out.stderr.push('\n');
        }
        out.stdout
            .push_str(&legacy.line(&native_io::specs_dir(Some(&again))?));
        out.stdout.push('\n');
        return Some(out);
    }
    if options.line {
        // No active stage: exit 1 with no line, so the hook falls back to INDEX.md.
        out.code = 1;
        return Some(out);
    }
    json_line(&mut out, &empty_status(index.as_ref()));
    Some(out)
}

/// JS truthiness of a config value.
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => false,
        Some(JsValue::Bool(b)) => *b,
        Some(JsValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(JsValue::String(s)) => !s.units().is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    }
}

/// `readMasterStatus`'s `empty`: no active stage, with the last closed one when there is any.
fn empty_status(index: Option<&MasterIndex>) -> JsValue {
    let last_closed = status::last_closed_json(index.and_then(MasterIndex::last_closed));
    object(vec![
        ("stage", JsValue::Null),
        ("phase", JsValue::Null),
        ("nextPhase", JsValue::Null),
        ("mode", JsValue::Null),
        ("activePart", JsValue::Null),
        ("parts", JsValue::Array(Vec::new())),
        ("discrepancies", JsValue::Array(Vec::new())),
        ("allDone", JsValue::Bool(false)),
        ("closable", JsValue::Bool(false)),
        ("blockers", JsValue::Array(Vec::new())),
        ("evidenceBlockers", JsValue::Array(Vec::new())),
        ("lastClosed", last_closed),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_args_delegate_every_uncertain_shape() {
        assert_eq!(
            parse_status(&["--json", "--cwd=x"]),
            Some(StatusOptions {
                json: true,
                line: false,
                cwd: Some("x")
            })
        );
        for argv in [
            &["--json", "extra"][..],
            &["--no-json"],
            &["--line=true"],
            &["--cwd"],
            &["--cwd", "--json"],
            &["--cwd", "a", "--cwd", "b"],
            &["-j"],
        ] {
            assert_eq!(parse_status(argv), None, "{argv:?}");
        }
    }
}
