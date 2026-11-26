//! `.codex/rules/navori.rules` (`engines/codex/build-rules.ts`, spec 0059 T19, D37): the shell
//! `ask`/`deny` permissions as Codex `prefix_rule`s, emitted as text, plus the drop and narrow
//! ledger the render warning reads. `allow` is never translated: in Codex an `allow` rule runs the
//! command outside the sandbox.

use crate::integrity::is_js_whitespace;
use crate::js_json::JsValue;

/// `translateShellPattern`: the tokens a `Bash(<pattern>)` rule keeps as a Codex prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedPattern {
    /// Whitespace-separated tokens of the prefix.
    pub tokens: Vec<String>,
    /// A `*` glued to the last token was dropped, so the rule matches only the literal token.
    pub narrowed: bool,
}

/// `/^Bash\((.*)\)$/`: the inner text, which `.` keeps free of line terminators.
fn bash_inner(pattern: &str) -> Option<&str> {
    let inner = pattern.strip_prefix("Bash(")?.strip_suffix(')')?;
    (!inner.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(inner)
}

/// `translateShellPattern`: `None` for a rule that is not `Bash(...)`, keeps a wildcard a token
/// prefix cannot express, or has no token.
#[must_use]
pub fn translate_shell_pattern(pattern: &str) -> Option<TranslatedPattern> {
    let mut inner = bash_inner(pattern)?;
    let mut narrowed = false;
    if let Some(rest) = inner
        .strip_suffix(" *")
        .or_else(|| inner.strip_suffix(":*"))
    {
        inner = rest;
    } else {
        let last = inner.rfind(' ').map_or(inner, |at| &inner[at + 1..]);
        // `lastToken.length > 1`: a token ending in `*` is longer than one unit unless it is `*`.
        if last != "*"
            && let Some(head) = last.strip_suffix('*')
            && !head.contains('*')
        {
            inner = &inner[..inner.len() - 1];
            narrowed = true;
        }
    }
    if inner.contains(['*', '?', '[']) {
        return None;
    }
    let tokens: Vec<String> = inner
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    (!tokens.is_empty()).then_some(TranslatedPattern { tokens, narrowed })
}

/// Why a rule did not reach the rules file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// Not a `Bash(...)` rule.
    NotBash,
    /// A wildcard inside the pattern.
    InnerWildcard,
}

/// The decision a translated rule carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// From `ask`.
    Prompt,
    /// From `deny`.
    Forbidden,
}

impl Decision {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Forbidden => "forbidden",
        }
    }
}

/// `buildCodexRules`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRules {
    /// The rules file body, without the managed-marker header.
    pub body: String,
    /// Rules that could not be translated, in rule order.
    pub dropped: Vec<(String, DropReason)>,
    /// Rules translated more narrowly than Claude matches them.
    pub narrowed: Vec<(String, Decision)>,
}

/// `JSON.stringify` of a string, the quoting Starlark accepts.
fn quote(text: &str) -> String {
    JsValue::string(text).stringify(None).unwrap_or_default()
}

fn serialize_rule(tokens: &[String], decision: Decision, justification: Option<&str>) -> String {
    let pattern: Vec<String> = tokens.iter().map(|t| quote(t)).collect();
    let mut lines = vec![
        "prefix_rule(".to_owned(),
        format!("    pattern = [{}],", pattern.join(", ")),
        format!("    decision = {},", quote(decision.as_str())),
    ];
    if let Some(justification) = justification {
        lines.push(format!("    justification = {},", quote(justification)));
    }
    lines.push(")".to_owned());
    lines.join("\n")
}

/// `buildCodexRules(rules)` over the `ask` and `deny` patterns; `None` when a pattern is not a
/// string Rust can read, which the TS would coerce.
#[must_use]
pub fn build_codex_rules(ask: &[JsValue], deny: &[JsValue]) -> Option<CodexRules> {
    let mut dropped = Vec::new();
    let mut narrowed = Vec::new();
    let mut seen: Vec<(Decision, Vec<String>)> = Vec::new();
    let mut blocks = Vec::new();
    for (patterns, decision) in [(ask, Decision::Prompt), (deny, Decision::Forbidden)] {
        for pattern in patterns {
            let JsValue::String(text) = pattern else {
                return None;
            };
            let text = text.to_rust()?;
            let Some(translated) = translate_shell_pattern(&text) else {
                let reason = if bash_inner(&text).is_some() {
                    DropReason::InnerWildcard
                } else {
                    DropReason::NotBash
                };
                dropped.push((text, reason));
                continue;
            };
            if translated.narrowed {
                narrowed.push((text, decision));
            }
            if seen
                .iter()
                .any(|(d, t)| *d == decision && *t == translated.tokens)
            {
                continue;
            }
            blocks.push(serialize_rule(&translated.tokens, decision, None));
            seen.push((decision, translated.tokens));
        }
    }
    let gh = ["gh", "pr", "create"].map(str::to_owned);
    blocks.push(serialize_rule(
        &gh,
        Decision::Prompt,
        Some("Confirma antes de publicar un PR (complementa pr-publisher-confirm)."),
    ));
    Some(CodexRules {
        body: format!("{}\n", blocks.join("\n\n")),
        dropped,
        narrowed,
    })
}
