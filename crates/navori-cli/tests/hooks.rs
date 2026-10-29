//! Native hook CLI entry and preflight contract (spec 0057 R12-R13).

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use navori_cli::hook::{Handler, Invocation, Mode, NativeHook, run_with};
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
        self.script_body(engine, "#!/bin/sh\nexit 0\n", deps)
    }

    fn script_body(
        &self,
        engine: &str,
        body: &str,
        deps: &[&[u8]],
    ) -> Result<PathBuf, Box<dyn Error>> {
        let path = self.0.join(engine).join("hooks/example.sh");
        fs::create_dir_all(path.parent().ok_or("hooks parent")?)?;
        let source = format!(
            "# navori:native-hook v=1 file=sha256:{} impl={HASH}\n{body}",
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
        audit: None,
    })
}

fn fail(_payload: &[u8], _invocation: &Invocation) -> Result<Evaluation, Failure> {
    panic!("fixture handler panic")
}

fn registry(evaluate: fn(&[u8], &Invocation) -> Result<Evaluation, Failure>) -> [NativeHook; 1] {
    [NativeHook {
        id: "example",
        implementation: HASH,
        handler: Handler::Pure(evaluate),
        phase: |_| Some("PreToolUse"),
        tool: None,
    }]
}

mod shadow_dispatch {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStringExt;

    static SERIAL: Mutex<()> = Mutex::new(());
    static OBSERVED: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

    fn observe(payload: &[u8], invocation: &Invocation) -> Result<Evaluation, Failure> {
        OBSERVED
            .lock()
            .map_err(|_| Failure("observation lock".to_owned()))?
            .push(payload.to_vec());
        record(payload, invocation)
    }

    fn native_error(payload: &[u8], invocation: &Invocation) -> Result<Evaluation, Failure> {
        observe(payload, invocation)?;
        Err(Failure("native fixture error".to_owned()))
    }

    fn native_panic(payload: &[u8], invocation: &Invocation) -> Result<Evaluation, Failure> {
        observe(payload, invocation)?;
        panic!("native fixture panic")
    }

    fn shadow_manifest(gating: bool) -> Result<Manifest, Box<dyn Error>> {
        let mut manifest = manifest(gating, &[])?;
        manifest.hooks.get_mut("example").ok_or("hook")?.mode =
            navori_core::manifest::HookMode::Shadow;
        Ok(manifest)
    }

    struct Once<'a> {
        remaining: &'a [u8],
        eof: bool,
    }
    impl Read for Once<'_> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.eof {
                return Err(io::Error::other("stdin traversed twice"));
            }
            let size = bytes.len().min(self.remaining.len());
            bytes[..size].copy_from_slice(&self.remaining[..size]);
            self.remaining = &self.remaining[size..];
            self.eof = size == 0;
            Ok(size)
        }
    }

    struct PartialFailure {
        delivered: bool,
        reads: usize,
    }
    impl Read for PartialFailure {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if self.delivered {
                return Err(io::Error::other("fixture partial read failure"));
            }
            let data = b"partial payload";
            let size = bytes.len().min(data.len());
            bytes[..size].copy_from_slice(&data[..size]);
            self.delivered = true;
            Ok(size)
        }
    }

    /// Assert the explicit D6 engine/event expectation, without accepting leaked lane output.
    fn assert_safe(code: u8, stdout: &[u8], stderr: &[u8], expected: u8) -> TestResult {
        assert_eq!(code, expected);
        if expected == 0 {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(stdout)?["hookSpecificOutput"]["permissionDecision"],
                "ask"
            );
            assert!(stderr.is_empty());
        } else {
            assert!(stdout.is_empty());
            assert!(!stderr.is_empty());
        }
        assert!(!String::from_utf8_lossy(stdout).contains("unsafe-shell"));
        assert!(!String::from_utf8_lossy(stderr).contains("unsafe-shell"));
        Ok(())
    }

    // Covers: R11, R12, R13
    #[test]
    fn auto_shadow_returns_one_shell_with_the_same_payload_cwd_env_and_exact_arguments()
    -> TestResult {
        let _serial = SERIAL.lock()?;
        let scratch = Scratch::new()?;
        let counter = scratch.0.join("shell-count");
        let script = scratch.script_body(".claude", "printf x >> \"$1\"\nprintf '%s\\0' \"$PWD\" \"$PATH\" \"$NAVORI_HOOK_IMPL\" \"$@\"\ncat\nprintf 'shell-only\\n\\n' >&2\nexit 2\n", &[])?;
        let payload = b"payload\0\xff\n\n";
        let own_args = [
            counter.as_os_str().to_owned(),
            "".into(),
            "space value".into(),
            "literal;$(never)".into(),
            OsString::from_vec(vec![0xff, b'x']),
            "--shadow".into(),
        ];
        for (index, (descriptor_shadow, explicit)) in [(true, false), (false, true), (true, true)]
            .into_iter()
            .enumerate()
        {
            OBSERVED.lock()?.clear();
            let manifest = if descriptor_shadow {
                shadow_manifest(true)?
            } else {
                manifest(true, &[])?
            };
            let mut args = argv(&script);
            if explicit {
                args.push("--shadow".into());
            }
            args.extend(own_args.iter().cloned());
            let mut input = Once {
                remaining: payload,
                eof: false,
            };
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            assert_eq!(
                run_with(
                    &args,
                    &manifest,
                    &registry(observe),
                    Mode::Auto,
                    &mut input,
                    &mut stdout,
                    &mut stderr
                ),
                2
            );
            assert!(input.eof);
            assert_eq!(OBSERVED.lock()?.as_slice(), &[payload.to_vec()]);
            assert_eq!(fs::read(&counter)?, vec![b'x'; index + 1]);
            let cwd = std::env::current_dir()?;
            let path = std::env::var_os("PATH").ok_or("test PATH")?;
            let mut expected = Vec::new();
            for field in [cwd.as_os_str(), path.as_os_str(), OsStr::new("shell")]
                .into_iter()
                .chain(own_args.iter().map(OsString::as_os_str))
            {
                expected.extend_from_slice(field.as_encoded_bytes());
                expected.push(0);
            }
            expected.extend_from_slice(payload);
            assert_eq!(stdout, expected);
            assert_eq!(stderr, b"shell-only\n\n");
        }
        // Every embedded hook has the compiled implementation it names, and none answers for the
        // shell yet: shadow only until its activation is approved (R7, T27).
        let embedded = Manifest::embedded()?;
        for (id, hook) in &embedded.hooks {
            let compiled = navori_cli::hook::NATIVE_HOOKS
                .iter()
                .find(|native| native.id == id)
                .ok_or("embedded hook without a compiled implementation")?;
            assert_eq!(compiled.implementation, hook.r#impl, "{id}");
            assert_eq!(hook.mode, navori_core::manifest::HookMode::Shadow, "{id}");
        }
        Ok(())
    }

    // Covers: R11, R12, R13
    #[test]
    fn forced_native_ignores_shadow_dispatch_but_shell_override_defers_without_reading()
    -> TestResult {
        let _serial = SERIAL.lock()?;
        let scratch = Scratch::new()?;
        let counter = scratch.0.join("must-not-exist");
        let script =
            scratch.script_body(".claude", "printf x >> \"$1\"\nprintf shell\nexit 0\n", &[])?;
        for (descriptor_shadow, explicit) in [(true, false), (false, true), (true, true)] {
            let manifest = if descriptor_shadow {
                shadow_manifest(true)?
            } else {
                manifest(true, &[])?
            };
            let mut args = argv(&script);
            if explicit {
                args.push("--shadow".into());
            }
            let own_args = [counter.as_os_str().to_owned(), "own-arg".into()];
            args.extend(own_args.iter().cloned());
            OBSERVED.lock()?.clear();
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            assert_eq!(
                run_with(
                    &args,
                    &manifest,
                    &registry(observe),
                    Mode::Rust,
                    &mut &b"native input"[..],
                    &mut stdout,
                    &mut stderr
                ),
                2
            );
            assert_eq!(
                stdout,
                format!("native input|Claude|None|{own_args:?}").as_bytes()
            );
            assert_eq!(stderr, b"recorded\n");
            assert_eq!(OBSERVED.lock()?.len(), 1);
            assert!(!counter.exists());
            OBSERVED.lock()?.clear();
            assert_eq!(
                run_with(
                    &args,
                    &manifest,
                    &registry(observe),
                    Mode::Shell,
                    &mut NeverRead,
                    &mut Vec::new(),
                    &mut Vec::new()
                ),
                3
            );
            assert!(OBSERVED.lock()?.is_empty());
            assert!(!counter.exists());
        }
        Ok(())
    }

    // Covers: R12, R13
    #[test]
    fn invalid_shadow_signature_defers_before_stdin_native_or_shell() -> TestResult {
        let _serial = SERIAL.lock()?;
        OBSERVED.lock()?.clear();
        let scratch = Scratch::new()?;
        let counter = scratch.0.join("must-not-exist");
        let script = scratch.script_body(".claude", "printf x >> \"$1\"\n", &[])?;
        fs::write(
            &script,
            format!("{}# edited\n", fs::read_to_string(&script)?),
        )?;
        let mut args = argv(&script);
        args.extend(["--shadow".into(), counter.as_os_str().to_owned()]);
        for mode in [Mode::Auto, Mode::Rust] {
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            assert_eq!(
                run_with(
                    &args,
                    &shadow_manifest(true)?,
                    &registry(observe),
                    mode,
                    &mut NeverRead,
                    &mut stdout,
                    &mut stderr
                ),
                if mode == Mode::Auto { 3 } else { 1 }
            );
            assert!(stdout.is_empty());
            assert!(OBSERVED.lock()?.is_empty());
            assert!(!counter.exists());
        }
        Ok(())
    }

    // Covers: R12, R13
    #[test]
    fn missing_shadow_cwd_defers_before_capture_in_an_isolated_child() -> TestResult {
        if std::env::var_os("NAVORI_SHADOW_CWD_TEST_CHILD").as_deref() == Some(OsStr::new("1")) {
            let script =
                PathBuf::from(std::env::var_os("NAVORI_SHADOW_TEST_SCRIPT").ok_or("child script")?);
            let counter = PathBuf::from(
                std::env::var_os("NAVORI_SHADOW_TEST_COUNTER").ok_or("child counter")?,
            );
            fs::remove_dir(std::env::current_dir()?)?;
            assert!(std::env::current_dir().is_err());
            let mut args = argv(&script);
            args.extend(["--shadow".into(), counter.as_os_str().to_owned()]);
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            assert_eq!(
                run_with(
                    &args,
                    &shadow_manifest(true)?,
                    &registry(observe),
                    Mode::Auto,
                    &mut NeverRead,
                    &mut stdout,
                    &mut stderr
                ),
                3
            );
            assert!(stdout.is_empty() && stderr.is_empty());
            assert!(OBSERVED.lock()?.is_empty());
            assert!(!counter.exists());
            assert_eq!(
                run_with(
                    &args,
                    &shadow_manifest(true)?,
                    &registry(observe),
                    Mode::Rust,
                    &mut &b"forced"[..],
                    &mut stdout,
                    &mut stderr
                ),
                2
            );
            assert!(stdout.starts_with(b"forced|Claude|"));
            assert_eq!(OBSERVED.lock()?.as_slice(), &[b"forced".to_vec()]);
            assert!(!counter.exists());
            return Ok(());
        }
        let scratch = Scratch::new()?;
        let counter = scratch.0.join("must-not-exist");
        let script = scratch.script_body(".claude", "printf x >> \"$1\"\n", &[])?;
        let cwd = scratch.0.join("removed-child-cwd");
        fs::create_dir(&cwd)?;
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "shadow_dispatch::missing_shadow_cwd_defers_before_capture_in_an_isolated_child",
                "--nocapture",
            ])
            .current_dir(&cwd)
            .env("NAVORI_SHADOW_CWD_TEST_CHILD", "1")
            .env("NAVORI_SHADOW_TEST_SCRIPT", script)
            .env("NAVORI_SHADOW_TEST_COUNTER", &counter)
            .output()?;
        assert!(
            output.status.success(),
            "isolated child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!counter.exists());
        Ok(())
    }

    // Covers: R12, R13
    #[test]
    fn partial_input_failure_never_runs_a_lane_and_uses_engine_event_gating() -> TestResult {
        let _serial = SERIAL.lock()?;
        let scratch = Scratch::new()?;
        let counter = scratch.0.join("must-not-exist");
        for (engine, event, gating, expected) in [
            (".claude", "PreToolUse", true, 0),
            (".claude", "Stop", true, 1),
            (".claude", "PreToolUse", false, 1),
            (".codex", "PreToolUse", true, 2),
            (".pi/navori", "tool_call", true, 2),
            (".pi/navori", "tool_call", false, 1),
        ] {
            let script = scratch.script_body(engine, "printf x >> \"$1\"\n", &[])?;
            let args = vec![
                "--via-command".into(),
                event.into(),
                script.into_os_string(),
                "--shadow".into(),
                counter.as_os_str().to_owned(),
            ];
            for mode in [Mode::Auto, Mode::Rust] {
                OBSERVED.lock()?.clear();
                let mut input = PartialFailure {
                    delivered: false,
                    reads: 0,
                };
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                let code = run_with(
                    &args,
                    &shadow_manifest(gating)?,
                    &registry(observe),
                    mode,
                    &mut input,
                    &mut stdout,
                    &mut stderr,
                );
                assert_safe(code, &stdout, &stderr, expected)?;
                assert!(input.delivered && input.reads >= 2);
                assert!(OBSERVED.lock()?.is_empty());
                assert!(!counter.exists());
            }
        }
        Ok(())
    }

    // Covers: R11, R12
    #[test]
    fn native_errors_and_panics_leave_valid_shell_verdicts_authoritative() -> TestResult {
        let _serial = SERIAL.lock()?;
        let scratch = Scratch::new()?;
        for evaluate in [
            native_error as fn(&[u8], &Invocation) -> Result<Evaluation, Failure>,
            native_panic,
        ] {
            for code in [0, 1, 2] {
                OBSERVED.lock()?.clear();
                let counter = scratch.0.join(format!("shell-{code}"));
                let script = scratch.script_body(".claude", &format!("printf x >> \"$1\"\nprintf 'shell-output\\n'\nprintf shell-diagnostic >&2\nexit {code}\n"), &[])?;
                let mut args = argv(&script);
                args.push(counter.as_os_str().to_owned());
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                assert_eq!(
                    run_with(
                        &args,
                        &shadow_manifest(true)?,
                        &registry(evaluate),
                        Mode::Auto,
                        &mut &b"input"[..],
                        &mut stdout,
                        &mut stderr
                    ),
                    code
                );
                assert_eq!(stdout, b"shell-output\n");
                assert_eq!(stderr, b"shell-diagnostic");
                assert_eq!(OBSERVED.lock()?.as_slice(), &[b"input".to_vec()]);
                assert!(!fs::read(&counter)?.is_empty());
            }
        }
        Ok(())
    }

    // Covers: R12
    #[test]
    fn shell_anomalies_use_the_dispatch_derived_engine_event_gating() -> TestResult {
        let _serial = SERIAL.lock()?;
        let scratch = Scratch::new()?;
        for (engine, event, expected) in [
            (".claude", "PreToolUse", 0),
            (".claude", "Stop", 1),
            (".codex", "PreToolUse", 2),
            (".pi/navori", "tool_call", 2),
        ] {
            OBSERVED.lock()?.clear();
            let counter = scratch.0.join(format!("shell-{event}"));
            let script = scratch.script_body(
                engine,
                "printf x >> \"$1\"\nprintf unsafe-shell\nexit 101\n",
                &[],
            )?;
            let args = vec![
                "--via-command".into(),
                event.into(),
                script.into_os_string(),
                counter.as_os_str().to_owned(),
            ];
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            let code = run_with(
                &args,
                &shadow_manifest(true)?,
                &registry(observe),
                Mode::Auto,
                &mut &b"input"[..],
                &mut stdout,
                &mut stderr,
            );
            assert_safe(code, &stdout, &stderr, expected)?;
            assert_eq!(OBSERVED.lock()?.as_slice(), &[b"input".to_vec()]);
            assert!(!fs::read(&counter)?.is_empty());
        }
        Ok(())
    }
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
fn changed_or_escaping_dependencies_defer_before_stdin_even_for_shadow() -> TestResult {
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
    // The dependency is still edited: shadow selection must not bypass integrity preflight.
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
        handler: Handler::Pure(record),
        phase: |_| Some("PreToolUse"),
        tool: None,
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

mod prepared_handlers {
    use super::*;
    use navori_cli::hook::{Evaluator, Recorder, Snapshot};

    fn ineligible<'a>(_: &'a Invocation, _: Snapshot<'a>) -> Result<Evaluator<'a>, String> {
        Err("fixture host is not accredited".to_owned())
    }

    /// Echo what the preparation saw (bytes, environment, cwd, engine), then the payload.
    fn echo<'a>(
        invocation: &'a Invocation,
        snapshot: Snapshot<'a>,
    ) -> Result<Evaluator<'a>, String> {
        let seen = format!(
            "{}|{}|{}|{:?}|{}|",
            snapshot.source.len(),
            snapshot.env.iter().any(|(key, _)| key == "PATH"),
            snapshot.cwd.is_absolute(),
            invocation.engine,
            snapshot
                .source
                .starts_with(b"# navori:native-hook v=1 file=sha256:"),
        );
        Ok(Box::new(move |payload: &[u8], _: &dyn Recorder| {
            let mut stdout = seen.clone().into_bytes();
            stdout.extend_from_slice(payload);
            Ok(Evaluation {
                verdict: Verdict::Block,
                stdout,
                stderr: Vec::new(),
                audit: None,
            })
        }))
    }

    fn prepared(
        prepare: for<'a> fn(&'a Invocation, Snapshot<'a>) -> Result<Evaluator<'a>, String>,
    ) -> [NativeHook; 1] {
        [NativeHook {
            id: "example",
            implementation: HASH,
            handler: Handler::Prepared(prepare),
            phase: |_| Some("PreToolUse"),
            tool: None,
        }]
    }

    // Covers: R12, R13
    #[test]
    fn an_ineligible_host_defers_before_stdin_and_names_its_cause_when_forced() -> TestResult {
        let scratch = Scratch::new()?;
        let script = scratch.script(".claude", &[])?;
        let manifest = manifest(true, &[])?;
        for (mode, expected) in [(Mode::Auto, 3), (Mode::Rust, 1)] {
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            let code = run_with(
                &argv(&script),
                &manifest,
                &prepared(ineligible),
                mode,
                &mut NeverRead,
                &mut stdout,
                &mut stderr,
            );
            assert_eq!(code, expected);
            assert!(stdout.is_empty());
            if mode == Mode::Rust {
                assert_eq!(
                    stderr,
                    b"navori-rust: hook deferred: hook is ineligible: fixture host is not accredited\n"
                );
            } else {
                assert!(stderr.is_empty());
            }
        }
        Ok(())
    }

    // Covers: R11, R13
    #[test]
    fn preparation_sees_the_verified_bytes_and_this_invocation_environment() -> TestResult {
        let scratch = Scratch::new()?;
        let script = scratch.script(".pi/navori", &[])?;
        let manifest = manifest(true, &[])?;
        let size = fs::read(&script)?.len();
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let mut input: &[u8] = b"{\"payload\":1}";
        let code = run_with(
            &argv(&script),
            &manifest,
            &prepared(echo),
            Mode::Rust,
            &mut input,
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, 2);
        assert_eq!(
            String::from_utf8(stdout)?,
            format!("{size}|true|true|Pi|true|{{\"payload\":1}}")
        );
        Ok(())
    }

    const CHILD: &str = "NAVORI_PRODUCTION_REGISTRY_CHILD";

    /// The real asset with its includes expanded, as the renderer writes it.
    fn expanded_asset() -> Result<String, Box<dyn Error>> {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/core-assets/hooks");
        let mut expanded = String::new();
        for line in fs::read_to_string(root.join("subagent-no-background.sh"))?.lines() {
            if let Some(name) = line.strip_prefix("# navori:include ") {
                expanded.push_str(&fs::read_to_string(
                    root.join("_partials").join(format!("{name}.sh")),
                )?);
            } else {
                expanded.push_str(line);
            }
            expanded.push('\n');
        }
        Ok(expanded)
    }

    /// The real hook, signed for the compiled implementation, under the scratch's `.claude`.
    fn install_production_script(scratch: &Scratch) -> Result<PathBuf, Box<dyn Error>> {
        let path = scratch.0.join(".claude/hooks/subagent-no-background.sh");
        fs::create_dir_all(path.parent().ok_or("hooks parent")?)?;
        let implementation = navori_hooks::compiled::implementation_hash("subagent-no-background")
            .ok_or("compiled hash")?;
        let zero = "0".repeat(64);
        let unsigned = format!(
            "# navori:native-hook v=1 file=sha256:{zero} impl={implementation}\n{}",
            expanded_asset()?
        );
        let hash = script_hash(unsigned.as_bytes(), &[]).ok_or("metadata")?;
        fs::write(&path, unsigned.replacen(&zero, &hash[7..], 1))?;
        Ok(path)
    }

    /// Production manifest entry for the hook in `mode`.
    fn production_manifest(mode: &str) -> Result<Manifest, Box<dyn Error>> {
        let implementation = navori_hooks::compiled::implementation_hash("subagent-no-background")
            .ok_or("compiled hash")?;
        Ok(Manifest::parse(
            &serde_json::json!({
                "schema":1, "commands":[], "hooks":{"subagent-no-background":{
                    "mode":mode, "gating":true,
                    "blocks":{"subagent-no-background-base":HASH}, "impl":implementation
                }}
            })
            .to_string(),
        )?)
    }

    /// Child half: evaluate through the production registry under the parent's clean env.
    fn production_registry_child(script: &Path) -> TestResult {
        let manifest = production_manifest("active")?;
        let payloads: [&[u8]; 4] = [
            b"{}",
            br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"run_in_background":true,"command":"sleep 1"}}"#,
            br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep 1 &"}}"#,
            br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"printf ok"}}"#,
        ];
        for payload in payloads {
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            let mut input = payload;
            let code = run_with(
                &argv(script),
                &manifest,
                &*navori_cli::hook::NATIVE_HOOKS,
                Mode::Rust,
                &mut input,
                &mut stdout,
                &mut stderr,
            );
            let mut shell = Command::new("bash")
                .arg(script)
                .env("NAVORI_HOOK_IMPL", "shell")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            io::Write::write_all(&mut shell.stdin.take().ok_or("stdin")?, payload)?;
            let oracle = shell.wait_with_output()?;
            let shown = String::from_utf8_lossy(payload);
            assert_eq!(oracle.status.code(), Some(i32::from(code)), "{shown}");
            assert_eq!(oracle.stdout, stdout, "{shown}");
            assert_eq!(
                String::from_utf8_lossy(&oracle.stderr),
                String::from_utf8_lossy(&stderr),
                "{shown}"
            );
        }
        Ok(())
    }

    // Covers: R11, R13
    #[test]
    fn the_production_registry_reproduces_the_real_shell_hook_byte_for_byte() -> TestResult {
        if let Some(script) = std::env::var_os(CHILD) {
            return production_registry_child(Path::new(&script));
        }
        let scratch = Scratch::new()?;
        let path = install_production_script(&scratch)?;
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "prepared_handlers::the_production_registry_reproduces_the_real_shell_hook_byte_for_byte",
                "--nocapture",
            ])
            .current_dir(&scratch.0)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("LC_ALL", "C")
            .env("NAVORI_AUDITS_ROOT", scratch.0.join("audit-off"))
            .env(CHILD, &path)
            .output()?;
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        Ok(())
    }

    const AUDIT_CHILD: &str = "NAVORI_NATIVE_AUDIT_CHILD";

    /// Spool events with the per-run `ms` and `tsMs` removed, in file-name order.
    fn spool_events(spool: &Path) -> Result<Vec<serde_json::Value>, Box<dyn Error>> {
        let mut names: Vec<PathBuf> = fs::read_dir(spool)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<io::Result<_>>()?;
        names.sort();
        names
            .iter()
            .map(|path| {
                let mut event: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
                let metadata = event["metadata"].as_object_mut().ok_or("metadata")?;
                assert!(metadata.remove("ms").is_some_and(|ms| ms.is_u64()));
                assert!(metadata.remove("tsMs").is_some_and(|ts| ts.is_u64()));
                Ok(event)
            })
            .collect()
    }

    fn clear(spool: &Path) -> TestResult {
        for entry in fs::read_dir(spool)? {
            fs::remove_file(entry?.path())?;
        }
        Ok(())
    }

    /// Child half: native decisions audit like the shell; shadow ones only through the shell.
    fn native_audit_child(script: &Path) -> TestResult {
        let project = std::env::current_dir()?;
        let spool = Path::new(&std::env::var_os("NAVORI_AUDITS_ROOT").ok_or("audit root")?)
            .join(project.file_name().ok_or("repo")?)
            .join("spool-s1");
        let cwd = project.to_string_lossy();
        for (command, verdict) in [("sleep 1 &", "block"), ("printf ok", "allow")] {
            let payload = serde_json::json!({
                "session_id":"s1", "cwd":cwd, "agent_id":"worker", "tool_use_id":"call:1",
                "tool_name":"Bash", "tool_input":{"command":command}
            })
            .to_string();
            let run = |manifest: &Manifest, mode: Mode| {
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                run_with(
                    &argv(script),
                    manifest,
                    &*navori_cli::hook::NATIVE_HOOKS,
                    mode,
                    &mut payload.as_bytes(),
                    &mut stdout,
                    &mut stderr,
                )
            };
            clear(&spool)?;
            run(&production_manifest("active")?, Mode::Rust);
            let native = spool_events(&spool)?;
            assert_eq!(native.len(), 1, "{command}");
            assert_eq!(native[0]["metadata"]["verdict"], verdict);
            let mut shell = Command::new("bash")
                .arg(script)
                .env("NAVORI_HOOK_IMPL", "shell")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            io::Write::write_all(&mut shell.stdin.take().ok_or("stdin")?, payload.as_bytes())?;
            shell.wait()?;
            let both = spool_events(&spool)?;
            assert_eq!(both.len(), 2, "{command}");
            assert_eq!(both[0], both[1], "{command}");
            clear(&spool)?;
            run(&production_manifest("shadow")?, Mode::Auto);
            assert_eq!(spool_events(&spool)?, native, "{command}");
        }
        Ok(())
    }

    // Covers: R11
    #[test]
    fn native_decisions_audit_like_the_shell_and_shadow_never_audits_twice() -> TestResult {
        if let Some(script) = std::env::var_os(AUDIT_CHILD) {
            return native_audit_child(Path::new(&script));
        }
        let scratch = Scratch::new()?;
        let path = install_production_script(&scratch)?;
        let project = scratch.0.join("project");
        fs::create_dir(&project)?;
        let audits = scratch.0.join("audits");
        let spool = audits.join("project/spool-s1");
        fs::create_dir_all(&spool)?;
        fs::write(audits.join("project/session-s1.log"), "")?;
        for dir in [&audits, &audits.join("project"), &spool] {
            fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        }
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "prepared_handlers::native_decisions_audit_like_the_shell_and_shadow_never_audits_twice",
                "--nocapture",
            ])
            .current_dir(&project)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("LC_ALL", "C")
            .env("NAVORI_AUDITS_ROOT", &audits)
            .env(AUDIT_CHILD, &path)
            .output()?;
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        Ok(())
    }
}

mod journal_bridge {
    use super::*;
    use navori_cli::hook::run_with_journal;
    use navori_cli::journal::{
        CliJournal, ShadowJournal, base64, completion, engine_name, project_root, receipt,
    };
    use navori_cli::shadow::Comparison;
    use navori_hooks::runner::Engine;
    use std::cell::RefCell;

    const MATCH: Comparison = Comparison {
        native_unobserved: false,
        native_failed: false,
        shell_failed: false,
        code_differs: false,
        stdout_differs: false,
        stderr_differs: false,
    };

    #[derive(Default)]
    struct Recording {
        refuse: bool,
        begun: RefCell<Vec<(PathBuf, String, &'static str, String)>>,
        completed: RefCell<Vec<(String, Comparison, Vec<u8>)>>,
    }

    impl ShadowJournal for Recording {
        fn begin(
            &self,
            root: &Path,
            hook: &str,
            engine: Engine,
            implementation: &str,
        ) -> Option<String> {
            self.begun.borrow_mut().push((
                root.to_path_buf(),
                hook.to_owned(),
                engine_name(engine),
                implementation.to_owned(),
            ));
            (!self.refuse).then(|| "{\"kind\":\"begin\"}".to_owned())
        }

        fn complete(&self, _: &Path, receipt: &str, comparison: Comparison, payload: &[u8]) {
            self.completed
                .borrow_mut()
                .push((receipt.to_owned(), comparison, payload.to_vec()));
        }
    }

    fn shadow_manifest() -> Result<Manifest, Box<dyn Error>> {
        let mut manifest = manifest(true, &[])?;
        manifest.hooks.get_mut("example").ok_or("hook")?.mode =
            navori_core::manifest::HookMode::Shadow;
        Ok(manifest)
    }

    // Covers: R11
    #[test]
    fn wire_helpers_encode_canonical_base64_and_strict_documents() {
        for (input, expected) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"\0\xff\n", "AP8K"),
        ] {
            assert_eq!(base64(input), expected);
        }
        assert_eq!(
            receipt(b"{\"kind\":\"begin\",\"id\":\"x\"}\n").as_deref(),
            Some("{\"kind\":\"begin\",\"id\":\"x\"}")
        );
        for bad in [
            &b"{\"kind\":\"begin\"}"[..],
            b"{\"kind\":\"complete\"}\n",
            b"{\"kind\":\"begin\"}\n{}\n",
            b"not json\n",
        ] {
            assert_eq!(receipt(bad), None);
        }
        assert_eq!(
            completion("{}", MATCH, b"secret"),
            r#"{"receipt":{},"comparison":{"nativeFailed":false,"shellFailed":false,"codeDiffers":false,"stdoutDiffers":false,"stderrDiffers":false}}"#
        );
        let diverged = Comparison {
            stderr_differs: true,
            ..MATCH
        };
        assert!(completion("{}", diverged, b"{}").ends_with(r#""payloadBase64":"e30="}"#));
        // Covers: R50 (D40): an unobserved lane names its flag and carries no payload.
        let unobserved = Comparison {
            native_unobserved: true,
            ..MATCH
        };
        assert!(!unobserved.diverged());
        assert_eq!(
            completion("{}", unobserved, b"secret"),
            r#"{"receipt":{},"comparison":{"nativeFailed":false,"shellFailed":false,"codeDiffers":false,"stdoutDiffers":false,"stderrDiffers":false,"nativeUnobserved":true}}"#
        );
        assert_eq!(
            project_root(Engine::Pi, Path::new("/repo/.pi/navori")),
            Some(Path::new("/repo"))
        );
        assert_eq!(
            project_root(Engine::Claude, Path::new("/repo/.claude")),
            Some(Path::new("/repo"))
        );
    }

    // Covers: R12, R13
    #[test]
    fn an_unacknowledged_begin_keeps_the_shell_route_without_reading_stdin() -> TestResult {
        let scratch = Scratch::new()?;
        let script = scratch.script(".claude", &[])?;
        let journal = Recording {
            refuse: true,
            ..Recording::default()
        };
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let code = run_with_journal(
            &argv(&script),
            &shadow_manifest()?,
            &registry(record),
            Mode::Auto,
            Some(&journal),
            &mut NeverRead,
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, 3);
        assert!(stdout.is_empty() && stderr.is_empty());
        let begun = journal.begun.borrow();
        assert_eq!(begun.len(), 1);
        assert_eq!(begun[0].0, fs::canonicalize(&scratch.0)?);
        assert_eq!((begun[0].1.as_str(), begun[0].2), ("example", "claude"));
        assert_eq!(begun[0].3, HASH);
        assert!(journal.completed.borrow().is_empty());
        Ok(())
    }

    // Covers: R11, R12
    #[test]
    fn an_acknowledged_observation_records_one_comparison_and_returns_the_shell() -> TestResult {
        let scratch = Scratch::new()?;
        let script = scratch.script_body(".claude", "cat >/dev/null\nexit 0\n", &[])?;
        let journal = Recording::default();
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let mut input: &[u8] = b"{\"tool\":1}";
        let code = run_with_journal(
            &argv(&script),
            &shadow_manifest()?,
            &registry(record),
            Mode::Auto,
            Some(&journal),
            &mut input,
            &mut stdout,
            &mut stderr,
        );
        // The shell permits; the native fixture blocks: the host sees the shell, the journal
        // records the divergence with the payload that reproduces it.
        assert_eq!(code, 0);
        assert!(stdout.is_empty() && stderr.is_empty());
        let completed = journal.completed.borrow();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].0, "{\"kind\":\"begin\"}");
        assert!(completed[0].1.code_differs && completed[0].1.diverged());
        assert_eq!(completed[0].2, b"{\"tool\":1}");
        Ok(())
    }

    // Covers: R11, R13
    #[test]
    fn the_cli_journal_speaks_the_ts_bridge_protocol() -> TestResult {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new()?;
        // A TS CLI stand-in: logs argv and stdin, acknowledges begin only for absolute roots.
        let log = scratch.0.join("cli.log");
        let cli = scratch.0.join("fake-navori");
        let body = [
            "#!/bin/sh".to_owned(),
            format!("printf 'argv:%s\\n' \"$*\" >> '{}'", log.display()),
            format!(
                "if [ \"$3\" = complete ]; then printf 'stdin:' >> '{0}'; cat >> '{0}'; printf '\\n' >> '{0}'; exit 0; fi",
                log.display()
            ),
            "case \"$5\" in /*) printf '{\"kind\":\"begin\",\"id\":\"r1\"}\\n'; exit 0;; esac"
                .to_owned(),
            "printf '{\"ok\":false}\\n'; exit 1".to_owned(),
        ];
        fs::write(&cli, body.join("\n") + "\n")?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755))?;
        let journal = CliJournal::from_locations(&navori_cli::delegate::Locations {
            ts_cli: Some(cli.into_os_string()),
            checkout_dist: scratch.0.join("missing/index.js"),
            path: None,
            self_exe: None,
        })
        .ok_or("fake CLI not resolved")?;
        let implementation = format!("sha256:{}", "c".repeat(64));
        let receipt = journal
            .begin(Path::new("/repo"), "example", Engine::Pi, &implementation)
            .ok_or("begin refused")?;
        assert_eq!(receipt, "{\"kind\":\"begin\",\"id\":\"r1\"}");
        let diverged = Comparison {
            stdout_differs: true,
            ..MATCH
        };
        journal.complete(Path::new("/repo"), &receipt, diverged, b"\0payload");
        assert_eq!(
            journal.begin(
                Path::new("relative"),
                "example",
                Engine::Pi,
                &implementation
            ),
            None
        );
        let begin = |root: &str| {
            format!(
                "argv:tools rust-shadow begin --root {root} --hook example --engine pi --impl {implementation}\n"
            )
        };
        assert_eq!(
            fs::read_to_string(&log)?,
            format!(
                "{}argv:tools rust-shadow complete --root /repo\nstdin:{}\n{}",
                begin("/repo"),
                completion(&receipt, diverged, b"\0payload"),
                begin("relative")
            )
        );
        Ok(())
    }
}

/// A hook's phase table with the argument lists it ports and the ones it defers.
type ModeTable = (
    fn(&[OsString]) -> Option<&'static str>,
    &'static [&'static [&'static str]],
    &'static [&'static [&'static str]],
);

// Covers: R51, R50
#[test]
fn un_modo_diferido_sale_3_con_stdin_intacto() -> TestResult {
    use navori_hooks::hooks::{model_advisor, subagent_stop_handoff};
    let scratch = Scratch::new()?;
    let manifest = manifest(false, &[])?;
    let tables: [ModeTable; 2] = [
        (
            model_advisor::phase,
            &[
                &["claude-session-start"],
                &["claude-post-model-switch"],
                &["claude-stop"],
                &["codex-session-start"],
            ],
            &[
                &["codex-pretool-profile"],
                &[],
                &["unknown-mode"],
                &["claude-stop", "extra"],
            ],
        ),
        (
            subagent_stop_handoff::phase,
            &[&[], &["codex"]],
            &[
                &["codex", "capture-start"],
                &["claude"],
                &["codex", "other"],
            ],
        ),
    ];
    for (dir, (phase, ported, deferred)) in [".claude", ".codex"].into_iter().zip(tables) {
        let script = scratch.script(dir, &[])?;
        let registry = [NativeHook {
            id: "example",
            implementation: HASH,
            handler: Handler::Pure(record),
            phase,
            tool: None,
        }];
        let call = |modes: &[&str]| {
            let mut args = argv(&script);
            args.extend(modes.iter().map(OsString::from));
            args
        };
        for modes in deferred {
            for (mode, expected) in [(Mode::Auto, 3), (Mode::Rust, 1)] {
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                let code = run_with(
                    &call(modes),
                    &manifest,
                    &registry,
                    mode,
                    &mut NeverRead,
                    &mut stdout,
                    &mut stderr,
                );
                assert_eq!(code, expected, "{dir} {modes:?} under {mode:?}");
                assert!(stdout.is_empty());
                let expected_stderr: &[u8] = if mode == Mode::Rust {
                    b"navori-rust: hook deferred: hook mode is not ported\n"
                } else {
                    b""
                };
                assert_eq!(stderr, expected_stderr);
            }
        }
        for modes in ported {
            let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
            let code = run_with(
                &call(modes),
                &manifest,
                &registry,
                Mode::Auto,
                &mut &b"{}"[..],
                &mut stdout,
                &mut stderr,
            );
            // `record` answers Block: reaching it is exit 2, a deferral would be 3.
            assert_eq!(code, 2, "{dir} {modes:?} reaches the handler");
            assert!(
                stdout.starts_with(b"{}|"),
                "{dir} {modes:?} reads the payload"
            );
        }
    }
    Ok(())
}
