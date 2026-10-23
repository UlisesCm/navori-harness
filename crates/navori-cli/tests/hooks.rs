//! Native hook CLI entry and preflight contract (spec 0057 R12-R13).

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use navori_cli::hook::{Invocation, Mode, NativeHook, run_with};
use navori_core::integrity::script_hash;
use navori_core::manifest::Manifest;
use navori_hooks::runner::{Evaluation, Failure, Verdict};

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
type TestResult = Result<(), Box<dyn Error>>;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "hook-entry-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.parent().ok_or("scratch parent")?)?;
        fs::create_dir(&root)?;
        Ok(Self(root))
    }

    fn script(&self, engine: &str, deps: &[&[u8]]) -> Result<PathBuf, Box<dyn Error>> {
        let path = self.0.join(engine).join("hooks/example.sh");
        fs::create_dir_all(path.parent().ok_or("hooks parent")?)?;
        let source = format!(
            "# navori:native-hook v=1 file=sha256:{} impl={HASH}\n#!/bin/sh\nexit 0\n",
            "0".repeat(64)
        );
        let hash = script_hash(source.as_bytes(), deps).ok_or("metadata")?;
        fs::write(&path, source.replacen(&"0".repeat(64), &hash[7..], 1))?;
        Ok(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct NeverRead;
impl Read for NeverRead {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        panic!("stdin must remain untouched during deferral")
    }
}

struct BrokenInput;
impl Read for BrokenInput {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("fixture input error"))
    }
}

fn manifest(gating: bool, deps: &[&str]) -> Result<Manifest, Box<dyn Error>> {
    let deps = deps
        .iter()
        .map(|path| ((*path).to_owned(), HASH))
        .collect::<std::collections::BTreeMap<_, _>>();
    Ok(Manifest::parse(&serde_json::json!({
        "schema":1, "commands":[], "hooks":{"example":{
            "mode":"active", "gating":gating, "blocks":{"example-base":HASH}, "deps":deps, "impl":HASH
        }}
    }).to_string())?)
}

fn argv(script: &Path) -> Vec<OsString> {
    vec![
        OsString::from("--via-script"),
        script.as_os_str().to_owned(),
    ]
}

fn record(payload: &[u8], invocation: &Invocation) -> Result<Evaluation, Failure> {
    let mut stdout = payload.to_vec();
    stdout.extend_from_slice(
        format!(
            "|{:?}|{:?}|{:?}",
            invocation.engine, invocation.event, invocation.args
        )
        .as_bytes(),
    );
    Ok(Evaluation {
        verdict: Verdict::Block,
        stdout,
        stderr: b"recorded\n".to_vec(),
    })
}

fn fail(_payload: &[u8], _invocation: &Invocation) -> Result<Evaluation, Failure> {
    panic!("fixture handler panic")
}

fn registry(evaluate: fn(&[u8], &Invocation) -> Result<Evaluation, Failure>) -> [NativeHook; 1] {
    [NativeHook {
        id: "example",
        implementation: HASH,
        evaluate,
    }]
}

// Covers: R12, R13
#[test]
fn unknown_binary_hook_exits_three_without_waiting_for_stdin_eof() -> TestResult {
    let mut child = Command::new(BIN)
        .args(["hook", "--via-script", "missing.sh"])
        .env_remove("NAVORI_HOOK_IMPL")
        .env("NAVORI_TS_CLI", "/no/ts/cli")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let held_open = child.stdin.take().ok_or("stdin pipe")?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            assert_eq!(status.code(), Some(3));
            break;
        }
        if started.elapsed() > Duration::from_secs(5) {
            child.kill()?;
            child.wait()?;
            return Err("unknown hook waited for stdin EOF".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    drop(held_open);
    let result = child.wait_with_output()?;
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    let forced = Command::new(BIN)
        .args(["hook", "--via-script", "missing.sh"])
        .env("NAVORI_HOOK_IMPL", "rust")
        .output()?;
    assert_eq!(forced.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&forced.stderr).contains("hook deferred"));
    Ok(())
}

// Covers: R12, R13
#[test]
fn manifest_registration_integrity_and_modes_precede_stdin() -> TestResult {
    let scratch = Scratch::new()?;
    let script = scratch.script(".claude", &[])?;
    let args = argv(&script);
    let registered = manifest(true, &[])?;
    let empty = Manifest::parse(r#"{"schema":1,"commands":[],"hooks":{}}"#)?;
    let compiled = registry(record);
    for (manifest, registry, mode, expected) in [
        (&empty, compiled.as_slice(), Mode::Auto, 3),
        (&registered, &[][..], Mode::Auto, 3),
        (&registered, compiled.as_slice(), Mode::Shell, 3),
        (&empty, &[][..], Mode::Rust, 1),
    ] {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        assert_eq!(
            run_with(
                &args,
                manifest,
                registry,
                mode,
                &mut NeverRead,
                &mut stdout,
                &mut stderr
            ),
            expected
        );
        assert!(stdout.is_empty());
    }
    fs::write(&script, "edited after render\n")?;
    for mode in [Mode::Auto, Mode::Rust] {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        assert_eq!(
            run_with(
                &args,
                &registered,
                &registry(record),
                mode,
                &mut NeverRead,
                &mut stdout,
                &mut stderr
            ),
            if mode == Mode::Rust { 1 } else { 3 }
        );
        assert!(stdout.is_empty());
    }
    Ok(())
}

// Covers: R11, R12, R13
#[test]
fn routes_all_engines_and_preserves_payload_event_and_hook_arguments() -> TestResult {
    let scratch = Scratch::new()?;
    let manifest = manifest(true, &[])?;
    for (dir, engine) in [
        (".claude", "Claude"),
        (".codex", "Codex"),
        (".pi/navori", "Pi"),
    ] {
        let script = scratch.script(dir, &[])?;
        let mut args = argv(&script);
        args.extend([OsString::from("--flag"), OsString::from("space value")]);
        let payload = b"{\"truncated\":\xff";
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let code = run_with(
            &args,
            &manifest,
            &registry(record),
            Mode::Auto,
            &mut &payload[..],
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, 2);
        let mut expected = payload.to_vec();
        expected
            .extend_from_slice(format!("|{engine}|None|[\"--flag\", \"space value\"]").as_bytes());
        assert_eq!(stdout, expected);
        assert_eq!(stderr, b"recorded\n");
    }
    let script = scratch.0.join(".claude/hooks/example.sh");
    let args = vec![
        "--via-command".into(),
        "PreToolUse".into(),
        script.into_os_string(),
        "claude-stop".into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    assert_eq!(
        run_with(
            &args,
            &manifest,
            &registry(record),
            Mode::Auto,
            &mut &b"{}"[..],
            &mut stdout,
            &mut stderr
        ),
        2
    );
    assert_eq!(stdout, b"{}|Claude|Some(\"PreToolUse\")|[\"claude-stop\"]");
    Ok(())
}

// Covers: R12
#[test]
fn input_and_handler_panics_use_the_host_safe_verdict() -> TestResult {
    let scratch = Scratch::new()?;
    for gating in [false, true] {
        let manifest = manifest(gating, &[])?;
        for dir in [".claude", ".codex", ".pi/navori"] {
            let script = scratch.script(dir, &[])?;
            for input_error in [false, true] {
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                let code = if input_error {
                    run_with(
                        &argv(&script),
                        &manifest,
                        &registry(record),
                        Mode::Auto,
                        &mut BrokenInput,
                        &mut stdout,
                        &mut stderr,
                    )
                } else {
                    run_with(
                        &argv(&script),
                        &manifest,
                        &registry(fail),
                        Mode::Auto,
                        &mut &b"{}"[..],
                        &mut stdout,
                        &mut stderr,
                    )
                };
                let expected = if !gating {
                    1
                } else if dir == ".claude" {
                    0
                } else {
                    2
                };
                assert_eq!(code, expected);
                if gating && dir == ".claude" {
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&stdout)?["hookSpecificOutput"]
                            ["permissionDecision"],
                        "ask"
                    );
                    assert!(stderr.is_empty());
                } else {
                    assert!(stdout.is_empty());
                    assert!(!stderr.is_empty());
                }
            }
        }
    }
    Ok(())
}

// Covers: R12, R13
#[test]
fn changed_or_escaping_dependencies_and_shadow_never_consume_stdin() -> TestResult {
    let scratch = Scratch::new()?;
    let dep = b"dependency\n";
    let script = scratch.script(".codex", &[dep])?;
    let root = scratch.0.join(".codex");
    fs::create_dir_all(root.join("scripts"))?;
    fs::write(root.join("scripts/dep.sh"), dep)?;
    let good = manifest(true, &["scripts/dep.sh"])?;
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    assert_eq!(
        run_with(
            &argv(&script),
            &good,
            &registry(record),
            Mode::Auto,
            &mut &b"{}"[..],
            &mut stdout,
            &mut stderr
        ),
        2
    );
    fs::write(root.join("scripts/dep.sh"), b"edited\n")?;
    assert_eq!(
        run_with(
            &argv(&script),
            &good,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    fs::write(scratch.0.join("external.sh"), dep)?;
    symlink(
        scratch.0.join("external.sh"),
        root.join("scripts/escape.sh"),
    )?;
    for name in ["../external.sh", "scripts/escape.sh", "/absolute/dep.sh"] {
        assert_eq!(
            run_with(
                &argv(&script),
                &manifest(true, &[name])?,
                &registry(record),
                Mode::Auto,
                &mut NeverRead,
                &mut Vec::new(),
                &mut Vec::new()
            ),
            3
        );
    }
    let mut shadow_args = argv(&script);
    shadow_args.extend(["--shadow".into(), "own-arg".into()]);
    assert_eq!(
        run_with(
            &shadow_args,
            &good,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    let mut shadow = good;
    shadow.hooks.get_mut("example").ok_or("hook")?.mode = navori_core::manifest::HookMode::Shadow;
    assert_eq!(
        run_with(
            &argv(&script),
            &shadow,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    Ok(())
}

// Covers: R12, R13
#[test]
fn compiled_hash_mismatch_and_non_engine_script_paths_defer() -> TestResult {
    let scratch = Scratch::new()?;
    let script = scratch.script(".claude", &[])?;
    let manifest = manifest(true, &[])?;
    let wrong = [NativeHook {
        id: "example",
        implementation: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evaluate: record,
    }];
    assert_eq!(
        run_with(
            &argv(&script),
            &manifest,
            &wrong,
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    let external = scratch.0.join("example.sh");
    fs::copy(&script, &external)?;
    assert_eq!(
        run_with(
            &argv(&external),
            &manifest,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    Ok(())
}

// Covers: R12
#[test]
fn non_pretooluse_claude_event_stays_advisory_for_a_gating_manifest_entry() -> TestResult {
    let scratch = Scratch::new()?;
    let script = scratch.script(".claude", &[])?;
    let args = vec![
        "--via-command".into(),
        "Stop".into(),
        script.into_os_string(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    assert_eq!(
        run_with(
            &args,
            &manifest(true, &[])?,
            &registry(fail),
            Mode::Auto,
            &mut &b"{}"[..],
            &mut stdout,
            &mut stderr
        ),
        1
    );
    assert!(stdout.is_empty());
    assert!(String::from_utf8_lossy(&stderr).contains("fixture handler panic"));
    Ok(())
}

// Covers: R13
#[test]
fn a_symlink_cannot_change_the_engine_protocol_of_a_hook_invocation() -> TestResult {
    let scratch = Scratch::new()?;
    scratch.script(".codex", &[])?;
    symlink(scratch.0.join(".codex"), scratch.0.join(".claude"))?;
    let requested = scratch.0.join(".claude/hooks/example.sh");
    assert_eq!(
        run_with(
            &argv(&requested),
            &manifest(true, &[])?,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    Ok(())
}

// Covers: R12
#[test]
fn non_claude_command_events_keep_the_manifest_gating_contract() -> TestResult {
    let scratch = Scratch::new()?;
    let script = scratch.script(".pi/navori", &[])?;
    let args = vec![
        "--via-command".into(),
        "tool_call".into(),
        script.into_os_string(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    assert_eq!(
        run_with(
            &args,
            &manifest(true, &[])?,
            &registry(fail),
            Mode::Auto,
            &mut &b"{}"[..],
            &mut stdout,
            &mut stderr
        ),
        2
    );
    assert!(stdout.is_empty());
    assert!(!stderr.is_empty());
    Ok(())
}

// Covers: R13
#[test]
fn a_hooks_directory_symlink_cannot_redirect_to_another_root_of_the_same_engine() -> TestResult {
    let source = Scratch::new()?;
    let destination = Scratch::new()?;
    let target = destination.script(".claude", &[])?;
    fs::create_dir_all(source.0.join(".claude"))?;
    symlink(
        target.parent().ok_or("target hooks")?,
        source.0.join(".claude/hooks"),
    )?;
    let requested = source.0.join(".claude/hooks/example.sh");
    assert_eq!(
        run_with(
            &argv(&requested),
            &manifest(true, &[])?,
            &registry(record),
            Mode::Auto,
            &mut NeverRead,
            &mut Vec::new(),
            &mut Vec::new()
        ),
        3
    );
    Ok(())
}

// Covers: R7, R13
#[test]
fn same_pid_hook_recursion_exits_70_while_a_real_child_still_defers() -> TestResult {
    // A non-exec shell must stay alive so its token belongs to the parent, not the Rust child.
    let child = Command::new("sh")
        .args([
            "-c",
            "NAVORI_DELEGATED=$$ \"$1\" hook --via-script missing.sh; exit $?",
            "hook-child",
            BIN,
        ])
        .env_remove("NAVORI_HOOK_IMPL")
        .output()?;
    assert_eq!(child.status.code(), Some(3));
    assert!(child.stdout.is_empty());
    assert!(child.stderr.is_empty());

    // exec preserves the shell PID; the startup loop marker must win over hook deferral.
    let recursive = Command::new("sh")
        .args([
            "-c",
            "NAVORI_DELEGATED=$$ exec \"$1\" hook --via-script missing.sh",
            "hook-loop",
            BIN,
        ])
        .env_remove("NAVORI_HOOK_IMPL")
        .output()?;
    assert_eq!(recursive.status.code(), Some(70));
    assert!(recursive.stdout.is_empty());
    assert!(String::from_utf8_lossy(&recursive.stderr).contains("delegation loop"));
    Ok(())
}
