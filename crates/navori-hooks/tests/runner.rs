//! Contract tests for the buffered runtime (spec 0057 D6).

use std::io::{self, Read, Write};

use navori_hooks::runner::{Context, Engine, Evaluation, Failure, Verdict, emit, run};

fn context(engine: Engine, gating: bool) -> Context<'static> {
    Context {
        engine,
        hook: "example",
        gating,
    }
}

fn output(verdict: Verdict) -> Evaluation {
    Evaluation {
        verdict,
        stdout: b"complete stdout\n".to_vec(),
        stderr: b"complete stderr\n".to_vec(),
        audit: None,
    }
}

struct Unreadable;

impl Read for Unreadable {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("unreadable stdin"))
    }
}

// Covers: R12
#[test]
fn panic_in_gating_hook_emits_the_hosts_safe_verdict() {
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        let result = run(
            context(engine, true),
            &mut &b"{}"[..],
            || Ok(true),
            |_| {
                let mut partial = output(Verdict::Permit);
                partial.stdout.extend_from_slice(b"unfinished");
                panic!("failed \"evaluation\"\nline");
            },
        );
        if engine == Engine::Claude {
            assert_eq!(result.code(), 0);
            let stdout = String::from_utf8_lossy(result.stdout());
            assert!(stdout.starts_with(r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"#));
            assert!(stdout.contains(r#"panic: failed \"evaluation\"\nline"#));
            assert!(!stdout.contains("unfinished"));
            assert!(result.stderr().is_empty());
        } else {
            assert_eq!(result.code(), 2);
            assert!(result.stdout().is_empty());
            assert!(String::from_utf8_lossy(result.stderr()).contains("panic: failed"));
        }
    }
}

// Covers: R12
#[test]
fn input_and_handler_errors_are_controlled_failures() {
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        for gating in [false, true] {
            let ctx = context(engine, gating);
            let input_error = run(
                ctx,
                &mut Unreadable,
                || Ok(true),
                |_| panic!("handler must not run after input failure"),
            );
            let handler_error = run(
                ctx,
                &mut &b"{}"[..],
                || Ok(true),
                |_| Err(Failure("handler error".to_owned())),
            );
            let integrity_error = run(
                ctx,
                &mut Unreadable,
                || Err(Failure("integrity error".to_owned())),
                |_| panic!("handler must not run after integrity failure"),
            );
            for response in [input_error, handler_error, integrity_error] {
                let expected = if !gating {
                    1
                } else if engine == Engine::Claude {
                    0
                } else {
                    2
                };
                assert_eq!(response.code(), expected);
                assert!(!response.stdout().is_empty() || !response.stderr().is_empty());
            }
        }
    }
}

// Covers: R12
#[test]
fn deferral_happens_before_stdin_is_read_and_never_calls_the_handler() {
    let result = run(
        context(Engine::Codex, true),
        &mut Unreadable,
        || Ok(false),
        |_| panic!("deferred hook must not run"),
    );
    assert_eq!(result.code(), 3);
    assert!(result.stdout().is_empty());
    assert!(result.stderr().is_empty());
}

// Covers: R11, R12
#[test]
fn preserves_shell_verdict_and_exact_bytes_including_invalid_input() {
    for verdict in [Verdict::Permit, Verdict::Error, Verdict::Block] {
        let payload = b"{\"truncated\":\xff";
        let result = run(
            context(Engine::Claude, true),
            &mut &payload[..],
            || Ok(true),
            |bytes| {
                assert_eq!(bytes, payload);
                Ok(output(verdict))
            },
        );
        assert_eq!(
            result.code(),
            match verdict {
                Verdict::Permit => 0,
                Verdict::Error => 1,
                Verdict::Block => 2,
            }
        );
        assert_eq!(result.stdout(), b"complete stdout\n");
        assert_eq!(result.stderr(), b"complete stderr\n");
    }
}

// Covers: R12
#[test]
fn non_gating_panics_exit_one_and_captures_do_not_leak_between_calls() {
    let ctx = context(Engine::Claude, false);
    let failure = run(ctx, &mut &b""[..], || Ok(true), |_| panic!("first failure"));
    assert_eq!(failure.code(), 1);
    assert!(failure.stdout().is_empty());
    let success = run(
        ctx,
        &mut &b""[..],
        || Ok(true),
        |_| Ok(output(Verdict::Permit)),
    );
    assert_eq!(success.code(), 0);
    assert_eq!(success.stderr(), b"complete stderr\n");
}

struct BrokenWriter {
    panic: bool,
    partial: bool,
    bytes: Vec<u8>,
}

impl Write for BrokenWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.partial && self.bytes.is_empty() && !bytes.is_empty() {
            self.bytes.push(bytes[0]);
            return Ok(1);
        }
        if self.panic {
            panic!("fixture writer panic");
        }
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "fixture closed output",
        ))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Covers: R12
#[test]
fn writer_failure_or_panic_never_permits_a_partial_gating_result() {
    for engine in [Engine::Claude, Engine::Codex, Engine::Pi] {
        for gating in [false, true] {
            for panic in [false, true] {
                let ctx = context(engine, gating);
                let response = run(
                    ctx,
                    &mut &b"{}"[..],
                    || Ok(true),
                    |_| Ok(output(Verdict::Permit)),
                );
                let mut writer = BrokenWriter {
                    panic,
                    partial: true,
                    bytes: Vec::new(),
                };
                let mut stderr = Vec::new();
                assert_eq!(
                    emit(ctx, &response, &mut writer, &mut stderr),
                    if gating { 2 } else { 1 }
                );
                assert_eq!(writer.bytes.len(), 1);
                assert!(String::from_utf8_lossy(&stderr).contains("could not publish"));
            }
        }
    }
}

// Covers: R12
#[test]
fn emission_preserves_bytes_and_a_broken_diagnostic_channel_is_safe() {
    let ctx = context(Engine::Codex, true);
    let response = run(
        ctx,
        &mut &b"{}"[..],
        || Ok(true),
        |_| Ok(output(Verdict::Block)),
    );
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    assert_eq!(emit(ctx, &response, &mut stdout, &mut stderr), 2);
    assert_eq!(stdout, b"complete stdout\n");
    assert_eq!(stderr, b"complete stderr\n");
    for panic in [false, true] {
        let mut stderr = BrokenWriter {
            panic,
            partial: false,
            bytes: Vec::new(),
        };
        assert_eq!(emit(ctx, &response, &mut Vec::new(), &mut stderr), 2);
    }
}
