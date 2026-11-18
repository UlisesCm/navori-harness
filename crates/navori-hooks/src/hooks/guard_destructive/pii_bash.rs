//! Port of `_partials/pii-egress-bash.sh`: the PII-egress Bash lane of `guard-destructive` (#1445).
//!
//! "A network request to an external host" for Bash: a live segment whose command is, behind
//! `sudo|env|time|command|exec` and a path prefix, one of `curl wget http https xh xhs`, or an
//! inline `node|bun|deno|python|python3` (`-e|-c|--eval|eval`) using `fetch`, `requests.`,
//! `urllib` or `http.request`. Matching is per segment, plus the whole command when that segment
//! opens a heredoc. This transcribes the partial's CODE, not its header: the request test reads
//! `*fetch*` (the cheap gate reads `fetch(`), the assignment prefix is the lax glob
//! `[A-Za-z_]*=*`, and `' -e '` has literal spaces.
//!
//! The identifier handling lives in [`crate::shell::pii_egress`] and never crosses this module
//! as anything but a [`Code`]. [`check`] runs entirely inside `catch_unwind`: a panic is
//! [`Code::Unverified`] and its message (which could hold a slice of the command) is dropped.
//! [`lane`] wires it into `rules.rs`, between the inert skeleton and the fast path as in the
//! script. The host facts it needs (the identifiers, `git config user.email`, a `grep`) come
//! through a [`Probe`] and are asked only after [`gate`] matched. Code outside [`check`] has no
//! panicking construct: a panic message could hold a slice of the command.
#![deny(clippy::string_slice, clippy::indexing_slicing)]

use std::ffi::OsString;
use std::fmt;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::tr;
use crate::runner::Failure;
use crate::shell::Locale;
use crate::shell::inert::{self, Rules};
use crate::shell::pii_egress::{
    Code, EmailRead, HostGrep, Matcher, Secret, Unverifiable, is_local, verdict,
};
use crate::shell::subcommand::{self, Call, Capture, Input};

/// The cheap gate of `navori_pii_bash_lane`: pure text, no process. HTTPie (`http https xh xhs`)
/// matches only as a whole word: after the start, a blank, one of ``; & | ( ` ``, `'` or a path
/// `/`, and before a blank.
#[must_use]
pub fn gate(cmd: &str, locale: Locale) -> bool {
    let text = format!(" {cmd}");
    if ["curl", "wget", "://", "fetch("]
        .iter()
        .any(|needle| text.contains(needle))
    {
        return true;
    }
    ["http", "https", "xh", "xhs"].iter().any(|word| {
        text.match_indices(word).any(|(at, _)| {
            let before = text.get(..at).and_then(|head| head.chars().next_back());
            let after = text
                .get(at + word.len()..)
                .and_then(|rest| rest.chars().next());
            before.is_some_and(|c| {
                locale.whitespace(c) || matches!(c, '\'' | ';' | '&' | '|' | '(' | '`' | '/')
            }) && after.is_some_and(|c| locale.whitespace(c))
        })
    })
}

/// `_pii_is_request`: is the segment a network request?
fn is_request(segment: &str, locale: Locale) -> bool {
    let space = |c: char| locale.whitespace(c);
    let mut rest = segment;
    let word = loop {
        rest = rest.trim_start_matches(space);
        let word = rest.split(space).next().unwrap_or_default();
        // `[A-Za-z_]*=*`: a letter or `_` first and an `=` anywhere after it.
        let assignment = word
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && word.contains('=');
        if !(matches!(word, "sudo" | "env" | "time" | "command" | "exec") || assignment) {
            break word;
        }
        match rest.strip_prefix(word) {
            Some(next) => rest = next,
            None => break word,
        }
    };
    match word.rsplit('/').next().unwrap_or_default() {
        "curl" | "wget" | "http" | "https" | "xh" | "xhs" => true,
        "node" | "bun" | "deno" | "python" | "python3" => {
            let padded = format!(" {rest} ");
            ["-e", "-c", "--eval", "eval"]
                .iter()
                .any(|flag| padded.contains(&format!(" {flag} ")))
                && ["fetch", "requests.", "urllib", "http.request"]
                    .iter()
                    .any(|needle| rest.contains(needle))
        }
        _ => false,
    }
}

/// The scheme-and-authority regex, without personal data, for `locale`.
fn url_regex(locale: Locale) -> Option<&'static Regex> {
    const PATTERN: &str = r#"[A-Za-z][A-Za-z0-9+.-]*://[^/?#"'[:space:]]*"#;
    static UTF8: LazyLock<Option<Regex>> = LazyLock::new(|| Locale::Utf8.ere(PATTERN).ok());
    static GNU_UTF8: LazyLock<Option<Regex>> = LazyLock::new(|| Locale::GnuUtf8.ere(PATTERN).ok());
    static C: LazyLock<Option<Regex>> = LazyLock::new(|| Locale::C.ere(PATTERN).ok());
    match locale {
        Locale::Utf8 => &UTF8,
        Locale::GnuUtf8 => &GNU_UTF8,
        Locale::C => &C,
    }
    .as_ref()
}

/// `_pii_external`: does the request segment go to an external host? `None` when the URL
/// pattern did not compile. A segment with a scheme is external when any URL is; one without is
/// external unless one of its words is a local `host[:port][/path]`.
fn external(segment: &str, locale: Locale) -> Option<bool> {
    let mut found = false;
    for url in url_regex(locale)?.find_iter(segment) {
        found = true;
        let authority = url.as_str().split_once("://").map_or("", |(_, rest)| rest);
        if !is_local(authority) {
            return Some(true);
        }
    }
    if found {
        return Some(false);
    }
    for word in segment.split(|c| tr::space(locale, c)) {
        if word.is_empty() || word.starts_with('-') {
            continue;
        }
        let word = word.strip_prefix(['"', '\'']).unwrap_or(word);
        // A path (`/usr/bin/http`, `-o /tmp/x`) has no host.
        let host = word.split('/').next().unwrap_or_default();
        if !host.is_empty() && is_local(host) {
            return Some(false);
        }
    }
    Some(true)
}

fn run(
    cmd: &str,
    skeleton: &str,
    rules: &Rules,
    locale: Locale,
    matcher: &mut dyn Matcher,
    email: impl FnOnce() -> EmailRead,
    ids: Option<&Secret>,
) -> Code {
    let live = inert::live(cmd, skeleton, rules);
    let scan = inert::scan(&live, rules);
    let mut texts = String::new();
    for segment in inert::segments(&scan, rules)
        .iter()
        .filter(|segment| !segment.is_empty())
    {
        if !is_request(segment, locale) {
            continue;
        }
        match external(segment, locale) {
            None => return Code::Unverified,
            Some(false) => continue,
            Some(true) => {}
        }
        // A heredoc opener widens the segment to the whole command: the body is the request body.
        texts.push_str(if segment.contains("<<") { cmd } else { segment });
        texts.push('\n');
        if segment.contains("git config user.email")
            || segment.contains("git config --get user.email")
        {
            return Code::GitEmail;
        }
    }
    if texts.is_empty() {
        return Code::Clean;
    }
    verdict(&texts, email, ids, locale, matcher)
}

/// Whether the lane may run under `locale`: only the glibc ones (`C`, C.UTF-8). `Utf8` is BSD
/// (macOS, bash 3.2), where the rest of the lane has not been measured: the caller leaves the
/// rule to the shell.
#[must_use]
pub fn eligible(locale: Locale) -> bool {
    locale != Locale::Utf8
}

/// `navori_pii_bash_check`: what the lane decides for a command that passed [`gate`], or
/// `None` when the lane is not eligible under `locale` (see [`eligible`]); nothing has run then.
///
/// `skeleton` is the command's inert skeleton (the caller's own `inert::skeleton`). `email` is
/// lazy: it runs only for a request to an external host that has no inline `git config
/// user.email`. `matcher` is asked only once an identifier is configured. A panic anywhere in
/// here is [`Code::Unverified`], never an `Err` and never a message.
#[must_use]
pub fn check(
    cmd: &str,
    skeleton: &str,
    rules: &Rules,
    locale: Locale,
    matcher: &mut dyn Matcher,
    email: impl FnOnce() -> EmailRead,
    ids: Option<&Secret>,
) -> Option<Code> {
    if !eligible(locale) {
        return None;
    }
    Some(
        panic::catch_unwind(AssertUnwindSafe(|| {
            run(cmd, skeleton, rules, locale, matcher, email, ids)
        }))
        .unwrap_or(Code::Unverified),
    )
}

/// The failure message of a gated command under a locale the lane does not measure (see
/// [`eligible`]). Fixed text: it never carries bytes of the command.
pub const UNMEASURED: &str =
    "the pii-egress lane is not measured under the BSD locale; the shell answers";

/// Whether `failure` is the [`UNMEASURED`] one.
#[must_use]
pub fn is_unmeasured(failure: &Failure) -> bool {
    failure.0 == UNMEASURED
}

/// Host facts of the lane, asked only after [`gate`] matched. No implementor derives `Debug`:
/// they hold the environment and an identifier.
pub trait Probe {
    /// `NAVORI_PERSONAL_IDS`, as the environment holds the bytes.
    fn ids(&self) -> Option<&Secret>;
    /// `$(git config user.email 2>/dev/null || true)` in the hook's directory and environment.
    fn email(&self) -> EmailRead;
    /// A fresh `_pii_has` for one evaluation: its time budget is per evaluation.
    fn matcher(&self) -> Box<dyn Matcher + '_>;
}

/// What the lane decides for a command it measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// Not a request that carries an identifier: the rules go on.
    Pass,
    /// Block with this code (never [`Code::Clean`]).
    Deny(Code),
}

/// `navori_pii_bash_lane`: `None` when the command passed [`gate`] under a locale the lane is
/// not eligible for (see [`UNMEASURED`]). A command that fails the gate is [`Lane::Pass`]
/// without the probe being touched. Text with a NUL byte cannot reach the matcher (it could not
/// be handed to `grep` whole): it is [`Code::Unverified`].
#[must_use]
pub fn lane(
    cmd: &str,
    skeleton: &str,
    rules: &Rules,
    locale: Locale,
    probe: &dyn Probe,
) -> Option<Lane> {
    if !gate(cmd, locale) {
        return Some(Lane::Pass);
    }
    if !eligible(locale) {
        return None;
    }
    if cmd.contains('\0') {
        return Some(Lane::Deny(Code::Unverified));
    }
    let mut matcher = probe.matcher();
    let code = check(
        cmd,
        skeleton,
        rules,
        locale,
        &mut *matcher,
        || probe.email(),
        probe.ids(),
    )?;
    Some(match code {
        Code::Clean => Lane::Pass,
        other => Lane::Deny(other),
    })
}

/// Wall time `git config user.email` may take, as tight as the `grep` budget of one evaluation.
const EMAIL_BUDGET: Duration = Duration::from_secs(4);

/// `$(…)` of `git config user.email`: the trailing newlines dropped, a NUL unreadable.
fn parse_email(stdout: &[u8]) -> EmailRead {
    let value = subcommand::substitution(stdout);
    if value.contains(&0) {
        EmailRead::Unreadable
    } else if value.is_empty() {
        EmailRead::Absent
    } else {
        EmailRead::Present(Secret::new(value))
    }
}

/// `grep` behind the deadline: past `until` it is not launched.
struct Until<'a> {
    inner: HostGrep<'a>,
    until: Option<Instant>,
}

impl Matcher for Until<'_> {
    fn has(&mut self, needle: &[u8], text: &str) -> Result<bool, Unverifiable> {
        if self.until.is_some_and(|until| Instant::now() >= until) {
            return Err(Unverifiable);
        }
        self.inner.has(needle, text)
    }
}

/// The host, as production reads it. `Debug` is written by hand and prints nothing of it.
pub struct HostProbe<'a> {
    /// The hook's complete environment.
    pub env: &'a [(OsString, OsString)],
    /// `command -v grep`, `None` when it did not resolve.
    pub grep: Option<&'a Path>,
    /// `command -v git`, `None` when it did not resolve (the email is then absent).
    pub git: Option<&'a Path>,
    /// The shell's working directory.
    pub pwd: &'a Path,
    /// `NAVORI_PERSONAL_IDS`.
    pub ids: Option<&'a Secret>,
    /// The script's deadline: past it nothing new is launched.
    pub until: Option<Instant>,
}

impl fmt::Debug for HostProbe<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HostProbe(<redacted>)")
    }
}

impl Probe for HostProbe<'_> {
    fn ids(&self) -> Option<&Secret> {
        self.ids
    }

    /// `git config user.email` bound by the least of [`EMAIL_BUDGET`] and the time left to the
    /// deadline; a bound that expires is unreadable (the lane denies), a git that cannot be
    /// launched is absent, as in `read_user_email`.
    fn email(&self) -> EmailRead {
        let Some(git) = self.git else {
            return EmailRead::Absent;
        };
        let budget = self.until.map_or(EMAIL_BUDGET, |until| {
            EMAIL_BUDGET.min(until.saturating_duration_since(Instant::now()))
        });
        if budget.is_zero() {
            return EmailRead::Unreadable;
        }
        let args = [OsString::from("config"), OsString::from("user.email")];
        let env = subcommand::child_env(self.env, self.pwd.as_os_str(), None, git, &[]);
        let Ok(done) = subcommand::run(&Call {
            program: git,
            args: &args,
            cwd: self.pwd,
            env: &env,
            input: Input::Null,
            capture: Capture::Separate,
            timeout: Some(budget),
        }) else {
            return EmailRead::Absent;
        };
        if done.timed_out {
            return EmailRead::Unreadable;
        }
        parse_email(&done.stdout)
    }

    fn matcher(&self) -> Box<dyn Matcher + '_> {
        Box::new(Until {
            inner: HostGrep::new(self.grep, self.pwd, self.env),
            until: self.until,
        })
    }
}

/// A matcher that cannot answer.
struct Refuse;

impl Matcher for Refuse {
    fn has(&mut self, _: &[u8], _: &str) -> Result<bool, Unverifiable> {
        Err(Unverifiable)
    }
}

/// A host with no identifiers, no email and no `grep`: for callers that only exercise the other
/// rules.
#[derive(Debug, Clone, Copy, Default)]
pub struct NullProbe;

impl Probe for NullProbe {
    fn ids(&self) -> Option<&Secret> {
        None
    }

    fn email(&self) -> EmailRead {
        EmailRead::Absent
    }

    fn matcher(&self) -> Box<dyn Matcher + '_> {
        Box::new(Refuse)
    }
}
