//! A subcommand left to the `navori` of `PATH` (spec 0059 T4, D30, R52): it receives the arguments,
//! the stdin and the environment the shell gives it, and its result is read as `$(… 2>&1)` reads
//! it.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use navori_hooks::shell::delegated_subcommand::{Call, Status, run};

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);

impl Temp {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("delegated-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(&root)?;
        Ok(Self(root))
    }

    /// An executable `navori` with `body`.
    fn program(&self, body: &str) -> Result<PathBuf, Box<dyn Error>> {
        let path = self.0.join("navori");
        fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(path)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn os(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}

fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

fn call<'a>(
    program: &'a Path,
    args: &'a [OsString],
    stdin: &'a [u8],
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
) -> Call<'a> {
    Call {
        program,
        args,
        stdin,
        env,
        cwd,
        deadline: None,
    }
}

// Covers: R52
#[test]
fn the_subprocess_receives_argv_stdin_and_environment_of_the_shell() -> TestResult {
    let temp = Temp::new("receives")?;
    let log = temp.0.join("log");
    // Records what it was given, byte for byte, and answers on both streams.
    let program = temp.program(&format!(
        "printf '%s\\n' \"$#\" > '{log}.argc'\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done > '{log}.argv'\ncat > '{log}.stdin'\nprintf '%s|%s|%s' \"$NAVORI_HOOK_ENGINE\" \"$KEPT\" \"${{UNSET:-gone}}\" > '{log}.env'\npwd > '{log}.cwd'\necho out\necho err >&2\nexit 2",
        log = log.display()
    ))?;
    let args = os(&["plan", "gate", "with space", "-x", ""]);
    // No trailing newline and an embedded NUL-free multi-line payload, as the shell's variable.
    let payload = b"{\"tool_name\":\"Agent\"}\nline two";
    let environment = env(&[("NAVORI_HOOK_ENGINE", "codex"), ("KEPT", "yes")]);
    let captured = run(&call(&program, &args, payload, &environment, &temp.0));

    assert_eq!(captured.status, Status::Exited(2));
    assert_eq!(fs::read_to_string(temp.0.join("log.argc"))?, "5\n");
    assert_eq!(
        fs::read_to_string(temp.0.join("log.argv"))?,
        "[plan][gate][with space][-x][]"
    );
    assert_eq!(fs::read(temp.0.join("log.stdin"))?, payload);
    // The environment is exactly the one given: a variable the caller did not pass is absent.
    assert_eq!(
        fs::read_to_string(temp.0.join("log.env"))?,
        "codex|yes|gone"
    );
    assert_eq!(
        fs::canonicalize(fs::read_to_string(temp.0.join("log.cwd"))?.trim_end())?,
        fs::canonicalize(&temp.0)?
    );
    // `2>&1`: both streams, in the order they were written.
    assert_eq!(captured.merged, b"out\nerr\n");
    assert_eq!(captured.substituted(), b"out\nerr");
    Ok(())
}

// Covers: R52
#[test]
fn the_result_is_read_as_a_command_substitution_reads_it() -> TestResult {
    let temp = Temp::new("substitution")?;
    let program = temp.program("printf 'a\\0b\\n\\n\\nc \\n\\n'; exit 0")?;
    let captured = run(&call(&program, &[], b"", &[], &temp.0));
    // NUL bytes are dropped, interior newlines stay, every final newline goes.
    assert_eq!(captured.substituted(), b"ab\n\n\nc ");
    assert_eq!(captured.merged, b"a\0b\n\n\nc \n\n");

    // A child that never reads its stdin does not break the call, whatever the payload size.
    let quiet = temp.program("echo done")?;
    let big = vec![b'x'; 4 * 1024 * 1024];
    let captured = run(&call(&quiet, &[], &big, &[], &temp.0));
    assert_eq!(
        (captured.status, captured.substituted()),
        (Status::Exited(0), b"done".to_vec())
    );
    Ok(())
}

// Covers: R52
#[test]
fn the_result_equals_what_bash_makes_of_the_same_pipeline() -> TestResult {
    let temp = Temp::new("bash")?;
    let bodies = [
        "echo hi",
        "printf 'no newline'",
        "printf 'x\\n\\n\\n'; exit 3",
        "echo out; echo err >&2; echo out2; exit 1",
        "printf 'a\\0b'; printf 'c\\n'",
        "printf '  lead\\n\\n  trail  \\n\\n'",
        "cat; echo; echo done >&2; exit 64",
        "printf '\\n\\n'",
        "printf 'caf\\303\\251 \\377 \\r\\n'",
    ];
    let payload = b"{\"a\":1}\nsecond";
    let path = std::env::var_os("PATH").unwrap_or_default();
    for body in bodies {
        let program = temp.program(body)?;
        let payload_file = temp.0.join("payload");
        fs::write(&payload_file, payload)?;
        // `payload=$(cat); out=$(printf '%s' "$payload" | navori 2>&1); rc=$?`
        let script = format!(
            "payload=$(cat '{}'); out=$(printf '%s' \"$payload\" | '{}' 2>&1); rc=$?; printf '%s' \"$rc\"; printf '\\0'; printf '%s' \"$out\"",
            payload_file.display(),
            program.display()
        );
        let bash = std::process::Command::new("bash")
            .args(["-c", &script])
            .env("PATH", &path)
            .output()?;
        let mut parts = bash.stdout.splitn(2, |b| *b == 0);
        let rc: i32 = String::from_utf8(parts.next().unwrap_or_default().to_vec())?.parse()?;
        let expected = parts.next().unwrap_or_default().to_vec();

        let environment = [("PATH".into(), path.clone())];
        let captured = run(&call(&program, &[], payload, &environment, &temp.0));
        assert_eq!(captured.status.code(), rc, "status of {body:?}");
        assert_eq!(captured.substituted(), expected, "output of {body:?}");
    }
    Ok(())
}

// Covers: R52
#[test]
fn the_status_is_what_the_shell_reads_from_a_dollar_question() -> TestResult {
    let temp = Temp::new("status")?;
    for code in [0, 1, 2, 64, 127] {
        let program = temp.program(&format!("exit {code}"))?;
        let captured = run(&call(&program, &[], b"", &[], &temp.0));
        assert_eq!(
            (captured.status, captured.status.code()),
            (Status::Exited(code), code)
        );
    }
    // A signal is `128 + n`, as `$?` reports it.
    let program = temp.program("kill -TERM $$")?;
    let captured = run(&call(&program, &[], b"", &[], &temp.0));
    assert_eq!(
        (captured.status, captured.status.code()),
        (Status::Signaled(15), 143)
    );

    // A program that is not there is 127, one that cannot run is 126, with nothing printed.
    let missing = run(&call(&temp.0.join("absent"), &[], b"", &[], &temp.0));
    assert_eq!(
        (missing.status.code(), missing.merged.is_empty()),
        (127, true)
    );
    let plain = temp.0.join("plain");
    fs::write(&plain, "#!/bin/sh\n")?;
    let denied = run(&call(&plain, &[], b"", &[], &temp.0));
    assert_eq!(
        (denied.status.code(), denied.merged.is_empty()),
        (126, true)
    );
    Ok(())
}

// Covers: R52
#[test]
fn a_deadline_kills_the_child_and_no_deadline_leaves_the_bound_to_the_host() -> TestResult {
    let temp = Temp::new("deadline")?;
    let slow = temp.program("echo started\nexec sleep 30")?;
    let started = Instant::now();
    let captured = run(&Call {
        deadline: Some(Duration::from_millis(200)),
        ..call(
            &slow,
            &[],
            b"",
            &[("PATH".into(), std::env::var_os("PATH").unwrap_or_default())],
            &temp.0,
        )
    });
    assert_eq!(captured.status, Status::TimedOut);
    assert_eq!(captured.status.code(), 137);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(captured.substituted(), b"started");

    // Without a deadline the call simply waits for the child, as the shell does.
    let quick = temp.program("sleep 0.2; echo late")?;
    let path = [("PATH".into(), std::env::var_os("PATH").unwrap_or_default())];
    let captured = run(&call(&quick, &[], b"", &path, &temp.0));
    assert_eq!(
        (captured.status, captured.substituted()),
        (Status::Exited(0), b"late".to_vec())
    );
    Ok(())
}
