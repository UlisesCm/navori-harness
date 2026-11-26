//! The `gh pr create` confirmation (spec 0060 T14, R70, R72).
//!
//! `pr-publisher-confirm.sh` routes a `gh pr create` that does not come from a subagent to the
//! user: `ask` under Claude (only when jq can build the reason), a draft-bound `ask` under Pi,
//! and under Codex the deny-as-confirmation that `navori codex approval request` builds, or a
//! fixed one. That request records an approval, so a shadow call answers "unobserved" there;
//! every other branch only reads.

use std::sync::LazyLock;

use regex::Regex;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext};
use crate::shell::draft_body::{self, DraftHost, Kind, NodePrograms, decision_json};
use crate::shell::gate_trigger::scan;
use crate::shell::payload::{self, Extractor, Profile};

/// Hosts that register this hook.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

const FIELDS: [&str; 3] = ["agent_id", "subagent_id", "tool_input.command"];
const AGENT_ID: usize = 0;
const SUBAGENT_ID: usize = 1;
const COMMAND: usize = 2;
const TOKENS: [&str; 1] = ["create"];
const SKIP: &str = "el comando no abre un PR";
const BLOCK_END: &str = "# navori:managed end id=\"pr-publisher-confirm-base\"";

const CODEX_DENY: &str = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"[navori] this `gh pr create` opens a PR and Codex hooks cannot prompt. Show the user the title and body, and let them confirm and run the command themselves.\"}}\n";
const PI_FALLBACK: &str = "[navori] this call opens a GitHub pull request and its draft could not be read or rendered (no readable body, or no jq/node on PATH to parse it). Review the exact command above before confirming.";
const CLAUDE_REASON: &str = "[navori] this `gh pr create` does not come from the publisher.\n\nThe publisher is the single owner of commit+PR: it applies the title/body format\nthis repo uses and runs the git/gh pre-flight before opening anything.\n\nDelegate it with the Agent tool (subagent_type: publisher), or confirm to\nopen this PR by hand — a rollout PR, a revert, or a session where subagents are\nunavailable are all legitimate reasons to do so.";

/// What the script carries besides its rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `draft-body`'s ADF and GraphQL-body programs (the Pi arm).
    pub node: NodePrograms,
    /// The Codex arm's `node -e` program that runs `navori codex approval request`.
    pub approval: String,
}

impl Rendered {
    /// Read the programs; only comments may follow the managed block.
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
        let mut approvals = source
            .split("node -e '")
            .skip(1)
            .filter_map(|rest| rest.split_once('\'').map(|(program, _)| program))
            .filter(|program| program.contains("spawn(\"navori\""));
        let approval = approvals.next().ok_or("the approval program is missing")?;
        if approvals.next().is_some() {
            return Err("the approval program is ambiguous".to_owned());
        }
        Ok(Self {
            node: NodePrograms::from_script(source)?,
            approval: approval.to_owned(),
        })
    }
}

/// What the hook reads or runs besides the draft.
pub trait Host: DraftHost {
    /// `command -v name`.
    fn on_path(&self, name: &str) -> bool;
    /// `printf '%s' "$payload" | node -e "$program" 2>/dev/null`: stdout when it exits 0,
    /// `None` otherwise.
    ///
    /// # Errors
    /// [`crate::runner::unobserved`] in shadow (the call records an approval), or a run the port
    /// cannot reproduce.
    fn request_approval(&self, program: &str, payload: &[u8]) -> Result<Option<Vec<u8>>, Failure>;
}

/// The invocation facts collected before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// The engine whose copy runs (`$0`).
    pub engine: Engine,
    /// Accredited extraction and locale profile; the extractor also says which of jq and node
    /// `command -v` finds.
    pub profile: Profile,
    /// Script identity and the source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// The programs the script carries.
    pub rendered: Rendered,
}

fn trigger(locale: Locale) -> Result<&'static Regex, Failure> {
    const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
    static COMPILED: LazyLock<Vec<Result<Regex, regex::Error>>> = LazyLock::new(|| {
        LOCALES
            .map(|locale| locale.ere(r"^gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"))
            .into()
    });
    let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
    COMPILED
        .get(column)
        .ok_or_else(|| Failure("trigger pattern missing".to_owned()))?
        .as_ref()
        .map_err(|error| Failure(format!("trigger pattern: {error}")))
}

/// Evaluate one call.
///
/// # Errors
/// An extraction failure, text that is not valid UTF-8, a draft the port does not reproduce,
/// or [`crate::runner::unobserved`] for the Codex approval request in shadow.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    host: &dyn Host,
) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    let mentions = |token: &str| captured.windows(token.len()).any(|w| w == token.as_bytes());
    if !TOKENS.iter().any(|token| mentions(token)) {
        return Ok(Evaluation {
            verdict: Verdict::Permit,
            stdout: Vec::new(),
            stderr: Vec::new(),
            audit: None,
        });
    }
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
    let done = |stdout: Vec<u8>, verdict: &'static str, reason: &str| Evaluation {
        verdict: Verdict::Permit,
        stdout,
        stderr: stderr.clone(),
        audit: Some(AuditLabel {
            verdict,
            reason: reason.to_owned(),
        }),
    };
    let cmd = fields.values[COMMAND].as_str();
    let locale = context.profile.locale;
    if cmd.is_empty() || !scan(cmd, &TOKENS, trigger(locale)?, false, locale).map_err(Failure)? {
        return Ok(done(Vec::new(), "skip", SKIP));
    }
    let (have_jq, have_node) = match context.profile.extractor {
        Extractor::JqAndNode => (true, true),
        Extractor::JqOnly => (true, false),
        Extractor::Node => (false, true),
        Extractor::Sed => (false, false),
    };
    match context.engine {
        Engine::Codex => {
            let reason = "gh pr create requires user confirmation (Codex)";
            if have_node
                && host.on_path("navori")
                && let Some(out) = host.request_approval(&context.rendered.approval, &captured)?
            {
                return Ok(done(out, "deny", reason));
            }
            Ok(done(CODEX_DENY.as_bytes().to_vec(), "deny", reason))
        }
        Engine::Pi => {
            let reason = "gh pr create requires user confirmation (Pi)";
            if !have_jq && !have_node {
                return Ok(done(
                    format!(
                        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"{PI_FALLBACK}\"}}}}\n"
                    )
                    .into_bytes(),
                    "ask",
                    reason,
                ));
            }
            let draft = draft_body::draft(
                &draft_body::Request {
                    cmd,
                    kind: Kind::GhPrOpen,
                    label: "a GitHub pull request",
                    fallback: PI_FALLBACK,
                    have_jq,
                    node: &context.rendered.node,
                    locale,
                },
                host,
            )?;
            let files = (!draft.bound_file.is_empty()).then_some(draft.bound_file.as_str());
            Ok(done(
                decision_json("ask", &draft.reason, files, have_jq).into_bytes(),
                "ask",
                reason,
            ))
        }
        _ => {
            if !fields.values[AGENT_ID].is_empty() || !fields.values[SUBAGENT_ID].is_empty() {
                return Ok(done(Vec::new(), "allow", "el PR viene de un subagente"));
            }
            let reason = "PR abierto fuera del publisher";
            // No jq: silent rather than malformed JSON.
            if !have_jq {
                return Ok(done(Vec::new(), "ask", reason));
            }
            Ok(done(
                decision_json("ask", CLAUDE_REASON, None, true).into_bytes(),
                "ask",
                reason,
            ))
        }
    }
}
