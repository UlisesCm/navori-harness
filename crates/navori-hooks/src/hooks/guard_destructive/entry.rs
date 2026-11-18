//! The rendered script end to end: `payload_load` and `cmd=$(extract_cmd)`, `hook-input`'s
//! project directory, then [`decide`] and the exit trap's audit category.

use std::any::Any;
use std::ffi::OsString;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use super::{Rendered, decide};
use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::{self, CaptureContext};
use crate::shell::hook_input::{self, Host};
use crate::shell::payload::{self, Profile};
use crate::shell::pii_egress::HostProbe;
pub use crate::shell::pii_egress::Pii;
use crate::shell::pii_egress::Secret;
use crate::shell::repo::Repo;

/// Hosts that register guard-destructive.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

/// `nv_payload_fields` of guard-destructive.sh. Every field takes part in the bulk read's NUL
/// check, although only `cwd` and `tool_input.command` reach a rule.
const FIELDS: [&str; 9] = [
    "agent_type",
    "cwd",
    "hook_event_name",
    "tool_input.agent_type",
    "tool_input.command",
    "tool_input.file_path",
    "tool_input.notebook_path",
    "tool_input.subagent_type",
    "tool_name",
];
const CWD: usize = 1;
const COMMAND: usize = 4;

/// Everything fixed before stdin: the accredited extraction profile and diagnostics context,
/// the rendered values and the host facts read from the environment.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Host of this invocation.
    pub engine: Engine,
    /// Accredited extraction and locale profile.
    pub profile: Profile,
    /// Script identity and source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// Values the renderer wrote into the script.
    pub rendered: Rendered,
    /// Environment facts; `project_dir` and `cwd` are filled in from the payload.
    pub host: Host,
    /// What the PII-egress lane reads from the host.
    pub pii: Pii<'a>,
}

/// `nv_deadline` of the script (#1671): its default and ceiling, 2s under the host's 10s kill.
const DEADLINE_SECONDS: u64 = 8;

/// The script's own deadline (#1671). A hook the host kills at 10s approves the call, so past
/// this instant the answer is a block, never an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadline {
    at: Instant,
    seconds: u64,
}

impl Deadline {
    /// 8s from `started`. `NAVORI_GUARD_DEADLINE` (`value`) can only lower it: one digit 1..8,
    /// as the script's `case` pattern `[1-8]`; anything else is ignored.
    #[must_use]
    pub fn from_env(value: Option<&str>, started: Instant) -> Self {
        let seconds = value
            .filter(|value| value.len() == 1)
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|seconds| (1..=DEADLINE_SECONDS).contains(seconds))
            .unwrap_or(DEADLINE_SECONDS);
        Self {
            // An instant past the clock's range cannot be waited for: fail closed at once.
            at: started
                .checked_add(Duration::from_secs(seconds))
                .unwrap_or(started),
            seconds,
        }
    }

    fn expired(self) -> bool {
        Instant::now() >= self.at
    }

    /// The instant past which nothing new may be launched.
    #[must_use]
    pub fn at(self) -> Instant {
        self.at
    }

    /// `nv_on_deadline`: the block without a command (it may not be extracted yet) and with no
    /// reason code, since the audit allowlist has none for a deadline.
    fn evaluation(self) -> Evaluation {
        Evaluation {
            verdict: Verdict::Block,
            stdout: Vec::new(),
            stderr: format!(
                "[navori] BLOCKED by guard-destructive: inspection did not finish within {}s — nothing was approved\n",
                self.seconds
            )
            .into_bytes(),
            audit: Some(AuditLabel {
                verdict: "block",
                reason: String::new(),
            }),
        }
    }
}

/// Stack of the evaluation thread: the main thread's 8 MiB, not the 2 MiB of a spawned one. An
/// overflow aborts the process and the host approves.
const WORKER_STACK: usize = 8 << 20;

/// [`Context`] with every borrow owned, so a thread that may outlive the call can hold it.
struct Owned {
    engine: Engine,
    profile: Profile,
    shell: capture::ShellDialect,
    script: PathBuf,
    input_line: usize,
    fallback_line: usize,
    rendered: Rendered,
    host: Host,
    env: Vec<(OsString, OsString)>,
    grep: Option<PathBuf>,
    git: Option<PathBuf>,
    ids: Option<Secret>,
}

impl Owned {
    fn new(context: &Context<'_>) -> Self {
        Self {
            engine: context.engine,
            profile: context.profile,
            shell: context.capture.shell,
            script: context.capture.script.to_path_buf(),
            input_line: context.capture.input_line,
            fallback_line: context.capture.fallback_line,
            rendered: context.rendered.clone(),
            host: context.host.clone(),
            env: context.pii.env.to_vec(),
            grep: context.pii.grep.clone(),
            git: context.pii.git.clone(),
            ids: context.pii.ids.clone(),
        }
    }

    fn evaluate(
        &self,
        payload: &[u8],
        repo: &dyn Repo,
        until: Instant,
    ) -> Result<Evaluation, Failure> {
        let context = Context {
            engine: self.engine,
            profile: self.profile,
            capture: CaptureContext {
                shell: self.shell,
                script: &self.script,
                input_line: self.input_line,
                fallback_line: self.fallback_line,
            },
            rendered: self.rendered.clone(),
            host: self.host.clone(),
            pii: Pii {
                env: &self.env,
                grep: self.grep.clone(),
                git: self.git.clone(),
                ids: self.ids.clone(),
            },
        };
        evaluate_with(payload, &context, repo, Some(until))
    }
}

/// The text of a panic payload.
fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string payload".to_owned())
}

/// [`evaluate`] under the script's own deadline: expired before the rules run, they are
/// skipped; the rules run on a thread of their own and past the deadline their answer is
/// abandoned. Either way the call is blocked, even if a rule never returns (a hung `git`, a
/// pathological pattern).
///
/// The thread is detached: nothing joins it, so a hung rule dies with the process. A panic in
/// it, like a failure to start it, is an error and never a permit.
///
/// # Errors
/// The errors of [`evaluate`], only while the deadline has not passed; a panic of a rule
/// (`panic: …`); a thread that could not start.
pub fn evaluate_until<R: Repo + Send + 'static>(
    payload: &[u8],
    context: &Context<'_>,
    repo: R,
    deadline: Deadline,
) -> Result<Evaluation, Failure> {
    if deadline.expired() {
        return Ok(deadline.evaluation());
    }
    let owned = Owned::new(context);
    let payload = payload.to_vec();
    let until = deadline.at();
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("guard-destructive".to_owned())
        .stack_size(WORKER_STACK)
        .spawn(move || {
            let result =
                panic::catch_unwind(AssertUnwindSafe(|| owned.evaluate(&payload, &repo, until)))
                    .unwrap_or_else(|payload| {
                        Err(Failure(format!("panic: {}", panic_text(&*payload))))
                    });
            // The caller may have given up already.
            let _ = sender.send(result);
        });
    // Dropping the handle detaches the thread; it is never joined.
    drop(spawned.map_err(|error| Failure(format!("cannot start the evaluation thread: {error}")))?);
    match receiver.recv_timeout(until.saturating_duration_since(Instant::now())) {
        Ok(_) if deadline.expired() => Ok(deadline.evaluation()),
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Ok(deadline.evaluation()),
        Err(RecvTimeoutError::Disconnected) => Err(Failure(
            "panic: the evaluation thread ended without an answer".to_owned(),
        )),
    }
}

/// Evaluate one payload as the rendered script does. Repository facts are read through `repo`;
/// nothing is written and no audit event is recorded.
///
/// # Errors
/// An extraction failure, a command the sed lane read as invalid UTF-8 (its byte count is not
/// representable) or an error of [`decide`].
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    repo: &dyn Repo,
) -> Result<Evaluation, Failure> {
    evaluate_with(payload, context, repo, None)
}

/// [`evaluate`], with the instant past which the PII lane launches nothing.
fn evaluate_with(
    payload: &[u8],
    context: &Context<'_>,
    repo: &dyn Repo,
    until: Option<Instant>,
) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    let field = |index: usize| fields.values.get(index).cloned().unwrap_or_default();
    let (cwd, cmd) = (field(CWD), field(COMMAND));
    if fields.bytes.get(COMMAND).copied().unwrap_or_default() != cmd.len() {
        return Err(Failure("command is not valid UTF-8".to_owned()));
    }
    let mut host = context.host.clone();
    host.project_dir = hook_input::project_dir(
        context.engine,
        host.claude_project_dir.as_deref(),
        &cwd,
        repo,
    );
    host.cwd = cwd;
    let probe = HostProbe {
        env: context.pii.env,
        grep: context.pii.grep.as_deref(),
        git: context.pii.git.as_deref(),
        pwd: Path::new(&host.pwd),
        ids: context.pii.ids.as_ref(),
        until,
    };
    let decision = decide(
        &cmd,
        &context.rendered,
        context.engine,
        &host,
        repo,
        context.profile.locale,
        &probe,
    )
    .map_err(Failure)?;
    Ok(Evaluation {
        verdict: if decision.status == 2 {
            Verdict::Block
        } else {
            Verdict::Permit
        },
        stdout: decision.stdout.into_bytes(),
        stderr: capture::prepend(
            context.capture,
            payload.contains(&0),
            fields.nul_substitutions,
            decision.stderr,
        ),
        audit: Some(AuditLabel {
            verdict: decision.verdict,
            reason: decision.reason,
        }),
    })
}
