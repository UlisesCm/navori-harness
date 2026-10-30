//! Executable shadow transport and safe failure contract (0057 R11/R12).

use std::cell::Cell;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use navori_cli::shadow::{ShellInvocation, run};
use navori_hooks::runner::{self, Context, Engine, Evaluation, Failure, Response, Verdict};

type TestResult = Result<(), Box<dyn Error>>;

struct Fixture {
    root: PathBuf,
    script: PathBuf,
    env: Vec<(OsString, OsString)>,
}

impl Fixture {
    fn new(body: &str) -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "shadow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.parent().ok_or("scratch parent")?)?;
        fs::create_dir(&root)?;
        let script = root.join("fixture.sh");
        fs::write(&script, body)?;
        Ok(Self {
            root,
            script,
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        })
    }

    fn invocation<'a>(&'a self, args: &'a [OsString]) -> ShellInvocation<'a> {
        ShellInvocation {
            script: &self.script,
            args,
            cwd: &self.root,
            env: &self.env,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn context(engine: Engine, gating: bool) -> Context<'static> {
    Context {
        engine,
        hook: "fixture",
        gating,
    }
}

fn evaluation(verdict: Verdict, stdout: &[u8], stderr: &[u8]) -> Evaluation {
    Evaluation {
        verdict,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
        audit: None,
    }
}

fn assert_safe(response: &Response, engine: Engine, gating: bool) -> TestResult {
    if engine == Engine::Claude && gating {
        assert_eq!(response.code(), 0);
        let output: serde_json::Value = serde_json::from_slice(response.stdout())?;
        assert_eq!(output["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "ask");
        assert!(response.stderr().is_empty());
    } else {
        assert_eq!(response.code(), if gating { 2 } else { 1 });
        assert!(response.stdout().is_empty());
        assert!(!response.stderr().is_empty());
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn exact_bytes_argv_event_env_cwd_and_all_valid_shell_codes_are_authoritative_once() -> TestResult {
    let mut fixture = Fixture::new(
        r#"
printf x >> "$COUNTER"
if [ "$NAVORI_HOOK_IMPL" != shell ]; then printf recursive >&2; exit 101; fi
printf '%s\0' "$PWD" "$@" "$HOOK_EVENT_NAME" "$KEPT_VALUE" "$NAVORI_HOOK_IMPL"
cat
printf 'shell diagnostic\0' >&2
exit "$3"
"#,
    )?;
    let counter = fixture.root.join("counter");
    fixture.env.extend([
        ("COUNTER".into(), counter.as_os_str().to_owned()),
        ("HOOK_EVENT_NAME".into(), "Stop".into()),
        ("KEPT_VALUE".into(), "value\nwith spaces ñ".into()),
        ("NAVORI_HOOK_IMPL".into(), "rust".into()),
    ]);
    let payload = b"invalid json\0\xff\r\n";
    for (code, verdict) in [
        (0, Verdict::Permit),
        (1, Verdict::Error),
        (2, Verdict::Block),
    ] {
        let args: [OsString; 3] = [
            "literal $(touch should-not-exist)".into(),
            "".into(),
            code.to_string().into(),
        ];
        let mut expected = fs::canonicalize(&fixture.root)?
            .to_string_lossy()
            .as_bytes()
            .to_vec();
        expected.push(0);
        for arg in &args {
            expected.extend_from_slice(arg.as_encoded_bytes());
            expected.push(0);
        }
        expected.extend_from_slice(b"Stop\0value\nwith spaces \xc3\xb1\0shell\0");
        expected.extend_from_slice(payload);
        let calls = Cell::new(0);
        let result = run(
            context(Engine::Claude, false),
            payload,
            fixture.invocation(&args),
            |bytes| {
                calls.set(calls.get() + 1);
                assert_eq!(bytes, payload);
                Ok(evaluation(verdict, &expected, b"shell diagnostic\0"))
            },
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(result.shell.code(), code);
        assert_eq!(result.shell.stdout(), expected);
        assert_eq!(result.shell.stderr(), b"shell diagnostic\0");
        assert!(!result.comparison.diverged());
    }
    assert_eq!(fs::read(counter)?, b"xxx");
    assert!(!fixture.root.join("should-not-exist").exists());
    Ok(())
}

// Covers: R11, R12
#[test]
fn large_binary_input_and_both_large_output_pipes_make_progress_concurrently() -> TestResult {
    let fixture = Fixture::new(
        r#"
dd if=/dev/zero bs=65536 count=8 2>/dev/null
dd if=/dev/zero bs=65536 count=8 >&2 2>/dev/null
cat
"#,
    )?;
    let payload: Vec<u8> = (0_u8..=255).cycle().take(2 * 1024 * 1024).collect();
    let mut stdout = vec![0; 8 * 65536];
    stdout.extend_from_slice(&payload);
    let stderr = vec![0; 8 * 65536];
    let result = run(
        context(Engine::Codex, true),
        &payload,
        fixture.invocation(&[]),
        |bytes| {
            assert_eq!(bytes, payload);
            Ok(evaluation(Verdict::Permit, &stdout, &stderr))
        },
    );
    assert_eq!(result.shell.code(), 0);
    assert_eq!(result.shell.stdout(), stdout);
    assert_eq!(result.shell.stderr(), stderr);
    assert!(!result.comparison.diverged());
    Ok(())
}

// Covers: R11, R12
#[test]
fn intentional_early_stdin_close_preserves_every_valid_shell_verdict() -> TestResult {
    let payload = vec![b'x'; 2 * 1024 * 1024];
    for prefix in ["exec 0<&-", "head -c 1 >/dev/null"] {
        for (code, verdict) in [
            (0, Verdict::Permit),
            (1, Verdict::Error),
            (2, Verdict::Block),
        ] {
            let fixture = Fixture::new(&format!("{prefix}\nprintf accepted\nexit {code}\n"))?;
            let result = run(
                context(Engine::Claude, true),
                &payload,
                fixture.invocation(&[]),
                |_| Ok(evaluation(verdict, b"accepted", b"")),
            );
            assert_eq!(result.shell.code(), code);
            assert_eq!(result.shell.stdout(), b"accepted");
            assert!(!result.comparison.diverged());
        }
    }
    Ok(())
}

// Covers: R11, R12
#[test]
fn native_errors_and_panics_never_replace_a_valid_shell_verdict() -> TestResult {
    for code in 0..=2 {
        let fixture = Fixture::new(&format!(
            "printf shell\nprintf diagnostic >&2\nexit {code}\n"
        ))?;
        for panic in [false, true] {
            let result = run(
                context(Engine::Claude, true),
                b"payload",
                fixture.invocation(&[]),
                |_| {
                    if panic {
                        panic!("native details must not reach the host");
                    }
                    Err(Failure("native details must not reach the host".to_owned()))
                },
            );
            assert_eq!(result.shell.code(), code);
            assert_eq!(result.shell.stdout(), b"shell");
            assert_eq!(result.shell.stderr(), b"diagnostic");
            assert!(result.comparison.native_failed);
            assert!(!result.comparison.shell_failed);
            assert!(result.comparison.diverged());
        }
    }
    Ok(())
}

// Covers: R11
#[test]
fn divergence_reports_code_stdout_and_stderr_independently() -> TestResult {
    let fixture = Fixture::new("printf shell\nprintf stderr >&2\nexit 1\n")?;
    for (verdict, stdout, stderr, expected) in [
        (
            Verdict::Permit,
            b"shell".as_slice(),
            b"stderr".as_slice(),
            (true, false, false),
        ),
        (
            Verdict::Error,
            b"other".as_slice(),
            b"stderr".as_slice(),
            (false, true, false),
        ),
        (
            Verdict::Error,
            b"shell".as_slice(),
            b"other".as_slice(),
            (false, false, true),
        ),
    ] {
        let result = run(
            context(Engine::Pi, true),
            b"",
            fixture.invocation(&[]),
            |_| Ok(evaluation(verdict, stdout, stderr)),
        );
        let observed = result.comparison;
        assert!(!observed.native_failed && !observed.shell_failed);
        assert_eq!(
            (
                observed.code_differs,
                observed.stdout_differs,
                observed.stderr_differs
            ),
            expected
        );
        assert!(observed.diverged());
        assert_eq!(result.shell.code(), 1);
    }
    Ok(())
}

// Covers: R12
#[test]
fn shell_signals_and_abnormal_codes_discard_partial_output_and_use_engine_safety() -> TestResult {
    for end in [
        "kill -KILL $$",
        "kill -ABRT $$",
        "exit 101",
        "exit 3",
        "exit 126",
        "exit 127",
    ] {
        let fixture = Fixture::new(&format!(
            "ulimit -c 0\nprintf partial-payload\nprintf partial-diagnostic >&2\n{end}\n"
        ))?;
        for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
            for gating in [false, true] {
                let result = run(
                    context(engine, gating),
                    b"",
                    fixture.invocation(&[]),
                    |_| Ok(evaluation(Verdict::Permit, b"", b"")),
                );
                assert_safe(&result.shell, engine, gating)?;
                assert!(result.comparison.shell_failed);
                assert!(result.comparison.diverged());
                assert!(
                    !String::from_utf8_lossy(result.shell.stdout()).contains("partial-payload")
                );
                assert!(
                    !String::from_utf8_lossy(result.shell.stderr()).contains("partial-diagnostic")
                );
            }
        }
    }
    Ok(())
}

// Covers: R12
#[test]
fn missing_bash_uses_snapshot_path_and_safe_policy_without_inherited_fallback() -> TestResult {
    let mut fixture = Fixture::new("printf must-not-run\n")?;
    fixture.env = vec![(
        "PATH".into(),
        fixture.root.join("missing-bin").into_os_string(),
    )];
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        for gating in [false, true] {
            let result = run(
                context(engine, gating),
                b"input",
                fixture.invocation(&[]),
                |_| Ok(evaluation(Verdict::Permit, b"native", b"")),
            );
            assert_safe(&result.shell, engine, gating)?;
            assert!(result.comparison.shell_failed);
        }
    }
    Ok(())
}

struct Closed;
impl Write for Closed {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        Err(io::ErrorKind::BrokenPipe.into())
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::BrokenPipe.into())
    }
}

// Covers: R12
#[test]
fn consumers_publish_buffered_shadow_results_with_the_existing_closed_writer_policy() -> TestResult
{
    let fixture = Fixture::new("printf complete\n")?;
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        for gating in [false, true] {
            let context = context(engine, gating);
            let result = run(context, b"", fixture.invocation(&[]), |_| {
                Ok(evaluation(Verdict::Permit, b"complete", b""))
            });
            assert_eq!(
                runner::emit(context, &result.shell, &mut Closed, &mut Vec::new()),
                if gating { 2 } else { 1 }
            );
        }
    }
    Ok(())
}

// Covers: R50 (spec 0059 D40)
#[test]
fn an_unobserved_native_lane_is_not_a_divergence_and_the_shell_still_answers() -> TestResult {
    let fixture = Fixture::new("printf shell; exit 2\n")?;
    let observed = run(
        context(Engine::Codex, true),
        b"{}",
        fixture.invocation(&[]),
        |_| Err(runner::unobserved()),
    );
    assert_eq!(
        (observed.shell.code(), observed.shell.stdout()),
        (2, b"shell".as_slice())
    );
    let comparison = observed.comparison;
    assert!(comparison.native_unobserved);
    assert!(!comparison.native_failed && !comparison.code_differs && !comparison.diverged());
    let failed = run(
        context(Engine::Codex, true),
        b"{}",
        fixture.invocation(&[]),
        |_| Err(Failure("native bug".to_owned())),
    );
    assert!(!failed.comparison.native_unobserved && failed.comparison.diverged());
    Ok(())
}
