//! JSON model and serializer with JavaScript semantics (D14).
//!
//! [`JsValue::stringify`] is `JSON.stringify(v)` / `JSON.stringify(v, null, n)`: numbers print like
//! `Number.prototype.toString` (`1.0` -> `1`, `-0` -> `0`, `1e21`), object keys come out in
//! JS property order (array indices ascending, then insertion order), strings are UTF-16 so lone
//! surrogates survive and are escaped as `\uXXXX`, and `undefined` is omitted.

use std::fmt::Write as _;

/// A JS string: UTF-16 code units, so lone surrogates are representable.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct JsString(Vec<u16>);

impl JsString {
    /// Wraps raw UTF-16 code units.
    #[must_use]
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }

    /// The UTF-16 code units.
    #[must_use]
    pub fn units(&self) -> &[u16] {
        &self.0
    }

    /// Whether this is a canonical array index (`"0"`..`"4294967294"`, no leading zeros): the
    /// keys JS orders first, ascending, ahead of the insertion order of the rest.
    #[must_use]
    pub fn array_index(&self) -> Option<u32> {
        let digits = &self.0;
        if digits.is_empty() || digits.len() > 10 {
            return None;
        }
        if digits.len() > 1 && digits.first() == Some(&u16::from(b'0')) {
            return None;
        }
        let mut value: u64 = 0;
        for unit in digits {
            let digit = unit.checked_sub(u16::from(b'0')).filter(|d| *d <= 9)?;
            value = value * 10 + u64::from(digit);
        }
        u32::try_from(value).ok().filter(|v| *v != u32::MAX)
    }

    /// Rust text of this string, or `None` when it holds a lone surrogate.
    #[must_use]
    pub fn to_rust(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }

    /// Whether this string equals the Rust text `text`.
    #[must_use]
    pub fn is(&self, text: &str) -> bool {
        self.0.iter().copied().eq(text.encode_utf16())
    }
}

impl From<&str> for JsString {
    fn from(text: &str) -> Self {
        Self(text.encode_utf16().collect())
    }
}

impl From<String> for JsString {
    fn from(text: String) -> Self {
        Self::from(text.as_str())
    }
}

/// A JS object: properties in insertion order, as `JSON.parse` builds them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsObject(Vec<(JsString, JsValue)>);

impl JsObject {
    /// An empty object.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a property. An existing key keeps its position and takes the new value, like
    /// `JSON.parse` does with a duplicated key.
    pub fn insert(&mut self, key: impl Into<JsString>, value: JsValue) {
        let key = key.into();
        match self.0.iter_mut().find(|(existing, _)| *existing == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }

    /// Properties in insertion order.
    #[must_use]
    pub fn entries(&self) -> &[(JsString, JsValue)] {
        &self.0
    }

    /// Own property `key`, like `obj[key]` restricted to own properties.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.0
            .iter()
            .find_map(|(existing, value)| existing.is(key).then_some(value))
    }

    /// Whether `key` is an own property.
    #[must_use]
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Own property `key`, mutably.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut JsValue> {
        self.0
            .iter_mut()
            .find_map(|(existing, value)| existing.is(key).then_some(value))
    }

    /// `delete obj[key]`.
    pub fn remove(&mut self, key: &str) {
        self.0.retain(|(existing, _)| !existing.is(key));
    }

    /// The number of own properties (`Object.keys(obj).length`).
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether there are no own properties.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Properties in JS enumeration order: array indices ascending, then the rest as inserted.
    #[must_use]
    pub fn ordered(&self) -> Vec<&(JsString, JsValue)> {
        let mut indexed: Vec<(u32, &(JsString, JsValue))> = self
            .0
            .iter()
            .filter_map(|entry| entry.0.array_index().map(|index| (index, entry)))
            .collect();
        indexed.sort_by_key(|(index, _)| *index);
        let rest = self
            .0
            .iter()
            .filter(|entry| entry.0.array_index().is_none());
        indexed
            .into_iter()
            .map(|(_, entry)| entry)
            .chain(rest)
            .collect()
    }
}

/// A JS value as `JSON.stringify` sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    /// `undefined`: omitted from objects, `null` in arrays, no output at top level.
    Undefined,
    /// `null`.
    Null,
    /// `true` / `false`.
    Bool(bool),
    /// Any `Number`; `NaN` and the infinities print as `null`.
    Number(f64),
    /// A string.
    String(JsString),
    /// An array.
    Array(Vec<JsValue>),
    /// An object.
    Object(JsObject),
}

impl JsValue {
    /// A string value from Rust text.
    #[must_use]
    pub fn string(text: &str) -> Self {
        Self::String(JsString::from(text))
    }

    /// `JSON.stringify(self)` (`indent` `None`) or `JSON.stringify(self, null, indent)`.
    /// `None` result means JS returned `undefined`. Like JS, `indent` is capped at 10.
    #[must_use]
    pub fn stringify(&self, indent: Option<usize>) -> Option<String> {
        let gap = " ".repeat(indent.unwrap_or(0).min(10));
        let mut out = String::new();
        write_value(self, &gap, 0, &mut out).then_some(out)
    }
}

/// Writes `value`; false (and nothing written) when it serializes to nothing (`undefined`).
fn write_value(value: &JsValue, gap: &str, depth: usize, out: &mut String) -> bool {
    match value {
        JsValue::Undefined => return false,
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(number) => out.push_str(&number_to_js(*number)),
        JsValue::String(text) => write_string(text, out),
        JsValue::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return true;
            }
            out.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                newline(gap, depth + 1, out);
                if !write_value(item, gap, depth + 1, out) {
                    out.push_str("null");
                }
            }
            newline(gap, depth, out);
            out.push(']');
        }
        JsValue::Object(object) => {
            let mut wrote = false;
            out.push('{');
            for (key, member) in object.ordered().into_iter().map(|e| (&e.0, &e.1)) {
                let checkpoint = out.len();
                if wrote {
                    out.push(',');
                }
                newline(gap, depth + 1, out);
                write_string(key, out);
                out.push(':');
                if !gap.is_empty() {
                    out.push(' ');
                }
                if write_value(member, gap, depth + 1, out) {
                    wrote = true;
                } else {
                    out.truncate(checkpoint);
                }
            }
            if wrote {
                newline(gap, depth, out);
            }
            out.push('}');
        }
    }
    true
}

fn newline(gap: &str, depth: usize, out: &mut String) {
    if gap.is_empty() {
        return;
    }
    out.push('\n');
    for _ in 0..depth {
        out.push_str(gap);
    }
}

/// `Number.prototype.toString()` for the values JSON allows; `null` for `NaN` and infinities.
/// `String(number)` / `Number.prototype.toString()`.
#[must_use]
pub fn number_to_js(number: f64) -> String {
    if !number.is_finite() {
        return "null".to_owned();
    }
    if number == 0.0 {
        // `-0` prints as `0`.
        return "0".to_owned();
    }
    ryu_js::Buffer::new().format_finite(number).to_owned()
}

/// `JSON.stringify` string quoting for well-formed output: lone surrogates as `\uXXXX`, U+2028
/// and U+2029 untouched.
fn write_string(text: &JsString, out: &mut String) {
    out.push('"');
    for decoded in char::decode_utf16(text.units().iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if u32::from(c) < 0x20 => {
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            Ok(c) => out.push(c),
            Err(lone) => {
                let _ = write!(out, "\\u{:04x}", lone.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

/// `JSON.parse(text)` for the documents navori reads, or `None` when Rust cannot reproduce it.
///
/// `None` covers both text JS rejects and the rare text JS accepts but this parser does not model
/// (lone surrogate escapes, numbers that overflow to `Infinity`, nesting deeper than 128, a
/// `__proto__` key). Callers treat `None` as "let the TS decide", which is always safe. Known limit:
/// an object whose only key is serde_json's private number marker reads as that number.
#[must_use]
pub fn parse(text: &str) -> Option<JsValue> {
    let parsed: Parsed = serde_json::from_str(text).ok()?;
    Some(parsed.0)
}

struct Parsed(JsValue);

/// serde_json's private marker for a number under `arbitrary_precision`.
const ARBITRARY_PRECISION_TOKEN: &str = "$serde_json::private::Number";

/// A JSON number literal as `JSON.parse` reads it: nearest double, `Infinity` unsupported.
fn number_from_text<E: serde::de::Error>(digits: &str) -> Result<JsValue, E> {
    match digits.parse::<f64>() {
        Ok(value) if value.is_finite() => Ok(JsValue::Number(value)),
        _ => Err(E::custom("number overflows to Infinity")),
    }
}

impl<'de> serde::Deserialize<'de> for Parsed {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ParsedVisitor).map(Parsed)
    }
}

struct ParsedVisitor;

impl<'de> serde::de::Visitor<'de> for ParsedVisitor {
    type Value = JsValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<JsValue, E> {
        Ok(JsValue::Bool(value))
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "JSON.parse rounds integers to the nearest double too"
    )]
    fn visit_i64<E>(self, value: i64) -> Result<JsValue, E> {
        Ok(JsValue::Number(value as f64))
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "JSON.parse rounds integers to the nearest double too"
    )]
    fn visit_u64<E>(self, value: u64) -> Result<JsValue, E> {
        Ok(JsValue::Number(value as f64))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<JsValue, E> {
        if value.is_finite() {
            Ok(JsValue::Number(value))
        } else {
            Err(E::custom("number overflows to Infinity"))
        }
    }

    fn visit_str<E>(self, value: &str) -> Result<JsValue, E> {
        Ok(JsValue::string(value))
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<JsValue, A::Error> {
        let mut items = Vec::new();
        while let Some(Parsed(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(JsValue::Array(items))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<JsValue, A::Error> {
        let mut object = JsObject::new();
        let mut first = true;
        while let Some(key) = map.next_key::<String>()? {
            // With serde_json's `arbitrary_precision` (enabled by navori-hooks, so present in the
            // `navori-rust` build through feature unification) every number arrives as this
            // single-entry map holding its source text.
            if first && key == ARBITRARY_PRECISION_TOKEN {
                let digits: String = map.next_value()?;
                return number_from_text(&digits);
            }
            first = false;
            if key == "__proto__" {
                return Err(serde::de::Error::custom("__proto__ key"));
            }
            let Parsed(value) = map.next_value()?;
            object.insert(key, value);
        }
        Ok(JsValue::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(entries: &[(&str, JsValue)]) -> JsValue {
        let mut o = JsObject::new();
        for (k, v) in entries {
            o.insert(*k, v.clone());
        }
        JsValue::Object(o)
    }

    #[test]
    fn parse_reads_numbers_like_json_parse_with_or_without_arbitrary_precision() {
        let numbers = parse("[1, -0, 1.5e3, 123456789012345678901234, 9007199254740993]");
        assert_eq!(
            numbers,
            Some(JsValue::Array(vec![
                JsValue::Number(1.0),
                JsValue::Number(-0.0),
                JsValue::Number(1500.0),
                JsValue::Number(1.234_567_890_123_456_9e23),
                JsValue::Number(9_007_199_254_740_992.0),
            ]))
        );
        assert_eq!(parse("[1e400]"), None);
        assert_eq!(
            parse(r#"{"b":1,"a":{"c":[]}}"#).and_then(|v| v.stringify(None)),
            Some(r#"{"b":1,"a":{"c":[]}}"#.to_owned())
        );
    }

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (1.0, "1"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (0.1, "0.1"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
        ];
        for (value, expected) in cases {
            assert_eq!(
                JsValue::Number(value).stringify(None).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn integer_keys_come_first_ascending() {
        let value = obj(&[
            ("b", JsValue::Null),
            ("10", JsValue::Null),
            ("a", JsValue::Null),
            ("2", JsValue::Null),
            ("01", JsValue::Null),
            ("4294967295", JsValue::Null),
        ]);
        assert_eq!(
            value.stringify(None).as_deref(),
            Some(r#"{"2":null,"10":null,"b":null,"a":null,"01":null,"4294967295":null}"#)
        );
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let mut o = JsObject::new();
        o.insert("a", JsValue::Number(1.0));
        o.insert("b", JsValue::Number(2.0));
        o.insert("a", JsValue::Number(3.0));
        assert_eq!(
            JsValue::Object(o).stringify(None).as_deref(),
            Some(r#"{"a":3,"b":2}"#)
        );
    }

    #[test]
    fn undefined_is_omitted_nulled_or_absent() {
        let value = obj(&[
            ("a", JsValue::Undefined),
            ("b", JsValue::Array(vec![JsValue::Undefined, JsValue::Null])),
        ]);
        assert_eq!(
            value.stringify(None).as_deref(),
            Some(r#"{"b":[null,null]}"#)
        );
        assert_eq!(JsValue::Undefined.stringify(None), None);
        assert_eq!(
            obj(&[("a", JsValue::Undefined)])
                .stringify(Some(2))
                .as_deref(),
            Some("{}")
        );
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        let text = JsString::from_units(vec![
            u16::from(b'a'),
            0xd800,
            0x2028,
            0x2029,
            0x7f,
            0x1f,
            u16::from(b'"'),
            0xd83d,
            0xde00,
        ]);
        assert_eq!(
            JsValue::String(text).stringify(None).as_deref(),
            Some("\"a\\ud800\u{2028}\u{2029}\u{7f}\\u001f\\\"\u{1f600}\"")
        );
    }

    #[test]
    fn indentation_matches_json_stringify_two_spaces() {
        let value = obj(&[
            (
                "a",
                JsValue::Array(vec![JsValue::Number(1.0), JsValue::Array(vec![])]),
            ),
            ("b", obj(&[])),
        ]);
        assert_eq!(
            value.stringify(Some(2)).as_deref(),
            Some("{\n  \"a\": [\n    1,\n    []\n  ],\n  \"b\": {}\n}")
        );
    }
}
