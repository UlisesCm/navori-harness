//! plan-gate.sh (spec 0059 T12): the rendered script end to end, as a decision that stops at its
//! one effect, `navori plan gate` ([`Step::Call`], run by [`call::run`]). [`after_call`] reads
//! the call's outcome the way the script does, stale-CLI hint included.

pub mod call;
pub mod rendered;

pub use rendered::Rendered;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext};
use crate::shell::gate_ask::{ask_answer, can_ask};
use crate::shell::payload::{self, Extractor, Profile};
use crate::shell::subcommand::substitution;

/// Hosts that register plan-gate (Pi's extension calls `navori plan gate` itself).
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];

/// `nv_payload_fields` of plan-gate.sh, in the script's order.
const FIELDS: [&str; 3] = ["hook_event_name", "permission_mode", "tool_input.command"];
const EVENT: usize = 0;
const MODE: usize = 1;

/// Everything fixed before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Accredited extraction and locale profile.
    pub profile: Profile,
    /// Script identity and the source lines of the Bash 5 NUL warnings; `input_line` is the
    /// script's own capture ([`Rendered::input_line`]).
    pub capture: CaptureContext<'a>,
    /// Values the renderer wrote into the script.
    pub rendered: Rendered,
    /// `$0`: the script path exactly as invoked.
    pub script: String,
}

impl Context<'_> {
    /// `case "$0" in *".codex/hooks/"*`: the Codex copy.
    fn codex_copy(&self) -> bool {
        self.script.contains(".codex/hooks/")
    }
}

/// The `navori plan gate` the script runs: `printf '%s' "$payload" | [NAVORI_HOOK_ENGINE=codex]
/// navori plan gate 2>&1`, inside `$(…)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// `$payload`: stdin without NUL bytes and final newlines.
    pub payload: Vec<u8>,
    /// The Codex copy sets `NAVORI_HOOK_ENGINE=codex` for the call.
    pub codex: bool,
}

/// Output produced before the call, plus what reading its outcome needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    stderr: Vec<u8>,
    can_ask: bool,
    codex_copy: bool,
}

/// Where the decision stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The script finished without effects.
    Done(Evaluation),
    /// Run `navori plan gate` (see [`call::run`]), then [`after_call`].
    Call(Pending, Call),
}

fn finish(
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: u8,
    verdict: &'static str,
    reason: &str,
) -> Evaluation {
    Evaluation {
        verdict: if status == 2 {
            Verdict::Block
        } else {
            Verdict::Permit
        },
        stdout,
        stderr,
        audit: Some(AuditLabel {
            verdict,
            reason: reason.to_owned(),
        }),
    }
}

/// `plan_gate_no_verdict`: ask where the host shows the prompt, else block.
fn no_verdict(
    mut stderr: Vec<u8>,
    can_ask: bool,
    codex_copy: bool,
    code: &str,
    hard: &str,
    ask: &str,
) -> Evaluation {
    if !codex_copy && can_ask {
        return finish(ask_answer(ask).into_bytes(), stderr, 0, "ask", code);
    }
    stderr.extend_from_slice(hard.as_bytes());
    stderr.push(b'\n');
    finish(Vec::new(), stderr, 2, "block", code)
}

/// Bytes after the first `needle` (`${hay#*needle}`), `None` when it does not occur.
fn after_first<'h>(hay: &'h [u8], needle: &[u8]) -> Option<&'h [u8]> {
    find(hay, needle).map(|at| &hay[at + needle.len()..])
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len())
        .position(|window| window == needle)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    find(hay, needle).is_some()
}

/// `${s#"${s%%[![:space:]]*}"}`: drop the leading characters of the locale's space class.
fn trim_space(mut s: &[u8], locale: Locale) -> &[u8] {
    loop {
        let width = match s.first() {
            Some(byte) if *byte < 0x80 => 1,
            Some(byte) if *byte >= 0xf0 => 4,
            Some(byte) if *byte >= 0xe0 => 3,
            Some(byte) if *byte >= 0xc0 => 2,
            _ => return s,
        };
        let space = s
            .get(..width)
            .and_then(|head| std::str::from_utf8(head).ok())
            .and_then(|head| head.chars().next())
            .is_some_and(|c| locale.whitespace(c));
        if !space {
            return s;
        }
        s = &s[width..];
    }
}

/// `plan_gate_fast_allow`: `agent_type` occurs once, directly inside the single `"tool_input"`
/// object, with a plain value in the rendered non-implementer list.
fn fast_allow(payload: &[u8], roles: &str, locale: Locale) -> bool {
    const KEY: &[u8] = b"agent_type";
    const INPUT: &[u8] = b"\"tool_input\"";
    if contains(payload, b"\\u") {
        return false;
    }
    let Some(at) = find(payload, KEY) else {
        return false;
    };
    let after = &payload[at + KEY.len()..];
    if contains(after, KEY) {
        return false;
    }
    let head = &payload[..at];
    let Some(head) = head
        .strip_suffix(b"\"sub")
        .or_else(|| head.strip_suffix(b"\""))
    else {
        return false;
    };
    if head.ends_with(b"\\") {
        return false;
    }
    let Some(tail) = after_first(payload, INPUT) else {
        return false;
    };
    if contains(tail, INPUT) {
        return false;
    }
    // `${pg_head##*'"tool_input"'}`: after the last occurrence.
    let Some(last) = head.windows(INPUT.len()).rposition(|w| w == INPUT) else {
        return false;
    };
    let segment = &head[last + INPUT.len()..];
    if segment.iter().any(|b| matches!(b, b'}' | b'[' | b']')) {
        return false;
    }
    if contains(after_first(segment, b"{").unwrap_or(segment), b"{") {
        return false;
    }
    let Some(after) = after.strip_prefix(b"\"") else {
        return false;
    };
    let Some(after) = trim_space(after, locale).strip_prefix(b":") else {
        return false;
    };
    let Some(after) = trim_space(after, locale).strip_prefix(b"\"") else {
        return false;
    };
    let Some(end) = find(after, b"\"") else {
        return false;
    };
    let value = &after[..end];
    if value.is_empty()
        || !value
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'.' | b'-'))
    {
        return false;
    }
    let role = after_first(value, b":").unwrap_or(value);
    if role.is_empty() {
        return false;
    }
    let mut needle = Vec::with_capacity(role.len() + 2);
    needle.push(b' ');
    needle.extend_from_slice(role);
    needle.push(b' ');
    contains(format!(" {roles} ").as_bytes(), &needle)
}

/// Evaluate one payload up to `navori plan gate`. `navori_on_path` answers `command -v navori`
/// from the hook's working directory; it is asked only past the fast path.
///
/// # Errors
/// An extraction failure the shell's cascade does not model.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    navori_on_path: impl FnOnce() -> bool,
) -> Result<Step, Failure> {
    let captured = payload::capture(payload);
    let raw_nul = payload.contains(&0);
    if fast_allow(&captured, &context.rendered.roles, context.profile.locale) {
        let stderr = capture::prepend(context.capture, raw_nul, 0, Vec::new());
        return Ok(Step::Done(finish(
            Vec::new(),
            stderr,
            0,
            "allow",
            "rol no implementer",
        )));
    }
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    let field = |index: usize| fields.values.get(index).map_or("", String::as_str);
    let stderr = capture::prepend(
        context.capture,
        raw_nul,
        fields.nul_substitutions,
        Vec::new(),
    );
    let jq = matches!(
        context.profile.extractor,
        Extractor::JqAndNode | Extractor::JqOnly
    );
    let pending = Pending {
        stderr,
        can_ask: can_ask(&context.script, jq, field(EVENT), field(MODE)),
        codex_copy: context.codex_copy(),
    };
    if !navori_on_path() {
        return Ok(Step::Done(no_verdict(
            pending.stderr,
            pending.can_ask,
            pending.codex_copy,
            "binary-missing",
            "[navori] BLOCKED by plan-gate: navori is not installed or not on PATH — install it before dispatching a planned implementer.",
            "[navori] plan-gate could not check the workplan: navori is not on PATH, so there is no verdict. Approve to dispatch the implementer WITHOUT the plan gate, or deny and install navori. If you are an agent, report this to the user and wait.",
        )));
    }
    let codex = pending.codex_copy;
    Ok(Step::Call(
        pending,
        Call {
            payload: captured,
            codex,
        },
    ))
}

/// The script after `navori plan gate`: replay its merged output, then map the exit code. On a
/// denial `stale_hint` supplies what [`stale_hint`] needs, and is asked for nothing else.
///
/// # Errors
/// Output the shell would drop bytes from (a NUL), or a hint input that cannot be read.
pub fn after_call(
    pending: Pending,
    status: i32,
    output: &[u8],
    hint: impl FnOnce() -> Result<Option<String>, Failure>,
) -> Result<Evaluation, Failure> {
    let out = substitution(output);
    if out.contains(&0) {
        return Err(Failure("navori plan gate printed a NUL byte".to_owned()));
    }
    let Pending {
        mut stderr,
        can_ask,
        codex_copy,
    } = pending;
    if !out.is_empty() {
        stderr.extend_from_slice(out);
        stderr.push(b'\n');
    }
    Ok(match status {
        0 => finish(Vec::new(), stderr, 0, "allow", ""),
        2 => {
            if let Some(line) = hint()? {
                stderr.extend_from_slice(line.as_bytes());
            }
            finish(Vec::new(), stderr, 2, "block", "plan-denied")
        }
        code => no_verdict(
            stderr,
            can_ask,
            codex_copy,
            "subcommand-unavailable",
            &format!(
                "[navori] BLOCKED by plan-gate: this navori build has no working 'plan' subcommand (exit {code}) — update navori (or run 'navori render --apply' after updating) before dispatching a planned implementer."
            ),
            &format!(
                "[navori] plan-gate could not check the workplan: this navori build has no working 'plan' subcommand (exit {code}), so there is no verdict. Approve to dispatch the implementer WITHOUT the plan gate, or deny and update navori. If you are an agent, report this to the user and wait."
            ),
        ),
    })
}

/// `plan_gate_version_num`: `major*10^6 + minor*10^3 + patch` of a dotted version, the
/// pre-release suffix dropped; `None` when a part is not plain digits. Bash's arithmetic wraps.
#[must_use]
pub fn version_num(version: &str) -> Option<i64> {
    let v = version.split(['-', '+']).next().unwrap_or_default();
    let major = v.split('.').next().unwrap_or_default();
    let rest = &v[major.len()..];
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    let minor = rest.split('.').next().unwrap_or_default();
    let patch = &rest[minor.len()..];
    let patch = patch.strip_prefix('.').unwrap_or(patch);
    let patch = patch.split('.').next().unwrap_or_default();
    let number = |part: &str| -> Option<i64> {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(part.bytes().fold(0i64, |acc, b| {
            acc.wrapping_mul(10).wrapping_add(i64::from(b - b'0'))
        }))
    };
    let or_zero = |part: &str| {
        if part.is_empty() {
            Some(0)
        } else {
            number(part)
        }
    };
    let (major, minor, patch) = (number(major)?, or_zero(minor)?, or_zero(patch)?);
    Some(
        major
            .wrapping_mul(1_000_000)
            .wrapping_add(minor.wrapping_mul(1000))
            .wrapping_add(patch),
    )
}

/// `plan_gate_stale_cli_hint`: the line printed when the CLI is older than `harnessVersion`.
/// `config` is `navori.config.json` (`None` when it is not readable); `cli` runs `navori
/// --version` and returns its first line, only once the config names a `harnessVersion`.
///
/// # Errors
/// A config that is not UTF-8 (sed's reading of it is not modeled), or `cli`'s failure.
pub fn stale_hint(
    config: Option<&[u8]>,
    cli: impl FnOnce() -> Result<String, Failure>,
    locale: Locale,
) -> Result<Option<String>, Failure> {
    let Some(config) = config else {
        return Ok(None);
    };
    let text = std::str::from_utf8(config)
        .map_err(|_| Failure("navori.config.json is not UTF-8".to_owned()))?;
    let pattern = locale
        .ere(r#"^.*"harnessVersion"[[:space:]]*:[[:space:]]*"([^"]*)".*$"#)
        .map_err(|e| Failure(format!("harnessVersion pattern: {e}")))?;
    let harness = text
        .split('\n')
        .find_map(|line| pattern.captures(line))
        .and_then(|captures| captures.get(1))
        .map_or("", |m| m.as_str());
    if harness.is_empty() {
        return Ok(None);
    }
    let line = cli()?;
    // `${pg_cli##* }`
    let cli = line.rsplit(' ').next().unwrap_or_default();
    let (Some(cli_num), Some(harness_num)) = (version_num(cli), version_num(harness)) else {
        return Ok(None);
    };
    Ok((cli_num < harness_num).then(|| {
        format!(
            "[navori] the navori CLI is outdated: it is {cli} but this repo was rendered with harnessVersion {harness}, so it may not know the opening you used. Update it with 'navori update' (or 'npm i -g navori@latest'), then run 'navori render --apply'.\n"
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::{fast_allow, version_num};
    use crate::shell::Locale;

    // Covers: R50
    #[test]
    fn version_numbers_follow_the_script() {
        for (version, expected) in [
            ("0.12.3", Some(12_003)),
            ("1.2.3-beta.1", Some(1_002_003)),
            ("1.2.3+build", Some(1_002_003)),
            ("2", Some(2_000_000)),
            ("1..3", Some(1_000_003)),
            ("1.2.3.4", Some(1_002_003)),
            ("v1.2.3", None),
            ("", None),
            ("1.x", None),
        ] {
            assert_eq!(version_num(version), expected, "{version}");
        }
    }

    // Covers: R50
    #[test]
    fn fast_allow_takes_only_the_unambiguous_shape() {
        let roles = " scout reviewer ";
        for (payload, expected) in [
            (r#"{"tool_input":{"subagent_type":"scout"}}"#, true),
            (
                r#"{"tool_input":{"agent_type" :  "plugin:reviewer"}}"#,
                true,
            ),
            (r#"{"tool_input":{"subagent_type":"implementer"}}"#, false),
            (r#"{"agent_type":"scout","tool_input":{}}"#, false),
            (r#"{"tool_input":{"x":{"subagent_type":"scout"}}}"#, false),
            (r#"{"tool_input":{"subagent_type":"sc\u006fut"}}"#, false),
            (
                r#"{"tool_input":{"subagent_type":"scout","agent_type":"scout"}}"#,
                false,
            ),
            (r#"{"tool_input":["subagent_type","scout"]}"#, false),
            (r#"{"tool_input":{"subagent_type":"Scout"}}"#, false),
            (r#"{"tool_input":{"subagent_type":"plugin:"}}"#, false),
        ] {
            assert_eq!(
                fast_allow(payload.as_bytes(), roles, Locale::Utf8),
                expected,
                "{payload}"
            );
        }
    }
}
