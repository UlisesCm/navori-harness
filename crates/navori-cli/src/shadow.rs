//! Observational native evaluation followed by one authoritative shell execution (0057 D9).
//!
//! The caller owns selection, integrity and verified invocation metadata. No registry activation,
//! audit, divergence log or payload persistence happens here. A native failure never replaces a
//! valid shell verdict; shell transport/protocol failures use the existing runner's D6 policy.

use std::ffi::OsString;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;

use navori_hooks::runner::{self, Context, Evaluation, Failure, Response, Verdict};

/// Already verified shell invocation, including the complete environment snapshot.
///
/// The caller must retain hook-specific arguments and event environment unchanged, and provide
/// an effective `Context::gating` (Claude events outside PreToolUse are advisory).
pub struct ShellInvocation<'a> {
    /// Verified script path, resolved before any working-directory change.
    pub script: &'a Path,
    /// Exact hook-specific argv, excluding the native runtime's own routing flags.
    pub args: &'a [OsString],
    /// Working directory used by the engine's shell invocation.
    pub cwd: &'a Path,
    /// Full environment; only NAVORI_HOOK_IMPL is overridden to prevent shadow recursion.
    pub env: &'a [(OsString, OsString)],
}

/// Byte-exact comparison without retaining a payload or additional output copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Comparison {
    /// Native evaluation returned an error or panicked.
    pub native_failed: bool,
    /// Shell spawning, transport or its exit status failed the hook protocol.
    pub shell_failed: bool,
    /// Terminal protocol codes differ.
    pub code_differs: bool,
    /// Stdout bytes differ.
    pub stdout_differs: bool,
    /// Stderr bytes differ.
    pub stderr_differs: bool,
}

impl Comparison {
    /// Whether either evaluation failed or any verdict/output bytes differ.
    #[must_use]
    pub const fn diverged(self) -> bool {
        self.native_failed
            || self.shell_failed
            || self.code_differs
            || self.stdout_differs
            || self.stderr_differs
    }
}

/// Buffered shell result plus observations for a future caller-owned divergence ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowResult {
    /// Authoritative result; only this response may be emitted to the host.
    pub shell: Response,
    /// Comparison metadata; it never substitutes the native verdict for the shell result.
    pub comparison: Comparison,
}

/// Evaluate a pure native callback, then execute the shell exactly once with captured bytes.
///
/// The native callback must perform no filesystem, audit, log or host-output effects. Its only
/// input capability is a byte slice; callers supply any immutable metadata through the closure.
/// Input is already captured: this function never opens or reads the process's stdin.
#[must_use]
pub fn run<H>(
    context: Context<'_>,
    payload: &[u8],
    invocation: ShellInvocation<'_>,
    native: H,
) -> ShadowResult
where
    H: FnOnce(&[u8]) -> Result<Evaluation, Failure>,
{
    let mut native_succeeded = false;
    let mut native_input = payload;
    let native = runner::run(
        context,
        &mut native_input,
        || Ok(true),
        |bytes| {
            let evaluated = native(bytes)?;
            native_succeeded = true;
            Ok(evaluated)
        },
    );
    let mut shell_succeeded = false;
    let mut shell_input = payload;
    let shell = runner::run(
        context,
        &mut shell_input,
        || Ok(true),
        |bytes| {
            let evaluated = shell_once(&invocation, bytes)?;
            shell_succeeded = true;
            Ok(evaluated)
        },
    );
    let comparison = Comparison {
        native_failed: !native_succeeded,
        shell_failed: !shell_succeeded,
        code_differs: native.code() != shell.code(),
        stdout_differs: native.stdout() != shell.stdout(),
        stderr_differs: native.stderr() != shell.stderr(),
    };
    ShadowResult { shell, comparison }
}

/// Write stdin concurrently while both output pipes are drained by wait_with_output.
fn shell_once(invocation: &ShellInvocation<'_>, payload: &[u8]) -> Result<Evaluation, Failure> {
    let mut child = Command::new("bash")
        .arg(invocation.script)
        .args(invocation.args)
        .current_dir(invocation.cwd)
        .env_clear()
        .envs(invocation.env.iter().map(|(key, value)| (key, value)))
        .env("NAVORI_HOOK_IMPL", "shell")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure(format!("shadow shell spawn failed: {error}")))?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Failure("shadow shell stdin unavailable".to_owned()));
    };
    let (output, input_result) = thread::scope(|scope| {
        let writer =
            match thread::Builder::new().spawn_scoped(scope, move || stdin.write_all(payload)) {
                Ok(writer) => writer,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(Failure(format!("shadow stdin thread failed: {error}")));
                }
            };
        let output = child.wait_with_output();
        let input_result = writer
            .join()
            .map_err(|_| Failure("shadow stdin writer panicked".to_owned()))?;
        let output =
            output.map_err(|error| Failure(format!("shadow shell output failed: {error}")))?;
        Ok((output, input_result))
    })?;
    let verdict = match output.status.code() {
        Some(0) => Verdict::Permit,
        Some(1) => Verdict::Error,
        Some(2) => Verdict::Block,
        _ => {
            return Err(Failure(format!(
                "shadow shell status outside hook protocol: {}",
                output.status
            )));
        }
    };
    // Legacy hooks may stop reading early; EPIPE with a valid verdict is normal shell behavior.
    if let Err(error) = input_result
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        return Err(Failure(format!("shadow stdin write failed: {error}")));
    }
    Ok(Evaluation {
        verdict,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}
