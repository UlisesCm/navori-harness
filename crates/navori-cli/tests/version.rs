//! `--version` prints the cargo workspace version in citty's format (`meta.version` plus a newline).

use std::error::Error;
use std::process::Command;

fn run_version() -> Result<std::process::Output, Box<dyn Error>> {
    Ok(Command::new(env!("CARGO_BIN_EXE_navori-rust"))
        .arg("--version")
        .output()?)
}

// Covers: R25, R17
#[test]
fn version_reports_the_workspace_version() -> Result<(), Box<dyn Error>> {
    let out = run_version()?;
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout)?,
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(out.stderr.is_empty());
    Ok(())
}

// Covers: R25
#[test]
fn version_is_the_plain_release_semver_of_packages_cli() -> Result<(), Box<dyn Error>> {
    let version = env!("CARGO_PKG_VERSION");
    let parts: Vec<&str> = version.split('.').collect();
    assert!(
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        "not a plain release semver: {version}"
    );
    let manifest = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/cli/package.json"
    ))?;
    assert!(
        manifest.contains(&format!("\"version\": \"{version}\"")),
        "packages/cli version differs from {version}"
    );
    Ok(())
}

// Covers: R17
#[test]
fn embedded_assets_table_is_populated() {
    assert!(
        navori_core::assets::ASSETS
            .iter()
            .any(|(p, b)| p.starts_with("packages/core/core-assets/") && !b.is_empty())
    );
    assert!(
        navori_core::assets::ASSETS
            .iter()
            .any(|(p, _)| p.starts_with("packages/plugins/"))
    );
}
