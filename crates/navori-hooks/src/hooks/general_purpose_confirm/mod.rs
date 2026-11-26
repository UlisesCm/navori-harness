//! Pure policy body of the general-purpose dispatch confirmation (spec 0060 M1, R70).
//!
//! The reference hook slice of phase 4: a gating hook with no CLI call and no effect. Like
//! `subagent_no_background`, this module neither discovers tools nor reads/writes files, launches
//! processes or audits; it names the shell's audit verdict and reason for the caller to record.

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::CaptureContext;
use crate::shell::payload::Profile;
use crate::shell::prepare::Prepared;
use crate::shell::{capture, payload};

/// Hosts that register this hook: Claude asks, Codex denies as the confirmation (Pi does not
/// register it).
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];

/// `nv_payload_fields` of general-purpose-confirm.sh, in its declared order.
const FIELDS: [&str; 3] = [
    "tool_input.agent_type",
    "tool_input.command",
    "tool_input.subagent_type",
];

/// The role this hook confirms, and the substring its fast path looks for.
const ROLE: &str = "general-purpose";

const REASON: &str = "general-purpose despachado; scout cubre lectura e investigación";

const ASK: &str = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"[navori] general-purpose is dispatched here. For read-only exploration or web research the scout covers it (dispatch it with the Agent tool) with the right tools. Confirm only if this task needs general-purpose.\"}}\n";

const DENY: &str = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"[navori] general-purpose is dispatched here and Codex hooks cannot prompt. For read-only exploration or web research dispatch the scout instead; if this task really needs general-purpose, ask the user to confirm and re-dispatch.\"}}\n";

/// Evaluate with a preparation's accredited profile and capture context.
///
/// # Errors
/// The failures of [`evaluate_with_capture`].
pub fn evaluate_prepared(prepared: &Prepared<'_>, payload: &[u8]) -> Result<Evaluation, Failure> {
    evaluate_with_capture(
        payload,
        prepared.engine(),
        prepared.profile(),
        prepared.capture(),
    )
}

/// Evaluate the policy plus the original Bash command-substitution diagnostics, without effects.
///
/// # Errors
/// Returns an internal extraction failure; no error permits a call.
pub fn evaluate_with_capture(
    payload: &[u8],
    engine: Engine,
    profile: Profile,
    context: CaptureContext<'_>,
) -> Result<Evaluation, Failure> {
    let (mut evaluation, substitutions) = evaluate_captured(payload, engine, profile)?;
    evaluation.stderr = capture::prepend(
        context,
        payload.contains(&0),
        substitutions,
        evaluation.stderr,
    );
    Ok(evaluation)
}

/// Evaluate the policy alone, with no capture diagnostics.
///
/// # Errors
/// Returns an internal extraction failure.
pub fn evaluate(payload: &[u8], engine: Engine, profile: Profile) -> Result<Evaluation, Failure> {
    evaluate_captured(payload, engine, profile).map(|(evaluation, _)| evaluation)
}

/// The script, in order: fast path on the raw capture, then the two fields, then the engine arm.
/// Returns the evaluation and how many individual field substitutions dropped a NUL.
fn evaluate_captured(
    payload: &[u8],
    engine: Engine,
    profile: Profile,
) -> Result<(Evaluation, usize), Failure> {
    let captured = payload::capture(payload);
    // `case "${payload:-}" in *general-purpose*`: exits before `navori_audit_begin`, so no event.
    if !captured.windows(ROLE.len()).any(|w| w == ROLE.as_bytes()) {
        return Ok((outcome(Verdict::Permit, "", None), 0));
    }
    let extracted = payload::extract(&captured, &FIELDS, profile)?;
    let [agent_type, _command, subagent_type] = extracted.values.as_slice() else {
        return Err(Failure("payload extraction lost a field".to_owned()));
    };
    let role = if subagent_type.is_empty() {
        agent_type
    } else {
        subagent_type
    };
    let evaluation = if role != ROLE {
        outcome(
            Verdict::Permit,
            "",
            Some(("skip", "el subagente no es general-purpose")),
        )
    } else if engine == Engine::Codex {
        outcome(Verdict::Permit, DENY, Some(("deny", REASON)))
    } else {
        outcome(Verdict::Permit, ASK, Some(("ask", REASON)))
    };
    Ok((evaluation, extracted.nul_substitutions))
}

fn outcome(verdict: Verdict, stdout: &str, audit: Option<(&'static str, &str)>) -> Evaluation {
    Evaluation {
        verdict,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        audit: audit.map(|(verdict, reason)| AuditLabel {
            verdict,
            reason: reason.to_owned(),
        }),
    }
}
