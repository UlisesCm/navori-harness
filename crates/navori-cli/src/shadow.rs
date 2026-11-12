//! Observational native evaluation followed by one authoritative shell execution (0057 D9).
//!
//! The caller owns selection, integrity and verified invocation metadata. No registry activation,
//! audit, divergence log or payload persistence happens here. A native failure never replaces a
//! valid shell verdict; shell transport/protocol failures use the existing runner's D6 policy.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// Wall-clock budget per shadow hook, anchored at the start of the hook process. A hook without
/// an entry has no deadline. Each budget must stay below the lowest timeout the renders register
/// for that hook, so the host never kills the process while it could still answer safely.
pub const SHADOW_DEADLINES: &[(&str, Duration)] =
    &[("guard-destructive", Duration::from_millis(8500))];

/// Absolute expiry for `hook`, counted from `start`; `None` when the hook has no deadline.
#[must_use]
pub fn deadline_for(hook: &str, start: Instant) -> Option<Instant> {
    SHADOW_DEADLINES
        .iter()
        .find(|(id, _)| *id == hook)
        .and_then(|(_, budget)| start.checked_add(*budget))
}

pub(crate) const POLL: Duration = Duration::from_millis(5);

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
    /// The native lane stopped at a branch with effects (spec 0059 D40). Nothing was compared:
    /// every other native flag is false, and the call never counts as a divergence.
    pub native_unobserved: bool,
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
    /// Terminal protocol code (0, 1 or 2) of the shell lane, when it finished within the protocol.
    pub shell_code: Option<u8>,
    /// Terminal protocol code (0, 1 or 2) of the native lane, when it evaluated successfully.
    pub native_code: Option<u8>,
}

impl Comparison {
    /// Whether either evaluation failed or any verdict/output bytes differ.
    #[must_use]
    pub const fn diverged(self) -> bool {
        self.shell_failed || (!self.native_unobserved && self.compared_diverged())
    }

    const fn compared_diverged(self) -> bool {
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
    run_until(context, payload, invocation, None, native)
}

/// [`run`] with an absolute expiry for the shell lane. Past it the shell process group is killed
/// and the lane fails like any shell transport failure (safe response, `shell_failed`); when the
/// expiry already passed after the native lane, the shell never starts.
#[must_use]
pub fn run_until<H>(
    context: Context<'_>,
    payload: &[u8],
    invocation: ShellInvocation<'_>,
    deadline: Option<Instant>,
    native: H,
) -> ShadowResult
where
    H: FnOnce(&[u8]) -> Result<Evaluation, Failure>,
{
    let mut native_succeeded = false;
    // Past the deadline on entry (an expired journal begin): the native lane would only add time
    // before the fail-safe, and its comparison would be thrown away. It does not run.
    let mut native_unobserved = deadline.is_some_and(|at| Instant::now() >= at);
    let native = (!native_unobserved).then(|| {
        let mut native_input = payload;
        runner::run(
            context,
            &mut native_input,
            || Ok(true),
            |bytes| {
                let evaluated = native(bytes).inspect_err(|failure| {
                    native_unobserved = failure.is_unobserved();
                })?;
                native_succeeded = true;
                Ok(evaluated)
            },
        )
    });
    let mut shell_succeeded = false;
    let mut shell_input = payload;
    let shell = runner::run(
        context,
        &mut shell_input,
        || Ok(true),
        |bytes| {
            let evaluated = shell_once(&invocation, bytes, deadline)?;
            shell_succeeded = true;
            Ok(evaluated)
        },
    );
    let compared = !native_unobserved;
    let comparison = Comparison {
        native_unobserved,
        native_failed: compared && !native_succeeded,
        shell_failed: !shell_succeeded,
        code_differs: compared && native.as_ref().is_some_and(|n| n.code() != shell.code()),
        stdout_differs: compared
            && native
                .as_ref()
                .is_some_and(|n| n.stdout() != shell.stdout()),
        stderr_differs: compared
            && native
                .as_ref()
                .is_some_and(|n| n.stderr() != shell.stderr()),
        shell_code: shell_succeeded.then(|| shell.code()),
        native_code: native
            .as_ref()
            .filter(|_| native_succeeded)
            .map(|n| n.code()),
    };
    ShadowResult { shell, comparison }
}

/// Captured shell process result.
struct Captured {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// SIGKILL the whole process group `child` leads (it was spawned with `process_group(0)`), so a
/// grandchild holding the pipes cannot outlive the deadline. Falls back to the child alone.
pub(crate) fn kill_group(child: &mut Child, env: &[(OsString, OsString)]) {
    let pgid = child.id();
    let kill = crate::quality_gate::resolve(env, "kill", "/")
        .or_else(|| {
            ["/usr/bin/kill", "/bin/kill"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("kill"));
    let group_killed = Command::new(kill)
        .args(["-KILL", "--", &format!("-{pgid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !group_killed {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Drain `pipe` on its own thread; the bytes arrive on the returned channel at EOF.
pub(crate) fn drain<P: Read + Send + 'static>(mut pipe: P) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    receiver
}

pub(crate) fn collect(
    receiver: &mpsc::Receiver<Vec<u8>>,
    deadline: Option<Instant>,
) -> Result<Vec<u8>, RecvTimeoutError> {
    match deadline {
        None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        Some(at) => receiver.recv_timeout(at.saturating_duration_since(Instant::now())),
    }
}

/// Run the shell in its own process group. Stdin is written and both outputs drained on detached
/// threads, so neither a child that never reads nor a grandchild holding a pipe can keep this
/// function from returning at `deadline`.
fn run_shell(
    invocation: &ShellInvocation<'_>,
    payload: &[u8],
    deadline: Option<Instant>,
) -> Result<(Captured, Option<io::Error>), Failure> {
    if deadline.is_some_and(|at| Instant::now() >= at) {
        return Err(Failure("shadow shell deadline already expired".to_owned()));
    }
    let mut command = Command::new("bash");
    command
        .arg(invocation.script)
        .args(invocation.args)
        .current_dir(invocation.cwd)
        .env_clear()
        .envs(invocation.env.iter().map(|(key, value)| (key, value)))
        .env("NAVORI_HOOK_IMPL", "shell")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own group only when a deadline may kill it: without one, nothing changes.
    if deadline.is_some() {
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| Failure(format!("shadow shell spawn failed: {error}")))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_group(&mut child, invocation.env);
        return Err(Failure("shadow shell pipes unavailable".to_owned()));
    };
    let (written, write_result) = mpsc::channel();
    let bytes = payload.to_vec();
    thread::spawn(move || {
        let _ = written.send(stdin.write_all(&bytes));
    });
    let (out, err) = (drain(stdout), drain(stderr));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if deadline.is_some_and(|at| Instant::now() >= at) => {
                kill_group(&mut child, invocation.env);
                return Err(Failure("shadow shell exceeded its deadline".to_owned()));
            }
            Ok(None) => thread::sleep(POLL),
            Err(error) => {
                kill_group(&mut child, invocation.env);
                return Err(Failure(format!("shadow shell wait failed: {error}")));
            }
        }
    };
    let (Ok(stdout), Ok(stderr)) = (collect(&out, deadline), collect(&err, deadline)) else {
        kill_group(&mut child, invocation.env);
        return Err(Failure("shadow shell output not closed in time".to_owned()));
    };
    // Best effort: a writer still blocked here only means the shell never read its input.
    let input_error = write_result.try_recv().ok().and_then(Result::err);
    Ok((
        Captured {
            status,
            stdout,
            stderr,
        },
        input_error,
    ))
}

fn shell_once(
    invocation: &ShellInvocation<'_>,
    payload: &[u8],
    deadline: Option<Instant>,
) -> Result<Evaluation, Failure> {
    let (output, input_result) = run_shell(invocation, payload, deadline)?;
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
    if let Some(error) = input_result
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        return Err(Failure(format!("shadow stdin write failed: {error}")));
    }
    // The shell hook records its own audit event; nothing is recorded again for it.
    Ok(Evaluation {
        verdict,
        stdout: output.stdout,
        stderr: output.stderr,
        audit: None,
    })
}
