//! Spec 0059 (R50): byte parity of the git section of session-start-context (branch line, base
//! branch warning, `git log --oneline -15`, overflow notice) between the rendered shell copy and
//! the native host, over real git repositories. `session_start.rs` of navori-hooks stubs git.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type TestResult = Result<(), Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

/// A scratch tree: the rendered hook installed under `<engine>/hooks/`, an empty home and a work
/// directory for the repositories.
struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        // Outside the checkout: a scratch under the target directory would sit inside its work tree.
        let root =
            std::env::temp_dir().join(format!("navori-session-git-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(root.join("home"))?;
        fs::create_dir_all(root.join("work"))?;
        Ok(Self {
            root: fs::canonicalize(&root)?,
        })
    }

    /// Install the repository's rendered copy of the hook for `engine` (`.claude` or `.codex`).
    fn install(&self, engine: &str) -> Result<PathBuf, Box<dyn Error>> {
        let dest = self
            .root
            .join(engine)
            .join("hooks/session-start-context.sh");
        fs::create_dir_all(dest.parent().ok_or("parent")?)?;
        fs::copy(
            workspace()
                .join(engine)
                .join("hooks/session-start-context.sh"),
            &dest,
        )?;
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

/// An initialized repository on `branch`, with `commits` empty commits.
fn repo(dir: &Path, branch: &str, commits: usize) -> TestResult {
    fs::create_dir_all(dir)?;
    git(dir, &["init", "-q", "-b", branch])?;
    for n in 1..=commits {
        git(
            dir,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("commit {n}"),
            ],
        )?;
    }
    Ok(())
}

struct Run {
    status: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// `args` runs the hook as its host does; stdin carries a SessionStart payload.
fn run(
    program: &str,
    args: &[&str],
    mode: &str,
    home: &Path,
    cwd: &Path,
    extra: &[(&str, &str)],
) -> Result<Run, Box<dyn Error>> {
    let payload = serde_json::json!({
        "session_id": "s1",
        "cwd": cwd,
        "hook_event_name": "SessionStart",
        "source": "startup",
    });
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("PWD", cwd)
        .env("TMPDIR", home)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("NAVORI_NO_UPDATE_NOTIFIER", "1")
        .env("NAVORI_HOOK_IMPL", mode)
        .envs(extra.iter().copied())
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

fn run_native(
    script: &str,
    home: &Path,
    cwd: &Path,
    extra: &[(&str, &str)],
) -> Result<Run, Box<dyn Error>> {
    run(
        BIN,
        &["hook", "--via-script", script],
        "rust",
        home,
        cwd,
        extra,
    )
}

/// Shell and native answers for `cwd`, asserted byte for byte; the shell's stdout is returned.
fn parity(
    scratch: &Scratch,
    engine: &str,
    cwd: &Path,
    extra: &[(&str, &str)],
) -> Result<String, Box<dyn Error>> {
    let script = scratch.install(engine)?;
    let script = script.to_string_lossy().into_owned();
    let home = scratch.root.join("home");
    let shell = run("bash", &[&script], "shell", &home, cwd, extra)?;
    // Bounded retry: the 5s NAVORI_CLI_PROBE deadline in hook_facts.rs falls back to the shell
    // under CPU load.
    // Under heavy load the native host's capability probe can miss its deadline and defer to
    // the shell (a legitimate fallback, not a parity result): retry that, and only that.
    let mut native = run_native(&script, &home, cwd, extra)?;
    for _ in 0..4 {
        if !String::from_utf8_lossy(&native.stderr).contains("probe deadline expired") {
            break;
        }
        native = run_native(&script, &home, cwd, extra)?;
    }
    assert_eq!(
        shell.status,
        0,
        "shell failed: {}",
        String::from_utf8_lossy(&shell.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&native.stdout),
        String::from_utf8_lossy(&shell.stdout),
        "{engine} stdout (native status {}, stderr {:?})",
        native.status,
        String::from_utf8_lossy(&native.stderr)
    );
    assert_eq!(native.status, shell.status, "{engine} status");
    assert_eq!(
        String::from_utf8_lossy(&native.stderr),
        String::from_utf8_lossy(&shell.stderr),
        "{engine} stderr"
    );
    Ok(String::from_utf8(shell.stdout)?)
}

fn both(
    name: &str,
    build: impl Fn(&Scratch) -> Result<PathBuf, Box<dyn Error>>,
) -> Result<Vec<String>, Box<dyn Error>> {
    let mut outputs = Vec::new();
    for engine in [".claude", ".codex"] {
        let scratch = Scratch::new(&format!("{name}-{}", engine.trim_start_matches('.')))?;
        let cwd = build(&scratch)?;
        outputs.push(parity(&scratch, engine, &cwd, &[])?);
    }
    Ok(outputs)
}

// Covers: R50
#[test]
fn outside_a_work_tree_has_no_git_section() -> TestResult {
    for out in both("plain", |s| {
        let dir = s.work("plain");
        fs::create_dir_all(&dir)?;
        Ok(dir)
    })? {
        assert!(!out.contains("Branch:"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn a_repository_without_commits_prints_the_branch_only() -> TestResult {
    for out in both("empty", |s| {
        let dir = s.work("r");
        repo(&dir, "feat/x", 0)?;
        Ok(dir)
    })? {
        // Both lanes print `rev-parse`'s literal `HEAD` and then the `|| echo '?'` fallback.
        assert!(out.contains("Branch: HEAD\\n?  (base:"), "{out}");
        assert!(!out.contains("Recent commits"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn a_work_branch_lists_its_commits() -> TestResult {
    for out in both("work", |s| {
        let dir = s.work("r");
        repo(&dir, "feat/x", 3)?;
        Ok(dir)
    })? {
        assert!(out.contains("Branch: feat/x  (base:"), "{out}");
        assert!(out.contains("commit 3"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn the_base_branch_carries_the_warning() -> TestResult {
    // The rendered base of this repository's copies is `dev`.
    for out in both("base", |s| {
        let dir = s.work("r");
        repo(&dir, "dev", 2)?;
        Ok(dir)
    })? {
        assert!(out.contains("on the base branch"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn a_detached_head_names_head() -> TestResult {
    for out in both("detached", |s| {
        let dir = s.work("r");
        repo(&dir, "feat/x", 2)?;
        git(&dir, &["checkout", "-q", "--detach"])?;
        Ok(dir)
    })? {
        assert!(out.contains("Branch: HEAD"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn more_than_fifteen_commits_are_capped_at_fifteen() -> TestResult {
    for out in both("overflow", |s| {
        let dir = s.work("r");
        repo(&dir, "feat/x", 20)?;
        Ok(dir)
    })? {
        assert!(out.contains("commit 20"), "{out}");
        assert!(out.contains("commit 6"), "{out}");
        assert!(!out.contains("commit 5\\n"), "{out}");
    }
    Ok(())
}

// Covers: R50
#[test]
fn a_log_that_overflows_the_budget_becomes_the_pointer() -> TestResult {
    for engine in [".claude", ".codex"] {
        let scratch = Scratch::new(&format!("budget-{}", engine.trim_start_matches('.')))?;
        let cwd = scratch.work("r");
        repo(&cwd, "feat/x", 15)?;
        // A budget so small that only the pointer fits.
        let text = parity(&scratch, engine, &cwd, &[("NAVORI_CTX_BUDGET", "400")])?;
        assert!(text.contains("didn't fit the startup context"), "{text}");
    }
    Ok(())
}
