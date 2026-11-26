//! The `navori` subprocess of a hook branch (spec 0059 R52): Bash and [`subcommand::run`] hand
//! the same program the same argv, stdin, environment and working directory, and read back the
//! same status and output.
//!
//! The fake `navori` is this test binary behind a symlink: run with `NAVORI_T4_DUMP` set, the
//! `dump_helper` test records what it received and exits with a known status. A shell script
//! cannot stand in for it, because a shell edits `PWD`, `SHLVL` and `_` before it could dump them.

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use navori_hooks::shell::subcommand::{self, Call, Capture, Finished, Input};

type TestResult = Result<(), Box<dyn Error>>;

const DUMP: &str = "NAVORI_T4_DUMP";
const SLEEP: &str = "NAVORI_T4_SLEEP";
/// libtest arguments that select only the helper; both sides pass them unchanged.
const HELPER: [&str; 4] = ["--exact", "dump_helper", "--quiet", "--test-threads=1"];

/// The fake `navori`. A no-op under a normal test run.
#[test]
fn dump_helper() {
    let Some(dir) = std::env::var_os(DUMP) else {
        return;
    };
    let dir = PathBuf::from(dir);
    if std::env::var_os(SLEEP).is_some() {
        std::thread::sleep(Duration::from_secs(10));
    }
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| format!("{arg:?}"))
        .collect();
    let mut stdin = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut stdin);
    let mut env: Vec<String> = std::env::vars_os()
        .map(|(name, value)| format!("{name:?}={value:?}"))
        .collect();
    env.sort();
    let cwd = std::env::current_dir().map(|dir| dir.display().to_string());
    let written = fs::write(dir.join("argv"), args.join("\n"))
        .and_then(|()| fs::write(dir.join("stdin"), &stdin))
        .and_then(|()| fs::write(dir.join("env"), env.join("\n")))
        .and_then(|()| fs::write(dir.join("cwd"), cwd.unwrap_or_default()));
    assert!(written.is_ok(), "dump failed");
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(b"out-1\n");
    let _ = out.flush();
    // Written to the descriptor: libtest captures `eprintln!` inside a test.
    let _ = std::io::stderr().lock().write_all(b"err-1\n");
    let _ = out.write_all(b"out-2\n\n\n");
    let _ = out.flush();
    std::process::exit(3);
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "delegated-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("bin"))?;
        fs::create_dir_all(root.join("dump"))?;
        fs::create_dir_all(root.join("project/sub"))?;
        let root = fs::canonicalize(root)?;
        symlink(std::env::current_exe()?, root.join("bin/navori"))?;
        Ok(Self(root))
    }

    /// What the fake recorded, then cleared for the next run.
    fn take(&self) -> Result<Vec<Vec<u8>>, Box<dyn Error>> {
        ["argv", "stdin", "env", "cwd"]
            .iter()
            .map(|name| {
                let path = self.0.join("dump").join(name);
                let bytes = fs::read(&path)?;
                fs::remove_file(path)?;
                Ok(bytes)
            })
            .collect()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The environment the hook process receives from its host.
fn hook_env(scratch: &Scratch) -> Vec<(OsString, OsString)> {
    let path = format!("{}:/usr/bin:/bin", scratch.0.join("bin").display());
    vec![
        ("PATH".into(), path.into()),
        ("HOME".into(), scratch.0.as_os_str().to_owned()),
        (DUMP.into(), scratch.0.join("dump").into_os_string()),
        ("SHLVL".into(), "2".into()),
        ("PWD".into(), scratch.0.join("project").into_os_string()),
        ("SPACED".into(), "a  b\tc".into()),
    ]
}

/// `$?`, stdout and stderr of a Bash run.
type ShellRun = (i32, Vec<u8>, Vec<u8>);

/// Run `body` under Bash as the hook does, with `payload` on its stdin, and return its `$?`
/// and outputs.
fn bash(
    env: &[(OsString, OsString)],
    cwd: &Path,
    body: &str,
    payload: &[u8],
) -> Result<ShellRun, Box<dyn Error>> {
    let mut child = Command::new("/bin/bash")
        .arg("-c")
        .arg(body)
        .env_clear()
        .envs(env.iter().map(|(name, value)| (name, value)))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // The hook's stdin: what the shell drains into `payload=$(cat)`.
    child.stdin.take().ok_or("stdin")?.write_all(payload)?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .stdout
        .take()
        .ok_or("stdout")?
        .read_to_end(&mut stdout)?;
    child
        .stderr
        .take()
        .ok_or("stderr")?
        .read_to_end(&mut stderr)?;
    let status = child.wait()?.code().ok_or("signal")?;
    Ok((status, stdout, stderr))
}

fn args(extra: &[&str]) -> Vec<OsString> {
    HELPER.iter().chain(extra).map(OsString::from).collect()
}

// Covers: R52
#[test]
fn el_subproceso_recibe_argv_stdin_y_entorno_del_shell() -> TestResult {
    let scratch = Scratch::new()?;
    let hook = hook_env(&scratch);
    let project = scratch.0.join("project");
    let sub = project.join("sub");
    let program = scratch.0.join("bin/navori");
    let quoted = HELPER.join(" ");
    // The hook drains stdin with `payload=$(cat)`, which drops the trailing newlines.
    let payload = b"{\"tool\":\"Agent\"}\n\xff\n\n";

    // `cd sub && out=$(printf '%s' "$payload" | NAVORI_HOOK_ENGINE=codex navori … 2>"$err")`,
    // the shape of plan-gate's call, with the cd of quality-gate's `gate probe`.
    let body = format!(
        "payload=$(cat)\ncd sub || exit 99\nout=$(printf '%s' \"$payload\" | NAVORI_HOOK_ENGINE=codex navori {quoted} plan gate 'two words' 2>/dev/fd/2); rc=$?\nprintf '%s' \"$out\"; exit $rc"
    );
    let (shell_status, shell_out, shell_err) = bash(&hook, &project, &body, payload)?;
    let shell = scratch.take()?;
    let engine = OsStr::new("codex");
    let env = subcommand::child_env(
        &hook,
        sub.as_os_str(),
        Some(project.as_os_str()),
        &program,
        &[("NAVORI_HOOK_ENGINE", engine)],
    );
    let argv = args(&["plan", "gate", "two words"]);
    let native = subcommand::run(&Call {
        program: &program,
        args: &argv,
        cwd: &sub,
        env: &env,
        input: Input::Bytes(subcommand::substitution(payload)),
        capture: Capture::Separate,
        timeout: None,
    })?;
    let rust = scratch.take()?;
    for (index, name) in ["argv", "stdin", "env", "cwd"].iter().enumerate() {
        assert_eq!(
            String::from_utf8_lossy(&rust[index]),
            String::from_utf8_lossy(&shell[index]),
            "{name} differs"
        );
    }
    assert_eq!(native.status, shell_status);
    assert_eq!(native.status, 3);
    assert_eq!(subcommand::substitution(&native.stdout), &shell_out[..]);
    assert_eq!(native.stderr, shell_err);
    assert!(!native.timed_out);

    // `out=$(navori … 2>&1 </dev/null)`: gate foreign's call, both streams in write order.
    let body = format!(
        "out=$(navori {quoted} gate foreign 2>&1 </dev/null); rc=$?\nprintf '%s' \"$out\"; exit $rc"
    );
    let (shell_status, shell_out, _) = bash(&hook, &project, &body, b"")?;
    let shell = scratch.take()?;
    let env = subcommand::child_env(&hook, project.as_os_str(), None, &program, &[]);
    let argv = args(&["gate", "foreign"]);
    let merged = subcommand::run(&Call {
        program: &program,
        args: &argv,
        cwd: &project,
        env: &env,
        input: Input::Null,
        capture: Capture::Merged,
        timeout: None,
    })?;
    assert_eq!(scratch.take()?, shell);
    assert_eq!(merged.status, shell_status);
    assert_eq!(subcommand::substitution(&merged.stdout), &shell_out[..]);
    // After libtest's own `running 1 test` header, both streams in write order.
    assert!(subcommand::substitution(&merged.stdout).ends_with(b"out-1\nerr-1\nout-2"));
    assert!(merged.stderr.is_empty());

    // `navori … >/dev/null 2>&1`: audit --capture-child; only the status survives.
    let env = subcommand::child_env(&hook, project.as_os_str(), None, &program, &[]);
    let discarded = subcommand::run(&Call {
        program: &program,
        args: &args(&[]),
        cwd: &project,
        env: &env,
        input: Input::Bytes(&[]),
        capture: Capture::Discard,
        timeout: None,
    })?;
    assert_eq!(
        discarded,
        Finished {
            status: 3,
            stdout: Vec::new(),
            stderr: Vec::new(),
            timed_out: false,
        }
    );
    assert_eq!(scratch.take()?[1], b"");
    Ok(())
}

// Covers: R52
#[test]
fn el_plazo_mata_al_subproceso_y_no_espera_su_salida() -> TestResult {
    let scratch = Scratch::new()?;
    let project = scratch.0.join("project");
    let program = scratch.0.join("bin/navori");
    let mut hook = hook_env(&scratch);
    hook.push((SLEEP.into(), "1".into()));
    let env = subcommand::child_env(&hook, project.as_os_str(), None, &program, &[]);
    let started = Instant::now();
    let finished = subcommand::run(&Call {
        program: &program,
        args: &args(&["plan", "resume"]),
        cwd: &project,
        env: &env,
        input: Input::Null,
        capture: Capture::Separate,
        timeout: Some(Duration::from_millis(200)),
    })?;
    assert!(finished.timed_out);
    assert_eq!(finished.status, 137);
    assert!(finished.stdout.is_empty());
    assert!(started.elapsed() < Duration::from_secs(5));
    Ok(())
}

#[test]
fn child_env_follows_bash_rules_for_shlvl_and_overrides() {
    let program = Path::new("/bin/navori");
    let level = |value: Option<&str>| {
        let hook: Vec<(OsString, OsString)> = value
            .map(|v| vec![("SHLVL".into(), v.into())])
            .unwrap_or_default();
        subcommand::child_env(&hook, OsStr::new("/w"), None, program, &[])
            .into_iter()
            .find(|(name, _)| name == "SHLVL")
            .map(|(_, value)| value)
    };
    assert_eq!(level(None), Some("1".into()));
    assert_eq!(level(Some("4")), Some("5".into()));
    assert_eq!(level(Some("x")), Some("1".into()));
    let hook = vec![
        ("A".into(), "1".into()),
        ("PWD".into(), "/old".into()),
        ("NAVORI_HOOK_ENGINE".into(), "claude".into()),
    ];
    let env = subcommand::child_env(
        &hook,
        OsStr::new("/w"),
        None,
        program,
        &[("NAVORI_HOOK_ENGINE", OsStr::new("codex"))],
    );
    let get = |key: &str| {
        let found: Vec<&OsString> = env
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value)
            .collect();
        assert!(found.len() <= 1, "{key} appears once");
        found.first().map(|value| (*value).clone())
    };
    assert_eq!(get("A"), Some("1".into()));
    assert_eq!(get("PWD"), Some("/w".into()));
    assert_eq!(get("_"), Some("/bin/navori".into()));
    assert_eq!(get("NAVORI_HOOK_ENGINE"), Some("codex".into()));
    assert_eq!(get("OLDPWD"), None);
    assert_eq!(subcommand::substitution(b"a\n\n"), b"a");
    assert_eq!(subcommand::substitution(b"\n"), b"");
}
