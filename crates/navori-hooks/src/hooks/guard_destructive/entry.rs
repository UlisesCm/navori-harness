//! The rendered script end to end: `payload_load` and `cmd=$(extract_cmd)`, `hook-input`'s
//! project directory, then [`decide`] and the exit trap's audit category.

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
