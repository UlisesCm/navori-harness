//! Port of `_partials/pii-egress.sh`: the shared core of the PII-egress rule (#1445).
//!
//! The mechanical half of "never send the user's personal data to an external service": look
//! for the configured `git user.email` and the entries of `NAVORI_PERSONAL_IDS` (at least four
//! characters each) in the text of an external request, case-insensitively, plus their URL
//! encodings (`@` to `%40`, `+` to `%2B`, space to `%20` or `+`).
//!
//! # The identifier never leaves this module
//!
//! It enters as a [`Secret`] (bytes, redacted `Debug`, no `Display`) or as an [`EmailRead`], and
//! leaves only as a [`Code`], an enum with no data. There is no regex built from it (a `Regex`
//! prints its pattern in `Debug`) and no error that carries bytes is ever formatted: the byte
//! handling below has no `FromUtf8Error` to leak. The three guards against a panic that would
//! print a slice are the `deny` lints at the top of this file.
//!
//! # Failure contract
//!
//! [`Code::Unverified`] is every status other than 0, 41 and 42 of the shell's subshell: the
//! caller denies ("could not verify"). It is also what an unreadable email, an identifier
//! `grep` could not even be launched with (one argument longer than the kernel's
//! `MAX_ARG_STRLEN`) and, in `guard_destructive::pii_bash`, a panic of the lane become.
//!
//! # Matching
//!
//! `grep -qiF -e ID` of the partial, reproduced byte for byte under [`Locale::C`] (ASCII folding
//! over bytes) and [`Locale::GnuUtf8`] (the measured, asymmetric table of [`super::case_fold`]).
//! A pattern byte that is not valid UTF-8 matches that very byte; a match starts at a character
//! boundary of the text and may end inside a character (measured with GNU grep 3.12). BSD
//! `grep` has not been measured: [`Folding::for_locale`] answers `None` for [`Locale::Utf8`] and
//! the caller must not run this rule there.
#![deny(clippy::string_slice, clippy::indexing_slicing)]

use std::collections::HashMap;
use std::fmt;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use super::Locale;
use super::case_fold::COUNTERPARTS;

/// Longest single argument `execve` accepts on Linux (`MAX_ARG_STRLEN`, NUL included): `grep`
/// cannot be launched with a longer identifier, and the shell then answers "could not verify".
const GREP_ARG_MAX: usize = 131_072;

/// Bytes of a personal identifier. `Debug` is redacted; there is no `Display` or `Serialize`.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(Vec<u8>);

impl Secret {
    /// Wrap the bytes of an identifier.
    #[must_use]
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self(bytes.into())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// What `git config user.email` yielded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmailRead {
    /// Empty stdout, or `git` could not be launched.
    Absent,
    /// The value, with its trailing newlines removed.
    Present(Secret),
    /// Stdout with a NUL byte: bash would drop it with a warning and `git config` cannot store
    /// one. Not reachable from `git`; it denies.
    Unreadable,
}

/// Run `git` (already built as `git config user.email`, with its working directory and
/// environment) as `$(git config user.email 2>/dev/null || true)` does: stdin and stderr are
/// null, the exit status is ignored and the trailing newlines of stdout are dropped. Nothing
/// about a failure is formatted.
pub fn read_user_email(git: &mut Command) -> EmailRead {
    let Ok(output) = git
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    else {
        return EmailRead::Absent;
    };
    let mut bytes = output.stdout;
    while bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.contains(&0) {
        EmailRead::Unreadable
    } else if bytes.is_empty() {
        EmailRead::Absent
    } else {
        EmailRead::Present(Secret(bytes))
    }
}

/// The exit status of the shell's verdict subshell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// 0: nothing to report.
    Clean,
    /// 41: a hit on `git config user.email`.
    GitEmail,
    /// 42: a hit on `NAVORI_PERSONAL_IDS`.
    PersonalIds,
    /// Any other status: the check could not complete.
    Unverified,
}

/// The two lines `navori_pii_finish` writes to stderr for a blocking code (never the
/// identifier or the command). Empty for [`Code::Clean`].
#[must_use]
pub fn stderr(code: Code) -> &'static str {
    match code {
        Code::Clean => "",
        Code::GitEmail => concat!(
            "[navori] BLOCKED by pii-egress-guard: a request to an external host carries a personal identifier (source: the configured user email).\n",
            "[navori] Rule: never send the user's personal data to external services. Use a generic identifier instead, e.g. \"User-Agent: navori-agent/1.0\" or example@example.com.\n",
        ),
        Code::PersonalIds => concat!(
            "[navori] BLOCKED by pii-egress-guard: a request to an external host carries a personal identifier (source: NAVORI_PERSONAL_IDS).\n",
            "[navori] Rule: never send the user's personal data to external services. Use a generic identifier instead, e.g. \"User-Agent: navori-agent/1.0\" or example@example.com.\n",
        ),
        Code::Unverified => concat!(
            "[navori] BLOCKED by pii-egress-guard: could not verify that this network request is free of personal identifiers; split it, or ask the user to run it.\n",
            "[navori] Rule: never send the user's personal data to external services. Use a generic identifier instead, e.g. \"User-Agent: navori-agent/1.0\" or example@example.com.\n",
        ),
    }
}

/// How `grep -i` folds case in a locale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Folding(Mode);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `LC_ALL=C`: bytes, ASCII letters only.
    Ascii,
    /// glibc UTF-8: the measured table of [`COUNTERPARTS`].
    Table,
}

impl Folding {
    /// The folding of `locale`, or `None` when it has not been measured (BSD UTF-8): the caller
    /// must then leave the rule to the shell.
    #[must_use]
    pub fn for_locale(locale: Locale) -> Option<Self> {
        match locale {
            Locale::C => Some(Self(Mode::Ascii)),
            Locale::GnuUtf8 => Some(Self(Mode::Table)),
            Locale::Utf8 => None,
        }
    }
}

/// A unit of a pattern: a valid UTF-8 character, or a byte that is not part of one.
#[derive(Debug, Clone, Copy)]
enum Unit {
    Char(char),
    Byte(u8),
}

/// The unit that starts at byte `at` and its length; `None` at the end. A byte that is not
/// part of a valid sequence is a unit of its own, as bash counts and `grep` matches it.
fn unit_at(bytes: &[u8], at: usize) -> Option<(Unit, usize)> {
    let rest = bytes.get(at..)?;
    let first = *rest.first()?;
    let window = rest.get(..rest.len().min(4)).unwrap_or(rest);
    let valid = match std::str::from_utf8(window) {
        Ok(_) => window,
        Err(error) => window.get(..error.valid_up_to()).unwrap_or_default(),
    };
    match std::str::from_utf8(valid)
        .ok()
        .and_then(|text| text.chars().next())
    {
        Some(c) => Some((Unit::Char(c), c.len_utf8())),
        None => Some((Unit::Byte(first), 1)),
    }
}

fn units(bytes: &[u8]) -> Vec<Unit> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((unit, len)) = unit_at(bytes, at) {
        out.push(unit);
        at += len;
    }
    out
}

/// `${#v}`: characters, or bytes under `LC_ALL=C`.
fn length(bytes: &[u8], locale: Locale) -> usize {
    if locale == Locale::C {
        bytes.len()
    } else {
        units(bytes).len()
    }
}

/// `v="${v#"${v%%[![:space:]]*}"}"` then the trailing counterpart, with the locale's class.
fn trim_space(bytes: &[u8], locale: Locale) -> &[u8] {
    let mut first = None;
    let mut end = 0;
    let mut at = 0;
    while let Some((unit, len)) = unit_at(bytes, at) {
        if !matches!(unit, Unit::Char(c) if locale.whitespace(c)) {
            first.get_or_insert(at);
            end = at + len;
        }
        at += len;
    }
    first
        .and_then(|start| bytes.get(start..end))
        .unwrap_or_default()
}

/// Whether a pattern character `p` matches the text character `t`: the measured relation, which
/// is not symmetric.
fn folds(p: char, t: char) -> bool {
    p == t
        || COUNTERPARTS
            .binary_search_by_key(&p, |&(key, _)| key)
            .ok()
            .and_then(|i| COUNTERPARTS.get(i))
            .is_some_and(|(_, set)| set.contains(t))
}

/// A representative per connected class of [`COUNTERPARTS`]: if `p` matches `t`, both share it.
/// It lets a linear scan find a superset of the matches, which `matches_at` then confirms.
fn canon(c: char) -> char {
    static CLASSES: LazyLock<HashMap<char, char>> = LazyLock::new(|| {
        let mut index: HashMap<char, usize> = HashMap::new();
        let mut chars: Vec<char> = Vec::new();
        let mut edges: Vec<(usize, usize)> = Vec::new();
        let mut slot = |c: char, chars: &mut Vec<char>| {
            *index.entry(c).or_insert_with(|| {
                chars.push(c);
                chars.len() - 1
            })
        };
        for (pattern, set) in &COUNTERPARTS {
            let from = slot(*pattern, &mut chars);
            for t in set.chars() {
                edges.push((from, slot(t, &mut chars)));
            }
        }
        let mut parent: Vec<usize> = (0..chars.len()).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while let Some(&up) = parent.get(i) {
                if up == i {
                    break;
                }
                let grand = parent.get(up).copied().unwrap_or(up);
                if let Some(entry) = parent.get_mut(i) {
                    *entry = grand;
                }
                i = grand;
            }
            i
        }
        for (a, b) in edges {
            let (ra, rb) = (root(&mut parent, a), root(&mut parent, b));
            if let Some(entry) = parent.get_mut(ra.max(rb)) {
                *entry = ra.min(rb);
            }
        }
        let mut least: HashMap<usize, char> = HashMap::new();
        for (i, &c) in chars.iter().enumerate() {
            let r = root(&mut parent, i);
            least
                .entry(r)
                .and_modify(|best| *best = (*best).min(c))
                .or_insert(c);
        }
        let mut classes = HashMap::new();
        for (i, &c) in chars.iter().enumerate() {
            let r = root(&mut parent, i);
            classes.insert(c, least.get(&r).copied().unwrap_or(c));
        }
        classes
    });
    CLASSES.get(&c).copied().unwrap_or(c)
}

fn kmp_failure(pattern: &[u32]) -> Vec<usize> {
    let mut failure = vec![0; pattern.len()];
    let mut k = 0;
    for i in 1..pattern.len() {
        let current = pattern.get(i);
        while k > 0 && pattern.get(k) != current {
            k = failure.get(k - 1).copied().unwrap_or(0);
        }
        if pattern.get(k) == current {
            k += 1;
        }
        if let Some(entry) = failure.get_mut(i) {
            *entry = k;
        }
    }
    failure
}

/// Knuth-Morris-Pratt over `text`: calls `confirm` with the index of the item where each match
/// of the non-empty `pattern` starts, and stops at the first `true`. Linear in both lengths.
fn kmp_any(
    pattern: &[u32],
    text: impl Iterator<Item = u32>,
    mut confirm: impl FnMut(usize) -> bool,
) -> bool {
    let failure = kmp_failure(pattern);
    let mut k = 0;
    for (i, item) in text.enumerate() {
        while k > 0 && pattern.get(k) != Some(&item) {
            k = failure.get(k - 1).copied().unwrap_or(0);
        }
        if pattern.get(k) == Some(&item) {
            k += 1;
        }
        if k == pattern.len() {
            if confirm(i + 1 - k) {
                return true;
            }
            k = failure.get(k - 1).copied().unwrap_or(0);
        }
    }
    false
}

/// Exact check of the pattern at byte `at` of the text (a character boundary).
fn matches_at(units: &[Unit], text: &str, at: usize) -> bool {
    let bytes = text.as_bytes();
    let mut pos = at;
    for unit in units {
        match *unit {
            Unit::Byte(b) => {
                if bytes.get(pos) != Some(&b) {
                    return false;
                }
                pos += 1;
            }
            Unit::Char(p) => {
                let Some(t) = text.get(pos..).and_then(|rest| rest.chars().next()) else {
                    return false;
                };
                if !folds(p, t) {
                    return false;
                }
                pos += t.len_utf8();
            }
        }
    }
    true
}

// TODO(perf): the confirmation of a candidate re-reads the whole pattern, so an identifier of
// ~100k characters made of case-folding oddities (U+1C80..U+1C88) against an adversarial text is
// quadratic. Only the user's own identifiers reach it; index the class of each unit if it ever
// matters.
fn find_table(units: &[Unit], text: &str) -> bool {
    let head: Vec<u32> = units
        .iter()
        .map_while(|unit| match unit {
            Unit::Char(c) => Some(u32::from(canon(*c))),
            Unit::Byte(_) => None,
        })
        .collect();
    if head.is_empty() {
        return text
            .char_indices()
            .any(|(at, _)| matches_at(units, text, at));
    }
    let starts: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
    kmp_any(&head, text.chars().map(|c| u32::from(canon(c))), |begin| {
        starts
            .get(begin)
            .is_some_and(|&at| matches_at(units, text, at))
    })
}

fn find_ascii(pattern: &[u8], text: &[u8]) -> bool {
    let key = |b: &u8| u32::from(b.to_ascii_lowercase());
    let pattern: Vec<u32> = pattern.iter().map(key).collect();
    kmp_any(&pattern, text.iter().map(key), |_| true)
}

/// `grep` could not complete: the shell's "could not verify".
struct Unverifiable;

/// `_pii_has`: `grep -qiF -e PATTERN <<<TEXT`.
fn has(pattern: &[u8], text: &str, folding: Folding) -> Result<bool, Unverifiable> {
    if pattern.len() >= GREP_ARG_MAX {
        return Err(Unverifiable);
    }
    if pattern.is_empty() {
        return Ok(true);
    }
    Ok(match folding.0 {
        Mode::Ascii => find_ascii(pattern, text.as_bytes()),
        Mode::Table => find_table(&units(pattern), text),
    })
}

/// `_pii_hits`: the identifier, or one of its encoded forms, in the text.
fn hits(id: &[u8], text: &str, folding: Folding) -> Result<bool, Unverifiable> {
    if has(id, text, folding)? {
        return Ok(true);
    }
    let mut percent = Vec::with_capacity(id.len());
    let mut plus = Vec::with_capacity(id.len());
    for &b in id {
        match b {
            b'@' => percent.extend_from_slice(b"%40"),
            b'+' => percent.extend_from_slice(b"%2B"),
            b' ' => percent.extend_from_slice(b"%20"),
            other => percent.push(other),
        }
        plus.push(if b == b' ' { b'+' } else { b });
    }
    for form in [percent, plus] {
        if form != id && has(&form, text, folding)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `navori_pii_verdict`: resolve the identifiers and look for them in `texts`.
///
/// `email` runs first and always (the shell forks `git config` here, once, and only for a
/// request that already is external): the caller keeps it lazy. The protocol string is the
/// shell's, built over bytes: one `g:EMAIL` line, then one `e:ID` per trimmed entry of the
/// comma-separated `ids`, each of at least four characters.
#[must_use]
pub fn verdict(
    texts: &str,
    email: impl FnOnce() -> EmailRead,
    ids: Option<&Secret>,
    locale: Locale,
    folding: &Folding,
) -> Code {
    let mut protocol: Vec<u8> = Vec::new();
    match email() {
        EmailRead::Unreadable => return Code::Unverified,
        EmailRead::Present(Secret(bytes)) if length(&bytes, locale) >= 4 => {
            protocol.extend_from_slice(b"g:");
            protocol.extend_from_slice(&bytes);
            protocol.push(b'\n');
        }
        EmailRead::Present(_) | EmailRead::Absent => {}
    }
    for entry in ids
        .iter()
        .flat_map(|ids| ids.0.split(|&b| matches!(b, b',' | b'\n')))
    {
        let value = trim_space(entry, locale);
        if length(value, locale) >= 4 {
            protocol.extend_from_slice(b"e:");
            protocol.extend_from_slice(value);
            protocol.push(b'\n');
        }
    }
    for line in protocol
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
    {
        let (source, value) = match line.iter().position(|&b| b == b':') {
            Some(colon) => (
                line.get(..colon).unwrap_or_default(),
                line.get(colon + 1..).unwrap_or_default(),
            ),
            None => (line, line),
        };
        match hits(value, texts, *folding) {
            Err(Unverifiable) => return Code::Unverified,
            Ok(true) if source == b"g" => return Code::GitEmail,
            Ok(true) => return Code::PersonalIds,
            Ok(false) => {}
        }
    }
    Code::Clean
}

/// The text before the first `separator`.
fn before(text: &str, separator: char) -> &str {
    text.split(separator).next().unwrap_or_default()
}

/// `_pii_local`: whether `host[:port]` (a URL's authority and what follows) is local. It is
/// case-sensitive: `LOCALHOST` is external.
#[must_use]
pub fn is_local(host: &str) -> bool {
    // Authority only: cut the path and query first, so an `@` in a query is not userinfo.
    let authority = before(before(before(host, '/'), '?'), '#');
    let authority = authority.rsplit('@').next().unwrap_or_default();
    if authority.is_empty() || authority == "[::1]" || authority.starts_with("[::1]:") {
        return true;
    }
    let name = authority.split(':').next().unwrap_or_default();
    if name == "localhost" || name.ends_with(".localhost") || name == "0.0.0.0" {
        return true;
    }
    if name.chars().any(|c| !(c.is_ascii_digit() || c == '.')) {
        return false;
    }
    let after = |prefix: &str| name.strip_prefix(prefix);
    after("127.").is_some()
        || after("10.").is_some()
        || after("192.168.").is_some()
        || ["172.1", "172.2", "172.3"].iter().any(|prefix| {
            let Some(rest) = after(prefix) else {
                return false;
            };
            let mut chars = rest.chars();
            let second = chars.next();
            chars.next() == Some('.')
                && match *prefix {
                    "172.1" => matches!(second, Some('6'..='9')),
                    "172.2" => matches!(second, Some('0'..='9')),
                    _ => matches!(second, Some('0' | '1')),
                }
        })
}
