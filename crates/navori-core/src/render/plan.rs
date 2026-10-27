//! Core pieces of `packages/cli/src/lib/render/render-plan.ts` (spec 0058 T14): the core managed
//! asset table, `navori:if`/`navori:if-not` resolution and per-language asset paths.

use std::sync::LazyLock;

use regex::Regex;

use crate::js_json::JsValue;
use crate::render::assets;

/// `"@navori/core"`.
pub const CORE_SOURCE_ID: &str = "@navori/core";

/// Who a core block is written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audience {
    /// `CLAUDE.md`, read by every session and subagent.
    Everyone,
    /// `.claude/context/<id>.md`, emitted by the `SessionStart` hook.
    Orchestrator,
}

/// `CoreManagedAsset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreManagedAsset {
    /// Block id.
    pub id: &'static str,
    /// Path under the core package.
    pub rel_path: &'static str,
    /// Config path that gates the block.
    pub condition: Option<&'static str>,
    /// Language the base file is authored in.
    pub base_language: &'static str,
    /// Omitted from monorepo workspace renders.
    pub root_only: bool,
    /// Destination audience.
    pub audience: Audience,
}

/// `CORE_MANAGED_ASSETS`, in emission order.
pub static CORE_MANAGED_ASSETS: LazyLock<Vec<CoreManagedAsset>> = LazyLock::new(|| {
    use Audience::{Everyone, Orchestrator};
    [
        (
            "planificacion",
            "en",
            true,
            Some("harness.planTiers"),
            Orchestrator,
        ),
        (
            "plan-maestro",
            "en",
            true,
            Some("harness.masterPlan"),
            Orchestrator,
        ),
        ("orquestacion", "en", true, None, Orchestrator),
        ("idioma-rol", "es", true, None, Everyone),
        ("formato-respuesta", "es", true, None, Everyone),
        (
            "tipado-fuerte",
            "en",
            false,
            Some("project.typedLanguage"),
            Everyone,
        ),
        ("operaciones-seguras", "en", true, None, Everyone),
        ("arranque-sesion", "en", true, None, Orchestrator),
        ("cierre-sesion", "en", true, None, Orchestrator),
        ("sdd", "en", true, Some("sdd.enabled"), Everyone),
        ("intake-tickets", "en", true, None, Everyone),
        ("code-discovery-routing", "en", true, None, Everyone),
    ]
    .into_iter()
    .map(
        |(id, base_language, root_only, condition, audience)| CoreManagedAsset {
            id,
            // Built once for the process lifetime, like the TS module constant.
            rel_path: Box::leak(format!("core-assets/managed/{id}.md").into_boxed_str()),
            condition,
            base_language,
            root_only,
            audience,
        },
    )
    .collect()
});

/// `EXCLUDABLE_BLOCK_IDS`.
pub const EXCLUDABLE_BLOCK_IDS: [&str; 2] = ["orquestacion", "sdd"];

/// `UnbalancedConditionMarkerError` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnbalancedConditionMarker(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerKind {
    If,
    IfNot,
}

impl MarkerKind {
    const fn label(self) -> &'static str {
        match self {
            Self::If => "if",
            Self::IfNot => "if-not",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token<'a> {
    Text(&'a str),
    Open(MarkerKind, &'a str),
    Close(MarkerKind),
}

static CONDITION_TOKEN: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"<!-- navori:(if|if-not) ([A-Za-z0-9_]+) -->|<!-- /navori:(if|if-not) -->").ok()
});

fn kind(text: &str) -> MarkerKind {
    if text == "if" {
        MarkerKind::If
    } else {
        MarkerKind::IfNot
    }
}

fn tokenize(content: &str) -> Vec<Token<'_>> {
    let mut tokens = Vec::new();
    let mut last = 0;
    let Some(re) = CONDITION_TOKEN.as_ref() else {
        return vec![Token::Text(content)];
    };
    for captures in re.captures_iter(content) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if whole.start() > last {
            tokens.push(Token::Text(&content[last..whole.start()]));
        }
        match (captures.get(1), captures.get(2), captures.get(3)) {
            (Some(open), Some(key), _) => {
                tokens.push(Token::Open(kind(open.as_str()), key.as_str()))
            }
            (_, _, Some(close)) => tokens.push(Token::Close(kind(close.as_str()))),
            _ => {}
        }
        last = whole.end();
    }
    if last < content.len() {
        tokens.push(Token::Text(&content[last..]));
    }
    tokens
}

/// `body.startsWith("\n") && body.endsWith("\n") ? body.slice(1, -1) : body`; a lone `"\n"`
/// slices to `""`.
fn without_markers(body: &str) -> &str {
    if body.starts_with('\n') && body.ends_with('\n') {
        body.get(1..body.len() - 1).unwrap_or_default()
    } else {
        body
    }
}

fn resolve(
    tokens: &[Token<'_>],
    pos: &mut usize,
    enabled: &dyn Fn(&str) -> bool,
    depth: usize,
) -> Result<String, UnbalancedConditionMarker> {
    let mut out = String::new();
    while let Some(token) = tokens.get(*pos) {
        let (open_kind, key) = match token {
            Token::Close(close) => {
                if depth == 0 {
                    return Err(UnbalancedConditionMarker(format!(
                        "Unmatched closing marker <!-- /navori:{} --> at token index {} has no opener",
                        close.label(),
                        *pos
                    )));
                }
                return Ok(out);
            }
            Token::Text(text) => {
                *pos += 1;
                out.push_str(text);
                continue;
            }
            Token::Open(open_kind, key) => (*open_kind, *key),
        };
        *pos += 1;
        let open_index = *pos - 1;
        let body = resolve(tokens, pos, enabled, depth + 1)?;
        match tokens.get(*pos) {
            None => {
                return Err(UnbalancedConditionMarker(format!(
                    "Unclosed marker <!-- navori:{} {key} --> opened at token index {open_index} reaches end of input without a matching </navori:{}>",
                    open_kind.label(),
                    open_kind.label()
                )));
            }
            Some(Token::Close(close)) if *close == open_kind => {}
            Some(other) => {
                let label = match other {
                    Token::Close(close) => close.label(),
                    _ => "unknown",
                };
                return Err(UnbalancedConditionMarker(format!(
                    "Marker <!-- navori:{} {key} --> opened at token index {open_index} is closed by mismatched <!-- /navori:{label} --> at token index {}",
                    open_kind.label(),
                    *pos
                )));
            }
        }
        *pos += 1;
        let show = match open_kind {
            MarkerKind::If => enabled(key),
            MarkerKind::IfNot => !enabled(key),
        };
        if show {
            out.push_str(without_markers(&body));
        }
    }
    Ok(out)
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `HARNESS_DEFAULTS[key] ?? true`: only the four opt-in flags default to off.
fn harness_default(key: &str) -> bool {
    !matches!(
        key,
        "scribeOwnsMarkdown" | "planTiers" | "codexIntegration" | "masterPlan"
    )
}

/// `conditionOrchestration`: resolves `navori:if`/`navori:if-not` for `engine`.
///
/// # Errors
/// An unbalanced marker structure, with the TS message.
pub fn condition_orchestration(
    content: &str,
    config: &JsValue,
    engine: &str,
) -> Result<String, UnbalancedConditionMarker> {
    let enabled = |key: &str| -> bool {
        match key {
            "onCodex" => engine == "codex",
            "onClaude" => engine == "claude",
            "onPi" => engine == "pi",
            "sdd" => {
                get(config, "sdd").and_then(|sdd| get(sdd, "enabled"))
                    != Some(&JsValue::Bool(false))
            }
            _ => match get(config, "harness").and_then(|harness| get(harness, key)) {
                Some(JsValue::Bool(explicit)) => *explicit,
                _ => harness_default(key),
            },
        }
    };
    let tokens = tokenize(content);
    let mut pos = 0;
    resolve(&tokens, &mut pos, &enabled, 0)
}

/// `resolveAssetPath`: core-relative path served for `language`, and whether that is a fallback
/// from a Spanish base the repo did not ask for.
#[must_use]
pub fn resolve_asset_path(asset: &CoreManagedAsset, language: &str) -> (String, bool) {
    let base = asset.base_language;
    if language == base {
        return (asset.rel_path.to_owned(), false);
    }
    let translated = asset
        .rel_path
        .strip_prefix("core-assets/managed/")
        .map_or_else(
            || asset.rel_path.to_owned(),
            |rest| format!("core-assets/managed/{language}/{rest}"),
        );
    if assets::core(&translated).is_some() {
        return (translated, false);
    }
    (asset.rel_path.to_owned(), base == "es")
}
