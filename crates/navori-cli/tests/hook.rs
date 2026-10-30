//! Modes of a hook (spec 0059 T2, D31, R51): the audit phase is a function of the mode, and a call
//! the hook leaves to its shell defers with exit 3 before stdin is read.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use navori_cli::hook::{
    Handler, Invocation, Mode, NativeHook, modes, never, pre_tool_use, run_with,
};
use navori_core::integrity::script_hash;
use navori_core::manifest::Manifest;
use navori_hooks::runner::{Engine, Evaluation, Failure, Verdict};

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type TestResult = Result<(), Box<dyn Error>>;
/// Exit code, stdout and stderr of one hook call.
type Call = (u8, Vec<u8>, Vec<u8>);

/// A scratch engine root with one valid, integrity-stamped hook script.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("hook-modes-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(root.join(".claude/hooks"))?;
        Ok(Self(root))
    }

    fn script(&self) -> Result<PathBuf, Box<dyn Error>> {
        let path = self.0.join(".claude/hooks/example.sh");
        let source = format!(
            "# navori:native-hook v=1 file=sha256:{} impl={HASH}\n#!/bin/sh\nexit 0\n",
            "0".repeat(64)
        );
        let hash = script_hash(source.as_bytes(), &[]).ok_or("metadata")?;
        fs::write(&path, source.replacen(&"0".repeat(64), &hash[7..], 1))?;
        Ok(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Stdin that fails the test if anything reads it.
struct NeverRead;

impl Read for NeverRead {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        panic!("stdin must remain untouched during deferral")
    }
}

fn manifest() -> Result<Manifest, Box<dyn Error>> {
    Ok(Manifest::parse(
        &serde_json::json!({
            "schema": 2, "commands": [], "hooks": { "example": {
                "mode": "active", "gating": false, "blocks": { "example-base": HASH }, "impl": HASH
            }}
        })
        .to_string(),
    )?)
}

fn answer(_: &[u8], _: &Invocation) -> Result<Evaluation, Failure> {
    Ok(Evaluation {
        verdict: Verdict::Permit,
        stdout: b"native".to_vec(),
        stderr: Vec::new(),
        audit: None,
    })
}

/// Defers when the first argument is `shell`, as a hook with a mode it leaves to its shell.
fn defers_on_shell(invocation: &Invocation) -> bool {
    invocation.args.first().is_some_and(|arg| arg == "shell")
}

fn registry() -> [NativeHook; 1] {
    [NativeHook {
        id: "example",
        implementation: HASH,
        handler: Handler::Pure(answer),
        phase: pre_tool_use,
        defers: defers_on_shell,
        tool: None,
    }]
}

fn invoke(args: &[&str], mode: Mode) -> Result<Call, Box<dyn Error>> {
    let scratch = Scratch::new(&format!("{mode:?}-{}", args.join("_")))?;
    let script = scratch.script()?;
    let mut argv = vec![
        OsString::from("--via-script"),
        script.as_os_str().to_owned(),
    ];
    argv.extend(args.iter().map(OsString::from));
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let code = run_with(
        &argv,
        &manifest()?,
        &registry(),
        mode,
        &mut NeverReadUnlessNative(args),
        &mut stdout,
        &mut stderr,
    );
    Ok((code, stdout, stderr))
}

/// A native call reads the payload; a deferred one must not, so only it gets the guard.
struct NeverReadUnlessNative<'a>(&'a [&'a str]);

impl Read for NeverReadUnlessNative<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.0.first() == Some(&"shell") {
            return NeverRead.read(bytes);
        }
        Ok(0)
    }
}

// Covers: R51
#[test]
fn a_deferred_mode_exits_3_with_stdin_untouched() -> TestResult {
    // Automatic mode: exit 3, nothing printed, and `NeverRead` would have panicked on a read.
    let (code, stdout, stderr) = invoke(&["shell"], Mode::Auto)?;
    assert_eq!((code, stdout, stderr), (3, Vec::new(), Vec::new()));
    // Forced Rust makes the deferral explicit (exit 1 and its cause), still without reading.
    let (code, stdout, stderr) = invoke(&["shell"], Mode::Rust)?;
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(String::from_utf8(stderr)?.contains("left to the shell"));
    // A mode the hook handles is evaluated natively.
    let (code, stdout, _) = invoke(&["native"], Mode::Auto)?;
    assert_eq!((code, stdout.as_slice()), (0, &b"native"[..]));
    Ok(())
}

fn invocation(args: &[&str]) -> Invocation {
    Invocation {
        engine: Engine::Codex,
        id: "example".to_owned(),
        script: PathBuf::from("/x/.codex/hooks/example.sh"),
        requested: PathBuf::from("/x/.codex/hooks/example.sh"),
        engine_root: PathBuf::from("/x/.codex"),
        event: None,
        args: args.iter().map(OsString::from).collect(),
        shadow: false,
    }
}

// Covers: R51, R50
#[test]
fn model_advisor_modes_carry_their_phase_and_unknown_ones_defer() {
    let phase = |mode: &[&str]| modes::model_advisor_phase(&invocation(mode));
    assert_eq!(phase(&["claude-session-start"]), "SessionStart");
    assert_eq!(phase(&["codex-session-start"]), "SessionStart");
    assert_eq!(phase(&["claude-post-model-switch"]), "PostModelSwitch");
    assert_eq!(phase(&["claude-stop"]), "Stop");
    assert_eq!(phase(&["codex-pretool-profile"]), "PreToolUse");
    for unknown in [
        &[][..],
        &[""],
        &["claude"],
        &["claude-session-start "],
        &["CLAUDE-STOP"],
    ] {
        assert_eq!(phase(unknown), "unknown", "{unknown:?}");
    }
    let defers = |mode: &[&str]| modes::model_advisor_defers(&invocation(mode));
    // The profile hook belongs to the `codex` commands of phase 4; unknown modes are not guessed.
    assert!(defers(&["codex-pretool-profile"]));
    assert!(defers(&[]));
    assert!(defers(&["nonsense"]));
    for native in [
        "claude-session-start",
        "codex-session-start",
        "claude-post-model-switch",
        "claude-stop",
    ] {
        assert!(!defers(&[native]), "{native}");
    }
}

// Covers: R51, R50
#[test]
fn subagent_stop_handoff_leaves_only_the_child_capture_start_to_its_shell() {
    let defers = |args: &[&str]| modes::subagent_stop_defers(&invocation(args));
    assert!(!defers(&[]), "Claude registers it with no argument");
    assert!(!defers(&["codex"]));
    assert!(defers(&["codex", "capture-start"]));
    for unknown in [
        &["claude"][..],
        &["codex", "other"],
        &["codex", "capture-start", "x"],
        &["capture-start"],
    ] {
        assert!(defers(unknown), "{unknown:?}");
    }
    assert_eq!(
        modes::subagent_stop_phase(&invocation(&["codex"])),
        "PostToolUse"
    );
    // The fixed-phase and never-defer helpers the other hooks use.
    assert_eq!(pre_tool_use(&invocation(&[])), "PreToolUse");
    assert!(!never(&invocation(&["anything"])));
}
