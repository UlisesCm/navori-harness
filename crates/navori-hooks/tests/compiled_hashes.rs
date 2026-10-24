//! D8 compilation hashes checked against the real Node implementation, without hook activation.

#[path = "../build_support.rs"]
mod build_support;

use std::error::Error;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use build_support::Sources;

type TestResult = Result<(), Box<dyn Error>>;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "compiled-hashes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.parent().ok_or("scratch parent")?)?;
        fs::create_dir(&root)?;
        let fixture = Self(root);
        fixture.write("lib.rs", b"pub mod compiled;\n")?;
        fixture.write("hooks/example_hook/handler.rs", b"// hook source\n")?;
        Ok(fixture)
    }

    fn src(&self) -> PathBuf {
        self.0.join("crates/navori-hooks/src")
    }

    fn write(&self, name: &str, bytes: &[u8]) -> TestResult {
        let path = self.src().join(name);
        fs::create_dir_all(path.parent().ok_or("source parent")?)?;
        fs::write(path, bytes)?;
        Ok(())
    }

    fn rust_hash(&self, id: &str) -> Result<String, Box<dyn Error>> {
        Sources::read(&self.src())?.implementation_hash(id)
    }

    fn node_hash(&self, id: &str) -> Result<String, Box<dyn Error>> {
        let module =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/js/rust-manifest-check.mjs");
        let output = Command::new("node")
            .args(["--experimental-transform-types", "--input-type=module", "-e", "const { implementationHash } = await import(process.argv[2]); process.stdout.write(implementationHash(process.argv[3], process.argv[4]));", "hash-probe"])
            .arg(module).arg(&self.0).arg(id).output()?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
        }
        Ok(String::from_utf8(output.stdout)?)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Covers: R13
#[test]
fn exact_binary_bytes_paths_nul_boundaries_and_utf16_order_match_the_real_node_helper() -> TestResult
{
    let fixture = Fixture::new()?;
    fixture.write("shared/\u{e000}.rs", b"\0\xff\r\nBMP\0")?;
    fixture.write("shared/\u{10000}.rs", b"non-BMP\n")?;
    fixture.write("hooks/example_hook/extra.bin", b"\xff\0\n\r\0")?;
    fixture.write("hooks/other_hook/excluded.rs", b"different implementation")?;
    let rust = fixture.rust_hash("example-hook")?;
    assert_eq!(rust, fixture.node_hash("example-hook")?);
    assert_eq!(rust, fixture.rust_hash("example_hook")?);
    assert!(
        Sources::read(&fixture.src())?
            .implementation_hash("../example-hook")
            .is_err()
    );
    assert!(
        Sources::read(&fixture.src())?
            .implementation_hash("missing")
            .is_err()
    );
    assert!(Sources::read(&fixture.src())?.table()?.contains(&rust));
    Ok(())
}

// Covers: R13
#[test]
fn shared_and_local_changes_count_while_other_hook_sources_are_excluded() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write("hooks/other_hook/base.rs", b"original")?;
    let original = fixture.rust_hash("example-hook")?;
    fixture.write("hooks/other_hook/base.rs", b"changed but excluded")?;
    assert_eq!(fixture.rust_hash("example-hook")?, original);
    fixture.write("hooks/example_hook/handler.rs", b"local changed")?;
    let local = fixture.rust_hash("example-hook")?;
    assert_ne!(local, original);
    assert_eq!(local, fixture.node_hash("example-hook")?);
    fixture.write("lib.rs", b"shared changed")?;
    let shared = fixture.rust_hash("example-hook")?;
    assert_ne!(shared, local);
    assert_eq!(shared, fixture.node_hash("example-hook")?);
    fixture.write("renamed.rs", b"local changed")?;
    assert_ne!(fixture.rust_hash("example-hook")?, shared);
    Ok(())
}

// Covers: R13
#[test]
fn symlinks_and_special_files_are_rejected_even_below_an_excluded_hook() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write("hooks/other_hook/base.rs", b"source")?;
    let link = fixture.src().join("hooks/other_hook/link.rs");
    symlink(fixture.src().join("lib.rs"), &link)?;
    assert!(Sources::read(&fixture.src()).is_err());
    assert!(fixture.node_hash("example-hook").is_err());
    fs::remove_file(link)?;
    let socket = fixture.src().join("hooks/other_hook/socket");
    assert!(Command::new("mkfifo").arg(&socket).status()?.success());
    assert!(Sources::read(&fixture.src()).is_err());
    Ok(())
}

// Covers: R13
#[test]
fn directory_watches_cover_empty_nested_directories_and_discovery_without_activation() -> TestResult
{
    let fixture = Fixture::new()?;
    let empty = fixture.src().join("nested/empty");
    fs::create_dir_all(&empty)?;
    let sources = Sources::read(&fixture.src())?;
    let watched: Vec<&Path> = sources.watched_paths().collect();
    assert!(watched.contains(&fixture.src().as_path()));
    assert!(watched.contains(&empty.as_path()));
    assert!(watched.contains(&fixture.src().join("lib.rs").as_path()));
    let table = sources.table()?;
    assert!(table.contains("example_hook"));
    assert!(navori_hooks::compiled::implementation_hash("unregistered-hook").is_none());
    assert!(navori_hooks::compiled::implementation_hash("../invalid").is_none());
    Ok(())
}

/// Exercise Cargo's real incremental directory watches in an isolated target, with cached deps.
fn built_hash(fixture: &Fixture, id: &str) -> Result<String, Box<dyn Error>> {
    let output = Command::new("cargo")
        .args(["run", "--quiet", "--offline", "--manifest-path"])
        .arg(fixture.0.join("crates/navori-hooks/Cargo.toml"))
        .arg("--")
        .arg(id)
        .env("CARGO_TARGET_DIR", fixture.0.join("target"))
        .env("CARGO_BUILD_JOBS", "2")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

// Covers: R13
#[test]
fn compiled_accessor_rebuilds_for_added_removed_and_edited_sources_without_a_hash_cycle()
-> TestResult {
    let fixture = Fixture::new()?;
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    for file in ["build.rs", "build_support.rs"] {
        fs::copy(
            crate_dir.join(file),
            fixture.0.join("crates/navori-hooks").join(file),
        )?;
    }
    fs::copy(
        crate_dir.join("src/compiled.rs"),
        fixture.src().join("compiled.rs"),
    )?;
    fixture.write(
        "main.rs",
        br#"fn main() {
    let id = std::env::args().nth(1).unwrap_or_default();
    print!("{}", hash_fixture::compiled::implementation_hash(&id).unwrap_or("missing"));
}
"#,
    )?;
    let workspace = fs::read_to_string(crate_dir.join("../../Cargo.toml"))?;
    let sha2 = workspace
        .lines()
        .find(|line| line.starts_with("sha2 = "))
        .ok_or("sha2 dependency")?;
    fs::write(
        fixture.0.join("crates/navori-hooks/Cargo.toml"),
        format!(
            "[package]\nname = \"hash-fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n[workspace]\n[build-dependencies]\n{sha2}\n"
        ),
    )?;
    let original = built_hash(&fixture, "example-hook")?;
    assert_eq!(original, fixture.node_hash("example-hook")?);
    assert_eq!(built_hash(&fixture, "example_hook")?, original);
    fixture.write("nested/added.bin", b"\0added\xff")?;
    let added = built_hash(&fixture, "example-hook")?;
    assert_ne!(added, original);
    assert_eq!(added, fixture.node_hash("example-hook")?);
    fs::remove_file(fixture.src().join("nested/added.bin"))?;
    assert_eq!(built_hash(&fixture, "example-hook")?, original);
    fixture.write("hooks/example_hook/handler.rs", b"// edited local source\n")?;
    let edited = built_hash(&fixture, "example-hook")?;
    assert_ne!(edited, original);
    assert_eq!(edited, fixture.node_hash("example-hook")?);
    fixture.write("hooks/new_hook/handler.rs", b"// newly discovered hook\n")?;
    assert_eq!(
        built_hash(&fixture, "new-hook")?,
        fixture.node_hash("new-hook")?
    );
    assert_eq!(built_hash(&fixture, "example-hook")?, edited);
    fs::remove_dir_all(fixture.src().join("hooks/new_hook"))?;
    assert_eq!(built_hash(&fixture, "new-hook")?, "missing");
    assert_eq!(built_hash(&fixture, "example-hook")?, edited);
    Ok(())
}
