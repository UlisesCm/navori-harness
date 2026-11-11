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
//! This lane is not wired into the rules yet: nothing calls it from `rules.rs`.
#![deny(clippy::string_slice, clippy::indexing_slicing)]

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;

use regex::Regex;

use super::tr;
use crate::shell::Locale;
use crate::shell::inert::{self, Rules};
use crate::shell::pii_egress::{Code, EmailRead, Folding, Secret, is_local, verdict};

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
    folding: &Folding,
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
    verdict(&texts, email, ids, locale, folding)
}

/// `navori_pii_bash_check`: what the lane decides for a command that passed [`gate`].
///
/// `skeleton` is the command's inert skeleton (the caller's own `inert::skeleton`). `email` is
/// lazy: it runs only for a request to an external host that has no inline `git config
/// user.email`. A panic anywhere in here is [`Code::Unverified`], never an `Err` and never a
/// message.
#[must_use]
pub fn check(
    cmd: &str,
    skeleton: &str,
    rules: &Rules,
    locale: Locale,
    folding: &Folding,
    email: impl FnOnce() -> EmailRead,
    ids: Option<&Secret>,
) -> Code {
    panic::catch_unwind(AssertUnwindSafe(|| {
        run(cmd, skeleton, rules, locale, folding, email, ids)
    }))
    .unwrap_or(Code::Unverified)
}
