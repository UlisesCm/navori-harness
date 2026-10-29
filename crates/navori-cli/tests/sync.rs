//! Native `sync` (spec 0058 T29, R48): only the forms that never prompt are native.

use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use navori_cli::sync::parse_args;
use navori_cli::{dispatch, parser};
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

// Covers: R48
#[test]
fn only_a_sync_that_cannot_prompt_is_native() -> TestResult {
    let manifest = Manifest::embedded()?;
    let selected = |args: &[&str]| dispatch(&manifest, &parser::parse(&argv(args))).map(|(_, e)| e);
    // `requires`: a bare sync (or one with only --cwd) would prompt, so it is delegated.
    assert!(selected(&["sync"]).is_none());
    assert!(selected(&["sync", "--cwd", "x"]).is_none());
    for flag in [
        "--apply",
        "--yes",
        "--dry-run",
        "--json",
        "--accept-new",
        "--keep-mine",
    ] {
        assert!(selected(&["sync", flag]).is_some(), "{flag}");
    }
    for flag in ["--interactive", "--workspace"] {
        assert!(selected(&["sync", "--apply", flag]).is_none(), "{flag}");
    }
    let entry = selected(&["sync", "--apply"]).ok_or("entry")?;
    let base = Path::new("/repo");
    let parsed = |args: &[&str]| parse_args(&argv(args), entry, base);
    let args = parsed(&["sync", "--yes", "--keep-mine", "--cwd", "sub"]).ok_or("parse")?;
    assert_eq!(args.cwd, PathBuf::from("/repo/sub"));
    assert!(args.flags.yes && args.flags.keep_mine && !args.flags.apply);
    for args in [
        &["sync", "--accept-new", "--keep-mine"][..],
        &["sync", "--accept-new-files", "--keep-mine"],
        &["sync", "--apply=1"],
        &["sync", "--apply", "--apply"],
        &["sync", "-y"],
        &["sync", "extra"],
    ] {
        assert!(parsed(args).is_none(), "{args:?}");
    }
    Ok(())
}
