//! Pure text rules of guard-destructive.sh (spec 0057 T28, first increment).
//!
//! Ported so far, in the shell's order: empty command, the byte/line/heredoc ceilings, the
//! no-rule-token fast path and rules 1 (skip-verify), 2 (force-push to base), 3 (recursive rm
//! over root/home/system/scratch root or a variable), 3b (`--no-preserve-root`), 4 (fork bomb)
//! and 5 (block device). Rule 1b and rules 6-7 read paths, git state or Pi permission rules;
//! until they are ported an evaluation that reaches them says so instead of guessing.
//! Nothing here reads files, runs processes or audits.

mod rendered;
mod rules;

pub use rendered::Rendered;

use crate::runner::Engine;
use crate::shell::Locale;

/// What the ported rules decide for one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// `block <message> <reason> [route]`: exit 2.
    Block {
        /// First argument of the shell's `block`.
        message: String,
        /// Allowlisted audit reason code.
        reason: &'static str,
        /// Route line, when the rule has a safe alternative.
        route: Option<&'static str>,
    },
    /// Exit 0 with nothing printed, audited as `skip`.
    Skip {
        /// The shell's `navori_audit_reason` text.
        reason: &'static str,
    },
    /// No ported rule decided; the shell's later rules still apply.
    Continue {
        /// The fast path saw only copy/move/install/link tokens (`nv_copy_only=1`).
        copy_only: bool,
    },
    /// Rule 1b (the progress ratchet lane) would run here; it is not ported yet.
    ProgressLane,
}

/// Command lengths as the shell counts them: characters, or bytes under `LC_ALL=C`.
fn length(cmd: &str, locale: Locale) -> usize {
    match locale {
        Locale::Utf8 | Locale::GnuUtf8 => cmd.chars().count(),
        Locale::C => cmd.len(),
    }
}

/// Evaluate the ported rules for an extracted command.
///
/// # Errors
/// Returns a description of a policy pattern that failed to compile.
pub fn evaluate(
    cmd: &str,
    rendered: &Rendered,
    engine: Engine,
    locale: Locale,
) -> Result<Outcome, String> {
    rules::evaluate(cmd, rendered, engine, locale)
}

/// Exact stderr of the shell's `block`: reason, the command cut at 2000 characters (bytes under
/// `LC_ALL=C`), and the route when there is one.
#[must_use]
pub fn block_stderr(cmd: &str, message: &str, route: Option<&str>, locale: Locale) -> Vec<u8> {
    let mut out = format!("[navori] BLOCKED by guard-destructive: {message}\n[navori] command: ")
        .into_bytes();
    match locale {
        Locale::Utf8 | Locale::GnuUtf8 => {
            out.extend(cmd.chars().take(2000).collect::<String>().bytes());
        }
        Locale::C => out.extend_from_slice(&cmd.as_bytes()[..cmd.len().min(2000)]),
    }
    out.push(b'\n');
    if let Some(route) = route {
        out.extend(format!("[navori] route: {route}\n").bytes());
    }
    out
}
