//! Native `remove` (spec 0058 T30, R48): only `--yes` runs are native, so none reaches the
//! confirmation prompt.

use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use navori_cli::remove::parse_args;
use navori_cli::{dispatch, parser};
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

// Covers: R48
#[test]
fn only_a_confirmed_remove_is_native() -> TestResult {
    let manifest = Manifest::embedded()?;
    let selected = |args: &[&str]| dispatch(&manifest, &parser::parse(&argv(args))).map(|(_, e)| e);
    assert!(selected(&["remove", "tgrep"]).is_none());
    assert!(selected(&["remove", "tgrep", "--cwd", "x"]).is_none());
    let entry = selected(&["remove", "tgrep", "--yes"]).ok_or("entry")?;
    let base = Path::new("/repo");
    let parsed = |args: &[&str]| parse_args(&argv(args), entry, base);
    let args = parsed(&["remove", "--yes", "tgrep", "--cwd", "sub"]).ok_or("parse")?;
    assert_eq!(args.plugin, "tgrep");
    assert_eq!(args.cwd, PathBuf::from("/repo/sub"));
    for args in [
        &["remove", "tgrep"][..],
        &["remove", "--yes"],
        &["remove", "a", "b", "--yes"],
        &["remove", "tgrep", "--yes=1"],
        &["remove", "tgrep", "--yes", "--yes"],
        &["remove", "tgrep", "-y"],
        &["remove", "--", "tgrep", "--yes"],
    ] {
        assert!(parsed(args).is_none(), "{args:?}");
    }
    Ok(())
}
