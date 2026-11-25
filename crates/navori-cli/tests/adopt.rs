//! Native `adopt` (spec 0058 T26): what runs natively and what is handed to the TS (R39).
//! `ENTRY` is the entry `crates/ported.json` lists.

use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use navori_cli::adopt::{AdoptArgs, parse_args};
use navori_cli::{dispatch, parser};
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

const ENTRY: &str = r#"{"schema":2,"commands":[{"path":["adopt"],"flags":["apply","cwd"]}]}"#;

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

// Covers: R14, R39
#[test]
fn one_positional_and_the_declared_flags_are_native() -> TestResult {
    let manifest = Manifest::parse(ENTRY)?;
    let entry = manifest.commands.first().ok_or("entry")?;
    let base = Path::new("/repo");
    let parsed = |args: &[&str]| parse_args(&argv(args), entry, base);
    assert_eq!(
        parsed(&["adopt", ".claude/a.md"]),
        Some(AdoptArgs {
            path: ".claude/a.md".to_owned(),
            cwd: base.to_path_buf(),
            apply: false,
        })
    );
    assert_eq!(
        parsed(&["adopt", "--apply", "--cwd", "sub", "x.md"]),
        Some(AdoptArgs {
            path: "x.md".to_owned(),
            cwd: PathBuf::from("/repo/sub"),
            apply: true,
        })
    );
    for args in [
        &["adopt"][..],
        &["adopt", "--apply"],
        &["adopt", "a.md", "b.md"],
        &["adopt", ""],
        &["adopt", "a.md", "--apply=1"],
        &["adopt", "a.md", "--apply", "--apply"],
        &["adopt", "a.md", "--force"],
        &["adopt", "--", "a.md"],
        &["adopt", "-a", "a.md"],
        &["render", "a.md"],
    ] {
        assert_eq!(parsed(args), None, "{args:?}");
    }
    // The embedded manifest lists the same entry.
    let embedded = Manifest::embedded()?;
    let inv = parser::parse(&argv(&["adopt", ".claude/a.md", "--apply"]));
    let (_, selected) = dispatch(&embedded, &inv).ok_or("embedded manifest lacks adopt")?;
    assert_eq!(selected, entry);
    Ok(())
}
