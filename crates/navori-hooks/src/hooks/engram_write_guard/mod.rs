//! The engram tool grant of each subagent role, Codex only (spec 0060 T13, R70).
//!
//! `engram-write-guard.sh` lets a subagent call only the engram tools its role is granted
//! (`nv_engram_allowed`, compiled by the renderer from the same grants Claude writes into
//! `tools:`), and blocks the rest. The main thread is never blocked. It reads nothing outside the
//! payload and its own text, so shadow evaluates it whole.

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::{self, CaptureContext};
use crate::shell::payload::{self, Extractor, Profile};
use crate::shell::role_case::RoleCase;

/// Hosts that register this hook.
pub const ENGINES: &[Engine] = &[Engine::Codex];

/// `nv_payload_fields`, in its declared order.
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
const AGENT_TYPE: usize = 0;
const TOOL_NAME: usize = 8;
const BLOCK_END: &str = "# navori:managed end id=\"engram-write-guard-base\"";

/// What the renderer wrote into the script: the grant policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `nv_engram_allowed`.
    pub policy: RoleCase,
}

impl Rendered {
    /// Read the policy; only comments may follow the managed block.
    ///
    /// # Errors
    /// The reason the script is not one the native hook reproduces.
    pub fn from_script(source: &str) -> Result<Self, String> {
        if let Some(end) = source.find(BLOCK_END)
            && source[end + BLOCK_END.len()..].lines().any(|line| {
                let line = line.trim_start_matches([' ', '\t']);
                !line.is_empty() && !line.starts_with('#')
            })
        {
            return Err("the user section holds commands".to_owned());
        }
        Ok(Self {
            policy: RoleCase::from_script(source, "nv_engram_allowed")?,
        })
    }
}

/// The invocation facts collected before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Accredited extraction and locale profile; the extractor also says whether jq or node is
    /// on `PATH`.
    pub profile: Profile,
    /// Script identity and the source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// The policy the renderer wrote.
    pub rendered: Rendered,
}

/// Evaluate one call.
///
/// # Errors
/// An extraction failure or a field that is not valid UTF-8.
pub fn evaluate(payload: &[u8], context: &Context<'_>) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    for (index, value) in fields.values.iter().enumerate() {
        if fields.bytes.get(index).copied().unwrap_or_default() != value.len() {
            return Err(Failure("a payload field is not valid UTF-8".to_owned()));
        }
    }
    let stderr = capture::prepend(
        context.capture,
        payload.contains(&0),
        fields.nul_substitutions,
        Vec::new(),
    );
    let done = |verdict: Verdict, label: &'static str, reason: &str, extra: &str| {
        let mut err = stderr.clone();
        err.extend_from_slice(extra.as_bytes());
        Evaluation {
            verdict,
            stdout: Vec::new(),
            stderr: err,
            audit: Some(AuditLabel {
                verdict: label,
                reason: reason.to_owned(),
            }),
        }
    };
    let skip = |reason: &str| done(Verdict::Permit, "skip", reason, "");
    if !captured
        .windows(b"\"agent_type\"".len())
        .any(|w| w == b"\"agent_type\"")
    {
        return Ok(skip("sin agent_type (hilo principal)"));
    }
    if matches!(context.profile.extractor, Extractor::Sed) {
        return Ok(skip("sin jq ni node: payload ilegible"));
    }
    let role = fields.values[AGENT_TYPE].as_str();
    if role.is_empty() {
        return Ok(skip("agent_type vacío (hilo principal)"));
    }
    // `nv_tool` under Codex.
    let tool = match fields.values[TOOL_NAME].as_str() {
        "apply_patch" => "Edit",
        "spawn_agent" => "Agent",
        tool => tool,
    };
    if !(tool.starts_with("mcp__engram__") || tool.starts_with("mcp__plugin_engram_engram__")) {
        return Ok(skip("tool_name no cubierto"));
    }
    // `${navori_tool##*__}`.
    let name = tool.rsplit_once("__").map_or(tool, |(_, name)| name);
    let granted = context.rendered.policy.lines(role);
    if granted
        .iter()
        .any(|allowed| allowed == "*" || allowed == name)
    {
        return Ok(done(
            Verdict::Permit,
            "allow",
            &format!("{name} concedida a {role}"),
            "",
        ));
    }
    let reason = format!(
        "{name} is not granted to the {role} role. This is a fixed harness policy, not a transient error: do NOT retry it and do NOT use another memory tool. Report what you found in your normal output; the main thread decides whether to save it."
    );
    Ok(done(
        Verdict::Block,
        "block",
        &reason,
        &format!("[navori] BLOCKED by engram-write-guard: {reason}\n"),
    ))
}
