//! Compiles the same source hashes as scripts/js/rust-manifest-check.mjs (0057 D8).

mod build_support;

use std::error::Error;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let crate_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").ok_or("manifest directory")?);
    let sources = build_support::Sources::read(&crate_dir.join("src"))?;
    // Directory watches detect new files/hooks; file watches also detect edits and removals.
    for path in sources.watched_paths() {
        println!("cargo::rerun-if-changed={}", path.display());
    }
    let output = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("output directory")?);
    fs::write(output.join("implementation_hashes.rs"), sources.table()?)?;
    Ok(())
}
