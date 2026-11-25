//! The workspace lint table must reject `unwrap` in production code, and accept clean code
//! (which also proves `-D warnings` sees no unknown lint name in the table).

use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const ROOT_MANIFEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml");

/// Returns the `[workspace.lints.*]` tables of the root manifest, renamed to `[lints.*]`.
fn lint_tables() -> Result<String, Box<dyn Error>> {
    let text = std::fs::read_to_string(ROOT_MANIFEST)?;
    let mut out = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with('[') {
            inside = line.starts_with("[workspace.lints.");
        }
        if inside {
            out.push_str(&line.replacen("[workspace.lints.", "[lints.", 1));
            out.push('\n');
        }
    }
    if out.is_empty() {
        return Err("no [workspace.lints.*] tables in the root Cargo.toml".into());
    }
    Ok(out)
}

/// Writes a standalone crate carrying the workspace lints and runs clippy on it.
fn clippy_on(name: &str, lib_rs: &str) -> Result<Output, Box<dyn Error>> {
    let dir: PathBuf = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::create_dir_all(dir.join("src"))?;
    let manifest = format!(
        "[package]\nname = \"{name}\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[workspace]\n\n{}",
        lint_tables()?
    );
    std::fs::write(dir.join("Cargo.toml"), manifest)?;
    std::fs::write(dir.join("src/lib.rs"), lib_rs)?;
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    Ok(Command::new(cargo)
        .args(["clippy", "--offline", "--manifest-path"])
        .arg(dir.join("Cargo.toml"))
        .args(["--", "-D", "warnings"])
        .output()?)
}

// Covers: R16
#[test]
fn unwrap_in_production_code_fails_clippy() -> Result<(), Box<dyn Error>> {
    let out = clippy_on(
        "lints_unwrap_probe",
        "/// Probe.\npub fn f(x: Option<u8>) -> u8 {\n    x.unwrap()\n}\n",
    )?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "clippy accepted an unwrap:\n{stderr}"
    );
    assert!(
        stderr.contains("unwrap_used"),
        "unexpected failure:\n{stderr}"
    );
    Ok(())
}

// Covers: R16
#[test]
fn clean_code_passes_clippy_with_the_workspace_lints() -> Result<(), Box<dyn Error>> {
    let out = clippy_on(
        "lints_clean_probe",
        "/// Probe.\npub fn f(x: Option<u8>) -> u8 {\n    x.unwrap_or(0)\n}\n",
    )?;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}
