//! `navori audit --arm` / `--disarm` end to end through the real binary, against the frozen TS.
//!
//! Parity tests run the same argv in two isolated worlds, once native and once through the built
//! TS CLI (`packages/cli/dist/index.js`, or `$NAVORI_TS_CLI`), and compare stdout, stderr, exit
//! code and the audit tree. They need that build: `bun run ensure-dist`. Without it they print a
//! note and pass, so a bare `cargo test --workspace` stays usable. The `quality` job of
//! `rust.yml` runs without `dist`, so in CI these are skipped: there the `oracle` job carries the
//! native/TS parity of `--arm`/`--disarm` (`rust-oracle/cases/audit.json`), and the interop in
//! both directions is checked locally (A3) and by the E2E of the workplan (A10).
//!
//! The native binary is only selected for `audit` once `crates/ported.json` lists it; the
//! delegation tests use a recording stub in place of the TS.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");

type TestResult = Result<(), Box<dyn Error>>;

/// Install `body` at `path` as an executable that this process never held open for writing.
/// Tests run on parallel threads that fork: a write descriptor open here at that moment lives
/// on in the forked child until its exec, and running `path` in that window fails with ETXTBSY
/// ("Text file busy"). `/bin/cp` writes the file in its own process, which never forks.
fn install_executable(path: &std::path::Path, body: &str, mode: u32) -> TestResult {
    use std::os::unix::fs::PermissionsExt as _;
    let mut staged = path.as_os_str().to_owned();
    staged.push(".staged");
    let staged = std::path::PathBuf::from(staged);
    fs::write(&staged, body)?;
    let status = std::process::Command::new("/bin/cp")
        .arg(&staged)
        .arg(path)
        .status()?;
    fs::remove_file(&staged)?;
    if !status.success() {
        return Err(format!("cp exited with {status}").into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn ts_cli() -> Option<PathBuf> {
    let path = std::env::var_os("NAVORI_TS_CLI").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/cli/dist/index.js"),
        PathBuf::from,
    );
    if path.is_file() {
        Some(path)
    } else {
        eprintln!(
            "audit_arm: {} missing; run `bun run ensure-dist`",
            path.display()
        );
        None
    }
}

fn node_dir() -> Result<PathBuf, Box<dyn Error>> {
    let path = std::env::var_os("PATH").ok_or("no PATH")?;
    std::env::split_paths(&path)
        .find(|dir| dir.join("node").is_file())
        .ok_or_else(|| "node not in PATH".into())
}

/// An isolated `HOME` with one repo.
struct World {
    root: PathBuf,
}

impl Drop for World {
    /// The root lives in the system temp dir, which nothing else cleans.
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl World {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        // The system temp dir, not `CARGO_TARGET_TMPDIR`: the audit repo is named after the cwd
        // path, and under `.claude/worktrees/` it is the parent repo (`repo_from_cwd`,
        // navori-core audit.rs), so a target inside a Claude worktree would file the audit
        // under that repo instead of `repo` (follow-up of #1791).
        let root = std::env::temp_dir().join(format!("aa-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(root.join("home"))?;
        fs::create_dir_all(root.join("repo/.git"))?;
        Ok(Self {
            root: root.canonicalize()?,
        })
    }

    fn repo(&self) -> PathBuf {
        self.root.join("repo")
    }

    fn audits(&self) -> PathBuf {
        self.root.join("home/.navori/audits")
    }

    fn armed(&self) -> PathBuf {
        self.audits().join("repo/.armed")
    }

    fn command(&self, program: &OsStr, lead: &[&OsStr]) -> Result<Command, Box<dyn Error>> {
        let mut command = Command::new(program);
        command
            .args(lead)
            .current_dir(self.repo())
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", node_dir()?.display()))
            .env("HOME", self.root.join("home"));
        Ok(command)
    }

    fn native(&self, args: &[&str]) -> Result<Output, Box<dyn Error>> {
        // No TS to fall back on: a silent delegation would exit 69 and fail the comparison.
        let ts = Path::new("/nonexistent/ts.js");
        let mut command = self.command(OsStr::new(BIN), &[OsStr::new("audit")])?;
        command.args(args).env("NAVORI_TS_CLI", ts);
        Ok(command.output()?)
    }

    fn ts(&self, args: &[&str]) -> Result<Output, Box<dyn Error>> {
        let ts = ts_cli().ok_or("no ts")?;
        let mut command =
            self.command(OsStr::new("node"), &[ts.as_os_str(), OsStr::new("audit")])?;
        command.args(args);
        Ok(command.output()?)
    }

    fn text(&self, bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).replace(&self.root.display().to_string(), "@W@")
    }

    /// Everything under the audit root: kind, mode and content, with `ts` masked.
    fn tree(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        walk(
            &self.audits(),
            &self.audits(),
            &self.root.display().to_string(),
            &mut out,
        );
        out
    }
}

fn walk(base: &Path, dir: &Path, root: &str, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let name = path
            .strip_prefix(base)
            .map_or_else(|_| String::new(), |p| p.display().to_string());
        let mode = meta.mode() & 0o7777;
        if meta.is_dir() {
            out.insert(name, format!("dir {mode:o}"));
            walk(base, &path, root, out);
        } else {
            let body = fs::read_to_string(&path)
                .unwrap_or_default()
                .replace(root, "@W@");
            out.insert(name, format!("file {mode:o} {}", mask_ts(&body)));
        }
    }
}

/// Replaces the value of `ts` with `@ISO@` after checking its shape (`toISOString`).
fn mask_ts(body: &str) -> String {
    let Some(start) = body.find("\"ts\":\"") else {
        return body.to_owned();
    };
    let from = start + 6;
    let Some(len) = body[from..].find('"') else {
        return body.to_owned();
    };
    let ts = &body[from..from + len];
    let shaped = ts.len() == 24
        && ts.ends_with('Z')
        && ts.as_bytes()[10] == b'T'
        && ts.as_bytes()[19] == b'.'
        && ts[..19].chars().enumerate().all(|(i, c)| {
            if matches!(i, 4 | 7) {
                c == '-'
            } else if matches!(i, 13 | 16) {
                c == ':'
            } else if i == 10 {
                c == 'T'
            } else {
                c.is_ascii_digit()
            }
        })
        && ts[20..23].chars().all(|c| c.is_ascii_digit());
    if shaped {
        format!("{}@ISO@{}", &body[..from], &body[from + len..])
    } else {
        format!("{}@BADTS:{ts}@{}", &body[..from], &body[from + len..])
    }
}

/// Runs `steps` (each an argv) native in one world and TS in another, then compares everything.
fn parity(name: &str, setup: impl Fn(&World) -> TestResult, steps: &[&[&str]]) -> TestResult {
    if ts_cli().is_none() {
        return Ok(());
    }
    let native = World::new(&format!("{name}-n"))?;
    let ts = World::new(&format!("{name}-t"))?;
    setup(&native)?;
    setup(&ts)?;
    for args in steps {
        let a = native.native(args)?;
        let b = ts.ts(args)?;
        assert_eq!(
            native.text(&a.stdout),
            ts.text(&b.stdout),
            "stdout {args:?}"
        );
        assert_eq!(
            native.text(&a.stderr),
            ts.text(&b.stderr),
            "stderr {args:?}"
        );
        assert_eq!(a.status.code(), b.status.code(), "exit {args:?}");
        assert_eq!(native.tree(), ts.tree(), "tree {args:?}");
    }
    Ok(())
}

fn nothing(_: &World) -> TestResult {
    Ok(())
}

#[test]
fn arm_then_arm_again_then_disarm_then_disarm() -> TestResult {
    parity(
        "cycle",
        nothing,
        &[&["--arm"], &["--arm"], &["--disarm"], &["--disarm"]],
    )
}

#[test]
fn arm_with_host_and_json() -> TestResult {
    parity(
        "host-json",
        nothing,
        &[
            &["--arm", "--host", "pi", "--json"],
            &["--disarm", "--json"],
            &["--arm", "--host=codex"],
        ],
    )
}

#[test]
fn invalid_host_with_and_without_json() -> TestResult {
    parity(
        "bad-host",
        nothing,
        &[
            &["--arm", "--host", "vim"],
            &["--arm", "--host", "vim", "--json"],
        ],
    )
}

#[test]
fn english_config_language() -> TestResult {
    parity(
        "en",
        |world| {
            fs::write(
                world.repo().join("navori.config.json"),
                r#"{"language":"en"}"#,
            )?;
            Ok(())
        },
        &[
            &["--arm"],
            &["--arm"],
            &["--disarm"],
            &["--arm", "--host", "x1"],
        ],
    )
}

#[test]
fn worktree_cwd_is_attributed_to_the_parent_repo() -> TestResult {
    parity(
        "worktree",
        |world| {
            fs::create_dir_all(world.repo().join(".claude/worktrees/agent-1/sub"))?;
            Ok(())
        },
        &[
            &["--arm", "--cwd", ".claude/worktrees/agent-1/sub"],
            &["--disarm", "--cwd", ".claude/worktrees/agent-1"],
        ],
    )
}

#[test]
fn open_audit_root_is_unsafe_like_the_ts() -> TestResult {
    let open = |world: &World| -> TestResult {
        fs::create_dir_all(world.audits())?;
        fs::set_permissions(world.audits(), fs::Permissions::from_mode(0o755))?;
        Ok(())
    };
    parity(
        "open",
        open,
        &[
            &["--arm"],
            &["--arm", "--json"],
            &["--disarm"],
            &["--disarm", "--json"],
        ],
    )
}

#[test]
fn a_tampered_armed_file_is_refused_the_same() -> TestResult {
    parity(
        "tampered",
        |world| {
            fs::create_dir_all(world.audits().join("repo"))?;
            fs::set_permissions(world.audits(), fs::Permissions::from_mode(0o700))?;
            fs::set_permissions(
                world.audits().join("repo"),
                fs::Permissions::from_mode(0o700),
            )?;
            fs::write(world.armed(), "x")?;
            fs::set_permissions(world.armed(), fs::Permissions::from_mode(0o644))?;
            Ok(())
        },
        &[&["--arm"], &["--disarm"]],
    )
}

#[test]
fn the_tree_is_private() -> TestResult {
    let world = World::new("modes")?;
    let out = world.native(&["--arm"]);
    if ts_cli().is_none() {
        return Ok(());
    }
    assert_eq!(out?.status.code(), Some(0));
    let mode = |path: &Path| fs::metadata(path).map(|m| m.mode() & 0o7777);
    assert_eq!(mode(&world.audits())?, 0o700);
    assert_eq!(mode(&world.audits().join("repo"))?, 0o700);
    assert_eq!(mode(&world.armed())?, 0o600);
    Ok(())
}

/// Delegation: the stub TS records its argv, and nothing is written.
#[test]
fn delegation_triggers_write_nothing() -> TestResult {
    let world = World::new("delegate")?;
    let stub = world.root.join("ts.sh");
    install_executable(&stub, "#!/bin/sh\necho \"delegated:$*\"\nexit 42\n", 0o755)?;
    let cases: &[&[&str]] = &[
        &["--arm", "--no-arm"],
        &["--no-arm"],
        &["--arm=false"],
        &["--arm", "--arm"],
        &["--arm", "--json", "--json"],
        &["--arm", "--host", "pi", "--host", "codex"],
        &["--arm", "--days", "3"],
        &["--arm", "--start", "x"],
        &["--arm", "--disarm"],
        &["--disarm", "--host", "pi"],
        &["--arm", "--host"],
        &["--arm", "--cwd", ""],
        &["--arm", "extra"],
        &["--arm", "--json=false"],
        &["--arm", "--host", "5"],
    ];
    for args in cases {
        let mut command = world.command(OsStr::new(BIN), &[OsStr::new("audit")])?;
        let out = command.args(*args).env("NAVORI_TS_CLI", &stub).output()?;
        assert_eq!(out.status.code(), Some(42), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stdout).starts_with("delegated:audit"),
            "{args:?}"
        );
        assert!(!world.audits().exists(), "wrote for {args:?}");
    }
    // HOME unset, empty or not UTF-8: the TS decides.
    let bad = OsStr::from_bytes(b"/h\xff");
    for home in [None, Some(OsStr::new("")), Some(bad)] {
        let mut command = world.command(OsStr::new(BIN), &[OsStr::new("audit")])?;
        command.arg("--arm").env("NAVORI_TS_CLI", &stub);
        match home {
            Some(value) => command.env("HOME", value),
            None => command.env_remove("HOME"),
        };
        let out = command.output()?;
        assert_eq!(out.status.code(), Some(42), "HOME {home:?}");
    }
    Ok(())
}

#[test]
fn native_arm_is_consumed_by_the_ts_and_starts_the_session() -> TestResult {
    let Some(ts) = ts_cli() else { return Ok(()) };
    let world = World::new("interop-a")?;
    let armed = world.native(&["--arm", "--host", "claude"])?;
    assert_eq!(armed.status.code(), Some(0));
    assert!(world.armed().is_file());

    let repo = world.repo();
    let audits = world.audits();
    let mut command = world.command(OsStr::new("node"), &[ts.as_os_str(), OsStr::new("audit")])?;
    let out = command
        .args([
            "--consume-arm",
            "--start",
            "sess-1",
            "--host",
            "claude",
            "--cwd",
        ])
        .arg(&repo)
        .arg("--root")
        .arg(&audits)
        .output()?;
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!world.armed().exists(), "consumed");
    let tree = world.tree();
    assert!(
        tree.keys()
            .any(|name| name.starts_with("repo/") && name != "repo/.armed"),
        "session started: {tree:?}"
    );
    Ok(())
}

#[test]
fn ts_arm_is_removed_by_the_native_disarm() -> TestResult {
    if ts_cli().is_none() {
        return Ok(());
    }
    let world = World::new("interop-b")?;
    assert_eq!(world.ts(&["--arm"])?.status.code(), Some(0));
    assert!(world.armed().is_file());
    let out = world.native(&["--disarm"])?;
    assert_eq!(out.status.code(), Some(0));
    assert!(!world.armed().exists());
    Ok(())
}

#[test]
fn native_armed_file_equals_the_ts_one_but_for_ts() -> TestResult {
    if ts_cli().is_none() {
        return Ok(());
    }
    for args in [&["--arm"][..], &["--arm", "--host", "pi"]] {
        let native = World::new("bytes-n")?;
        let ts = World::new("bytes-t")?;
        native.native(args)?;
        ts.ts(args)?;
        let read = |w: &World| fs::read_to_string(w.armed());
        let (a, b) = (read(&native)?, read(&ts)?);
        assert_eq!(a.len(), b.len());
        assert_eq!(
            mask_ts(&a).replace(&native.root.display().to_string(), "@W@"),
            mask_ts(&b).replace(&ts.root.display().to_string(), "@W@")
        );
        assert!(!mask_ts(&a).contains("@BADTS"), "{a}");
    }
    Ok(())
}
