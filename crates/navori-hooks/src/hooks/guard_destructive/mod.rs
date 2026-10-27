//! Pure text rules of guard-destructive.sh (spec 0057 T28, first increment).
//!
//! Ported so far, in the shell's order: empty command, the byte/line/heredoc ceilings, the
//! no-rule-token fast path and rules 1 (skip-verify), 2 (force-push to base), 3 (recursive rm
//! over root/home/system/scratch root or a variable), 3b (`--no-preserve-root`), 4 (fork bomb),
//! 5 (block device), 6 and 6b (shell rewrites of managed files), 6d (copies onto exact
//! render-owned paths), 6c (the Pi arm: control plane, `pi --no-extensions`, shared `deny` and
//! `ask` rules) and 7 (whole-tree discards of uncommitted work). Rule 1b (the progress ratchet)
//! is not ported; an evaluation that reaches it says so instead of guessing.
//! Nothing here audits; host facts arrive in [`Host`] and repository state through a
//! [`discard::Repo`] ([`discard::System`] is the one adapter that runs `git`).

pub mod copy_dest;
pub mod discard;
mod pi;
mod rendered;
mod rules;
mod tr;

pub use pi::ask_answer;
pub use rendered::Rendered;

/// Host facts the shell reads from its environment before the rules run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Host {
    /// `nv_project_dir`: `$CLAUDE_PROJECT_DIR` under Claude; under Codex and Pi the git
    /// toplevel of the payload's `cwd`, else that `cwd`, else `.`.
    pub project_dir: String,
    /// The payload's `cwd` field (`payload_field cwd`), empty when absent.
    pub cwd: String,
    /// `PWD` of the hook process.
    pub pwd: String,
    /// `HOME`, `None` when unset (rule 7 expands `~` with it).
    pub home: Option<String>,
}

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
    /// Every rule of the base block let the command through (exit 0). The blocks after it
    /// (search lane, user section) still apply.
    Allow {
        /// The fast path saw only copy/move/install/link tokens (`nv_copy_only=1`): audited as
        /// `skip` ("no rule token in the command") unless `ask` is set.
        copy_only: bool,
        /// The first shared `ask` rule a Pi segment matched (`navori_pi_ask`). The exit trap
        /// answers `ask` with [`ask_answer`] when the script exits 0.
        ask: Option<String>,
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
    host: &Host,
    repo: &dyn discard::Repo,
    locale: Locale,
) -> Result<Outcome, String> {
    rules::evaluate(cmd, rendered, engine, host, repo, locale)
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
