//! Native `remove` (spec 0058 T30, R48): only `--yes` runs are native, so none reaches the
//! confirmation prompt.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use navori_cli::remove::parse_args;
use navori_cli::{dispatch, parser};
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

// Covers: R48
#[test]
fn only_a_confirmed_remove_is_native() -> TestResult {
    let manifest = Manifest::embedded()?;
    let selected = |args: &[&str]| dispatch(&manifest, &parser::parse(&argv(args))).map(|(_, e)| e);
    assert!(selected(&["remove", "tgrep"]).is_none());
    assert!(selected(&["remove", "tgrep", "--cwd", "x"]).is_none());
    let entry = selected(&["remove", "tgrep", "--yes"]).ok_or("entry")?;
    let base = Path::new("/repo");
    let parsed = |args: &[&str]| parse_args(&argv(args), entry, base);
    let args = parsed(&["remove", "--yes", "tgrep", "--cwd", "sub"]).ok_or("parse")?;
    assert_eq!(args.plugin, "tgrep");
    assert_eq!(args.cwd, PathBuf::from("/repo/sub"));
    for args in [
        &["remove", "tgrep"][..],
        &["remove", "--yes"],
        &["remove", "a", "b", "--yes"],
        &["remove", "tgrep", "--yes=1"],
        &["remove", "tgrep", "--yes", "--yes"],
        &["remove", "tgrep", "-y"],
        &["remove", "--", "tgrep", "--yes"],
    ] {
        assert!(parsed(args).is_none(), "{args:?}");
    }
    Ok(())
}

const CMD: &str = "remove";

/// A rendered `claude` repo (with `tgrep`) next to a home whose registry is in step and a decoy
/// TS CLI that records any invocation in `marker`.
struct Fixture {
    repo: PathBuf,
    home: PathBuf,
    backups: PathBuf,
    decoy: PathBuf,
    marker: PathBuf,
}

/// Relative path -> (mode, mtime in ns, content) of everything under a root.
type Tree = BTreeMap<PathBuf, (u32, i64, Vec<u8>)>;

fn snapshot(root: &Path) -> Result<Tree, Box<dyn Error>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            let content = if meta.is_file() {
                fs::read(&path)?
            } else {
                Vec::new()
            };
            if meta.is_dir() {
                stack.push(path.clone());
            }
            out.insert(
                path.strip_prefix(root)?.to_path_buf(),
                (
                    meta.mode(),
                    meta.mtime_nsec() + meta.mtime() * 1_000_000_000,
                    content,
                ),
            );
        }
    }
    Ok(out)
}

impl Fixture {
    fn rendered(name: &str) -> Result<Self, Box<dyn Error>> {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("{CMD}-{name}-{}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        let fixture = Self {
            repo: dir.join("repo"),
            home: dir.join("home"),
            backups: dir.join("backups"),
            decoy: dir.join("decoy.sh"),
            marker: dir.join("marker"),
        };
        for path in [
            &fixture.repo,
            &fixture.home.join(".navori"),
            &fixture.backups,
        ] {
            fs::create_dir_all(path)?;
        }
        fs::write(
            &fixture.decoy,
            "#!/bin/sh\necho hit > \"$MARKER\"\nexit 97\n",
        )?;
        fs::set_permissions(
            &fixture.decoy,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )?;
        fs::write(
            fixture.repo.join("navori.config.json"),
            r#"{"name":"demo","preset":"custom","engines":["claude"],"language":"en","plugins":{"tgrep":{"enabled":true}}}"#,
        )?;
        let canonical = fs::canonicalize(&fixture.repo)?;
        fs::write(
            fixture.home.join(".navori/registry.json"),
            format!(r#"{{"repos":[{{"path":{canonical:?},"name":"demo"}}]}}"#),
        )?;
        let out = fixture.run(&["render", "--apply"], &[("NO_COLOR", "1")])?;
        assert_eq!(out.status.code(), Some(0), "setup render failed");
        assert!(!fixture.marker.exists(), "setup handed the run to the TS");
        Ok(fixture)
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> std::io::Result<std::process::Output> {
        Process::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(args)
            .current_dir(&self.repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("NAVORI_BACKUP_ROOT", &self.backups)
            .env("NAVORI_TS_CLI", &self.decoy)
            .env("MARKER", &self.marker)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .output()
    }

    /// Wraps the first rendered Claude hook in a conflict triple; returns its relative path.
    fn conflict(&self) -> Result<String, Box<dyn Error>> {
        let hook = fs::read_dir(self.repo.join(".claude/hooks"))?
            .filter_map(Result::ok)
            .find(|entry| entry.path().is_file())
            .ok_or("no rendered hook")?
            .file_name();
        let rel = format!(".claude/hooks/{}", hook.to_string_lossy());
        let path = self.repo.join(&rel);
        let body = fs::read_to_string(&path)?;
        fs::write(
            path,
            format!("<<<<<<< HEAD\n{body}\n=======\ntheirs\n>>>>>>> branch\n"),
        )?;
        Ok(rel)
    }

    fn state(&self) -> Result<[Tree; 3], Box<dyn Error>> {
        Ok([
            snapshot(&self.repo)?,
            snapshot(&self.home)?,
            snapshot(&self.backups)?,
        ])
    }

    /// Asserts the refusal of #1660: exit 1, nothing written (config included), no TS.
    fn assert_refused(
        &self,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<String, Box<dyn Error>> {
        let before = self.state()?;
        let out = self.run(args, env)?;
        let stdout = String::from_utf8(out.stdout)?;
        assert_eq!(out.status.code(), Some(1), "{args:?}: {stdout}");
        assert_eq!(before, self.state()?, "{args:?} wrote something");
        assert!(!self.marker.exists(), "{args:?} handed the run to the TS");
        Ok(stdout)
    }
}

/// A conflict in a rendered hook is refused before the config or anything else is written,
/// with or without a terminal, and without the TS.
// Covers: #1660
#[test]
fn conflict_markers_refuse_remove_before_any_write() -> TestResult {
    let fixture = Fixture::rendered("conflict")?;
    let rel = fixture.conflict()?;
    for env in [&[("NO_COLOR", "1")][..], &[("FORCE_COLOR", "1")]] {
        let stdout = fixture.assert_refused(&["remove", "tgrep", "--yes"], env)?;
        assert!(stdout.contains(&format!("{rel}:1")), "{stdout}");
    }
    let config = fs::read_to_string(fixture.repo.join("navori.config.json"))?;
    assert!(config.contains(r#""tgrep":{"enabled":true}"#), "{config}");
    Ok(())
}

/// A clean rendered repo keeps its behavior: remove is native and exits 0.
#[test]
fn conflict_markers_absent_leaves_remove_unchanged() -> TestResult {
    let fixture = Fixture::rendered("clean")?;
    let out = fixture.run(&["remove", "tgrep", "--yes"], &[("NO_COLOR", "1")])?;
    assert_eq!(out.status.code(), Some(0));
    assert!(!fixture.marker.exists());
    Ok(())
}
