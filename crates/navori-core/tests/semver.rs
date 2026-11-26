//! `semver.ts` ordering and the stamp version (spec 0058 T7).

use std::cmp::Ordering;
use std::error::Error;
use std::fs;
use std::path::Path;

use navori_core::semver::{compare, is_downgrade, parse};
use navori_core::{STAMP_VERSION, VERSION};

// Covers: R38
#[test]
fn rust_prerelease_orders_as_its_core_and_the_stamp_is_the_release_version()
-> Result<(), Box<dyn Error>> {
    // The hazard D20 exists for: the workspace prerelease is "newer" than the TS CLI.
    assert_eq!(
        compare(Some("0.13.0-rust.1"), Some("0.13.0")),
        Some(Ordering::Equal)
    );
    assert!(is_downgrade(Some("0.13.0-rust.1"), Some("0.12.2")));

    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/cli/package.json");
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&package)?)?;
    assert_eq!(Some(STAMP_VERSION), json["version"].as_str());
    // From 0.13.0 on (D20 amended, decision of 23 Nov): the binary answers `--version` with VERSION
    // and the hooks run ported subcommands in process only when it is the stamp, so a release
    // carries one number in both (`check-pin` checks it again before publishing).
    assert_eq!(
        STAMP_VERSION, VERSION,
        "Cargo.toml and packages/cli/package.json must carry the same release version"
    );
    Ok(())
}

// Covers: R37
#[test]
fn unparseable_or_absent_versions_are_never_a_downgrade() {
    for bad in [
        "", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "1.-2.3", "١.2.3", "1..3",
    ] {
        assert_eq!(parse(bad), None, "{bad:?}");
        assert!(!is_downgrade(Some(bad), Some("0.0.1")), "{bad:?}");
        assert!(!is_downgrade(Some("9.9.9"), Some(bad)), "{bad:?}");
    }
    assert!(!is_downgrade(None, Some("1.0.0")));
    assert!(!is_downgrade(Some("1.0.0"), None));
}

// Covers: R37
#[test]
fn trims_js_whitespace_and_drops_build_and_prerelease() {
    assert!(parse("\u{feff} 1.2.3+build \u{3000}").is_some());
    assert!(parse("\u{85}1.2.3").is_none(), "NEL is not JS whitespace");
    assert_eq!(
        compare(Some("1.10.0"), Some("1.9.9")),
        Some(Ordering::Greater)
    );
    assert_eq!(
        compare(Some("01.2.3"), Some("1.2.3")),
        Some(Ordering::Equal)
    );
    assert_eq!(
        compare(Some("1.2.3"), Some("1.2.4-rc.1")),
        Some(Ordering::Less)
    );
}
