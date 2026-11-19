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

/// Whether `text` has, outside any string, a bare `nan`, `inf` or `infinity` word (any case,
/// optional sign): the non-finite literals jq accepts and RFC 8259 (so serde_json) rejects.
fn has_non_finite_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            match byte {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
            index += 1;
        } else if byte == b'"' {
            in_string = true;
            index += 1;
        } else if byte.is_ascii_alphanumeric() {
            let end = bytes[index..]
                .iter()
                .position(|b| !b.is_ascii_alphanumeric())
                .map_or(bytes.len(), |length| index + length);
            let word = bytes[index..end].to_ascii_lowercase();
            if matches!(word.as_slice(), b"nan" | b"inf" | b"infinity") {
                return true;
            }
            index = end;
        } else {
            index += 1;
        }
    }
    false
}

/// Decode only the requested paths. Other fields remain raw; serde_json validates all syntax
/// before the bounded string-escape adaptation.
/// A requested-value decoding failure is distinct from a missing/null field and must not permit.
///
/// A document serde_json rejects is empty only where the shell's extractor rejects it too. jq
/// accepts `NaN`/`Infinity`/`-Infinity` and extracts the other fields, so in jq modes that
/// document fails closed instead of reading as empty (#1731). The rest of the class jq
/// accepts but RFC 8259 rejects (U+001F, `nan123`, depth 256-9999) is not modeled yet: #1731.
/// Node's `JSON.parse` rejects non-finite literals, so `Node` keeps the empty answer.
fn selected(
    text: &str,
    paths: &[&str],
    mode: Extractor,
) -> Result<Option<(Vec<Lookup>, bool)>, Failure> {
    let valid: &RawValue = match serde_json::from_str(text) {
        Ok(valid) => valid,
        Err(_)
            if matches!(mode, Extractor::JqOnly | Extractor::JqAndNode)
                && has_non_finite_literal(text) =>
        {
            return Err(Failure(
                "payload has a non-finite number literal jq accepts and the native extraction cannot model"
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
        serde_json::from_str::<Value>(raw.get())
            .map(Lookup::Found)
            .map_err(|error| Failure(format!("hook field {path} decoding failed: {error}")))
    })
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
        assert!(!has_non_finite_literal(r#"{"c":"NaN Infinity","x":1"#));
        assert!(!has_non_finite_literal(r#"{"c":"a\"NaN"}"#));
        assert!(!has_non_finite_literal("{broken"));
        assert!(matches!(
            selected("{broken", &["c"], Extractor::JqAndNode),
            Ok(None)
        ));
    }
}
