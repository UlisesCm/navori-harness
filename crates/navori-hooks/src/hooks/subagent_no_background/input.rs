//! Explicit tool/locale inputs keep extraction deterministic and free of PATH/process probes.

use std::collections::BTreeMap;

use navori_core::js_json::{JsObject, JsValue};
use regex::bytes::RegexBuilder;
use serde_json::{Value, value::RawValue};

use crate::runner::Failure;

/// Original shell extraction cascade. No tool is executed by the native handler.
#[derive(Debug, Clone, Copy, Default)]
pub enum Extractor {
    /// jq and Node are present. jq supplies valid JSON; Node's caught parse failure returns empty.
    #[default]
    JqAndNode,
    /// jq is present but Node is absent; malformed JSON reaches the sed leaf-string fallback.
    JqOnly,
    /// Node is present without jq; its individual-field fallback uses JavaScript String(value).
    Node,
    /// Neither jq nor Node is present; only raw quoted leaf strings are extracted by sed.
    Sed,
}

/// Shell text/character-count convention, supplied instead of inspecting LC_ALL.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Locale {
    /// UTF-8 shell locale: Unicode whitespace classes and scalar-value command lengths.
    #[default]
    Utf8,
    /// LC_ALL=C: ASCII whitespace classes and encoded-byte command lengths.
    C,
}

/// The caller's original shell environment; discovery/selection is outside the pure policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct Profile {
    /// Which extraction cascade would the shell use?
    pub extractor: Extractor,
    /// Which shell character-count convention applies?
    pub locale: Locale,
}

pub(super) struct Fields {
    pub tool: String,
    pub background: String,
    pub command: String,
    pub command_bytes: usize,
}

/// Command substitution drops NUL bytes and every final newline before the cheap presence gate.
pub(super) fn capture(payload: &[u8]) -> Vec<u8> {
    let mut captured: Vec<u8> = payload.iter().copied().filter(|b| *b != 0).collect();
    while captured.last() == Some(&b'\n') {
        captured.pop();
    }
    captured
}

fn shell_string(value: String) -> String {
    value.replace('\0', "").trim_end_matches('\n').to_owned()
}

/// Adapt only UTF-16 escapes in JSON already syntax-validated by RawValue. Node accepts lone
/// surrogates and writes U+FFFD for each on UTF-8 stdout. jq also accepts lone low surrogates,
/// but rejects unpaired high surrogates. A doubled backslash is never rewritten.
fn node_strings(text: &str) -> (String, bool, bool) {
    let bytes = text.as_bytes();
    let mut result = String::new();
    let mut start = 0;
    let mut index = 0;
    let mut high_surrogate = false;
    while index + 1 < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        if bytes[index + 1] != b'u' || index + 6 > bytes.len() {
            index += 2;
            continue;
        }
        let unit = u16::from_str_radix(&text[index + 2..index + 6], 16).ok();
        if unit.is_some_and(|v| (0xd800..=0xdbff).contains(&v))
            && bytes.get(index + 6..index + 8) == Some(b"\\u")
            && text
                .get(index + 8..index + 12)
                .and_then(|v| u16::from_str_radix(v, 16).ok())
                .is_some_and(|v| (0xdc00..=0xdfff).contains(&v))
        {
            index += 12;
        } else if unit.is_some_and(|v| (0xd800..=0xdfff).contains(&v)) {
            high_surrogate |= unit.is_some_and(|v| (0xd800..=0xdbff).contains(&v));
            result.push_str(&text[start..index]);
            result.push_str(r"\ufffd");
            index += 6;
            start = index;
        } else {
            index += 6;
        }
    }
    let changed = start != 0;
    result.push_str(&text[start..]);
    (result, high_surrogate, changed)
}

type Object = BTreeMap<String, Box<RawValue>>;

/// Decode only consumed values. Unknown fields remain raw, including non-finite numeric
/// literals; serde_json validates all syntax before the bounded string-escape adaptation.
fn selected(text: &str, mode: Extractor) -> Option<([Value; 3], bool)> {
    let valid: &RawValue = serde_json::from_str(text).ok()?;
    let (node_text, high_surrogate, changed) = node_strings(valid.get());
    if high_surrogate && matches!(mode, Extractor::JqOnly) {
        return None;
    }
    let node = matches!(mode, Extractor::Node) || high_surrogate;
    let text = if changed {
        node_text.as_str()
    } else {
        valid.get()
    };
    let object = serde_json::from_str::<Object>(text).unwrap_or_default();
    let tool_input = object
        .get("tool_input")
        .and_then(|v| serde_json::from_str::<Object>(v.get()).ok())
        .unwrap_or_default();
    let fields = [
        object.get("tool_name"),
        tool_input.get("run_in_background"),
        tool_input.get("command"),
    ]
    .map(|v| {
        v.and_then(|v| serde_json::from_str::<Value>(v.get()).ok())
            .unwrap_or(Value::Null)
    });
    Some((fields, node))
}

/// Format retained jq decimal literals, including scientific notation. Keeping decimal width
/// matters at CMD_MAX; Node instead goes through f64 and the existing JS serializer.
fn jq_number(token: &str) -> String {
    let Some((coefficient, exponent)) = token.split_once(['e', 'E']) else {
        return token.to_owned();
    };
    let Ok(exponent) = exponent.parse::<i64>() else {
        return token.to_owned();
    };
    let sign = if coefficient.starts_with('-') {
        "-"
    } else {
        ""
    };
    let coefficient = coefficient.trim_start_matches('-');
    let fraction = coefficient
        .split_once('.')
        .map_or(0, |(_, tail)| tail.len());
    let digits = coefficient.replace('.', "");
    let digits = digits.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let Some(scale) = exponent.checked_sub(i64::try_from(fraction).unwrap_or(i64::MAX)) else {
        return token.to_owned();
    };
    let Some(adjusted) = scale.checked_add(i64::try_from(digits.len()).unwrap_or(i64::MAX) - 1)
    else {
        return token.to_owned();
    };
    if scale <= 0 && adjusted >= -6 {
        let position = i64::try_from(digits.len())
            .unwrap_or(i64::MAX)
            .saturating_add(scale);
        if position <= 0 {
            return format!(
                "{sign}0.{}{digits}",
                "0".repeat(usize::try_from(-position).unwrap_or(0))
            );
        }
        let position = usize::try_from(position).unwrap_or(digits.len());
        if position >= digits.len() {
            return format!("{sign}{digits}");
        }
        return format!("{sign}{}.{}", &digits[..position], &digits[position..]);
    }
    let fraction = if digits.len() > 1 {
        format!(".{}", &digits[1..])
    } else {
        String::new()
    };
    format!(
        "{sign}{}{fraction}E{}{adjusted}",
        &digits[..1],
        if adjusted >= 0 { "+" } else { "" }
    )
}

/// Consumed jq values are compact for the bulk protocol and pretty for its NUL fallback.
fn jq_json(value: &Value, pretty: bool, depth: usize) -> String {
    let pad = |level| {
        if pretty {
            "  ".repeat(level)
        } else {
            String::new()
        }
    };
    let separator = if pretty { ",\n" } else { "," };
    let newline = if pretty { "\n" } else { "" };
    match value {
        Value::Number(number) => jq_number(&number.to_string()),
        Value::Array(values) if !values.is_empty() => {
            let body = values
                .iter()
                .map(|v| format!("{}{}", pad(depth + 1), jq_json(v, pretty, depth + 1)))
                .collect::<Vec<_>>()
                .join(separator);
            format!("[{newline}{body}{newline}{}]", pad(depth))
        }
        Value::Object(values) if !values.is_empty() => {
            let body = values
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}{}:{}{}",
                        pad(depth + 1),
                        Value::String(key.clone()),
                        if pretty { " " } else { "" },
                        jq_json(value, pretty, depth + 1)
                    )
                })
                .collect::<Vec<_>>()
                .join(separator);
            format!("{{{newline}{body}{newline}{}}}", pad(depth))
        }
        _ => value.to_string(),
    }
}

/// Reuse the core's established JS number/string serialization for Node's bulk protocol.
fn js_value(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(v) => JsValue::Bool(*v),
        Value::String(s) => JsValue::string(s),
        Value::Number(v) => JsValue::Number(v.to_string().parse::<f64>().unwrap_or(f64::NAN)),
        Value::Array(values) => JsValue::Array(values.iter().map(js_value).collect()),
        Value::Object(values) => {
            let mut object = JsObject::new();
            for (key, value) in values {
                object.insert(key.as_str(), js_value(value));
            }
            JsValue::Object(object)
        }
    }
}

/// Node's individual-field fallback uses String(value), not JSON.stringify(value).
fn node_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Array(values) => values.iter().map(node_string).collect::<Vec<_>>().join(","),
        Value::Number(v) => {
            let number = v.to_string().parse::<f64>().unwrap_or(f64::NAN);
            if number.is_infinite() {
                return if number.is_sign_negative() {
                    "-Infinity"
                } else {
                    "Infinity"
                }
                .to_owned();
            }
            JsValue::Number(number).stringify(None).unwrap_or_default()
        }
        _ => value.to_string(),
    }
}

/// Render the exact extraction lane selected by the original shell's bulk/fallback protocol.
fn structured(value: &Value, individual: bool, node: bool) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(false) if !individual || !node => String::new(),
        Value::String(s) => s.clone(),
        _ if individual && node => node_string(value),
        _ if node => js_value(value).stringify(None).unwrap_or_default(),
        _ => jq_json(value, individual, 0),
    }
}

/// Match the actual shell-expanded sed ERE. Its `\.` branch matches a literal dot, so this
/// legacy fallback cannot extract JSON strings containing a backslash (even a valid escape).
fn sed_field(payload: &[u8], leaf: &str, locale: Locale) -> Result<(String, usize), Failure> {
    let pattern = format!(r#".*"{leaf}"[[:space:]]*:[[:space:]]*"([^"\\]*)".*"#);
    let pattern = if locale == Locale::Utf8 {
        pattern.replace("[:space:]", r"\s")
    } else {
        pattern
    };
    let re = RegexBuilder::new(&pattern)
        .unicode(locale == Locale::Utf8)
        .build()
        .map_err(|e| Failure(format!("field pattern: {e}")))?;
    let mut output = Vec::new();
    for line in payload.split(|b| *b == b'\n') {
        if re.is_match(line) {
            output.extend_from_slice(&re.replace(line, &b"$1"[..]));
            output.push(b'\n');
        }
    }
    let output = capture(&output);
    Ok((String::from_utf8_lossy(&output).into_owned(), output.len()))
}

/// Reproduce bulk extraction and its all-fields NUL fallback; never execute an extractor.
pub(super) fn extract(payload: &[u8], profile: Profile) -> Result<Fields, Failure> {
    let mode = profile.extractor;
    let text = String::from_utf8_lossy(payload);
    if !matches!(mode, Extractor::Sed)
        && let Some((fields, node)) = selected(&text, mode)
    {
        let bulk = fields.each_ref().map(|v| structured(v, false, node));
        let values = if bulk.iter().any(|v| v.contains('\0')) {
            fields.each_ref().map(|v| structured(v, true, node))
        } else {
            bulk
        };
        let [tool, background, command] = values.map(shell_string);
        return Ok(Fields {
            tool,
            background,
            command_bytes: command.len(),
            command,
        });
    }
    if matches!(mode, Extractor::Sed | Extractor::JqOnly) {
        let (tool, _) = sed_field(payload, "tool_name", profile.locale)?;
        let (background, _) = sed_field(payload, "run_in_background", profile.locale)?;
        let (command, command_bytes) = sed_field(payload, "command", profile.locale)?;
        return Ok(Fields {
            tool,
            background,
            command,
            command_bytes,
        });
    }
    Ok(Fields {
        tool: String::new(),
        background: String::new(),
        command: String::new(),
        command_bytes: 0,
    })
}
