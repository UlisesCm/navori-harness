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
fn version_has_the_form_0_13_0_rust_n() {
    let rest = env!("CARGO_PKG_VERSION").strip_prefix("0.13.0-rust.");
    assert!(
        rest.is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        "unexpected version {}",
        env!("CARGO_PKG_VERSION")
    );
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
