//! Building blocks to spell JS (non-`u`) regex classes with the `regex` crate, whose `\s`, `\d`
//! and `.` are Unicode-aware and differ from ECMAScript's.

/// JS `\s` (WhiteSpace plus LineTerminator), as a class body without brackets.
pub const WS_BODY: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// JS `\s`.
#[must_use]
pub fn ws() -> String {
    format!("[{WS_BODY}]")
}

/// JS `\S`.
#[must_use]
pub fn non_ws() -> String {
    format!("[^{WS_BODY}]")
}

/// JS `.` without the `s` flag: anything but a line terminator.
pub const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

/// A JS `/i` literal of ASCII text: each ASCII letter becomes `[xX]`, everything else is escaped.
/// JS non-`u` case folding never maps a non-ASCII character onto ASCII, so this is exact.
#[must_use]
pub fn ascii_case_insensitive(literal: &str) -> String {
    literal
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}
