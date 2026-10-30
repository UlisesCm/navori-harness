//! Port of `lib/plan/expected.ts` (`parseExpected`).
//!
//! `matches: /pattern/flags` is validated by compiling a JS `RegExp`, whose syntax Rust cannot
//! reproduce; a well-shaped `matches:` is [`Expected::NeedsJs`] and the caller delegates to the TS.

use std::sync::LazyLock;

use regex::Regex;

/// A parsed `<expected>` clause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    Free,
    Exit(u8),
    Contains(String),
    /// A `matches:` with the right shape and distinct flags; only JS can tell if it compiles.
    NeedsJs,
    Invalid(&'static str),
}

/// JS `.` (no `s` flag): anything but a line terminator.
const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

static EXIT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^exit (0|[1-9][0-9]{0,2})$").ok());
static EXIT_LIKE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^exit [-+]?[0-9]+$").ok());
static CONTAINS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!("^contains: ({DOT}+)$")).ok());
static MATCHES: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!("^matches: /({DOT}+)/([imsu]*)$")).ok());

const EXIT_RANGE: &str = "exit code must be an integer from 0 to 255 without leading zeros";
const CONTAINS_LINE: &str = "contains: requires one nonempty literal line";
const MATCHES_FORM: &str = "matches: requires a valid /pattern/ with only i, m, s and u flags";

/// `parseExpected`. `None` only if a pattern failed to compile, which the tests rule out.
#[must_use]
pub fn parse_expected(text: &str) -> Option<Expected> {
    let exit = EXIT.as_ref()?.captures(text).and_then(|c| c.get(1));
    if let Some(Ok(code)) = exit.map(|c| c.as_str().parse::<u8>()) {
        return Some(Expected::Exit(code));
    }
    if EXIT_LIKE.as_ref()?.is_match(text) {
        return Some(Expected::Invalid(EXIT_RANGE));
    }
    if let Some(literal) = CONTAINS.as_ref()?.captures(text).and_then(|c| c.get(1)) {
        return Some(Expected::Contains(literal.as_str().to_owned()));
    }
    if text.starts_with("contains:") {
        return Some(Expected::Invalid(CONTAINS_LINE));
    }
    if text.starts_with("matches:") {
        let flags = MATCHES.as_ref()?.captures(text).and_then(|c| c.get(2));
        let distinct = flags.is_some_and(|f| {
            let f = f.as_str();
            f.char_indices().all(|(i, c)| !f[..i].contains(c))
        });
        return Some(if distinct {
            Expected::NeedsJs
        } else {
            Expected::Invalid(MATCHES_FORM)
        });
    }
    Some(Expected::Free)
}
