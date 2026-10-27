//! Pure policy body of the Claude/Pi subagent background-work guard (spec 0057 T26).
//!
//! This module neither discovers tools nor reads/writes files, launches processes or audits.
//! The caller supplies the original shell's extraction/locale profile. Each evaluation names
//! the shell's audit verdict and reason; recording it, native registration and shadow execution
//! are deliberately separate capabilities.

mod capture;
mod inert;
mod input;
pub mod prepare;

pub use capture::{CaptureContext, ShellDialect};
pub use input::{Extractor, Locale, Profile};

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};

const EXPLANATION: &str = "[navori] a subagent does not background its own work (verify-before-done: run chained steps one by one in the foreground, or report Status: BLOCKED).\n";

/// Block with `reason`, or allow; the audit label mirrors the shell's final `navori_audit_log`.
fn result(reason: Option<&str>) -> Evaluation {
    Evaluation {
        verdict: if reason.is_some() {
            Verdict::Block
        } else {
            Verdict::Permit
        },
        stdout: Vec::new(),
        stderr: reason.map_or_else(Vec::new, |reason| {
            format!("[navori] BLOCKED by subagent-no-background: {reason}\n{EXPLANATION}")
                .into_bytes()
        }),
        audit: Some(AuditLabel {
            verdict: if reason.is_some() { "block" } else { "allow" },
            reason: reason.unwrap_or("no backgrounded").to_owned(),
        }),
    }
}

/// Out of scope (main thread or an uncovered tool): allowed and audited as `skip`.
fn skip(reason: &str) -> Evaluation {
    Evaluation {
        audit: Some(AuditLabel {
            verdict: "skip",
            reason: reason.to_owned(),
        }),
        ..result(None)
    }
}

/// Evaluate the existing policy without effects. Its body is shared across engine hosts; the
/// registration layer, outside this pure handler, restricts it to Claude and Pi.
///
/// Malformed payloads follow the selected extraction fallback, never a generic parse-error
/// verdict. `profile` must describe the original shell environment, not Rust tool availability.
///
/// # Errors
/// Returns an internal extraction or policy-initialization failure.
pub fn evaluate(payload: &[u8], _engine: Engine, profile: Profile) -> Result<Evaluation, Failure> {
    evaluate_captured(payload, profile).map(|(evaluation, _)| evaluation)
}

/// Evaluate policy plus the original Bash command-substitution diagnostics without effects.
/// The caller provides the real shell dialect, script bytes and expanded-source line locations.
///
/// # Errors
/// Propagates the same internal extraction/policy failures as `evaluate`; no error permits a call.
pub fn evaluate_with_capture(
    payload: &[u8],
    _engine: Engine,
    profile: Profile,
    context: CaptureContext<'_>,
) -> Result<Evaluation, Failure> {
    let (mut evaluation, fields) = evaluate_captured(payload, profile)?;
    evaluation.stderr = capture::prepend(context, payload.contains(&0), fields, evaluation.stderr);
    Ok(evaluation)
}

/// Capture once and retain only the count of individual substitutions that dropped a NUL.
fn evaluate_captured(payload: &[u8], profile: Profile) -> Result<(Evaluation, usize), Failure> {
    let captured = input::capture(payload);
    if !captured
        .windows(b"\"agent_id\"".len())
        .any(|w| w == b"\"agent_id\"")
    {
        return Ok((skip("sin agent_id (hilo principal)"), 0));
    }
    let fields = input::extract(&captured, profile)?;
    Ok((evaluate_fields(&fields, profile)?, fields.nul_substitutions))
}

/// Preserve the pure policy after extraction, independently of runtime diagnostic formatting.
fn evaluate_fields(fields: &input::Fields, profile: Profile) -> Result<Evaluation, Failure> {
    if fields.tool == "Monitor" {
        return Ok(result(Some("Monitor dentro de un subagente")));
    }
    if fields.tool != "Bash" {
        return Ok(skip("tool_name no cubierto"));
    }
    if fields.background == "true" {
        return Ok(result(Some(
            "Bash run_in_background dentro de un subagente",
        )));
    }
    if fields.command.is_empty() {
        return Ok(result(None));
    }
    let length = match profile.locale {
        Locale::Utf8 | Locale::GnuUtf8 => fields.command.chars().count(),
        Locale::C => fields.command_bytes,
    };
    if length > inert::CMD_MAX {
        return Ok(result(Some(&format!(
            "comando demasiado grande para inspeccionarlo ({length} > {})",
            inert::CMD_MAX
        ))));
    }
    Ok(result(
        inert::reason(&fields.command, profile.locale)?.as_deref(),
    ))
}
