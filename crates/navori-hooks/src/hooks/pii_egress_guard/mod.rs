//! The web half of the PII-egress rule: `pii-egress-guard.sh` (#1445), PreToolUse on
//! `WebFetch|WebSearch`, Claude only (Codex's hosted search has no hook event and Pi has no such
//! tool).
//!
//! `WebFetch` inspects only the URL of an external host (`prompt` goes to the model provider,
//! not to the destination) and `WebSearch` is always external: its `query` is inspected. The
//! identifier handling, the matching and the host probe are the shared core in
//! [`crate::shell::pii_egress`], the same one the Bash lane of guard-destructive runs; this
//! module is the script's own part: the cheap gate, the field reads and the verdict mapping.
//!
//! # Never echo
//!
//! Nothing of the URL, the query or an identifier is formatted into an error, an audit reason
//! or a message, and the evaluation never returns a [`crate::runner::Failure`]: whatever cannot
//! be decided is [`Code::Unverified`] (deny), as the script's `set -e` subshell does. A panic
//! past the gate is caught and also becomes [`Code::Unverified`]; the default panic hook would
//! print its message (which may hold a slice of the text) to stderr, so it is muted for the
//! length of the check ([`quietly`]).
//!
//! # Deliberate divergence
//!
//! A field that is not valid UTF-8, or that holds a NUL, is [`Code::Unverified`] here; the
//! shell hands it to `grep`, whose answer depends on the host. Same stance as
//! [`crate::shell::pii_egress::verdict`] for an identifier that is not UTF-8.
#![deny(clippy::string_slice, clippy::indexing_slicing)]

use std::panic::{self, AssertUnwindSafe};
use std::sync::{Mutex, PoisonError};

use crate::runner::{AuditLabel, Engine, Evaluation, Verdict};
use crate::shell::capture::{self, CaptureContext};
use crate::shell::payload::{self, Profile};
use crate::shell::pii_egress::{self, Code, Probe, is_local};

/// Hosts that register this hook.
pub const ENGINES: &[Engine] = &[Engine::Claude];

/// `nv_payload_fields` of the script, in its order: all four take part in the bulk read.
const FIELDS: [&str; 4] = [
    "tool_input.command",
    "tool_input.query",
    "tool_input.url",
    "tool_name",
];
const QUERY: usize = 1;
const URL: usize = 2;
const TOOL_NAME: usize = 3;

/// Everything fixed before stdin: the accredited extraction and locale profile and the
/// diagnostics context of the Bash 5 NUL warnings.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// Accredited extraction and locale profile.
    pub profile: Profile,
    /// Script identity and source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
}

/// What the case statement of `pii_web_check` reads: the text an external request carries, or
/// `None` when there is nothing to inspect (not a web tool, an empty or a local target).
fn text_of<'a>(tool: &str, url: &'a str, query: &'a str) -> Option<&'a str> {
    match tool {
        "WebFetch" if url.is_empty() => None,
        // `${url#*://}`: what follows the first `://`; the whole URL when there is none.
        "WebFetch" if is_local(url.split_once("://").map_or(url, |(_, rest)| rest)) => None,
        "WebFetch" => Some(url),
        "WebSearch" if query.is_empty() => None,
        "WebSearch" => Some(query),
        _ => None,
    }
}

/// The subshell `pii_web_check` past the gate: its exit status as a [`Code`] and the number of
/// field reads that dropped a NUL (one Bash 5 warning each). Every failure is `Unverified`.
fn check(captured: &[u8], profile: Profile, probe: &dyn Probe) -> (Code, usize) {
    let Ok(fields) = payload::extract(captured, &FIELDS, profile) else {
        return (Code::Unverified, 0);
    };
    let nul = fields.nul_substitutions;
    let unreadable = fields
        .values
        .iter()
        .zip(&fields.bytes)
        .any(|(value, bytes)| *bytes != value.len() || value.contains('\0'));
    if unreadable {
        return (Code::Unverified, nul);
    }
    let field = |index: usize| fields.values.get(index).map_or("", String::as_str);
    let Some(text) = text_of(field(TOOL_NAME), field(URL), field(QUERY)) else {
        return (Code::Clean, nul);
    };
    let mut matcher = probe.matcher();
    let code = pii_egress::verdict(
        text,
        || probe.email(),
        probe.ids(),
        profile.locale,
        &mut *matcher,
    );
    (code, nul)
}

/// Serializes the swap of the process-wide panic hook: two overlapping swaps would restore each
/// other's mute hook and leave the process silent for good.
static PANIC_HOOK: Mutex<()> = Mutex::new(());

/// Run `body` and return `None` if it panics, with the panic message written nowhere: the
/// default hook prints it to stderr and it may hold a slice of the URL or the query.
fn quietly<T>(body: impl FnOnce() -> T) -> Option<T> {
    let _held = PANIC_HOOK.lock().unwrap_or_else(PoisonError::into_inner);
    let previous = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let outcome = panic::catch_unwind(AssertUnwindSafe(body));
    panic::set_hook(previous);
    outcome.ok()
}

/// Whether `captured` passes the cheap gate: the bytes the shell holds in `$payload` contain
/// `"WebFetch"` or `"WebSearch"`, quotes included. The decoded `tool_name` does not take part:
/// a `\u`-escaped name skips in the shell too.
fn gated(captured: &[u8]) -> bool {
    [b"\"WebFetch\"".as_slice(), b"\"WebSearch\"".as_slice()]
        .iter()
        .any(|needle| {
            captured
                .windows(needle.len())
                .any(|window| window == *needle)
        })
}

/// Evaluate one call. Infallible: a check that cannot complete denies ([`Code::Unverified`]),
/// as the script does.
#[must_use]
pub fn evaluate(payload: &[u8], context: &Context<'_>, probe: &dyn Probe) -> Evaluation {
    let captured = payload::capture(payload);
    let raw_nul = payload.contains(&0);
    let diagnostics = |substitutions: usize| {
        capture::prepend(context.capture, raw_nul, substitutions, Vec::new())
    };
    if !gated(&captured) {
        return Evaluation {
            verdict: Verdict::Permit,
            stdout: Vec::new(),
            stderr: diagnostics(0),
            audit: Some(AuditLabel {
                verdict: "skip",
                reason: "no network gate".to_owned(),
            }),
        };
    }
    let (code, nul) =
        quietly(|| check(&captured, context.profile, probe)).unwrap_or((Code::Unverified, 0));
    let mut stderr = diagnostics(nul);
    let (verdict, label, reason) = match code {
        Code::Clean => (
            Verdict::Permit,
            "allow",
            "no identifier in an external request",
        ),
        _ => (Verdict::Block, "block", "pii-egress"),
    };
    stderr.extend_from_slice(pii_egress::stderr(code).as_bytes());
    Evaluation {
        verdict,
        stdout: Vec::new(),
        stderr,
        audit: Some(AuditLabel {
            verdict: label,
            reason: reason.to_owned(),
        }),
    }
}
