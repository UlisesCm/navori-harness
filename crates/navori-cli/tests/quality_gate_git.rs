//! Spec 0059 (R50): byte parity of the git-state paths of quality-gate-pre-commit (worktree
//! resolution, foreign-commit landing, session-state ratchet) between the rendered shell copy
//! and the native host, over real git repositories. `quality_gate.rs` of navori-hooks stubs git.
//! The rendered copies set `navori_native_fast=1`, so the gate step itself is always skipped.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type TestResult = Result<(), Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
const SCRIPT: &str = "quality-gate-pre-commit.sh";

/// The three engines: the directory their rendered hook lives in, and whether `git push` gates.
const ENGINES: [(&str, bool); 3] = [
    (".claude/hooks", false),
    (".codex/hooks", false),
    (".pi/navori/hooks", true),
];

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

/// What a case must end in, so equal-but-wrong answers cannot pass.
#[derive(Clone, Copy, Debug)]
enum Expect {
    /// Not a gated command: exit 0, nothing printed.
    Silent,
    /// The ratchet blocked the commit: exit 2 and the BLOCKED line.
    Blocked,
    /// The gate step was skipped for `nativeHooks`: exit 0.
    Skip,
    /// The commit lands in another repository: exit 0, "not run from here".
    Foreign,
}

impl Expect {
    fn check(self, label: &str, status: i32, stderr: &str) {
        let ok = match self {
            Self::Silent => status == 0 && stderr.is_empty(),
            Self::Blocked => status == 2 && stderr.contains("Commit BLOCKED"),
            Self::Skip => status == 0 && stderr.contains("quality-gate skipped"),
            Self::Foreign => status == 0 && stderr.contains("not run from here"),
        };
        assert!(
            ok,
            "{label}: expected {self:?}, got status {status}, stderr {stderr:?}"
        );
    }
}

/// One hook call: the hook process cwd, the payload `cwd`, the Bash command, the outcome.
struct Probe {
    hook_cwd: PathBuf,
    payload_cwd: PathBuf,
    command: String,
    expect: Expect,
}

/// A scratch tree: the rendered hook installed under the engine's hooks dir, an empty home and a
/// work directory for the repositories.
struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        // Outside the checkout: a scratch under the target directory would sit inside its work tree.
        let root =
            std::env::temp_dir().join(format!("navori-qg-git-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(root.join("home"))?;
        fs::create_dir_all(root.join("work"))?;
        Ok(Self {
            root: fs::canonicalize(&root)?,
        })
    }

    fn install(&self, dir: &str) -> Result<PathBuf, Box<dyn Error>> {
        let dest = self.root.join(dir).join(SCRIPT);
        fs::create_dir_all(dest.parent().ok_or("parent")?)?;
        // This repository's `.claude` copy of the hook carries no native-hook integrity marker, so
        // the native host would defer it; the Claude lane is exercised with the marked `.codex`
        // copy installed at the Claude path (the engine is read from the path, not the content).
        let source = if dir == ".claude/hooks" {
            ".codex/hooks"
        } else {
            dir
        };
        fs::copy(workspace().join(source).join(SCRIPT), &dest)?;
        Ok(dest)
    }

    fn work(&self, name: &str) -> PathBuf {
        self.root.join("work").join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> TestResult {
    // Hermetic: a stray GIT_DIR (e.g. inside a git hook) must not redirect this to a real repo.
    let status = Command::new("git")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?} failed").into())
    }
}

/// An initialized repository on `main`, with one empty commit when `commit` is set.
fn repo(dir: &Path, commit: bool) -> TestResult {
    fs::create_dir_all(dir)?;
    git(dir, &["init", "-q", "-b", "main"])?;
    if commit {
        git(dir, &["commit", "-q", "--allow-empty", "-m", "base"])?;
    }
    Ok(())
}

/// Write `bytes` bytes at `rel` under `dir`.
fn file(dir: &Path, rel: &str, bytes: usize) -> TestResult {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().ok_or("parent")?)?;
    fs::write(path, vec![b'a'; bytes])?;
    Ok(())
}

struct Run {
    status: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// `args` runs the hook as its host does; stdin carries a PreToolUse Bash payload.
fn run(
    program: &str,
    args: &[&str],
    mode: &str,
    home: &Path,
    probe: &Probe,
) -> Result<Run, Box<dyn Error>> {
    let payload = serde_json::json!({
        "session_id": "s1",
        "cwd": probe.payload_cwd,
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": probe.command },
    });
    // No audit env and a scratch HOME keep navori's own audit log out of the real one.
    let mut child = Command::new(program)
        .args(args)
        .current_dir(&probe.hook_cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("PWD", &probe.hook_cwd)
        .env("TMPDIR", home)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("NAVORI_NO_UPDATE_NOTIFIER", "1")
        .env("NAVORI_HOOK_IMPL", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(payload.to_string().as_bytes())?;
    let out = child.wait_with_output()?;
    Ok(Run {
        status: out.status.code().ok_or("signal")?,
        stdout: out.stdout,
        stderr: out.stderr,
    })
}

fn run_native(script: &str, home: &Path, probe: &Probe) -> Result<Run, Box<dyn Error>> {
    run(BIN, &["hook", "--via-script", script], "rust", home, probe)
}

/// Shell and native answers for `probe`, asserted byte for byte and against the expected outcome.
fn parity(scratch: &Scratch, engine: &str, probe: &Probe) -> TestResult {
    let script = scratch.install(engine)?;
    let script = script.to_string_lossy().into_owned();
    let home = scratch.root.join("home");
    let label = format!("{engine} `{}`", probe.command);
    let shell = run("bash", &[&script], "shell", &home, probe)?;
    // Bounded retry: under heavy load the native host's capability probe can miss its deadline
    // and defer to the shell (a legitimate fallback, not a parity result): retry only that.
    let mut native = run_native(&script, &home, probe)?;
    for _ in 0..4 {
        if !String::from_utf8_lossy(&native.stderr).contains("probe deadline expired") {
            break;
        }
        native = run_native(&script, &home, probe)?;
    }
    assert_eq!(
        String::from_utf8_lossy(&native.stdout),
        String::from_utf8_lossy(&shell.stdout),
        "{label} stdout (native status {}, stderr {:?})",
        native.status,
        String::from_utf8_lossy(&native.stderr)
    );
    assert_eq!(native.status, shell.status, "{label} status");
    assert_eq!(
        String::from_utf8_lossy(&native.stderr),
        String::from_utf8_lossy(&shell.stderr),
        "{label} stderr"
    );
    probe.expect.check(
        &label,
        shell.status,
        &String::from_utf8_lossy(&shell.stderr),
    );
    Ok(())
}

/// Build the probes of one case once per engine, each in its own scratch tree.
fn each_engine(
    name: &str,
    build: impl Fn(&Scratch, bool) -> Result<Vec<Probe>, Box<dyn Error>>,
) -> TestResult {
    for (engine, pushes) in ENGINES {
        let tag = engine.replace(['/', '.'], "");
        let scratch = Scratch::new(&format!("{name}-{tag}"))?;
        for probe in build(&scratch, pushes)? {
            parity(&scratch, engine, &probe)?;
        }
    }
    Ok(())
}

/// A probe run from the repository itself.
fn here(dir: &Path, command: &str, expect: Expect) -> Probe {
    Probe {
        hook_cwd: dir.to_path_buf(),
        payload_cwd: dir.to_path_buf(),
        command: command.to_owned(),
        expect,
    }
}

const COMMIT: &str = "git commit -m x";

// Covers: R50
#[test]
fn a_command_that_is_not_a_commit_is_silent() -> TestResult {
    each_engine("status", |s, _| {
        let dir = s.work("r");
        repo(&dir, true)?;
        Ok(vec![here(&dir, "git status", Expect::Silent)])
    })
}

// Covers: R50
#[test]
fn a_commit_outside_any_work_tree_skips_the_gate() -> TestResult {
    each_engine("plain", |s, _| {
        let dir = s.work("plain");
        fs::create_dir_all(&dir)?;
        Ok(vec![here(&dir, COMMIT, Expect::Skip)])
    })
}

// Covers: R50
#[test]
fn an_unborn_head_counts_as_zero_bytes() -> TestResult {
    each_engine("unborn", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, "progress/current.md", 9000)?;
        git(&dir, &["add", "progress/current.md"])?;
        Ok(vec![here(&dir, COMMIT, Expect::Blocked)])
    })
}

// Covers: R50
#[test]
fn the_ratchet_compares_the_file_with_head() -> TestResult {
    each_engine("ratchet", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, "progress/current.md", 9000)?;
        git(&dir, &["add", "progress/current.md"])?;
        git(&dir, &["commit", "-q", "-m", "big"])?;
        Ok(vec![here(&dir, COMMIT, Expect::Skip)])
    })?;
    each_engine("grown", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, "progress/current.md", 9000)?;
        git(&dir, &["add", "progress/current.md"])?;
        git(&dir, &["commit", "-q", "-m", "big"])?;
        // Grown in the worktree only: the size is the max of worktree and index.
        file(&dir, "progress/current.md", 9500)?;
        Ok(vec![here(&dir, COMMIT, Expect::Blocked)])
    })?;
    each_engine("trim", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, "progress/current.md", 9000)?;
        git(&dir, &["add", "progress/current.md"])?;
        git(&dir, &["commit", "-q", "-m", "big"])?;
        // Still over the ceiling but smaller than at HEAD.
        file(&dir, "progress/current.md", 8500)?;
        Ok(vec![here(&dir, COMMIT, Expect::Skip)])
    })
}

// Covers: R50
#[test]
fn a_gitignored_session_file_is_skipped() -> TestResult {
    each_engine("ignored", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        fs::write(dir.join(".gitignore"), "progress/\n")?;
        file(&dir, "progress/current.md", 9000)?;
        Ok(vec![here(&dir, COMMIT, Expect::Skip)])
    })
}

// Covers: R50
#[test]
fn the_codex_variant_of_the_session_file_is_ratcheted() -> TestResult {
    each_engine("variant", |s, _| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, ".codex/progress/current.md", 9000)?;
        git(&dir, &["add", ".codex/progress/current.md"])?;
        Ok(vec![here(&dir, COMMIT, Expect::Blocked)])
    })
}

// Covers: R50
#[test]
fn the_gate_enters_the_tree_being_committed() -> TestResult {
    each_engine("linked", |s, _| {
        let main = s.work("main");
        repo(&main, true)?;
        let wt = s.work("wt");
        git(
            &main,
            &["worktree", "add", "-q", "-b", "wt", &wt.to_string_lossy()],
        )?;
        file(&wt, "progress/current.md", 9000)?;
        Ok(vec![
            // The host fires the hook from the main checkout; the payload names the worktree.
            Probe {
                hook_cwd: main.clone(),
                payload_cwd: wt.clone(),
                command: COMMIT.to_owned(),
                expect: Expect::Blocked,
            },
            // The command itself moves into the worktree; the payload still says main.
            Probe {
                hook_cwd: main.clone(),
                payload_cwd: main.clone(),
                command: format!("cd {} && {COMMIT}", wt.display()),
                expect: Expect::Blocked,
            },
        ])
    })
}

// Covers: R50
#[test]
fn a_commit_that_lands_in_another_repository_is_foreign() -> TestResult {
    each_engine("foreign", |s, _| {
        let main = s.work("main");
        repo(&main, true)?;
        let other = s.work("other");
        repo(&other, true)?;
        Ok(vec![
            here(
                &main,
                &format!("git -C {} commit -m x", other.display()),
                Expect::Foreign,
            ),
            here(
                &main,
                &format!("cd {} && {COMMIT}", other.display()),
                Expect::Foreign,
            ),
        ])
    })
}

// Covers: R50
#[test]
fn only_pi_gates_a_push() -> TestResult {
    each_engine("push", |s, pushes| {
        let dir = s.work("r");
        repo(&dir, false)?;
        file(&dir, "progress/current.md", 9000)?;
        git(&dir, &["add", "progress/current.md"])?;
        let expect = if pushes {
            Expect::Blocked
        } else {
            Expect::Silent
        };
        Ok(vec![here(&dir, "git push", expect)])
    })
}
