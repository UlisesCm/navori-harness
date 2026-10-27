//! Pure text rules of guard-destructive.sh (spec 0057 T28, first increment).
//!
//! Ported so far, in the shell's order: empty command, the byte/line/heredoc ceilings, the
//! no-rule-token fast path and rules 1 (skip-verify), 1b (the progress ratchet on a commit, with
//! its landing and worktree resolution), 2 (force-push to base), 3 (recursive rm
//! over root/home/system/scratch root or a variable), 3b (`--no-preserve-root`), 4 (fork bomb),
//! 5 (block device), 6 and 6b (shell rewrites of managed files), 6d (copies onto exact
//! render-owned paths), 6c (the Pi arm: control plane, `pi --no-extensions`, shared `deny` and
//! `ask` rules) and 7 (whole-tree discards of uncommitted work), which is the whole base block.
//! Nothing here audits; host facts arrive in [`Host`] and repository state through a
//! [`repo::Repo`] ([`repo::System`] is the one adapter that runs `git`).

pub mod copy_dest;
mod discard;
pub mod entry;
mod landing;
mod pi;
mod ratchet;
mod rendered;
pub mod repo;
mod rules;
pub mod search;
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
    /// `CLAUDE_PROJECT_DIR` as the environment holds it, under every engine (rule 1b's home
    /// repository and its fallback comparison).
    pub claude_project_dir: Option<String>,
    /// `CDPATH`: a non-empty value leaves a relative `cd` unproven in rule 1b.
    pub cdpath: Option<String>,
    /// `navori_hook_path`: `$0`, prefixed with `PWD/` when relative.
    pub hook_path: String,
    /// `PATH`, where the search lane looks for `tgrep`.
    pub path: Option<String>,
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
    /// Rule 1b blocked the commit and printed its own verdict: exit 2, audit reason
    /// `unspecified`, `stderr` exactly as the lane writes it.
    Ratchet {
        /// The lane's two lines.
        stderr: String,
    },
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
/// Returns a description of a policy pattern that failed to compile, or of a host state the
/// model does not reproduce (rule 1b cannot enter the tree it measures: bash's own `cd` error,
/// with its script line number, is the shell's answer there).
pub fn evaluate(
    cmd: &str,
    rendered: &Rendered,
    engine: Engine,
    host: &Host,
    repo: &dyn repo::Repo,
    locale: Locale,
) -> Result<Outcome, String> {
    rules::evaluate(cmd, rendered, engine, host, repo, locale)
}

/// The whole script's answer: what the host sees and what the exit trap records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// Exit status, 0 or 2.
    pub status: i32,
    /// Exact stdout (the trap's `ask` answer, or nothing).
    pub stdout: String,
    /// Exact stderr.
    pub stderr: Vec<u8>,
    /// `navori_audit_verdict`.
    pub verdict: &'static str,
    /// `navori_audit_reason`.
    pub reason: String,
}

/// The base block, the tgrep search lane after it (when the script carries it) and the exit
/// trap's `ask`, composed as the rendered script runs them. The user section is not modeled:
/// it must be empty.
///
/// # Errors
/// The errors of [`evaluate`] and [`search::evaluate`].
pub fn decide(
    cmd: &str,
    rendered: &Rendered,
    engine: Engine,
    host: &Host,
    repo: &dyn repo::Repo,
    locale: Locale,
) -> Result<Decision, String> {
    let blocked = |stderr: Vec<u8>, reason: &str| Decision {
        status: 2,
        stdout: String::new(),
        stderr,
        verdict: "block",
        reason: reason.to_owned(),
    };
    let (copy_only, ask) = match evaluate(cmd, rendered, engine, host, repo, locale)? {
        Outcome::Block {
            message,
            reason,
            route,
        } => return Ok(blocked(block_stderr(cmd, &message, route, locale), reason)),
        Outcome::Ratchet { stderr } => return Ok(blocked(stderr.into_bytes(), "unspecified")),
        Outcome::Skip { reason } => {
            return Ok(Decision {
                status: 0,
                stdout: String::new(),
                stderr: Vec::new(),
                verdict: "skip",
                reason: reason.to_owned(),
            });
        }
        Outcome::Allow { copy_only, ask } => (copy_only, ask),
    };
    let (mut verdict, mut reason) = if copy_only && ask.is_none() {
        ("skip", "no rule token in the command".to_owned())
    } else {
        ("allow", String::new())
    };
    let search = if rendered.search_lane {
        search::evaluate(cmd, host, repo, locale)?
    } else {
        search::Search::Pass
    };
    match search {
        search::Search::Block { stderr } => {
            return Ok(blocked(
                stderr.into_bytes(),
                "content search routed to the index",
            ));
        }
        search::Search::FailOpen => {
            verdict = "fail-open";
            reason = "search index unavailable".to_owned();
        }
        search::Search::Pass => {}
    }
    let mut stdout = String::new();
    if let Some(prefix) = ask {
        let (answer, why) = ask_answer(&prefix, locale);
        stdout = answer;
        verdict = "ask";
        reason = why;
    }
    Ok(Decision {
        status: 0,
        stdout,
        stderr: Vec::new(),
        verdict,
        reason,
    })
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
