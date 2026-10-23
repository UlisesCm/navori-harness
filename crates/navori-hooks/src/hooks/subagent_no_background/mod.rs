//! Pure policy body of the Claude/Pi subagent background-work guard (spec 0057 T26).
//!
//! This module neither discovers tools nor reads/writes files, launches processes or audits.
//! The caller supplies the original shell's extraction/locale profile. Native registration,
//! shadow execution and audit integration are deliberately separate capabilities.

mod inert;
mod input;

pub use input::{Extractor, Locale, Profile};

use crate::runner::{Engine, Evaluation, Failure, Verdict};

const EXPLANATION: &str = "[navori] a subagent does not background its own work (verify-before-done: run chained steps one by one in the foreground, or report Status: BLOCKED).\n";

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
    }
}

/// Evaluate the existing policy without effects. Its body is shared across engine hosts; the
/// registration layer, outside this pure handler, restricts it to Claude and Pi.
///
/// Malformed payloads follow the selected extraction fallback, never a generic parse-error
/// verdict. `profile` must describe the original shell environment, not Rust tool availability.
///
/// # Errors
/// Returns an internal failure only if the fixed policy patterns cannot be initialized.
pub fn evaluate(payload: &[u8], _engine: Engine, profile: Profile) -> Result<Evaluation, Failure> {
    let captured = input::capture(payload);
    if !captured
        .windows(b"\"agent_id\"".len())
        .any(|w| w == b"\"agent_id\"")
    {
        return Ok(result(None));
    }
    let fields = input::extract(&captured, profile)?;
    if fields.tool == "Monitor" {
        return Ok(result(Some("Monitor dentro de un subagente")));
    }
    if fields.tool != "Bash" {
        return Ok(result(None));
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
        Locale::Utf8 => fields.command.chars().count(),
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
