//! The rendered script end to end: `payload_load` and `cmd=$(extract_cmd)`, `hook-input`'s
//! project directory, then [`decide`] and the exit trap's audit category.

use std::time::{Duration, Instant};

use super::{Rendered, decide};
use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::{self, CaptureContext};
use crate::shell::hook_input::{self, Host};
use crate::shell::payload::{self, Profile};
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

/// [`evaluate`] under the script's own deadline: expired before the rules run, they are
/// skipped; expired when they return, their answer (an error included) is replaced. Either way
/// the call is blocked. The rules are linear in the command, so the deadline is the last net.
///
/// # Errors
/// The errors of [`evaluate`], only while the deadline has not passed.
pub fn evaluate_until(
    payload: &[u8],
    context: &Context<'_>,
    repo: &dyn Repo,
    deadline: Deadline,
) -> Result<Evaluation, Failure> {
    if deadline.expired() {
        return Ok(deadline.evaluation());
    }
    let result = evaluate(payload, context, repo);
    if deadline.expired() {
        return Ok(deadline.evaluation());
    }
    result
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
    let decision = decide(
        &cmd,
        &context.rendered,
        context.engine,
        &host,
        repo,
        context.profile.locale,
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
