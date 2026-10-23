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
fn number_to_js(number: f64) -> String {
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
