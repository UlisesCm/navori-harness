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
//! leaves only as a [`Code`], an enum with no data (and as the argument of the host's `grep`, as
//! in the shell). There is no regex built from it (a `Regex` prints its pattern in `Debug`) and
//! no error that carries bytes is ever formatted: the byte handling below has no
//! `FromUtf8Error` to leak. The guards against a panic that would print a slice are the two
//! `deny` lints at the top of this file.
//!
//! # Failure contract
//!
//! [`Code::Unverified`] is every status other than 0, 41 and 42 of the shell's subshell: the
//! caller denies ("could not verify"). It is also what an unreadable email, a `grep` that cannot
//! answer (see [`HostGrep`]) and, in `guard_destructive::pii_bash`, a panic of the lane become.
//!
//! # Matching
//!
//! This module folds nothing. `_pii_has` is `grep -qiF -e ID <<<TEXT`, and so is [`HostGrep`]:
//! the same program, arguments, stdin and environment, in the same order and as many times as the
//! shell runs it (no shortcut for an identifier equal to its encoded form). What `grep -i`
//! matches is whatever the host's `grep` and locale data say, by construction, on any glibc and
//! with any `grep`. [`Matcher`] is the seam: the lane asks "is this needle in this text?".
//! Only [`Locale::C`] and [`Locale::GnuUtf8`] are measured (the lane's own text handling has
//! not been run under bash 3.2 or BSD tools): the caller must not run the rule under
//! [`Locale::Utf8`].
#![deny(clippy::string_slice, clippy::indexing_slicing)]

use std::ffi::OsString;
use std::fmt;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::Locale;
use super::subcommand::{self, Call, Capture, Input};

/// Total wall time the `grep` calls of one evaluation of the lane may take. The shell has no
/// bound (the host kills the hook at 10 s); this one is deliberately tighter and fails closed.
const GREP_BUDGET: Duration = Duration::from_secs(4);

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

/// `grep` could not answer: the shell's "could not verify" (`exit 1` of `_pii_has`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unverifiable;

/// `_pii_has`: is `needle` in `text`, ignoring case? The needle is an identifier, so no
/// implementor derives `Debug`.
pub trait Matcher {
    /// Whether `text` holds `needle` (`grep -qiF -e NEEDLE <<<TEXT`).
    ///
    /// # Errors
    /// [`Unverifiable`] when the answer could not be obtained.
    fn has(&mut self, needle: &[u8], text: &str) -> Result<bool, Unverifiable>;
}

/// The host's `grep`, called as `_pii_has` calls it: `grep -qiF -e NEEDLE` with the text and a
/// newline (the here-string's) on stdin, output discarded, in the shell's working directory and
/// environment ([`subcommand::child_env`]).
///
/// Status 0 is a match and 1 is none. Anything else is [`Unverifiable`]: no program, a spawn
/// failure (`E2BIG` included), status 2 or more, a signal, or the cumulative bound of four
/// seconds spent (the child is then killed and waited for). `grep` is launched only inside
/// [`Matcher::has`], so an evaluation with nothing to look for never starts one.
pub struct HostGrep<'a> {
    program: Option<&'a Path>,
    cwd: &'a Path,
    env: &'a [(OsString, OsString)],
    budget: Duration,
}

impl<'a> HostGrep<'a> {
    /// `program` is the `grep` the caller resolved (`None`: it did not resolve), `cwd` the
    /// shell's working directory and `env` the hook's environment.
    #[must_use]
    pub fn new(program: Option<&'a Path>, cwd: &'a Path, env: &'a [(OsString, OsString)]) -> Self {
        Self {
            program,
            cwd,
            env,
            budget: GREP_BUDGET,
        }
    }
}

impl Matcher for HostGrep<'_> {
    fn has(&mut self, needle: &[u8], text: &str) -> Result<bool, Unverifiable> {
        let program = self.program.ok_or(Unverifiable)?;
        if self.budget.is_zero() {
            return Err(Unverifiable);
        }
        let mut stdin = Vec::with_capacity(text.len() + 1);
        stdin.extend_from_slice(text.as_bytes());
        stdin.push(b'\n');
        let args = [
            OsString::from("-qiF"),
            OsString::from("-e"),
            OsString::from_vec(needle.to_vec()),
        ];
        let env = subcommand::child_env(self.env, self.cwd.as_os_str(), None, program, &[]);
        let started = Instant::now();
        let finished = subcommand::run(&Call {
            program,
            args: &args,
            cwd: self.cwd,
            env: &env,
            input: Input::Bytes(&stdin),
            capture: Capture::Discard,
            timeout: Some(self.budget),
        });
        self.budget = self.budget.saturating_sub(started.elapsed());
        match finished {
            Ok(done) if !done.timed_out && done.status == 0 => Ok(true),
            Ok(done) if !done.timed_out && done.status == 1 => Ok(false),
            _ => Err(Unverifiable),
        }
    }
}

/// A unit of a pattern: a valid UTF-8 character, or a byte that is not part of one.
#[derive(Debug, Clone, Copy)]
enum Unit {
    Char(char),
    Byte,
}

/// The unit that starts at byte `at` and its length; `None` at the end. A byte that is not
/// part of a valid sequence is a unit of its own, as bash counts it.
fn unit_at(bytes: &[u8], at: usize) -> Option<(Unit, usize)> {
    let rest = bytes.get(at..)?;
    rest.first()?;
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
        None => Some((Unit::Byte, 1)),
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

/// `_pii_hits`: the identifier, or one of its encoded forms, in the text. Three calls at most,
/// in the shell's order, and no shortcut: a form equal to the identifier is still asked.
fn hits(id: &[u8], text: &str, matcher: &mut dyn Matcher) -> Result<bool, Unverifiable> {
    if matcher.has(id, text)? {
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
        if matcher.has(&form, text)? {
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
/// comma-separated `ids`, each of at least four characters. `matcher` is asked only for those.
#[must_use]
pub fn verdict(
    texts: &str,
    email: impl FnOnce() -> EmailRead,
    ids: Option<&Secret>,
    locale: Locale,
    matcher: &mut dyn Matcher,
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
    // An identifier that is not valid UTF-8 in a UTF-8 locale is not checked: it is
    // Unverifiable (deny), before any `grep`. Deliberate divergence from the shell, whose answer
    // depends on the Bash version: Bash 5.2's `read` swallows the newline after an incomplete
    // sequence, so the line carries a `\n`, `grep -e` gets an empty pattern that matches any
    // text, and the next identifier is merged into that line and never looked for. 5.3 splits
    // correctly. The native lane cannot tell 5.2 from 5.3, and copying either would copy a
    // false negative somewhere; failing closed has none.
    if locale != Locale::C
        && protocol
            .split(|&b| b == b'\n')
            .any(|line| std::str::from_utf8(line).is_err())
    {
        return Code::Unverified;
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
        match hits(value, texts, matcher) {
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
