//! `{{path}}` interpolation: literal port of `packages/cli/src/lib/render/interpolate.ts`
//! (spec 0058 T14). The config is the [`JsValue`] that [`crate::config::read`] returns, so paths
//! resolve exactly as the TS walks the zod output, arrays included.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::config::is_safe_gate_chain;
use crate::integrity::is_js_whitespace;
use crate::js_json::{JsValue, number_to_js};
use crate::render::context::Lang;

/// JS `\s` as a regex class body.
const JS_WS: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// `DEFAULT_COMPACT_ADVICE_TOKENS`.
const DEFAULT_COMPACT_ADVICE_TOKENS: f64 = 175_000.0;
/// `PROGRESS_SOFT_CAP_BYTES` / `PROGRESS_HARD_CAP_BYTES` (`lib/assets/doc-budgets.ts`).
const PROGRESS_SOFT_CAP_BYTES: &str = "4000";
const PROGRESS_HARD_CAP_BYTES: &str = "8000";
/// `NON_IMPLEMENTER_ROLES` (`engines/shared/roster.ts`).
const NON_IMPLEMENTER_ROLES: &str = "scout architect auditor reviewer scribe publisher explorer";

static PLACEHOLDER: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\{{\{{[{JS_WS}]*(?:(shq|raw):)?[{JS_WS}]*([a-zA-Z][a-zA-Z0-9_.]*)[{JS_WS}]*\}}\}}"
    ))
    .ok()
});

static KEY_LINE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([a-zA-Z_][a-zA-Z0-9_]*):[{JS_WS}]*\{{\{{[{JS_WS}]*([a-zA-Z][a-zA-Z0-9_.]*)[{JS_WS}]*\}}\}}[{JS_WS}]*$"
    ))
    .ok()
});

/// `InterpolateOptions`.
#[derive(Debug, Clone, Default)]
pub struct InterpolateOptions {
    /// `extraVars`, layered over the built-in variables.
    pub extra_vars: BTreeMap<String, String>,
    /// Drop `key: {{x}}` lines whose value is unresolved (frontmatter).
    pub omit_unresolved_key_lines: bool,
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn text_at(config: &JsValue, path: &[&str]) -> Option<String> {
    let mut cursor = config;
    for key in path {
        cursor = get(cursor, key)?;
    }
    match cursor {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

/// `sanitizeProjectValue`: no HTML-comment delimiters, whitespace runs collapsed, trimmed.
#[must_use]
pub fn sanitize_project_value(value: &str) -> String {
    let without = value.replace("<!--", "").replace("-->", "");
    let mut out = String::with_capacity(without.len());
    let mut in_run = false;
    for ch in without.chars() {
        if matches!(ch, '\r' | '\n' | '\t' | ' ') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `shellSingleQuote`.
#[must_use]
pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `placeholderFallback`.
#[must_use]
pub fn placeholder_fallback(path: &str, lang: Lang) -> String {
    match path {
        "qualityGate.fast" | "qualityGate.full" => match lang {
            Lang::Es => "(quality gate sin configurar — corre 'navori configure quality-gate')",
            Lang::En => "(quality gate not configured — run 'navori configure quality-gate')",
        }
        .to_owned(),
        "project.criticalAreas" => "auth, permissions, payments, data integrity".to_owned(),
        "project.legacyPaths" => "legacy/, vendor/".to_owned(),
        _ => format!("<not configured: {path}>"),
    }
}

/// `gateRunnerCommand`: `navori gate <kind>` when the configured gate is a safe chain.
#[must_use]
pub fn gate_runner_command(config: &JsValue, kind: &str) -> Option<String> {
    let gate = text_at(config, &["qualityGate", kind])?;
    (!js_trim(&gate).is_empty() && is_safe_gate_chain(&gate)).then(|| format!("navori gate {kind}"))
}

fn non_blank(value: String) -> Option<String> {
    (!js_trim(&value).is_empty()).then_some(value)
}

/// `String(value)` of a primitive, `None` for anything else.
fn primitive_string(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(text) => Some(String::from_utf16_lossy(text.units())),
        JsValue::Number(n) => Some(number_to_js(*n)),
        JsValue::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// One own-property step of the TS walk: object keys, array indices and an array's `length`.
fn own_property(cursor: &JsValue, segment: &str) -> Option<JsValue> {
    match cursor {
        JsValue::Object(object) => object.get(segment).cloned(),
        JsValue::Array(items) => {
            if segment == "length" {
                #[allow(
                    clippy::cast_precision_loss,
                    reason = "array lengths are far below 2^53"
                )]
                return Some(JsValue::Number(items.len() as f64));
            }
            let index = crate::js_json::JsString::from(segment).array_index()?;
            items.get(usize::try_from(index).ok()?).cloned()
        }
        _ => None,
    }
}

fn resolve_path(path: &str, config: &JsValue, extra: &BTreeMap<String, String>) -> Option<String> {
    if let Some(value) = extra.get(path) {
        return non_blank(value.clone());
    }
    let mut cursor = config.clone();
    for segment in path.split('.') {
        cursor = own_property(&cursor, segment)?;
    }
    match &cursor {
        JsValue::Undefined | JsValue::Null => None,
        JsValue::String(_) | JsValue::Number(_) | JsValue::Bool(_) => {
            non_blank(primitive_string(&cursor)?)
        }
        JsValue::Array(items) => {
            let strings: Option<Vec<String>> = items.iter().map(primitive_string).collect();
            let kept: Vec<String> = strings?
                .into_iter()
                .filter(|item| !js_trim(item).is_empty())
                .collect();
            non_blank(kept.join(", "))
        }
        JsValue::Object(_) => None,
    }
}

fn resolve_sanitized(
    path: &str,
    config: &JsValue,
    extra: &BTreeMap<String, String>,
) -> Option<String> {
    let value = resolve_path(path, config, extra)?;
    if path.starts_with("project.") {
        non_blank(sanitize_project_value(&value))
    } else {
        Some(value)
    }
}

/// The built-in variables of `interpolate`, with `extra_vars` layered on top.
fn built_in_vars(
    config: &JsValue,
    extra_vars: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let compact = get(config, "harness")
        .and_then(|harness| get(harness, "compactAdviceTokens"))
        .and_then(|value| match value {
            JsValue::Number(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(DEFAULT_COMPACT_ADVICE_TOKENS);
    let fast = text_at(config, &["qualityGate", "fast"]);
    let scoped = text_at(config, &["qualityGate", "scoped"])
        .or_else(|| fast.clone())
        .unwrap_or_else(|| "the repo's fast quality gate".to_owned());
    let guard_lane = if fast.as_deref().is_some_and(|f| !js_trim(f).is_empty()) {
        "0"
    } else {
        "1"
    };
    let native_hooks = get(config, "qualityGate")
        .and_then(|gate| get(gate, "nativeHooks"))
        .is_some_and(|value| *value == JsValue::Bool(true));
    let mut vars: BTreeMap<String, String> = [
        ("harness.compactAdviceTokens", number_to_js(compact)),
        (
            "navori.progressSoftCapBytes",
            PROGRESS_SOFT_CAP_BYTES.to_owned(),
        ),
        (
            "navori.progressHardCapBytes",
            PROGRESS_HARD_CAP_BYTES.to_owned(),
        ),
        ("navori.scopedGate", scoped),
        ("navori.progressGuardLane", guard_lane.to_owned()),
        (
            "navori.nonImplementerRoles",
            NON_IMPLEMENTER_ROLES.to_owned(),
        ),
        (
            "navori.nativeHooks",
            if native_hooks { "1" } else { "0" }.to_owned(),
        ),
        ("piPermissionRules", "-".to_owned()),
        ("navoriOwnedPaths", "-".to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    vars.extend(extra_vars.iter().map(|(k, v)| (k.clone(), v.clone())));
    vars
}

/// `interpolate`.
#[must_use]
pub fn interpolate(content: &str, config: &JsValue, options: &InterpolateOptions) -> String {
    let extra = built_in_vars(config, &options.extra_vars);
    let lang = Lang::resolve(text_at(config, &["language"]).as_deref());
    if !options.omit_unresolved_key_lines {
        return interpolate_raw(content, config, &extra, lang);
    }
    content
        .split('\n')
        .filter_map(|line| {
            let key_line = KEY_LINE.as_ref().and_then(|re| re.captures(line));
            match key_line.as_ref().and_then(|c| Some((c.get(1)?, c.get(2)?))) {
                Some((key, path)) => resolve_sanitized(path.as_str(), config, &extra)
                    .map(|resolved| format!("{}: {resolved}", key.as_str())),
                None => Some(interpolate_raw(line, config, &extra, lang)),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn interpolate_raw(
    content: &str,
    config: &JsValue,
    extra: &BTreeMap<String, String>,
    lang: Lang,
) -> String {
    let Some(placeholder) = PLACEHOLDER.as_ref() else {
        return content.to_owned();
    };
    placeholder
        .replace_all(content, |captures: &Captures<'_>| {
            let marker = captures.get(1).map(|m| m.as_str());
            let raw_path = captures.get(2).map_or("", |m| m.as_str());
            let shell = marker == Some("shq");
            if marker == Some("raw") {
                return format!("{{{{{raw_path}}}}}");
            }
            let mut path = raw_path.to_owned();
            if let Some(kind) = raw_path
                .strip_prefix("gateRun.")
                .filter(|kind| matches!(*kind, "fast" | "full"))
            {
                if let Some(runner) = gate_runner_command(config, kind) {
                    return if shell {
                        shell_single_quote(&runner)
                    } else {
                        runner
                    };
                }
                path = format!("qualityGate.{kind}");
            }
            let resolved = resolve_sanitized(&path, config, extra)
                .unwrap_or_else(|| placeholder_fallback(&path, lang));
            if shell {
                shell_single_quote(&resolved)
            } else {
                resolved
            }
        })
        .into_owned()
}
