//! The publish confirmation for comments, reviews and issues (spec 0060 T14, R70, R72).
//!
//! `comment-draft-confirm.sh` raises a call that publishes a GitHub comment/review/issue or a
//! Jira comment to the user, with the draft's own text in the reason: `ask` under Claude and
//! Pi, `deny` (deny-as-confirmation) under Codex. The row classification runs here; the draft
//! comes from [`crate::shell::draft_body`]. Nothing it does writes, so shadow evaluates it whole.

use std::sync::LazyLock;

use regex::Regex;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext};
use crate::shell::draft_body::{self, DraftHost, Kind, NodePrograms, any_line, decision_json};
use crate::shell::payload::{self, Extractor, Profile};

/// Hosts that register this hook; the Codex copy denies, the others ask.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

const FIELDS: [&str; 1] = ["tool_input.command"];
/// `$TRIGGER_TOKENS`: every row needs one of them.
const TOKENS: [&str; 4] = ["comment", "review", "api", "create"];
const SKIP: &str = "el comando no publica un comentario, una review ni un issue";
const BLOCK_END: &str = "# navori:managed end id=\"comment-draft-confirm-base\"";

/// What the script carries besides its rules: the partial's `node` programs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `draft-body`'s ADF and GraphQL-body programs.
    pub node: NodePrograms,
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
        Ok(Self {
            node: NodePrograms::from_script(source)?,
        })
    }
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

struct Rows {
    comment: Regex,
    review: Regex,
    issue_create: Regex,
    api: Regex,
    acli_create: Regex,
    acli_update: Regex,
    review_mode: Regex,
    review_body: Regex,
    graphql: Regex,
    mutation: Regex,
    create_issue: Regex,
    method: Regex,
    method_write: Regex,
    method_edit: Regex,
    data_flag: Regex,
    issues: Regex,
    comments: Regex,
}

fn rows(locale: Locale) -> Result<Rows, regex::Error> {
    let bound = r"(^|[;&|(`]|[[:space:]])";
    let row = |tail: &str| locale.ere(&format!("{bound}{tail}"));
    Ok(Rows {
        comment: row(r"gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|$)")?,
        review: row(r"gh[[:space:]]+pr[[:space:]]+review([[:space:]]|$)")?,
        issue_create: row(r"gh[[:space:]]+issue[[:space:]]+create([[:space:]]|$)")?,
        api: row(r"gh[[:space:]]+api([[:space:]]|$)")?,
        acli_create: row(
            r"acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+create([[:space:]]|$)",
        )?,
        acli_update: row(
            r"acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+update([[:space:]]|$)",
        )?,
        review_mode: locale.ere(
            r"(^|[[:space:]])(-c|--comment|-a|--approve|-r|--request-changes)([[:space:]]|$)",
        )?,
        review_body: locale.ere(r"(^|[[:space:]])(-b|--body|-F|--body-file)([[:space:]=]|$)")?,
        graphql: row(r"graphql([[:space:]]|$)")?,
        mutation: locale.ere(
            r"(^|[^A-Za-z])(createIssue|add(Comment|DiscussionComment|PullRequestReview|PullRequestReviewComment|PullRequestReviewThread|PullRequestReviewThreadReply)|update(IssueComment|DiscussionComment|PullRequestReview|PullRequestReviewComment))([^A-Za-z]|$)",
        )?,
        create_issue: locale.ere(r"(^|[^A-Za-z])createIssue([^A-Za-z]|$)")?,
        method: locale.ere(r"(-X|--method)[[:space:]=]+(GET|POST|PATCH|PUT|DELETE)")?,
        method_write: locale.ere(r"(POST|PATCH|PUT)$")?,
        method_edit: locale.ere(r"(PATCH|PUT)$")?,
        data_flag: locale.ere(r"(^|[[:space:]])(-f|-F|--input)([[:space:]=]|$)")?,
        issues: locale.ere(r#"/?repos/[^/[:space:]]+/[^/[:space:]]+/issues([[:space:]?"']|$)"#)?,
        comments: locale.ere(r"/(comments|reviews)([[:space:]/]|$)")?,
    })
}

fn compiled(locale: Locale) -> Result<&'static Rows, Failure> {
    const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
    static COMPILED: LazyLock<Vec<Result<Rows, regex::Error>>> =
        LazyLock::new(|| LOCALES.into_iter().map(rows).collect());
    let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
    COMPILED
        .get(column)
        .ok_or_else(|| Failure("rows missing".to_owned()))?
        .as_ref()
        .map_err(|error| Failure(format!("row pattern: {error}")))
}

/// The row and its label, or `None` when the command does not publish (`exit 0`).
fn classify(cmd: &str, r: &Rows) -> Option<(Kind, &'static str)> {
    let line = |re: &Regex| any_line(re, cmd);
    if line(&r.comment) {
        return Some((Kind::GhComment, "a GitHub PR/issue comment"));
    }
    if line(&r.review) {
        // Only with a body: `--approve` alone publishes no prose.
        return (line(&r.review_mode) && line(&r.review_body))
            .then_some((Kind::GhReview, "a GitHub PR review comment"));
    }
    if line(&r.issue_create) {
        return Some((Kind::GhIssueCreate, "a GitHub issue"));
    }
    if line(&r.api) {
        if line(&r.graphql) {
            if !line(&r.mutation) {
                return None;
            }
            let label = if line(&r.create_issue) {
                "a GitHub issue"
            } else {
                "a GitHub GraphQL comment/review mutation"
            };
            return Some((Kind::GhApiGraphql, label));
        }
        let method = cmd
            .split('\n')
            .find_map(|l| r.method.find(l).map(|m| m.as_str()))
            .unwrap_or_default();
        let writeish = if method.is_empty() {
            line(&r.data_flag)
        } else {
            r.method_write.is_match(method)
        };
        if !writeish {
            return None;
        }
        if line(&r.issues) {
            if !method.is_empty() && r.method_edit.is_match(method) {
                return None;
            }
            return Some((Kind::GhApiRest, "a GitHub issue"));
        }
        return line(&r.comments).then_some((Kind::GhApiRest, "a GitHub API comment/review write"));
    }
    if line(&r.acli_create) {
        return Some((Kind::AcliCreate, "a Jira comment"));
    }
    if line(&r.acli_update) {
        return Some((Kind::AcliUpdate, "a Jira comment edit"));
    }
    None
}

/// Evaluate one call.
///
/// # Errors
/// An extraction failure, text that is not valid UTF-8, or a draft the port does not reproduce.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    host: &dyn DraftHost,
) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    // `has_trigger_token "${payload:-}" || exit 0`: before `navori_audit_begin`, so no event.
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
    let [cmd] = fields.values.as_slice() else {
        return Err(Failure("payload extraction lost a field".to_owned()));
    };
    if fields.bytes.first().copied().unwrap_or_default() != cmd.len() {
        return Err(Failure("command is not valid UTF-8".to_owned()));
    }
    let stderr = capture::prepend(
        context.capture,
        payload.contains(&0),
        fields.nul_substitutions,
        Vec::new(),
    );
    let done = |stdout: String, verdict: &'static str, reason: &str| Evaluation {
        verdict: Verdict::Permit,
        stdout: stdout.into_bytes(),
        stderr: stderr.clone(),
        audit: Some(AuditLabel {
            verdict,
            reason: reason.to_owned(),
        }),
    };
    if cmd.is_empty() {
        return Ok(done(String::new(), "skip", SKIP));
    }
    let locale = context.profile.locale;
    let Some((kind, label)) = classify(cmd, compiled(locale)?) else {
        return Ok(done(String::new(), "skip", SKIP));
    };
    let decision = if context.engine == Engine::Codex {
        "deny"
    } else {
        "ask"
    };
    let fallback = format!(
        "[navori] this call publishes {label} and its draft could not be read or rendered (no readable body, or no jq/node on PATH to parse it). Review the exact command above before confirming."
    );
    let (have_jq, have_node) = match context.profile.extractor {
        Extractor::JqAndNode => (true, true),
        Extractor::JqOnly => (true, false),
        Extractor::Node => (false, true),
        Extractor::Sed => (false, false),
    };
    if !have_jq && !have_node {
        return Ok(done(
            format!(
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"{decision}\",\"permissionDecisionReason\":\"{fallback}\"}}}}\n"
            ),
            decision,
            "sin jq ni node: razón fija (R12)",
        ));
    }
    let draft = draft_body::draft(
        &draft_body::Request {
            cmd,
            kind,
            label,
            fallback: &fallback,
            have_jq,
            node: &context.rendered.node,
            locale,
        },
        host,
    )?;
    // Spec 0048 D5: the Pi copy names the file the draft was read from.
    let files = (context.engine == Engine::Pi && !draft.bound_file.is_empty())
        .then_some(draft.bound_file.as_str());
    Ok(done(
        decision_json(decision, &draft.reason, files, have_jq),
        decision,
        draft.source,
    ))
}
