//! Rule 7 of guard-destructive.sh (#1252): whole-tree discards of uncommitted work. The text
//! walk is pure; whether the target directory exists and holds what would be lost comes from a
//! [`Repo`], so the verdict depends on state exactly where the shell asks git.

use regex::Regex;

use super::tr;
use crate::shell::Locale;
use crate::shell::hook_input::Host;
use crate::shell::repo::{Holding, Loss, Repo};

/// Candidate segments past this count are not inspected: the command blocks.
const CANDIDATES_MAX: usize = 16;
/// `_dsc_resolve`'s marker for a directory that is not literal.
const UNRESOLVED: &str = "?";
macro_rules! route {
    () => {
        "commit the work first (a WIP commit is enough: 'git add -A && git commit -m wip'), or ask the user to run the discard outside the agent."
    };
}
const ROUTE: &str = route!();
const UNRESOLVED_ROUTE: &str = concat!(
    "use a literal existing directory (cd <dir> && … or git -C <dir> …), or ",
    route!()
);

/// A rule-7 block: message, audit reason and route.
pub(super) struct Block {
    pub message: String,
    pub reason: &'static str,
    pub route: &'static str,
}

/// `_dsc_resolve`: the directory `operand` names from `base`, or `?` when it is not literal.
fn resolve(base: &str, operand: &str, home: Option<&str>) -> String {
    let operand = if operand.is_empty() || operand == "~" || operand.starts_with("~/") {
        let home = home.filter(|h| !h.is_empty()).unwrap_or(UNRESOLVED);
        format!("{home}{}", operand.strip_prefix('~').unwrap_or(operand))
    } else {
        operand.to_owned()
    };
    let opaque = |text: &str| text.contains(['$', '`', '*', '?']);
    if opaque(base) || opaque(&operand) {
        UNRESOLVED.to_owned()
    } else if operand.starts_with('/') {
        operand
    } else {
        format!("{base}/{operand}")
    }
}

/// Flags of the token walk, after the subcommand.
#[derive(Default)]
struct Flags {
    hard: bool,
    staged: bool,
    worktree: bool,
    force: bool,
    dry_run: bool,
    all: bool,
    dot: bool,
}

/// What one candidate segment would discard, and in which directory.
fn candidate(
    segment: &str,
    mut dir: String,
    home: Option<&str>,
    locale: Locale,
) -> Option<(String, String, Loss)> {
    enum Want {
        Nothing,
        Dir,
        Skip,
    }
    let mut want = Want::Nothing;
    let mut sub: Option<&str> = None;
    let mut flags = Flags::default();
    // `tr -s '[:space:]' '\n'`, empty lines skipped, the `git` word itself dropped.
    let tokens = segment
        .split(|c| tr::space(locale, c))
        .filter(|token| !token.is_empty())
        .skip(1);
    for token in tokens {
        match want {
            Want::Dir => {
                dir = resolve(&dir, token, home);
                want = Want::Nothing;
                continue;
            }
            Want::Skip => {
                want = Want::Nothing;
                continue;
            }
            Want::Nothing => {}
        }
        if sub.is_none() {
            match token {
                "-C" => want = Want::Dir,
                "-c" | "--namespace" => want = Want::Skip,
                "--git-dir" | "--work-tree" => {
                    dir = UNRESOLVED.to_owned();
                    want = Want::Skip;
                }
                _ if token.starts_with("--git-dir=") || token.starts_with("--work-tree=") => {
                    dir = UNRESOLVED.to_owned();
                }
                _ if token.starts_with('-') => {}
                "reset" | "checkout" | "restore" | "clean" => sub = Some(token),
                _ if token.contains(['$', '`']) => dir = UNRESOLVED.to_owned(),
                _ => {
                    if dir != UNRESOLVED {
                        sub = Some(token);
                    }
                }
            }
            continue;
        }
        match token {
            "--ha" | "--har" | "--hard" => flags.hard = true,
            "--staged" => flags.staged = true,
            "--worktree" => flags.worktree = true,
            "--force" => flags.force = true,
            "--dry-run" => flags.dry_run = true,
            _ if token.starts_with("--") => {}
            _ if token.starts_with('-') => {
                flags.staged |= token.contains('S');
                flags.worktree |= token.contains('W');
                flags.force |= token.contains('f');
                flags.dry_run |= token.contains('n');
                flags.all |= token.contains(['x', 'X']);
            }
            "." | "./" | ":/" | ":/." => flags.dot = true,
            _ => {}
        }
    }
    let sub = sub?;
    let loss = match sub {
        "reset" if flags.hard => Loss::Tracked,
        "checkout" if flags.force || flags.dot => Loss::Tracked,
        "restore" if !flags.staged || flags.worktree => Loss::Tracked,
        "clean" if flags.force && !flags.dry_run => {
            if flags.all {
                Loss::All
            } else {
                Loss::Untracked
            }
        }
        _ => return None,
    };
    Some((sub.to_owned(), dir, loss))
}

/// `NAME=value`, the shape of an environment assignment.
fn is_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// An assignment of `GIT_DIR` or `GIT_WORK_TREE`: it moves the repository the command touches.
fn is_git_location(token: &str) -> bool {
    token.starts_with("GIT_DIR=") || token.starts_with("GIT_WORK_TREE=")
}

/// `git` written bare or as a path (`/usr/bin/git`, `./git`); `=` cannot be part of the path.
fn is_git_word(token: &str) -> bool {
    token
        .strip_suffix("git")
        .is_some_and(|dir| dir.is_empty() || (dir.ends_with('/') && !dir.contains('=')))
}

/// The `[start, end)` of the first token at or after `from`.
fn next_token(text: &str, from: usize, locale: Locale) -> Option<(usize, usize)> {
    let mut start = None;
    for (i, c) in text[from..].char_indices() {
        let blank = locale.whitespace(c);
        match (start, blank) {
            (None, false) => start = Some(from + i),
            (Some(a), true) => return Some((a, from + i)),
            _ => {}
        }
    }
    start.map(|a| (a, text.len()))
}

/// The shell's forms-of-git pass (#1801): `env`, assignment prefixes and a `…/git` path read as
/// the bare `git` word, and a `GIT_DIR=`/`GIT_WORK_TREE=` prefix, or one assigned or exported by
/// an earlier segment (`sticky`), injects `--git-dir=?` so the walk blocks it like the flag.
fn normalize(segment: &str, sticky: &mut bool, locale: Locale) -> String {
    let text = segment.trim_start_matches(|c| locale.whitespace(c));
    let mut words = Vec::new();
    let mut at = 0;
    while let Some((a, b)) = next_token(text, at, locale) {
        words.push(&text[a..b]);
        at = b;
    }
    let exports = words
        .first()
        .is_some_and(|w| matches!(*w, "export" | "declare" | "typeset" | "readonly" | "local"))
        && words.iter().skip(1).any(|w| is_git_location(w));
    let only_assignments =
        words.iter().all(|w| is_assignment(w)) && words.iter().any(|w| is_git_location(w));
    if exports || only_assignments {
        *sticky = true;
    }
    let mut tainted = false;
    let mut line = text.to_owned();
    let mut at = 0;
    while let Some((a, b)) = next_token(text, at, locale) {
        let token = &text[a..b];
        if token == "env" || is_assignment(token) {
            tainted |= is_git_location(token);
            at = b;
        } else {
            if is_git_word(token) {
                line = format!("git{}", &text[b..]);
            }
            break;
        }
    }
    let git = line
        .strip_prefix("git")
        .is_some_and(|rest| rest.chars().next().is_none_or(|c| locale.whitespace(c)));
    if git && (tainted || *sticky) {
        line = format!("git --git-dir=?{}", &line[3..]);
    } else if !git {
        // Re-peel: leading assignments go, as `inert::segments` peels them.
        let mut rest = line.as_str();
        while let Some((a, b)) = next_token(rest, 0, locale) {
            if a == 0 && is_assignment(&rest[a..b]) {
                rest = rest[b..].trim_start_matches(|c| locale.whitespace(c));
            } else {
                break;
            }
        }
        line = rest.trim_start_matches(|c| locale.whitespace(c)).to_owned();
    }
    line
}

/// Rule 7 over the unpeeled segments. `None` lets the command through.
pub(super) fn evaluate(
    segments: &[String],
    candidate_re: &Regex,
    host: &Host,
    repo: &dyn Repo,
    locale: Locale,
) -> Option<Block> {
    // `tr -d "'\")"` over the segment list, then the forms-of-git pass.
    let mut sticky = false;
    let segments: Vec<String> = segments
        .iter()
        .map(|s| {
            let dropped: String = s
                .chars()
                .filter(|c| !matches!(c, '\'' | '"' | ')'))
                .collect();
            normalize(&dropped, &mut sticky, locale)
        })
        .collect();
    let count = segments.iter().filter(|s| candidate_re.is_match(s)).count();
    if count == 0 {
        return None;
    }
    if count > CANDIDATES_MAX {
        return Some(Block {
            message: format!(
                "too many discard commands to inspect (> {CANDIDATES_MAX}) — nothing in it was evaluated"
            ),
            reason: "oversize",
            route: "split it into smaller commands the guard can inspect.",
        });
    }
    let home = host.home.as_deref();
    let mut current = if host.cwd.is_empty() {
        host.pwd.clone()
    } else {
        host.cwd.clone()
    };
    for segment in &segments {
        if segment == "cd" || segment.starts_with("cd ") {
            let arg = segment[2..].trim_matches(|c| locale.whitespace(c));
            let arg = if arg.starts_with("-P ") || arg.starts_with("-L ") {
                &arg[3..]
            } else {
                arg
            };
            current = if arg.starts_with('-') {
                UNRESOLVED.to_owned()
            } else {
                resolve(&current, arg, home)
            };
            continue;
        }
        if !candidate_re.is_match(segment) {
            continue;
        }
        let Some((sub, dir, loss)) = candidate(segment, current.clone(), home, locale) else {
            continue;
        };
        if dir == UNRESOLVED || !repo.is_dir(&dir) {
            return Some(Block {
                message: format!(
                    "git {sub} discards work and its target directory cannot be inspected (variable, substitution, missing or unresolved path)"
                ),
                reason: "unspecified",
                route: UNRESOLVED_ROUTE,
            });
        }
        match repo.holds(&dir, loss) {
            Holding::Holds => {
                return Some(Block {
                    message: format!("git {sub} would discard uncommitted work"),
                    reason: "unspecified",
                    route: ROUTE,
                });
            }
            Holding::Unknown => {
                return Some(Block {
                    message: format!(
                        "git {sub} discards work and its target directory cannot be inspected (the repository tool is missing, not executable or failing)"
                    ),
                    reason: "unspecified",
                    route: UNRESOLVED_ROUTE,
                });
            }
            Holding::Clear => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::inert::{self, Rules};

    /// For non-git, unquoted segments, `normalize` peels exactly what `inert::segments` peels.
    #[test]
    fn normalize_peels_like_inert_segments() -> Result<(), String> {
        let inputs = [
            "FOO=1 cd x",
            "FOO=1 BAR=2 cd x",
            "  FOO=1   cd x",
            "env FOO=1 cd x",
            "FOO=1",
            "FOO=1 BAR=",
            "cd x",
            "MY_GIT_DIR=x ls",
            "FOO=GIT_DIR=x ls",
            "1FOO=1 ls",
            "FOO=1\u{2000}ls",
            "ls -la",
            "",
        ];
        for locale in [Locale::Utf8, Locale::GnuUtf8, Locale::C] {
            let rules = Rules::get(locale);
            for input in inputs {
                let peeled = inert::segments(input, rules)?;
                let got = normalize(input, &mut false, locale);
                assert_eq!(Some(&got), peeled.first(), "{locale:?} {input:?}");
            }
        }
        Ok(())
    }
}
