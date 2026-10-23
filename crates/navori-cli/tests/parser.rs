//! citty-compatible parsing and help (D2), checked against `cli-surface.golden.json`.

use std::collections::BTreeSet;
use std::error::Error;
use std::ffi::OsString;
use std::process::Command;

use navori_cli::parser::parse;

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/cli/src/__tests__/fixtures/cli-surface.golden.json"
);

fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

fn flags(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

/// The golden `--help` stdout with the TS version swapped for the one of this binary.
fn golden_root_help() -> Result<String, Box<dyn Error>> {
    let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN)?)?;
    let case = golden["cases"]
        .as_array()
        .and_then(|cases| {
            cases
                .iter()
                .find(|c| c["args"] == serde_json::json!(["--help"]))
        })
        .ok_or("no --help case in the golden file")?;
    let stdout = case["stdout"]
        .as_str()
        .ok_or("--help case without stdout")?;
    let (head, tail) = stdout
        .split_once(" (navori v")
        .ok_or("unexpected golden help header")?;
    let (_ts_version, rest) = tail
        .split_once(')')
        .ok_or("unexpected golden help header")?;
    Ok(format!("{head} (navori v{}){rest}", navori_core::VERSION))
}

// Covers: R5
#[test]
fn root_help_matches_cli_surface_golden() -> Result<(), Box<dyn Error>> {
    let expected = golden_root_help()?;
    assert_eq!(navori_cli::help::root_help(navori_core::VERSION), expected);

    let out = Command::new(env!("CARGO_BIN_EXE_navori-rust"))
        .arg("--help")
        .output()?;
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout)?, expected);
    assert!(out.stderr.is_empty());
    Ok(())
}

// Covers: R5
#[test]
fn version_and_help_are_selected_only_as_the_sole_argument() {
    assert_eq!(parse(&os(&["--version"])).path, ["--version"]);
    assert_eq!(parse(&os(&["--help"])).path, ["--help"]);
    assert_eq!(parse(&os(&["-h"])).path, ["--help"]);
    let with_other = parse(&os(&["--version", "x"]));
    assert!(with_other.path.is_empty());
    assert_eq!(with_other.flags, flags(&["version"]));
}

// Covers: R5
#[test]
fn extracts_path_and_normalized_flags() {
    let inv = parse(&os(&[
        "spec",
        "check",
        "--json",
        "--no-color",
        "--engine=claude",
        "-v",
        "extra",
    ]));
    assert_eq!(inv.path, ["spec", "check"]);
    assert_eq!(inv.flags, flags(&["json", "color", "engine", "v"]));
}

// Covers: R5
#[test]
fn a_value_after_an_option_never_extends_the_path() {
    let inv = parse(&os(&["render", "--engine", "claude", "sync"]));
    assert_eq!(inv.path, ["render"]);
    assert_eq!(inv.flags, flags(&["engine"]));
}

// Covers: R5
#[test]
fn empty_argv_has_an_empty_invocation() {
    let inv = parse(&[]);
    assert!(inv.path.is_empty() && inv.flags.is_empty());
}
