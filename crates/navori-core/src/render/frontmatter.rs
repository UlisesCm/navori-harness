//! YAML-frontmatter splitting and field reads: literal port of
//! `packages/cli/src/lib/render/frontmatter.ts` (spec 0058 T14).
//!
//! The TS regexes use JS line semantics: in multiline mode `^` also starts after `\r`, U+2028 and
//! U+2029, and `.` stops at those characters. The `regex` crate only knows `\n`, so those rules
//! are written out by hand here instead of being left to a pattern that would differ silently.

use std::sync::LazyLock;

use regex::Regex;

use crate::integrity::is_js_whitespace;

static FRONTMATTER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\A---\r?\n((?s:.)*?)\r?\n---[ \t]*(?:\r?\n|\z)").ok());

/// JS line terminators (what `.` never matches and multiline `^`/`$` split on).
const fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Byte offsets where a JS multiline `^` matches: 0 and after every line terminator.
fn js_line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, ch)| is_js_line_terminator(*ch))
            .map(|(at, ch)| at + ch.len_utf8()),
    )
}

/// `[A-Za-z_][A-Za-z0-9_.-]*` at the start of `text`: the key's byte length.
fn key_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
    {
        return None;
    }
    Some(
        bytes
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
            .count(),
    )
}

/// `FM_KEY_LINE`: `/^[ \t]*[A-Za-z_][A-Za-z0-9_.-]*:/m`.
fn has_key_line(frontmatter: &str) -> bool {
    js_line_starts(frontmatter).any(|start| {
        let rest = frontmatter[start..].trim_start_matches([' ', '\t']);
        key_len(rest).is_some_and(|len| rest[len..].starts_with(':'))
    })
}

/// `SplitResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split<'a> {
    /// Raw YAML between the fences, empty when there is none.
    pub frontmatter: &'a str,
    /// Everything after the closing fence, or the whole input.
    pub body: &'a str,
}

/// `splitFrontmatter`.
#[must_use]
pub fn split_frontmatter(raw: &str) -> Split<'_> {
    let none = Split {
        frontmatter: "",
        body: raw,
    };
    let Some(captures) = FRONTMATTER.as_ref().and_then(|re| re.captures(raw)) else {
        return none;
    };
    let (Some(whole), Some(inner)) = (captures.get(0), captures.get(1)) else {
        return none;
    };
    if !has_key_line(inner.as_str()) {
        return none;
    }
    Split {
        frontmatter: inner.as_str(),
        body: &raw[whole.end()..],
    }
}

/// `FIELD_RE` (`/^([a-zA-Z_][a-zA-Z0-9_.-]*):\s*(.*)$/`) on one line: `(key, value)`.
fn field(line: &str) -> Option<(&str, &str)> {
    let len = key_len(line)?;
    let rest = line[len..].strip_prefix(':')?;
    let value = rest.trim_start_matches(is_js_whitespace);
    if value.contains(is_js_line_terminator) {
        return None;
    }
    Some((&line[..len], value))
}

/// The ordered `Record<string, string>` that `parseFrontmatterFields` builds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fields(Vec<(String, String)>);

impl Fields {
    fn set(&mut self, key: &str, value: String) {
        // Assigning a string to `__proto__` is a no-op in JS.
        if key == "__proto__" {
            return;
        }
        match self.0.iter_mut().find(|(existing, _)| existing == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    /// `fields[key]` for an own key.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find_map(|(existing, value)| (existing == key).then_some(value.as_str()))
    }

    /// `Object.entries(fields)`.
    #[must_use]
    pub fn entries(&self) -> &[(String, String)] {
        &self.0
    }
}

/// Members every JS object inherits, which `key in fields` reports as present.
const OBJECT_PROTOTYPE: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `frontmatter.split(/\r?\n/)`.
fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// `parseFrontmatterFields`: last write wins; a key without inline value absorbs the indented
/// lines that follow, prefixed with `\n`.
#[must_use]
pub fn parse_frontmatter_fields(frontmatter: &str) -> Fields {
    let mut out = Fields::default();
    let mut current: Option<(String, Vec<String>, bool)> = None;
    let flush = |out: &mut Fields, current: &Option<(String, Vec<String>, bool)>| {
        if let Some((key, lines, is_block)) = current {
            let joined = lines.join("\n");
            out.set(
                key,
                if *is_block {
                    format!("\n{joined}")
                } else {
                    joined
                },
            );
        }
    };
    for line in split_lines(frontmatter) {
        if let Some((key, value)) = field(line) {
            flush(&mut out, &current);
            let inline = js_trim(value);
            let is_block = inline.is_empty();
            let lines = if is_block {
                Vec::new()
            } else {
                vec![inline.to_owned()]
            };
            current = Some((key.to_owned(), lines, is_block));
        } else if let Some((_, lines, _)) = current.as_mut()
            && (line.starts_with(' ') || line.starts_with('\t'))
        {
            lines.push(line.to_owned());
        }
    }
    flush(&mut out, &current);
    out
}

/// `getFrontmatterField`: the inline value of the first `key:` line, unquoted.
#[must_use]
pub fn get_frontmatter_field(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    js_line_starts(frontmatter).find_map(|start| {
        let rest = frontmatter[start..].strip_prefix(prefix.as_str())?;
        let rest = rest.trim_start_matches([' ', '\t']);
        let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
        Some(unquote_inline_scalar(js_trim(&rest[..end])))
    })
}

fn unquote_inline_scalar(value: &str) -> String {
    if value.encode_utf16().count() < 2 {
        return value.to_owned();
    }
    if value.starts_with('\'') && value.ends_with('\'') {
        return value[1..value.len() - 1].replace("''", "'");
    }
    if value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\\'
                && let Some(next) = chars.peek().copied()
                && matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't')
            {
                chars.next();
                out.push(match next {
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
            } else {
                out.push(ch);
            }
        }
        return out;
    }
    value.to_owned()
}

/// `formatFrontmatterField`: quotes a plain scalar YAML would misparse.
#[must_use]
pub fn format_frontmatter_field(key: &str, value: &str) -> String {
    format_frontmatter_field_raw(key, &quote_if_unsafe_plain(value))
}

/// `formatFrontmatterFieldRaw`.
#[must_use]
pub fn format_frontmatter_field_raw(key: &str, value: &str) -> String {
    if value.starts_with('\n') {
        format!("{key}:{value}")
    } else {
        format!("{key}: {value}")
    }
}

fn quote_if_unsafe_plain(value: &str) -> String {
    let non_plain =
        value.starts_with(['\'', '"', '[', '{', '|', '>', '&', '*', '!', '%', '@', '`']);
    let unsafe_plain = value.contains(": ") || value.contains(" #") || value.ends_with(':');
    if value.starts_with('\n') || non_plain || !unsafe_plain {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "''"))
}

/// `stripFrontmatter`: the trimmed body.
#[must_use]
pub fn strip_frontmatter(raw: &str) -> &str {
    js_trim(split_frontmatter(raw).body)
}

/// `getFrontmatterMapField`: a scalar inside a nested map field.
#[must_use]
pub fn get_frontmatter_map_field(
    frontmatter: &str,
    map_key: &str,
    field_key: &str,
) -> Option<String> {
    let fields = parse_frontmatter_fields(frontmatter);
    let block = fields.get(map_key)?;
    block.split('\n').find_map(|line| {
        let trimmed = js_trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let colon = trimmed.find(':')?;
        (js_trim(&trimmed[..colon]) == field_key).then(|| js_trim(&trimmed[colon + 1..]).to_owned())
    })
}

/// `removeFrontmatterField`.
#[must_use]
pub fn remove_frontmatter_field(raw: &str, key: &str) -> String {
    let split = split_frontmatter(raw);
    if split.frontmatter.is_empty() {
        return raw.to_owned();
    }
    let fields = parse_frontmatter_fields(split.frontmatter);
    if fields.get(key).is_none() && !OBJECT_PROTOTYPE.contains(&key) {
        return raw.to_owned();
    }
    let rebuilt = fields
        .entries()
        .iter()
        .filter(|(k, _)| k != key)
        .map(|(k, v)| format_frontmatter_field(k, v))
        .collect::<Vec<_>>()
        .join("\n");
    format!("---\n{rebuilt}\n---\n{}", split.body)
}

/// `splitToolList`: commas at parenthesis depth zero; entries trimmed, empties kept.
#[must_use]
pub fn split_tool_list(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth: usize = 0;
    let mut start = 0;
    for (at, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(js_trim(&value[start..at]).to_owned());
                start = at + 1;
            }
            _ => {}
        }
    }
    out.push(js_trim(&value[start..]).to_owned());
    out
}
