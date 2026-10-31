//! Pure policy body of the master-plan manual-approval confirmation (spec 0060 T9, R70).
//!
//! `master-accept-confirm.sh` asks (Claude, Pi) or denies as the confirmation (Codex) when a
//! command records a person's manual approval or closes a stage. Like `general_purpose_confirm`
//! it makes no CLI call and has no effect; it names the shell's audit verdict and reason for the
//! caller to record.

use std::sync::LazyLock;

use regex::Regex;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::CaptureContext;
use crate::shell::gate_trigger::scan;
use crate::shell::payload::Profile;
use crate::shell::prepare::Prepared;
use crate::shell::{Locale, capture, payload};

/// Hosts that register this hook. Only the Codex copy denies; the others ask.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

/// `nv_payload_fields` of master-accept-confirm.sh.
const FIELDS: [&str; 1] = ["tool_input.command"];

/// `$TRIGGER_TOKENS`: every matching command carries one of them.
const TOKENS: [&str; 6] = [
    "approved-by",
    "delivery-baseline",
    "delivery-queue",
    "escalation-reset",
    "navori",
    "master",
];

const SKIP: &str = "el comando no registra una aprobación manual";
const REASON: &str = "manual approval or stage close";

/// `$TRIGGER_RE` as the script assembles it from `BOUND`, `RUNNER`, `NAVORI` and the forms.
fn pattern() -> String {
    const BOUND: &str = r"(^|[;&|(`]|[[:space:]])";
    const RUNNER: &str =
        r"((npx|bunx|pnpm[[:space:]]+(exec|dlx))[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?";
    let navori = format!(r"{RUNNER}([^[:space:];&|(`]*/)?navori(@[^[:space:]]+)?");
    let approved = r".*--approved-by([[:space:]=]|$)";
    let forms = [
        format!(r"{navori}[[:space:]]+master[[:space:]]+part([[:space:]]|$){approved}"),
        format!(r"{navori}[[:space:]]+master[[:space:]]+close([[:space:];&|)<>]|$)"),
        format!(
            r"{navori}[[:space:]]+master[[:space:]]+delivery-baseline([[:space:]]|$){approved}"
        ),
        format!(r"{navori}[[:space:]]+master[[:space:]]+delivery-queue([[:space:]]|$){approved}"),
        format!(
            r"{navori}[[:space:]]+master[[:space:]]+delivery-(review|decision|publication|revoke)([[:space:];&|)<>]|$)"
        ),
        format!(
            r"{navori}[[:space:]]+master[[:space:]]+delivery-criterion([[:space:]]|$){approved}"
        ),
        format!(
            r"{navori}[[:space:]]+master[[:space:]]+delivery-slice([[:space:]]|$).*--refresh([[:space:]=]|$)"
        ),
        format!(r"{navori}[[:space:]]+plan[[:space:]]+escalation-reset([[:space:]]|$){approved}"),
    ];
    format!(".*{BOUND}({})", forms.join("|"))
}

/// `$TRIGGER_RE` compiled for `locale`.
fn trigger(locale: Locale) -> Result<&'static Regex, Failure> {
    const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
    static COMPILED: LazyLock<Vec<Result<Regex, regex::Error>>> = LazyLock::new(|| {
        let pattern = pattern();
        LOCALES.map(|locale| locale.ere(&pattern)).into()
    });
    let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
    COMPILED
        .get(column)
        .ok_or_else(|| Failure("trigger pattern missing".to_owned()))?
        .as_ref()
        .map_err(|error| Failure(format!("trigger pattern: {error}")))
}

/// `approval_description`: the first `case "$cmd"` arm that matches.
fn description(cmd: &str) -> &'static str {
    const ARMS: [(&[&str], &str); 7] = [
        (
            &["delivery-review"],
            "this exact technical snapshot: you inspected the bound report, attest that the named reviewer was separate from the producer, and observed the stated full QA command succeed. The CLI checks content and the current receipt; it does not authenticate reviewer identity or execute QA",
        ),
        (
            &["delivery-decision"],
            "the explicit client decision on this exact presented delivery or reasoned disposition of its current scope",
        ),
        (
            &["delivery-publication"],
            "the release or deploy reference for this exact accepted delivery; this records publication, it does not deploy",
        ),
        (
            &["delivery-revoke"],
            "revocation of the active authority generation and prior effective proof",
        ),
        (
            &["delivery-slice"],
            "the current-queue reverification refresh; pending criteria reset and normal plan approval is required again",
        ),
        (
            &["escalation-reset"],
            "another review round after two rejections at level 2 or higher",
        ),
        (
            &["delivery-baseline", "delivery-queue"],
            "the delivery baseline or bounded queue",
        ),
    ];
    ARMS.iter()
        .find(|(needles, _)| needles.iter().any(|needle| cmd.contains(needle)))
        .map_or("a manual criterion", |(_, text)| text)
}

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
/// An extraction failure or a command that is not valid UTF-8; no error permits a call.
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
/// The failures of [`evaluate_with_capture`].
pub fn evaluate(payload: &[u8], engine: Engine, profile: Profile) -> Result<Evaluation, Failure> {
    evaluate_captured(payload, engine, profile).map(|(evaluation, _)| evaluation)
}

/// The script, in order: the token fast path on the raw capture, the command, its rewrites, the
/// segment scan and the engine arm. Returns the evaluation and how many field substitutions
/// dropped a NUL.
fn evaluate_captured(
    payload: &[u8],
    engine: Engine,
    profile: Profile,
) -> Result<(Evaluation, usize), Failure> {
    let captured = payload::capture(payload);
    // `has_trigger_token "${payload:-}" || exit 0`: before `navori_audit_begin`, so no event.
    let mentions = |token: &str| captured.windows(token.len()).any(|w| w == token.as_bytes());
    if !TOKENS.iter().any(|token| mentions(token)) {
        return Ok((outcome("", None), 0));
    }
    let extracted = payload::extract(&captured, &FIELDS, profile)?;
    let [cmd] = extracted.values.as_slice() else {
        return Err(Failure("payload extraction lost a field".to_owned()));
    };
    if extracted.bytes.first().copied().unwrap_or_default() != cmd.len() {
        return Err(Failure("command is not valid UTF-8".to_owned()));
    }
    let substitutions = extracted.nul_substitutions;
    if cmd.is_empty() {
        return Ok((outcome("", Some(("skip", SKIP))), substitutions));
    }
    // `${cmd//"$("/; }`, then every `"` and `'` deleted.
    let cmd = cmd.replace("$(", "; ").replace(['"', '\''], "");
    let locale = profile.locale;
    if !scan(&cmd, &TOKENS, trigger(locale)?, false, locale).map_err(Failure)? {
        return Ok((outcome("", Some(("skip", SKIP))), substitutions));
    }
    let what = description(&cmd);
    let evaluation = if engine == Engine::Codex {
        outcome(
            &format!(
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"[navori] this records that the user approved {what}, and Codex hooks cannot prompt. Show the user what it approves and let them confirm and run the command themselves.\"}}}}\n"
            ),
            Some(("deny", REASON)),
        )
    } else {
        outcome(
            &format!(
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"[navori] this records that you approved {what}. Confirm only if you reviewed it.\"}}}}\n"
            ),
            Some(("ask", REASON)),
        )
    };
    Ok((evaluation, substitutions))
}

fn outcome(stdout: &str, audit: Option<(&'static str, &str)>) -> Evaluation {
    Evaluation {
        verdict: Verdict::Permit,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        audit: audit.map(|(verdict, reason)| AuditLabel {
            verdict,
            reason: reason.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{description, pattern};

    // Covers: R70
    #[test]
    fn the_pattern_spells_the_scripts_trigger_re() {
        let re = pattern();
        assert!(re.starts_with(".*(^|[;&|(`]|[[:space:]])(((npx|bunx|pnpm"));
        assert_eq!(re.matches("navori(@[^[:space:]]+)?").count(), 8);
        assert_eq!(
            description("navori master delivery-queue x"),
            "the delivery baseline or bounded queue"
        );
        assert_eq!(
            description("navori master part P1 --approved-by u"),
            "a manual criterion"
        );
    }
}
