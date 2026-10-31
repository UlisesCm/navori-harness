//! Spec 0060 T9 (R72): the in-process lane of master-plan-context answers what
//! `navori master status --line` answers from the same directory.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A copy of an oracle fixture: `<name>.fixture` lands as `<name>`, `oracle.json` stays out.
fn copy_fixture(from: &Path, to: &Path) -> TestResult {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "fixture name")?;
        if name == "oracle.json" {
            continue;
        }
        let target = to.join(name.strip_suffix(".fixture").unwrap_or(&name));
        if entry.file_type()?.is_dir() {
            copy_fixture(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn fixture(name: &str) -> Result<Temp, Box<dyn Error>> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "navori-mpc-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/js/rust-oracle/fixtures")
        .join(name);
    copy_fixture(&source, &dir)?;
    let canonical = fs::canonicalize(&dir)?;
    Ok(Temp(canonical))
}

// Covers: R72
#[test]
fn the_in_process_status_line_is_the_native_command() -> TestResult {
    for name in [
        "master-legacy",
        "master-closed",
        "master-active",
        "fresh-init",
    ] {
        let temp = fixture(name)?;
        let native = Command::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(["master", "status", "--line"])
            .current_dir(&temp.0)
            // A delegation would reach this missing TS and fail loudly, never match.
            .env("NAVORI_TS_CLI", temp.0.join("missing-ts-cli.js"))
            .env("NO_COLOR", "1")
            .output()?;
        let in_process = navori_cli::master::status_line(&temp.0);
        match in_process {
            Some((code, stdout)) => {
                assert_eq!(Some(i32::from(code)), native.status.code(), "{name}");
                assert_eq!(stdout.as_bytes(), native.stdout.as_slice(), "{name}");
            }
            None => assert!(
                !native.status.success() || native.stdout.is_empty(),
                "{name}: the in-process lane deferred a call the native command answered"
            ),
        }
    }
    // An active legacy stage prints its line; none exits 1 with no line.
    let legacy = fixture("master-legacy")?;
    let (code, line) = navori_cli::master::status_line(&legacy.0).ok_or("legacy deferred")?;
    assert_eq!(code, 0);
    assert!(line.starts_with("Plan maestro"), "{line}");
    let closed = fixture("master-closed")?;
    assert_eq!(
        navori_cli::master::status_line(&closed.0),
        Some((1, String::new()))
    );
    Ok(())
}
