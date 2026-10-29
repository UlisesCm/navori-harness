//! String helpers with the exact semantics of the JS regexes `lib/spec` uses.
//!
//! The TS patterns rely on JS details the `regex` crate does not share: `\s` is the ECMAScript
//! whitespace set (with U+FEFF, without U+0085), `.` stops at `\n`, `\r`, U+2028 and U+2029,
//! `\d` and `\b` are ASCII-only, and some patterns use a lookahead. Each pattern is therefore
//! written out by hand here or at its call site, citing the JS source it reproduces.

use crate::integrity::is_js_whitespace;

/// A character JS `.` does not match (ECMAScript LineTerminator).
#[must_use]
pub const fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JS `\s` / `String.prototype.trim` set.
#[must_use]
pub const fn is_space(ch: char) -> bool {
    is_js_whitespace(ch)
}

/// `text.trim()`.
#[must_use]
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.replace(/\s+/g, " ")`.
#[must_use]
pub fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for ch in text.chars() {
        if is_space(ch) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

/// `text.replace(/\s+/g, " ").trim()`.
#[must_use]
pub fn squash(text: &str) -> String {
    trim(&collapse_spaces(text)).to_owned()
}

/// Length of the run of ASCII digits at the start of `text`.
#[must_use]
pub fn digits_len(text: &str) -> usize {
    text.bytes().take_while(u8::is_ascii_digit).count()
}

/// JS `\w` (ASCII, no `u` flag), for `\b`.
const fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Byte offsets where `\b<word>` matches, `word` starting with a word character: occurrences of
/// `word` not preceded by a word character.
pub fn word_starts<'a>(text: &'a str, word: &'a str) -> impl Iterator<Item = usize> + 'a {
    text.match_indices(word)
        .map(|(at, _)| at)
        .filter(move |&at| at == 0 || !is_word_byte(text.as_bytes()[at - 1]))
}

/// Case-insensitive ASCII `text.startsWith(prefix)`, as a JS `/i` regex without `u` compares.
#[must_use]
pub fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Byte offset of the first case-insensitive ASCII occurrence of `needle` (ASCII).
#[must_use]
pub fn find_ignore_case(text: &str, needle: &str) -> Option<usize> {
    let (hay, pat) = (text.as_bytes(), needle.as_bytes());
    if pat.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - pat.len()).find(|&at| hay[at..at + pat.len()].eq_ignore_ascii_case(pat))
}

/// The first `limit` UTF-16 code units of `text` (`text.slice(0, limit)`), or `None` when the cut
/// would split a surrogate pair: JS would keep a lone surrogate, which `String` cannot hold.
#[must_use]
pub fn utf16_prefix(text: &str, limit: usize) -> Option<&str> {
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > limit {
            return (units == limit).then_some(&text[..at]);
        }
        units += width;
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_and_trim_follow_the_js_whitespace_set() {
        assert_eq!(squash("\u{feff} a \u{2028}\t b \u{a0}"), "a b");
        // U+0085 is not JS whitespace.
        assert_eq!(squash("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn word_starts_needs_a_non_word_before() {
        let found: Vec<usize> = word_starts("pretest: x test: y", "test:").collect();
        assert_eq!(found, vec![11]);
    }

    #[test]
    fn utf16_prefix_refuses_to_split_a_pair() {
        assert_eq!(utf16_prefix("ab😀", 3), None);
        assert_eq!(utf16_prefix("ab😀", 4), Some("ab😀"));
        assert_eq!(utf16_prefix("ab😀c", 2), Some("ab"));
        assert_eq!(utf16_prefix("ab", 60), Some("ab"));
    }
}
