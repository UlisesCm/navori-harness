//! The `extract-cmd` partial's payload protocol (`payload_load` over a hook's declared
//! `nv_payload_fields`), shared by every ported hook. Explicit tool/locale inputs keep
//! extraction deterministic and free of PATH/process probes.

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

use crate::shell::Locale;

/// The caller's original shell environment; discovery/selection is outside the pure policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct Profile {
    /// Which extraction cascade would the shell use?
    pub extractor: Extractor,
    /// Which shell character-count convention applies?
    pub locale: Locale,
}

/// Values `payload_load` caches, in the order of the requested paths.
pub(crate) struct Fields {
    /// Each value as `$(payload_field <path>)` returns it.
    pub values: Vec<String>,
    /// Byte length of each value before any lossy UTF-8 decoding (the sed lane reads raw bytes).
    pub bytes: Vec<usize>,
    /// Individual-field command substitutions that dropped a NUL (one Bash 5 warning each).
    pub nul_substitutions: usize,
}

/// `payload=${payload-"$(cat)"}`: command substitution drops NUL bytes and every final newline.
pub(crate) fn capture(payload: &[u8]) -> Vec<u8> {
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

/// One dotted path looked up in the payload.
enum Lookup {
    /// The value, `Null` when a member is missing or null.
    Found(Value),
    /// An intermediate member is neither an object nor null: jq's bulk `?` and Node's `?.` read
    /// it as empty, but an individual `jq -r .a.b` fails and the cascade moves on.
    Unindexable,
}

/// The index just past the JSON string that opens at `start` (a `"`), or the end of `bytes`.
fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return index + 1,
            _ => index += 1,
        }
    }
    bytes.len()
}

/// Nesting from which some accredited jq rejects a document: 1.7 and 1.7.1 stop at 256 levels,
/// 1.8.x at 10000. serde_json reads it, so the native extraction would see what the shell's
/// `jq` does not.
const JQ_DEPTH: usize = 256;

/// The deepest nesting of arrays and objects in `text`, strings skipped.
fn nesting(text: &str) -> usize {
    let bytes = text.as_bytes();
    let (mut index, mut depth, mut deepest) = (0, 0_usize, 0_usize);
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index = string_end(bytes, index);
                continue;
            }
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        index += 1;
    }
    deepest
}

/// How jq's lexer reads a literal token (`[A-Za-z0-9+.-]+`) as a number: `None` when it is not
/// one jq accepts, else whether RFC 8259 accepts it too. jq takes an optional `+`, leading zeros
/// and a bare `.` on either side of the digits (`+1`, `01`, `.5`, `1.`), which RFC 8259 rejects.
fn number_token(token: &[u8]) -> Option<bool> {
    let digits = |part: &[u8]| part.iter().all(u8::is_ascii_digit);
    let unsigned = token
        .strip_prefix(b"-")
        .or_else(|| token.strip_prefix(b"+"))
        .unwrap_or(token);
    let (mantissa, exponent) = match unsigned.iter().position(|b| matches!(b, b'e' | b'E')) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = match mantissa.iter().position(|b| *b == b'.') {
        Some(at) => (&mantissa[..at], Some(&mantissa[at + 1..])),
        None => (mantissa, None),
    };
    let fraction_digits = fraction.unwrap_or_default();
    if !digits(whole)
        || !digits(fraction_digits)
        || (whole.is_empty() && fraction_digits.is_empty())
    {
        return None;
    }
    if let Some(exponent) = exponent {
        let exponent = exponent
            .strip_prefix(b"-")
            .or_else(|| exponent.strip_prefix(b"+"))
            .unwrap_or(exponent);
        if exponent.is_empty() || !digits(exponent) {
            return None;
        }
    }
    Some(
        !token.starts_with(b"+")
            && !whole.is_empty()
            && (whole == b"0" || !whole.starts_with(b"0"))
            && fraction.is_none_or(|part| !part.is_empty()),
    )
}

/// Whether jq may read a document serde_json rejected (#1731), judged over its bytes only (it
/// need not be valid JSON): a leading BOM, a raw control character in a string (U+001F, which
/// 1.7 accepts), a `nan`- or `snan`-prefixed, `inf` or `infinity` literal in any case and
/// sign (`NaN`, 1.7.1's `nan123`, the signaling `sNaN`, `-Infinity`), a number only jq's
/// lexer accepts ([`number_token`]), or a valid first document followed by more text (jq reads
/// the whole stream).
fn jq_may_read(text: &str) -> bool {
    let literal = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.');
    let bytes = text.as_bytes();
    let mut jq = text.starts_with('\u{feff}');
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let end = string_end(bytes, index);
                jq |= bytes[index..end].iter().any(|b| *b < 0x20);
                index = end;
            }
            byte if literal(byte) => {
                let end = bytes[index..]
                    .iter()
                    .position(|b| !literal(*b))
                    .map_or(bytes.len(), |length| index + length);
                let token = &bytes[index..end];
                let word = token
                    .strip_prefix(b"-")
                    .or_else(|| token.strip_prefix(b"+"))
                    .unwrap_or(token)
                    .to_ascii_lowercase();
                jq |= word.starts_with(b"nan")
                    || word.starts_with(b"snan")
                    || matches!(word.as_slice(), b"inf" | b"infinity")
                    || number_token(token) == Some(false);
                index = end;
            }
            _ => index += 1,
        }
    }
    jq || serde_json::Deserializer::from_str(text)
        .into_iter::<&RawValue>()
        .next()
        .is_some_and(|first| first.is_ok())
}

/// Whether every object in `raw` (valid JSON) lists its members in strictly ascending key order,
/// the order serde_json's map renders them in. jq and Node render the source order and keep a
/// repeated key at its first position, so any other object cannot be modeled (#1731).
fn sorted_members(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    // One frame per open container: `Some(last key)` for an object, `None` for an array.
    let mut frames: Vec<Option<Option<String>>> = Vec::new();
    let mut key_next = false;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                frames.push(Some(None));
                key_next = true;
            }
            b'[' => {
                frames.push(None);
                key_next = false;
            }
            b'}' | b']' => {
                frames.pop();
                key_next = false;
            }
            b',' => key_next = matches!(frames.last(), Some(Some(_))),
            b'"' => {
                let end = string_end(bytes, index);
                if key_next {
                    let Ok(key) = serde_json::from_str::<String>(&raw[index..end]) else {
                        return false;
                    };
                    if let Some(Some(last)) = frames.last_mut() {
                        if last.as_ref().is_some_and(|previous| *previous >= key) {
                            return false;
                        }
                        *last = Some(key);
                    }
                    key_next = false;
                }
                index = end;
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    true
}

/// Decode only the requested paths. Other fields remain raw; serde_json validates all syntax
/// before the bounded string-escape adaptation.
/// A requested-value decoding failure is distinct from a missing/null field and must not permit.
///
/// A document serde_json rejects is empty only where the shell's extractor rejects it too
/// (#1731). Where jq may read it ([`jq_may_read`]) the jq modes fail, which defers the call to
/// the shell, instead of reading it as empty. Node's `JSON.parse` rejects that whole class, so
/// `Node` keeps the empty answer. A truncated or plainly malformed document keeps its modeled
/// answer. The other way round, a document nested [`JQ_DEPTH`] levels or more, which serde
/// reads and some accredited jq rejects, also fails in the jq modes.
fn selected(
    text: &str,
    paths: &[&str],
    mode: Extractor,
) -> Result<Option<(Vec<Lookup>, bool)>, Failure> {
    let jq = matches!(mode, Extractor::JqOnly | Extractor::JqAndNode);
    let valid = match serde_json::from_str::<&RawValue>(text) {
        Ok(valid) if jq && nesting(valid.get()) >= JQ_DEPTH => {
            return Err(Failure(
                "payload nesting some accredited jq rejects; the native extraction cannot model it"
                    .to_owned(),
            ));
        }
        Ok(valid) => valid,
        Err(_) if jq && jq_may_read(text) => {
            return Err(Failure(
                "payload is JSON jq may read but RFC 8259 rejects; the native extraction cannot model it"
                    .to_owned(),
            ));
        }
        Err(_) => return Ok(None),
    };
    let (node_text, high_surrogate, changed) = node_strings(valid.get());
    if high_surrogate && matches!(mode, Extractor::JqOnly) {
        return Ok(None);
    }
    let node = matches!(mode, Extractor::Node) || high_surrogate;
    let text = if changed {
        node_text.as_str()
    } else {
        valid.get()
    };
    let root = serde_json::from_str::<Object>(text).unwrap_or_default();
    let lookups = paths
        .iter()
        .map(|path| lookup(&root, path))
        .collect::<Result<_, _>>()?;
    Ok(Some((lookups, node)))
}

/// Walk one dotted path. Only a payload object reaches the individual lane (a NUL needs a string
/// member), so a non-object root is simply empty.
fn lookup(root: &Object, path: &str) -> Result<Lookup, Failure> {
    let mut members = path.split('.');
    let mut raw: Option<Box<RawValue>> = members
        .next()
        .and_then(|name| root.get(name))
        .map(|value| (**value).to_owned());
    for name in members {
        let Some(value) = raw else {
            return Ok(Lookup::Found(Value::Null));
        };
        if value.get() == "null" {
            return Ok(Lookup::Found(Value::Null));
        }
        let mut nested = match serde_json::from_str::<Object>(value.get()) {
            Ok(object) => object,
            Err(error) if value.get().starts_with('{') => {
                return Err(Failure(format!(
                    "hook field {path} decoding failed: {error}"
                )));
            }
            Err(_) => return Ok(Lookup::Unindexable),
        };
        raw = nested.remove(name);
    }
    raw.map_or(Ok(Lookup::Found(Value::Null)), |raw| {
        if raw.get().starts_with(['{', '[']) && !sorted_members(raw.get()) {
            return Err(Failure(format!(
                "hook field {path} has an object whose member order the native extraction cannot model"
            )));
        }
        serde_json::from_str::<Value>(raw.get())
            .map(Lookup::Found)
            .map_err(|error| Failure(format!("hook field {path} decoding failed: {error}")))
    })
}

/// Format retained jq decimal literals, including scientific notation (`0.0000001` is `1E-7`).
/// Keeping decimal width matters at CMD_MAX; Node instead goes through f64 and the existing JS
/// serializer.
fn jq_number(token: &str) -> String {
    let (coefficient, exponent) = token.split_once(['e', 'E']).unwrap_or((token, "0"));
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
                        jq_string(key),
                        if pretty { " " } else { "" },
                        jq_json(value, pretty, depth + 1)
                    )
                })
                .collect::<Vec<_>>()
                .join(separator);
            format!("{{{newline}{body}{newline}{}}}", pad(depth))
        }
        Value::String(text) => jq_string(text),
        _ => value.to_string(),
    }
}

/// A string inside a structured jq value: JSON escapes, plus jq's `\u007f` for DEL.
fn jq_string(text: &str) -> String {
    Value::String(text.to_owned())
        .to_string()
        .replace('\u{7f}', "\\u007f")
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
    let pattern = pattern.replace("[:space:]", locale.space_class());
    let re = RegexBuilder::new(&pattern)
        .unicode(locale != Locale::C)
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

/// `payload_field`'s last resort: sed over the leaf name of the dotted path.
fn sed_leaf(payload: &[u8], path: &str, locale: Locale) -> Result<(String, usize), Failure> {
    sed_field(payload, path.rsplit('.').next().unwrap_or(path), locale)
}

/// Reproduce `payload_load` over `paths` (bulk extraction and its all-fields NUL fallback, field
/// by field through `payload_field`) on the captured payload; never execute an extractor.
pub(crate) fn extract(payload: &[u8], paths: &[&str], profile: Profile) -> Result<Fields, Failure> {
    let mode = profile.extractor;
    let text = String::from_utf8_lossy(payload);
    if !matches!(mode, Extractor::Sed)
        && let Some((lookups, node)) = selected(&text, paths, mode)?
    {
        let bulk: Vec<String> = lookups
            .iter()
            .map(|lookup| match lookup {
                Lookup::Found(value) => structured(value, false, node),
                Lookup::Unindexable => String::new(),
            })
            .collect();
        let (values, nul_substitutions) = if bulk.iter().any(|v| v.contains('\0')) {
            let mut individual = Vec::with_capacity(paths.len());
            for (lookup, path) in lookups.iter().zip(paths) {
                individual.push(match lookup {
                    Lookup::Found(value) => structured(value, true, node),
                    // jq fails; Node reads an absent member, and without Node sed takes over.
                    Lookup::Unindexable if node || matches!(mode, Extractor::JqAndNode) => {
                        String::new()
                    }
                    Lookup::Unindexable => sed_leaf(payload, path, profile.locale)?.0,
                });
            }
            let count = individual
                .iter()
                .filter(|value| value.contains('\0'))
                .count();
            (individual, count)
        } else {
            (bulk, 0)
        };
        let values: Vec<String> = values.into_iter().map(shell_string).collect();
        return Ok(Fields {
            bytes: values.iter().map(String::len).collect(),
            values,
            nul_substitutions,
        });
    }
    if matches!(mode, Extractor::Sed | Extractor::JqOnly) {
        let (values, bytes) = paths
            .iter()
            .map(|path| sed_leaf(payload, path, profile.locale))
            .collect::<Result<(Vec<_>, Vec<_>), _>>()?;
        return Ok(Fields {
            values,
            bytes,
            nul_substitutions: 0,
        });
    }
    Ok(Fields {
        values: vec![String::new(); paths.len()],
        bytes: vec![0; paths.len()],
        nul_substitutions: 0,
    })
}

#[cfg(test)]
mod locale_tests {
    use super::Locale;

    // Covers: R11, R12
    #[test]
    fn locale_space_tables_and_regex_agree_for_members_and_nonmembers() -> Result<(), regex::Error>
    {
        // GNU primary source: glibc-2.41/localedata/locales/i18n_ctype, space.
        // BSD table also checked against macOS libc.iswspace in en_US.UTF-8.
        let tables: [(Locale, &[u32]); 3] = [
            (Locale::C, &[0x9, 0xa, 0xb, 0xc, 0xd, 0x20]),
            (
                Locale::GnuUtf8,
                &[
                    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
                    0x2005, 0x2006, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000,
                ],
            ),
            (
                Locale::Utf8,
                &[
                    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
                    0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
                    0x205f, 0x3000,
                ],
            ),
        ];
        for (locale, expected) in tables {
            let re = regex::Regex::new(&format!("^[{}]$", locale.space_class()))?;
            for value in 0..=0x3001 {
                let c = char::from_u32(value).ok_or_else(|| {
                    regex::Error::Syntax("non-scalar locale test value".to_owned())
                })?;
                assert_eq!(
                    locale.whitespace(c),
                    expected.contains(&value),
                    "{locale:?}, U+{value:04X}"
                );
                assert_eq!(
                    re.is_match(&c.to_string()),
                    expected.contains(&value),
                    "{locale:?}, U+{value:04X}"
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "test assertions")]
mod jq_probe_tests {
    use super::*;
    use crate::shell::prepare::{JQ, expected_jq};

    /// The probe's nine documents, decoded: JSON escapes stay as written, raw bytes are raw.
    const DOCUMENTS: [&[u8]; 9] = [
        br#"{"a":1.000,"b":{"c":100000000000000000001}}"#,
        br#"{"a":1E1000,"b":{"c":-0}}"#,
        br#"{"a":1e2,"b":{"c":1.5e-7}}"#,
        br#"{"a":12345678901234567890123e-3,"b":{"c":"\ud83d\ude80"}}"#,
        br#"{"a":"x\udc00y","b":{"c":"\u001b\u007f\t"}}"#,
        b"{\"a\":\"\xff\xc0\xaf\",\"b\":{\"c\":\"a\xe2\x82\"}}",
        br#"{"a":false,"b":{"c":null}}"#,
        br#"{"a":1,"a":{"e":{},"k":[1,2.50,"\u0000"],"l":[]},"b":{"c":true}}"#,
        br#"{"a":"a\u0000b","b":"str"}"#,
    ];

    /// Split the expected output into the four `output\0rc\0` invocations.
    fn sections() -> Vec<(Vec<u8>, u8)> {
        let expected = expected_jq();
        let mut result = Vec::new();
        let mut start = 0;
        for &rc in b"0055" {
            let end = start
                + expected[start..]
                    .windows(3)
                    .position(|w| w == [0, rc, 0])
                    .expect("terminator");
            result.push((expected[start..end].to_vec(), rc));
            start = end + 3;
        }
        assert_eq!(start, expected.len());
        result
    }

    fn lookups(document: &[u8], mode: Extractor) -> Vec<Lookup> {
        let text = String::from_utf8_lossy(document);
        selected(&text, &["a", "b.c"], mode)
            .expect("no failure")
            .expect("accepted")
            .0
    }

    /// `jq -r '.p // empty'` over one document, one path.
    fn individual(lookup: &Lookup) -> String {
        match lookup {
            Lookup::Found(Value::Null | Value::Bool(false)) | Lookup::Unindexable => String::new(),
            Lookup::Found(value) => format!("{}\n", structured(value, true, false)),
        }
    }

    // Covers: R11, R13
    #[test]
    fn jq_probe_matches_model() {
        let sections = sections();
        for mode in [Extractor::JqOnly, Extractor::JqAndNode] {
            let mut bulk = Vec::new();
            let (mut first, mut second) = (String::new(), String::new());
            for document in DOCUMENTS {
                let found = lookups(document, mode);
                let values: Vec<String> = found
                    .iter()
                    .map(|l| match l {
                        Lookup::Found(v) => structured(v, false, false),
                        Lookup::Unindexable => String::new(),
                    })
                    .collect();
                // A NUL anywhere empties the document's bulk output.
                if !values.iter().any(|v| v.contains('\0')) {
                    bulk.extend_from_slice(
                        format!("{}\0{}\0END\0", values[0], values[1]).as_bytes(),
                    );
                }
                first.push_str(&individual(&found[0]));
                second.push_str(&individual(&found[1]));
            }
            assert_eq!(sections[0].0, bulk, "{mode:?} bulk");
            assert_eq!(sections[1].0, first.as_bytes(), "{mode:?} -r .a");
            assert_eq!(sections[2].0, second.as_bytes(), "{mode:?} -r .b.c");
        }
        // The lone high surrogate aborts jq (rc 5, no output): only the sed lane remains.
        assert!(sections[3].0.is_empty());
        assert!(matches!(
            selected(r#"{"a":"x\ud800y"}"#, &["a"], Extractor::JqOnly),
            Ok(None)
        ));
    }

    /// Resolve the shell escapes of a double-quoted word (`\"`, `\$`, `\\`).
    fn unquote(word: &str) -> String {
        let mut out = String::new();
        let mut chars = word.chars();
        while let Some(c) = chars.next() {
            match (c, chars.clone().next()) {
                ('\\', Some(next @ ('"' | '$' | '\\' | '`'))) => {
                    out.push(next);
                    chars.next();
                }
                _ => out.push(c),
            }
        }
        out
    }

    // Covers: R11, R13
    #[test]
    fn jq_probe_filter_is_extract_cmd() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/core-assets/hooks/_partials/extract-cmd.sh");
        let script = std::fs::read_to_string(path).expect("extract-cmd.sh");
        let line = |prefix: &str| {
            script
                .lines()
                .map(str::trim)
                .find(|l| l.starts_with(prefix))
                .unwrap_or_else(|| panic!("{prefix} not in extract-cmd.sh"))
                .to_owned()
        };
        let piece = line("_pf_filter=\"$_pf_filter");
        let piece = unquote(
            piece
                .strip_prefix("_pf_filter=\"")
                .and_then(|p| p.strip_suffix('"'))
                .expect("piece"),
        );
        let wrap = line("_pf_filter=\"[");
        let wrap = unquote(
            wrap.strip_prefix("_pf_filter=\"")
                .and_then(|p| p.strip_suffix('"'))
                .expect("wrap"),
        );
        let pieces: String = ["a", "b.c"]
            .iter()
            .map(|p| {
                piece
                    .replace("$_pf_filter", "")
                    .replace("${_pf_spec#*=}", p)
            })
            .collect();
        let filter = wrap.replace("${_pf_filter%,}", pieces.trim_end_matches(','));
        let probe = JQ
            .lines()
            .find_map(|l| l.strip_prefix("F='").and_then(|l| l.strip_suffix('\'')))
            .expect("filter line");
        assert_eq!(probe, filter);
        assert!(script.contains("jq -j \"$_pf_filter\""));
        assert!(script.contains("jq -r \".$1 // empty\""));
        assert!(JQ.contains("-j \"$F\"") && JQ.contains("-r '.a // empty'"));
    }

    // Covers: R11, R13
    #[test]
    fn a_non_finite_literal_in_jq_mode_fails_closed_not_empty() {
        let payload: &[u8] = br#"{"tool_input":{"command":"rm -rf /"},"x":NaN}"#;
        for text in [
            r#"{"c":"ls","x":NaN}"#,
            r#"{"c":"ls","x":-Infinity}"#,
            r#"{"c":"ls","x":[Infinity,nan]}"#,
        ] {
            for mode in [Extractor::JqOnly, Extractor::JqAndNode] {
                assert!(selected(text, &["c"], mode).is_err(), "{text} {mode:?}");
            }
            // Node's JSON.parse rejects it too: the shell lane is empty there.
            assert!(matches!(selected(text, &["c"], Extractor::Node), Ok(None)));
        }
        for mode in [Extractor::JqOnly, Extractor::JqAndNode] {
            let profile = Profile {
                extractor: mode,
                locale: Locale::C,
            };
            assert!(extract(payload, &["tool_input.command"], profile).is_err());
        }
        // Words inside strings and ordinary malformed JSON keep their old answers.
        assert!(!jq_may_read(r#"{"c":"NaN Infinity","x":1"#));
        assert!(!jq_may_read(r#"{"c":"a\"NaN""#));
        assert!(!jq_may_read("{broken"));
        assert!(matches!(
            selected("{broken", &["c"], Extractor::JqAndNode),
            Ok(None)
        ));
    }

    // Covers: R11, R13
    #[test]
    fn a_document_jq_may_read_and_serde_rejects_defers_in_jq_modes() {
        let lenient = [
            "{\"c\":\"a\u{1f}b\"}",
            r#"{"c":"ls","x":nan123}"#,
            r#"{"c":"ls"}{"c":"rm -rf /"}"#,
            r#"{"c":"ls"} trailing"#,
            "\u{feff}{\"c\":\"ls\"}",
            r#"{"c":"ls","x":01}"#,
            r#"{"c":"ls","x":.5}"#,
            r#"{"c":"ls","x":1.}"#,
            r#"{"c":"ls","x":+1}"#,
            r#"{"c":"ls","x":-.5}"#,
            r#"{"c":"ls","x":1.e5}"#,
            r#"{"c":"ls","x":sNaN}"#,
            r#"{"c":"ls","x":+sNaN}"#,
            r#"{"c":"ls","x":sNaN12}"#,
            r#"{"c":"ls","x":INF}"#,
        ];
        for text in lenient {
            assert!(
                serde_json::from_str::<&RawValue>(text).is_err(),
                "{text:.40}"
            );
            for mode in [Extractor::JqOnly, Extractor::JqAndNode] {
                assert!(selected(text, &["c"], mode).is_err(), "{text:.40} {mode:?}");
            }
            // Node's JSON.parse rejects them too: the shell lane is empty there.
            assert!(
                matches!(selected(text, &["c"], Extractor::Node), Ok(None)),
                "{text:.40}"
            );
        }
        // Nesting some accredited jq rejects (1.7.x at 256) defers in the jq modes only.
        for (levels, defers) in [(255, false), (256, true), (1_000, true)] {
            let nested = format!(
                r#"{{"c":"ls","x":{}1{}}}"#,
                "[".repeat(levels - 1),
                "]".repeat(levels - 1)
            );
            for mode in [Extractor::JqOnly, Extractor::JqAndNode] {
                assert_eq!(
                    selected(&nested, &["c"], mode).is_err(),
                    defers,
                    "{levels} {mode:?}"
                );
            }
            assert!(
                selected(&nested, &["c"], Extractor::Node).is_ok(),
                "{levels}"
            );
        }
        // What jq rejects too keeps the modeled answer: empty, or the sed lane without Node.
        for text in [
            "",
            "{",
            r#"{"tool_input":"#,
            "gh pr create",
            "general-purpose",
            "navori master close",
            r#"{"c":"ls","x":1e+}"#,
            r#"{"c":"ls","x":0x10}"#,
            r#"{"c":"ls","x":1.2.3}"#,
            r#"{"c":"ls","x":1e}"#,
            r#"{"c":"ls","x":1_0}"#,
            r#"{"c":"ls","x":Infinity1}"#,
            r#"{"c":"ls","x":true1}"#,
            r#"{"c":"ls","x":qNaN}"#,
            r#"{"c":"ls","x":infinite}"#,
            r#"{"c":"ls","x":1"#,
        ] {
            for mode in [Extractor::JqOnly, Extractor::JqAndNode, Extractor::Node] {
                assert!(
                    matches!(selected(text, &["c"], mode), Ok(None)),
                    "{text} {mode:?}"
                );
            }
        }
    }

    // Covers: R11, R13
    #[test]
    fn number_tokens_follow_jq_s_lexer_and_rfc_8259() {
        for (token, read) in [
            ("0", Some(true)),
            ("-0", Some(true)),
            ("10", Some(true)),
            ("1.5e-7", Some(true)),
            ("-12E+3", Some(true)),
            ("01", Some(false)),
            ("00", Some(false)),
            ("-01", Some(false)),
            (".5", Some(false)),
            ("-.5", Some(false)),
            ("1.", Some(false)),
            ("1.e5", Some(false)),
            ("+1", Some(false)),
            ("1e+", None),
            ("1e", None),
            ("0x10", None),
            ("1.2.3", None),
            ("-", None),
            ("+", None),
            (".", None),
            ("true", None),
        ] {
            assert_eq!(number_token(token.as_bytes()), read, "{token}");
        }
    }

    // Covers: R11, R13
    #[test]
    fn jq_numbers_without_an_exponent_use_its_scientific_form() {
        for (token, jq) in [
            ("0.0000001", "1E-7"),
            ("0.00000000", "0E-8"),
            ("-0.0000012", "-0.0000012"),
            ("0.000001", "0.000001"),
            ("0.0100", "0.0100"),
            ("1.000", "1.000"),
            ("100.0", "100.0"),
            ("-0", "-0"),
            ("0", "0"),
            ("100000000000000000001", "100000000000000000001"),
            ("1e2", "1E+2"),
            ("1.5e-7", "1.5E-7"),
        ] {
            assert_eq!(jq_number(token), jq, "{token}");
        }
    }

    // Covers: R11, R13
    #[test]
    fn structured_values_escape_del_and_defer_on_unsorted_members() {
        let text = "{\"c\":[\"\u{7f}\",{\"\u{7f}k\":\"z\u{7f}\"}]}";
        let found = selected(text, &["c"], Extractor::JqOnly)
            .expect("no failure")
            .expect("accepted")
            .0;
        let value = match &found[0] {
            Lookup::Found(value) => value.clone(),
            Lookup::Unindexable => Value::Null,
        };
        assert_eq!(
            structured(&value, false, false),
            r#"["\u007f",{"\u007fk":"z\u007f"}]"#
        );
        for (raw, sorted) in [
            (r#"{"a":1,"b":{"c":2,"d":[{"e":1,"f":2}]}}"#, true),
            (r#"[{"a":1},{"a":2},"b,\"a\":"]"#, true),
            (r#"{"b":1,"a":2}"#, false),
            (r#"{"a":1,"a":2}"#, false),
            (r#"{"a":{"z":1,"y":2}}"#, false),
            (r#"{"\u0062":1,"a":2}"#, false),
        ] {
            assert_eq!(sorted_members(raw), sorted, "{raw}");
        }
        for mode in [Extractor::JqOnly, Extractor::JqAndNode, Extractor::Node] {
            assert!(selected(r#"{"c":{"b":1,"a":2}}"#, &["c"], mode).is_err());
            assert!(selected(r#"{"c":"ls","x":{"b":1,"a":2}}"#, &["c"], mode).is_ok());
        }
    }
}
