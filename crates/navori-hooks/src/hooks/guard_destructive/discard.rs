//! Rule 7 of guard-destructive.sh (#1252): whole-tree discards of uncommitted work. The text
//! walk is pure; whether the target directory exists and holds what would be lost comes from a
//! [`Repo`], so the verdict depends on state exactly where the shell asks git.

use std::path::Path;
use std::process::{Command, Stdio};

use regex::Regex;

use super::{Host, tr};
use crate::shell::Locale;

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

/// What a discard destroys, as `_dsc_dirty` measures it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loss {
    /// Tracked changes: `git status --porcelain --untracked-files=no`.
    Tracked,
    /// Untracked, not ignored: `git ls-files --others --exclude-standard`.
    Untracked,
    /// Untracked including ignored (`clean -x`/`-X`): `git ls-files --others`.
    All,
}

/// Repository facts rule 7 reads.
pub trait Repo {
    /// `[ -d dir ]`.
    fn is_dir(&self, dir: &str) -> bool;
    /// `_dsc_dirty dir kind`: `dir` is a git work tree holding what `loss` destroys.
    fn holds(&self, dir: &str, loss: Loss) -> bool;
}

/// The host's file system and `git`, read as the shell reads them.
#[derive(Debug, Clone, Copy, Default)]
pub struct System;

impl System {
    fn git_stdout(dir: &str, args: &[&str], optional_locks: bool) -> Option<Vec<u8>> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if !optional_locks {
            command.env("GIT_OPTIONAL_LOCKS", "0");
        }
        command.output().ok().map(|output| output.stdout)
    }
}

impl Repo for System {
    fn is_dir(&self, dir: &str) -> bool {
        Path::new(dir).is_dir()
    }

    fn holds(&self, dir: &str, loss: Loss) -> bool {
        let inside = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--git-dir"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !inside {
            return false;
        }
        let stdout = match loss {
            Loss::Tracked => Self::git_stdout(
                dir,
                &["status", "--porcelain", "--untracked-files=no"],
                false,
            ),
            Loss::Untracked => {
                Self::git_stdout(dir, &["ls-files", "--others", "--exclude-standard"], true)
            }
            Loss::All => Self::git_stdout(dir, &["ls-files", "--others"], true),
        };
        // `[ -n "$(…)" ]` drops trailing newlines; `head -n 1` keeps the first line.
        stdout.is_some_and(|out| out.iter().any(|b| *b != b'\n'))
    }
}

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

/// Rule 7 over the segments. `None` lets the command through.
pub(super) fn evaluate(
    segments: &[String],
    candidate_re: &Regex,
    host: &Host,
    repo: &dyn Repo,
    locale: Locale,
) -> Option<Block> {
    // `tr -d "'\")"` over the segment list.
    let segments: Vec<String> = segments
        .iter()
        .map(|s| {
            s.chars()
                .filter(|c| !matches!(c, '\'' | '"' | ')'))
                .collect()
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
        if repo.holds(&dir, loss) {
            return Some(Block {
                message: format!("git {sub} would discard uncommitted work"),
                reason: "unspecified",
                route: ROUTE,
            });
        }
    }
    None
}
