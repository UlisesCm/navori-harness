//! Embeds `packages/core/core-assets/` and `packages/plugins/*/` as a sorted
//! `include_bytes!` table (the same roots as `bundled-assets.ts`), and exports the TS CLI version
//! as `NAVORI_TS_CLI_VERSION` (spec 0058 D20).

use std::error::Error;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

type BuildResult<T> = Result<T, Box<dyn Error>>;

/// Collects every regular file under `dir` and emits `rerun-if-changed` for each directory.
fn walk(dir: &Path, files: &mut Vec<PathBuf>) -> BuildResult<()> {
    println!("cargo::rerun-if-changed={}", dir.display());
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(&path, files)?;
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

/// `version` of `packages/cli/package.json`, with the same `name === "navori"` check as
/// `readCliVersion`.
fn ts_cli_version(repo: &Path) -> BuildResult<String> {
    let path = repo.join("packages/cli/package.json");
    println!("cargo::rerun-if-changed={}", path.display());
    let package: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    if package["name"].as_str() != Some("navori") {
        return Err(format!("{} is not the navori package", path.display()).into());
    }
    match package["version"].as_str() {
        Some(version) if !version.is_empty() => Ok(version.to_owned()),
        _ => Err(format!("{} has no version", path.display()).into()),
    }
}

fn main() -> BuildResult<()> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let repo = manifest_dir.join("..").join("..").canonicalize()?;
    println!(
        "cargo::rustc-env=NAVORI_TS_CLI_VERSION={}",
        ts_cli_version(&repo)?
    );

    let mut roots = vec![repo.join("packages/core/core-assets")];
    let plugins = repo.join("packages/plugins");
    println!("cargo::rerun-if-changed={}", plugins.display());
    for entry in fs::read_dir(&plugins)? {
        let path = entry?.path();
        if path.is_dir() {
            roots.push(path);
        }
    }

    let mut files = Vec::new();
    for root in &roots {
        walk(root, &mut files)?;
    }
    files.sort();

    let mut table = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    for file in &files {
        let rel = file
            .strip_prefix(&repo)?
            .to_str()
            .ok_or("non-UTF-8 asset path")?;
        let abs = file.to_str().ok_or("non-UTF-8 asset path")?;
        writeln!(table, "    ({rel:?}, include_bytes!({abs:?})),")?;
    }
    table.push_str("];\n");

    let out = PathBuf::from(std::env::var("OUT_DIR")?).join("assets.rs");
    fs::write(out, table)?;
    Ok(())
}
