//! Rule 1b's view of a commit, transcribed from the `gate-trigger` and `resolve-worktree`
//! partials: where the commit lands (`navori_commit_landing`) and which tree gets measured
//! (`navori_worktree`). Text work is pure; repository facts come from [`Repo`].

use std::cell::OnceCell;
use std::sync::LazyLock;

use regex::Regex;

use super::Locale;
use super::hook_input::Host;
use super::repo::Repo;

static ASSIGNMENT: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new("^[A-Za-z_][A-Za-z0-9_]*="));

fn trim_start(text: &str, locale: Locale) -> &str {
    text.trim_start_matches(|c| locale.whitespace(c))
}

fn trim_end(text: &str, locale: Locale) -> &str {
    text.trim_end_matches(|c| locale.whitespace(c))
}

/// `${text%%[[:space:]]*}`: everything before the first space-class character.
fn first_word(text: &str, locale: Locale) -> &str {
    text.find(|c| locale.whitespace(c))
        .map_or(text, |at| &text[..at])
}

/// `<word>[[:space:]]*`: the word followed by a space-class character.
fn starts_word(text: &str, word: &str, locale: Locale) -> bool {
    text.strip_prefix(word)
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| locale.whitespace(c))
}

/// `[A-Za-z0-9_.-]`, the heredoc tag alphabet.
fn tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// `navori_strip_heredoc_bodies`: drop the bodies (and terminators) of `cat` heredocs whose
/// output is data. Any doubt keeps the text whole.
pub(crate) fn strip_heredoc_bodies(input: &str, locale: Locale) -> String {
    if !input.contains("<<") {
        return input.to_owned();
    }
    let mut out = String::new();
    let mut tag = String::new();
    let mut dash = false;
    let mut inbody = false;
    for line in input.split('\n') {
        if inbody {
            let cmp = if dash {
                line.trim_start_matches('\t')
            } else {
                line
            };
            if cmp == tag {
                inbody = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
        let Some(at) = line.find("<<") else {
            continue;
        };
        let before = &line[..at];
        let mut rest = &line[at + 2..];
        if rest.starts_with('<') {
            continue;
        }
        dash = false;
        if let Some(r) = rest.strip_prefix('-') {
            dash = true;
            rest = r;
        }
        let rest = trim_start(rest, locale);
        let quoted = |q: char| {
            rest.strip_prefix(q)
                .and_then(|r| r.find(q).map(|end| (&r[..end], &r[end + 1..])))
                .unwrap_or(("", ""))
        };
        let bare = |r: &str| -> (String, String) {
            let end = r.find(|c| !tag_char(c)).unwrap_or(r.len());
            (r[..end].to_owned(), r[end..].to_owned())
        };
        let (found, after) = if rest.starts_with('\'') {
            let (t, a) = quoted('\'');
            (t.to_owned(), a.to_owned())
        } else if rest.starts_with('"') {
            let (t, a) = quoted('"');
            (t.to_owned(), a.to_owned())
        } else if let Some(r) = rest.strip_prefix('\\') {
            bare(r)
        } else {
            bare(rest)
        };
        if found.is_empty() {
            continue;
        }
        if after.contains(['|', ';', '&']) || after.contains("<<") {
            continue;
        }
        let (seg, pre) = if let Some(at) = before.rfind("$(") {
            (&before[at + 2..], &before[..at])
        } else if let Some(at) = before.rfind('`') {
            (&before[at + 1..], &before[..at])
        } else {
            (before, "")
        };
        if !pre.is_empty() {
            let pre = pre.rsplit("&&").next().unwrap_or(pre);
            let pre = pre.rsplit(';').next().unwrap_or(pre);
            let pre = pre.rsplit('|').next().unwrap_or(pre);
            let pfirst = first_word(trim_start(pre, locale), locale);
            if !matches!(pfirst, "gh" | "git" | "echo" | "printf") {
                continue;
            }
        }
        let seg = trim_start(seg, locale);
        if seg.contains(['|', ';', '&']) {
            continue;
        }
        if seg != "cat" && !starts_word(seg, "cat", locale) {
            continue;
        }
        tag = found;
        inbody = true;
    }
    if inbody { input.to_owned() } else { out }
}

/// `navori_count_triggers`: segments starting with a gated op once wrappers and `VAR=value`
/// prefixes are peeled; `strip` is `TRIGGER_STRIP_HEREDOC_BODIES=1`.
pub(crate) fn count_triggers(
    input: &str,
    trigger: &Regex,
    strip: bool,
    locale: Locale,
) -> Result<usize, String> {
    let assignment = ASSIGNMENT
        .as_ref()
        .map_err(|e| format!("trigger pattern: {e}"))?;
    let input = if strip && input.contains("<<") {
        strip_heredoc_bodies(input, locale)
    } else {
        input.to_owned()
    };
    let input = input
        .replace("\\\n", " ")
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|'], "\n");
    let mut hits = 0;
    for line in input.split('\n') {
        let mut segment = trim_start(line, locale);
        while let Some(rest) = segment.strip_prefix('(') {
            segment = trim_start(rest, locale);
        }
        segment = segment.strip_prefix('\\').unwrap_or(segment);
        while assignment.is_match(segment) {
            match segment.find(|c| locale.whitespace(c)) {
                Some(at) => {
                    let width = segment[at..].chars().next().map_or(1, char::len_utf8);
                    segment = trim_start(&segment[at + width..], locale);
                }
                None => {
                    segment = "";
                    break;
                }
            }
        }
        if let Some(rest) = segment.strip_prefix("command ") {
            segment = trim_start(rest, locale);
        }
        if trigger.is_match(segment) {
            hits += 1;
        }
    }
    Ok(hits)
}

/// `navori_mentions_shellish`: a word that can re-enter git, the cwd or a shell.
fn mentions_shellish(text: &str) -> bool {
    let words: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let words = format!(" {words} ");
    [
        "git", "cd", "pushd", "popd", "sh", "bash", "zsh", "dash", "ksh", "env", "eval", "exec",
        "command", "builtin", "source", "xargs",
    ]
    .iter()
    .any(|word| words.contains(&format!(" {word} ")))
}

/// `navori_take_token`: one shell token off the front, `None` for anything the shell would
/// expand or that is malformed.
fn take_token(text: &str, locale: Locale) -> Option<(&str, &str)> {
    let s = trim_start(text, locale);
    let (token, rest) = if let Some(r) = s.strip_prefix('\'').or_else(|| s.strip_prefix('"')) {
        let quote = s.chars().next()?;
        let end = r.find(quote)?;
        let rest = &r[end + 1..];
        if rest.chars().next().is_some_and(|c| !locale.whitespace(c)) {
            return None;
        }
        (&r[..end], rest)
    } else {
        let token = first_word(s, locale);
        if token.contains([';', '|', '&', '<', '>', '(', ')', '\'', '"']) {
            return None;
        }
        (token, &s[token.len()..])
    };
    if token.is_empty()
        || token.starts_with('~')
        || token.contains(['$', '`', '\\', '*', '?', '[', '{', '\n'])
    {
        return None;
    }
    Some((token, rest))
}

/// `navori_op_target` for a `git` segment: its `-C` target (`""` when none), `None` when the
/// parser will not follow it.
fn op_target(first: &str, locale: Locale) -> Option<String> {
    let mut p = first.strip_prefix("git").unwrap_or(first);
    let mut target = String::new();
    let mut seen_c = false;
    loop {
        let (arg, rest) = take_token(p, locale)?;
        p = rest;
        match arg {
            "commit" | "push" => return Some(target),
            "-C" => {
                if seen_c {
                    return None;
                }
                seen_c = true;
                let (dir, rest) = take_token(p, locale)?;
                target = dir.to_owned();
                p = rest;
            }
            "-c" => p = take_token(p, locale)?.1,
            "--no-pager"
            | "-p"
            | "--paginate"
            | "-P"
            | "--no-optional-locks"
            | "--literal-pathspecs"
            | "--glob-pathspecs"
            | "--noglob-pathspecs"
            | "--icase-pathspecs"
            | "--no-replace-objects" => {}
            _ => return None,
        }
    }
}

/// `navori_cmd_dir`: the directory a `git -C` or a leading `cd` names, unresolved.
fn cmd_dir(text: &str, locale: Locale) -> Option<String> {
    let rest = if let Some(at) = text.find("git -C ") {
        &text[at + "git -C ".len()..]
    } else {
        let head = text.split("&&").next().unwrap_or(text);
        trim_start(head, locale).strip_prefix("cd ")?
    };
    let rest = trim_start(rest, locale);
    if rest.is_empty() || rest.contains(['$', '`', '*', '?']) || rest.starts_with('~') {
        return None;
    }
    // `navori_first_token`: an unterminated quote runs to the end of the text.
    let token = if let Some(s) = rest.strip_prefix('"') {
        s.split('"').next().unwrap_or(s)
    } else if let Some(s) = rest.strip_prefix('\'') {
        s.split('\'').next().unwrap_or(s)
    } else {
        first_word(rest, locale)
    };
    Some(token.to_owned())
}

/// Where one gated op lands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Same,
    Foreign(String),
}

/// The hook's view of the host for one evaluation; the home repository is resolved once.
pub(crate) struct Facts<'a> {
    host: &'a Host,
    repo: &'a dyn Repo,
    locale: Locale,
    trigger: &'a Regex,
    home: OnceCell<String>,
}

impl<'a> Facts<'a> {
    pub(crate) fn new(
        host: &'a Host,
        repo: &'a dyn Repo,
        locale: Locale,
        trigger: &'a Regex,
    ) -> Self {
        Self {
            host,
            repo,
            locale,
            trigger,
            home: OnceCell::new(),
        }
    }

    /// `navori_home_resolve`: the protected repository's id, `""` when unknown.
    fn home(&self) -> &str {
        self.home.get_or_init(|| {
            let Some(cpd) = self
                .host
                .claude_project_dir
                .as_deref()
                .filter(|d| !d.is_empty())
            else {
                return String::new();
            };
            let trimmed = cpd.strip_suffix('/').unwrap_or(cpd);
            let Some(rest) = self.host.hook_path.strip_prefix(&format!("{trimmed}/")) else {
                return String::new();
            };
            let file = rest
                .strip_prefix(".claude/hooks/")
                .or_else(|| rest.strip_prefix(".claude/scripts/"));
            match file {
                Some(file) if !matches!(file, "" | "." | "..") && !file.contains('/') => {
                    self.repo.repo_id(cpd).unwrap_or_default()
                }
                _ => String::new(),
            }
        })
    }

    /// The payload's cwd when it is a directory, else `PWD`.
    fn base(&self) -> &str {
        if self.repo.is_dir(&self.host.cwd) {
            &self.host.cwd
        } else {
            &self.host.pwd
        }
    }

    /// `navori_op_landing`; `None` is an unproven op.
    fn op_landing(&self, cd_dir: &str, c_dir: &str) -> Option<Kind> {
        let home = self.home();
        if cd_dir.is_empty() && c_dir.is_empty() && home.is_empty() {
            return Some(Kind::Same);
        }
        let base = self.base();
        let mut dir = base.to_owned();
        let mut relative = false;
        if !cd_dir.is_empty() {
            if cd_dir.starts_with('/') {
                dir = cd_dir.to_owned();
            } else {
                relative = true;
                dir = format!("{base}/{cd_dir}");
                if self.host.cdpath.as_deref().is_some_and(|p| !p.is_empty()) {
                    return None;
                }
            }
        }
        if !c_dir.is_empty() {
            if c_dir.starts_with('/') {
                dir = c_dir.to_owned();
                relative = false;
            } else {
                relative = true;
                dir = format!("{dir}/{c_dir}");
            }
        }
        if relative
            && (cd_dir.contains("..") || c_dir.contains(".."))
            && self.repo.physical(base).as_deref() != Some(base)
        {
            return None;
        }
        if !self.repo.is_dir(&dir) {
            return None;
        }
        let top = self.repo.toplevel(&dir)?;
        if !self.repo.superproject(&dir)?.is_empty() {
            return None;
        }
        let landed = self.repo.repo_id(&dir)?;
        if !home.is_empty() {
            return Some(if landed == home {
                Kind::Same
            } else {
                Kind::Foreign(top)
            });
        }
        let anchor = self.repo.repo_id(base)?;
        let project = self
            .host
            .claude_project_dir
            .as_deref()
            .filter(|d| !d.is_empty())
            .and_then(|d| self.repo.repo_id(d))
            .unwrap_or_default();
        Some(
            if landed == anchor || (!project.is_empty() && landed == project) {
                Kind::Same
            } else {
                Kind::Foreign(top)
            },
        )
    }

    /// `navori_commit_landing` reduced to the one answer the guard reads: `foreign`.
    pub(crate) fn foreign(&self, cmd: &str) -> Result<bool, String> {
        Ok(self.foreign_root(cmd)?.is_some())
    }

    /// `navori_commit_landing`: `Some(navori_landing_root)` when every gated op provably lands
    /// in one other repository (`navori_landing=foreign`), `None` for any other answer.
    ///
    /// # Errors
    /// A trigger pattern that does not compile.
    pub(crate) fn foreign_root(&self, cmd: &str) -> Result<Option<String>, String> {
        Ok(match self.landing(cmd)? {
            Some(Kind::Foreign(root)) => Some(root),
            _ => None,
        })
    }

    /// The folded landing of every gated op, `None` when unproven.
    fn landing(&self, cmd: &str) -> Result<Option<Kind>, String> {
        const UNPROVEN: Result<Option<Kind>, String> = Ok(None);
        let locale = self.locale;
        let hits = count_triggers(cmd, self.trigger, true, locale)?;
        if hits < 1 {
            return UNPROVEN;
        }
        let stripped = strip_heredoc_bodies(cmd, locale).replace("\\\n", " ");
        let mut rest = trim_end(&stripped, locale);
        let mut ops: Vec<String> = Vec::new();
        let mut cd_dir = String::new();
        let mut cd_seen = false;
        let mut more = true;
        while more {
            let seg;
            if let Some(at) = rest.find("&&") {
                seg = &rest[..at];
                rest = &rest[at + 2..];
            } else {
                seg = rest;
                rest = "";
                more = false;
            }
            let seg = trim_start(seg, locale);
            let first = seg.split('\n').next().unwrap_or(seg);
            let gated = (starts_word(first, "git", locale) || starts_word(first, "gh", locale))
                && self.trigger.is_match(first);
            if gated {
                let Some(target) = op_target(first, locale) else {
                    return UNPROVEN;
                };
                ops.push(target);
                let mut tail = format!("{}\n", &seg[first.len()..]);
                if let Some(at) = first.find([';', '|', '&']) {
                    tail = format!("{}\n{tail}", &first[at + 1..]);
                }
                if mentions_shellish(&tail) {
                    return UNPROVEN;
                }
                continue;
            }
            if seg.contains('\n') {
                return UNPROVEN;
            }
            let seg = trim_end(seg, locale);
            if ops.is_empty() {
                if starts_word(seg, "cd", locale) {
                    if cd_seen {
                        return UNPROVEN;
                    }
                    cd_seen = true;
                    let Some((token, after)) = take_token(&seg[2..], locale) else {
                        return UNPROVEN;
                    };
                    if after.chars().any(|c| !locale.whitespace(c)) || token.starts_with('-') {
                        return UNPROVEN;
                    }
                    token.clone_into(&mut cd_dir);
                } else if starts_word(seg, "git", locale) {
                    if seg.contains([';', '|', '&', '<', '>', '(', ')', '$', '`']) {
                        return UNPROVEN;
                    }
                } else {
                    return UNPROVEN;
                }
                continue;
            }
            if seg.contains([';', '|', '&', '<', '>', '(', ')', '$', '`', '\\', '\t']) {
                return UNPROVEN;
            }
            if let Some(after) = seg.strip_prefix("git ") {
                if ["--exec", "--receive-pack", "--upload-pack", "--config-env"]
                    .iter()
                    .any(|flag| seg.contains(flag))
                {
                    return UNPROVEN;
                }
                let sub = after.split(' ').next().unwrap_or(after);
                if !matches!(
                    sub,
                    "status" | "diff" | "log" | "show" | "rev-parse" | "push"
                ) {
                    return UNPROVEN;
                }
            } else if !matches!(
                first_word(seg, locale),
                "echo" | "printf" | "true" | ":" | "ls" | "pwd"
            ) {
                return UNPROVEN;
            }
        }
        if ops.is_empty() || ops.len() != hits {
            return UNPROVEN;
        }
        let mut folded: Option<Kind> = None;
        let mut last: Option<(&str, Option<Kind>)> = None;
        for target in &ops {
            let kind = match &last {
                Some((previous, kind)) if previous == target => kind.clone(),
                _ => {
                    let kind = self.op_landing(&cd_dir, target);
                    last = Some((target, kind.clone()));
                    kind
                }
            };
            folded = match (kind, folded) {
                (Some(Kind::Same), None | Some(Kind::Same)) => Some(Kind::Same),
                (Some(Kind::Foreign(top)), None) => Some(Kind::Foreign(top)),
                (Some(Kind::Foreign(top)), Some(Kind::Foreign(seen))) if top == seen => {
                    Some(Kind::Foreign(top))
                }
                _ => return UNPROVEN,
            };
        }
        Ok(folded)
    }

    /// `navori_worktree`: the root of the tree the commit acts on, `""` when none resolves.
    pub(crate) fn worktree(&self, cmd: &str) -> String {
        let base = self.base().to_owned();
        let mut named = cmd_dir(cmd, self.locale).unwrap_or_default();
        if !named.is_empty() && !named.starts_with('/') {
            named = format!("{base}/{named}");
        }
        if !named.is_empty() {
            let anchor = self.repo.repo_id(&base).unwrap_or_default();
            let target = self.repo.repo_id(&named).unwrap_or_default();
            if target.is_empty() || (target != anchor && target != self.home()) {
                named.clear();
            }
        }
        [named.as_str(), &self.host.cwd, &self.host.pwd]
            .into_iter()
            .filter(|candidate| !candidate.is_empty() && self.repo.is_dir(candidate))
            .find_map(|candidate| self.repo.toplevel(candidate))
            .unwrap_or_default()
    }
}
