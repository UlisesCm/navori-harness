//! Shadow journal bridge (spec 0057 D9 / D12).
//!
//! The TS CLI stays the only journal writer: this module only spawns
//! `navori tools rust-shadow begin|complete` and never appends rows itself. A begin without
//! acknowledgement keeps the shell route; a lost completion leaves the begin pending, which the
//! report counts against readiness instead of silently passing as a match.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_hooks::runner::Engine;

use crate::delegate::{self, Locations};
use crate::shadow::Comparison;

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
    /// Record the comparison of an acknowledged observation. Payload bytes are kept only when
    /// the comparison diverged; an unrecorded completion leaves the begin pending.
    fn complete(&self, root: &Path, receipt: &str, comparison: Comparison, payload: &[u8]);
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
        let output = self
            .command("begin", root)
            .args([
                OsString::from("--hook"),
                hook.into(),
                "--engine".into(),
                engine_name(engine).into(),
                "--impl".into(),
                implementation.into(),
            ])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        receipt(&output.stdout)
    }

    fn complete(&self, root: &Path, receipt: &str, comparison: Comparison, payload: &[u8]) {
        let Ok(mut child) = self
            .command("complete", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
        else {
            return;
        };
        let document = completion(receipt, comparison, payload);
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(document.as_bytes());
        }
        let _ = child.wait();
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

/// `complete` stdin document; the payload travels only for a divergence.
#[must_use]
pub fn completion(receipt: &str, comparison: Comparison, payload: &[u8]) -> String {
    let flags = format!(
        r#"{{"nativeFailed":{},"shellFailed":{},"codeDiffers":{},"stdoutDiffers":{},"stderrDiffers":{}}}"#,
        comparison.native_failed,
        comparison.shell_failed,
        comparison.code_differs,
        comparison.stdout_differs,
        comparison.stderr_differs,
    );
    if comparison.diverged() {
        format!(
            r#"{{"receipt":{receipt},"comparison":{flags},"payloadBase64":"{}"}}"#,
            base64(payload)
        )
    } else {
        format!(r#"{{"receipt":{receipt},"comparison":{flags}}}"#)
    }
}

/// Standard padded base64, the canonical form the CLI round-trips.
#[must_use]
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
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
