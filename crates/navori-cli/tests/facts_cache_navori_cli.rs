//! Host fact `navori_cli` (spec 0059 T3, D30, R53): the `navori` the `PATH` resolves is probed for
//! its version once per binary, and a different binary is probed again.

use navori_cli::facts_cache::{FactsCache, MAX_AGE_MS, navori_cli_key, now_ms};
use navori_cli::hook_facts::{NavoriCli, navori_cli};
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);

impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "navori-cli-fact-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".navori/state"))?;
        Ok(Self(fs::canonicalize(root)?))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// An executable `navori` that appends a line to `counter` on every call and prints `lines`.
fn fake_navori(directory: &Path, counter: &Path, lines: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = directory.join("navori");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\necho probe >> '{}'\nprintf '%s' '{lines}'\n",
            counter.display()
        ),
    )?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

fn probes(counter: &Path) -> usize {
    fs::read_to_string(counter).map_or(0, |text| text.lines().count())
}

fn env(path: &Path) -> Vec<(OsString, OsString)> {
    vec![("PATH".into(), path.as_os_str().to_owned())]
}

// Covers: R53
#[test]
fn the_navori_on_path_is_probed_once_per_binary() -> TestResult {
    let temp = Temp::new()?;
    let cache = FactsCache::in_project(&temp.0);
    let bin = temp.0.join("bin");
    fs::create_dir(&bin)?;
    let counter = temp.0.join("counter");
    let env_bin = env(&bin);

    // No navori along PATH: the shell's "not installed" branch, and nothing to probe or cache.
    assert_eq!(
        navori_cli(&env_bin, &temp.0, Some(&cache))?,
        NavoriCli::Absent
    );

    // The first call runs `navori --version`, only its first line counts, the next ones replay it.
    fake_navori(&bin, &counter, "9.9.9\nsecond line\n")?;
    let first = navori_cli(&env_bin, &temp.0, Some(&cache))?;
    assert_eq!(first, NavoriCli::Version("9.9.9".to_owned()));
    assert_eq!(probes(&counter), 1);
    for _ in 0..3 {
        assert_eq!(navori_cli(&env_bin, &temp.0, Some(&cache))?, first);
    }
    assert_eq!(
        probes(&counter),
        1,
        "an unchanged binary is not probed again"
    );
    assert!(
        fs::read_dir(temp.0.join(".navori/state/rust-facts"))?
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("navori-cli-"))
    );

    // Without a cache every call probes.
    assert_eq!(navori_cli(&env_bin, &temp.0, None)?, first);
    assert_eq!(probes(&counter), 2);

    // A different binary at the same path (new size and timestamps) is a different key: it is
    // probed again and the new version replaces the cached one.
    fake_navori(&bin, &counter, "10.0.0 (newer build)\n")?;
    assert_eq!(
        navori_cli(&env_bin, &temp.0, Some(&cache))?,
        NavoriCli::Version("10.0.0 (newer build)".to_owned())
    );
    assert_eq!(probes(&counter), 3);

    // A directory earlier in PATH holding another navori wins, as `command -v` resolves it, and
    // it is probed on its own; a relative PATH entry resolves against the working directory.
    let early = temp.0.join("early");
    fs::create_dir(&early)?;
    let other = temp.0.join("other-counter");
    fake_navori(&early, &other, "1.2.3")?;
    let both = std::env::join_paths([&early, &bin])?;
    assert_eq!(
        navori_cli(&env(Path::new(&both)), &temp.0, Some(&cache))?,
        NavoriCli::Version("1.2.3".to_owned())
    );
    assert_eq!(
        navori_cli(&env(Path::new("early")), &temp.0, Some(&cache))?,
        NavoriCli::Version("1.2.3".to_owned()),
    );
    assert_eq!(
        probes(&other),
        1,
        "the same binary under two spellings shares one key"
    );
    assert_eq!(probes(&counter), 3);

    // A version equal to the build's runs in process; any other is a subprocess (D30).
    assert!(NavoriCli::Version("0.12.3".to_owned()).runs_in_process("0.12.3"));
    assert!(!NavoriCli::Version("0.12.2".to_owned()).runs_in_process("0.12.3"));
    assert!(!NavoriCli::Absent.runs_in_process("0.12.3"));

    // An entry older than the cache's age bound is not replayed, and one is keyed to its binary.
    let key = navori_cli_key(&bin.join("navori")).ok_or("key")?;
    let now = now_ms().ok_or("clock")?;
    assert!(cache.load_navori_cli(&key, now).is_some());
    assert!(cache.load_navori_cli(&key, now + MAX_AGE_MS + 1).is_none());
    assert!(cache.load_navori_cli("other-key", now).is_none());
    Ok(())
}
