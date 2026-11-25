//! Shadow journal bridge (spec 0057 D9 / D12).
//!
//! The TS CLI stays the only journal writer: this module only spawns
//! `navori tools rust-shadow begin|complete` and never appends rows itself. A begin without
//! acknowledgement keeps the shell route; a lost completion leaves the begin pending, which the
//! report counts against readiness instead of silently passing as a match.

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::RecvTimeoutError;
use std::thread;
use std::time::Instant;

use navori_hooks::runner::Engine;

use crate::delegate::{self, Locations};
use crate::shadow::{self, Comparison};

/// Where shadow observations are acknowledged before stdin and recorded afterwards.
pub trait ShadowJournal {
    /// Acknowledge one observation for `root`; `None` means the call must stay on the shell.
    fn begin(
        &self,
        root: &Path,
        hook: &str,
        engine: Engine,
        implementation: &str,
    ) -> Option<String>;
    /// Record the comparison of an acknowledged observation. No payload, stdout or stderr byte
    /// ever reaches the journal; an unrecorded completion leaves the begin pending.
    fn complete(&self, root: &Path, receipt: &str, comparison: Comparison);
    /// [`Self::begin`] that must answer by `deadline` (`None`: unbounded). Journals that cannot
    /// bound themselves keep the unbounded call.
    fn begin_until(
        &self,
        root: &Path,
        hook: &str,
        engine: Engine,
        implementation: &str,
        _deadline: Option<Instant>,
    ) -> Option<String> {
        self.begin(root, hook, engine, implementation)
    }
    /// [`Self::complete`] that is abandoned at `deadline` (`None`: unbounded).
    fn complete_until(
        &self,
        root: &Path,
        receipt: &str,
        comparison: Comparison,
        _deadline: Option<Instant>,
    ) {
        self.complete(root, receipt, comparison);
    }
}

/// Run `command` to completion, or until `deadline`, whichever comes first. With a deadline the
/// child leads its own process group and the whole group is killed at expiry; stdin is written
/// on a detached thread so a child that never reads cannot block. Returns the exit status and,
/// when `capture` is set, stdout; `None` on spawn failure or expiry.
fn run_bounded(
    mut command: Command,
    input: Option<Vec<u8>>,
    capture: bool,
    deadline: Option<Instant>,
) -> Option<(ExitStatus, Vec<u8>)> {
    if deadline.is_some_and(|at| Instant::now() >= at) {
        return None;
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    if deadline.is_some() {
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
    }
    let output = child.stdout.take().map(shadow::drain);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if deadline.is_some_and(|at| Instant::now() >= at) => {
                shadow::kill_group(&mut child, &[]);
                return None;
            }
            Ok(None) => thread::sleep(shadow::POLL),
            Err(_) => {
                shadow::kill_group(&mut child, &[]);
                return None;
            }
        }
    };
    let stdout = match output {
        None => Vec::new(),
        Some(receiver) => match shadow::collect(&receiver, deadline) {
            Ok(bytes) => bytes,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                shadow::kill_group(&mut child, &[]);
                return None;
            }
        },
    };
    Some((status, stdout))
}

/// Journal backed by the TS CLI resolved like delegation (`NAVORI_TS_CLI`, checkout, `PATH`).
pub struct CliJournal {
    program: PathBuf,
    prefix: Vec<PathBuf>,
}

impl CliJournal {
    /// Resolve the TS CLI of this process, or `None` when there is none to write the journal.
    #[must_use]
    pub fn from_process() -> Option<Self> {
        Self::from_locations(&Locations::from_process())
    }

    /// Resolve the TS CLI from explicit locations, with the same order as delegation.
    #[must_use]
    pub fn from_locations(locations: &Locations) -> Option<Self> {
        let plan = delegate::plan(locations, "tools").ok()?;
        Some(Self {
            program: plan.program,
            prefix: plan.prefix,
        })
    }

    fn command(&self, verb: &str, root: &Path) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.prefix)
            .args(["tools", "rust-shadow", verb, "--root"])
            .arg(root)
            .stderr(Stdio::null());
        command
    }
}

impl ShadowJournal for CliJournal {
    fn begin(
        &self,
        root: &Path,
        hook: &str,
        engine: Engine,
        implementation: &str,
    ) -> Option<String> {
        self.begin_until(root, hook, engine, implementation, None)
    }

    fn complete(&self, root: &Path, receipt: &str, comparison: Comparison) {
        self.complete_until(root, receipt, comparison, None);
    }

    fn begin_until(
        &self,
        root: &Path,
        hook: &str,
        engine: Engine,
        implementation: &str,
        deadline: Option<Instant>,
    ) -> Option<String> {
        let mut command = self.command("begin", root);
        command.args([
            OsString::from("--hook"),
            hook.into(),
            "--engine".into(),
            engine_name(engine).into(),
            "--impl".into(),
            implementation.into(),
        ]);
        let (status, stdout) = run_bounded(command, None, true, deadline)?;
        if !status.success() {
            return None;
        }
        receipt(&stdout)
    }

    fn complete_until(
        &self,
        root: &Path,
        receipt: &str,
        comparison: Comparison,
        deadline: Option<Instant>,
    ) {
        let document = completion(receipt, comparison).into_bytes();
        let _ = run_bounded(
            self.command("complete", root),
            Some(document),
            false,
            deadline,
        );
    }
}

/// Wire name of an engine in the journal schema.
#[must_use]
pub const fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::Claude => "claude",
        Engine::Codex => "codex",
        Engine::Pi => "pi",
    }
}

/// The begin row the CLI acknowledged: exactly one JSON object line with `kind: "begin"`.
#[must_use]
pub fn receipt(stdout: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(stdout).ok()?.strip_suffix('\n')?;
    if text.contains('\n') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    (value.get("kind")? == "begin").then(|| text.to_owned())
}

/// `complete` stdin document. It carries comparison flags and, for a divergence only, the
/// closed protocol codes of each lane; never the hook payload or any output byte.
#[must_use]
pub fn completion(receipt: &str, comparison: Comparison) -> String {
    // Only an unobserved call names the flag, so a journal writer that predates it keeps
    // accepting every other completion.
    let unobserved = if comparison.native_unobserved {
        r#","nativeUnobserved":true"#
    } else {
        ""
    };
    // Codes only on a divergence: a matching completion stays valid for an older writer.
    let mut codes = String::new();
    if comparison.diverged() {
        if let Some(code) = comparison.shell_code {
            codes.push_str(&format!(r#","shellCode":{code}"#));
        }
        if let Some(code) = comparison.native_code {
            codes.push_str(&format!(r#","nativeCode":{code}"#));
        }
    }
    format!(
        r#"{{"receipt":{receipt},"comparison":{{"nativeFailed":{},"shellFailed":{},"codeDiffers":{},"stdoutDiffers":{},"stderrDiffers":{}{unobserved}{codes}}}}}"#,
        comparison.native_failed,
        comparison.shell_failed,
        comparison.code_differs,
        comparison.stdout_differs,
        comparison.stderr_differs,
    )
}

/// Project root that owns an engine root (`.claude`, `.codex` or `.pi/navori`).
#[must_use]
pub fn project_root(engine: Engine, engine_root: &Path) -> Option<&Path> {
    let parent = engine_root.parent()?;
    match engine {
        Engine::Pi => parent.parent(),
        Engine::Claude | Engine::Codex => Some(parent),
    }
}
