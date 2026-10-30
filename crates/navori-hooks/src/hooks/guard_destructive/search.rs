//! The `tgrep-search-lane` block and the `guard-search-routing.sh` script it sources (spec 0039
//! D6): a recursive content search that starts a command is routed to `tgrep search`.
//! Extraction from a named file, a root outside the repo and anything unparsed pass.

use std::sync::LazyLock;

use regex::Regex;

use crate::shell::Locale;
use crate::shell::hook_input::Host;
use crate::shell::repo::Repo;

const CMD_MAX: usize = 20_000;

/// What the lane decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Search {
    /// Not a search the lane routes (any exit but 42 or 43).
    Pass,
    /// Exit 42: the remedy is on stderr; the guard exits 2.
    Block {
        /// The script's remedy lines.
        stderr: String,
    },
    /// Exit 43: tgrep is missing or has no index; the guard allows with verdict `fail-open`.
    FailOpen,
}

struct Patterns {
    grep: Regex,
    recursive: Regex,
    rg: Regex,
    no_content: Regex,
}

static ASSIGNMENT: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new("^[A-Za-z_][A-Za-z0-9_]*="));

impl Patterns {
    fn new(locale: Locale) -> Result<Self, regex::Error> {
        let re = |pattern: &str| locale.ere(pattern);
        Ok(Self {
            grep: re(r"^[[:space:]]*(grep|egrep|fgrep)([[:space:]]|$)")?,
            recursive: re(
                r"(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|=|$)",
            )?,
            rg: re(r"^[[:space:]]*rg([[:space:]]|$)")?,
            no_content: re(r"(^|[[:space:]])(--files|--version|--help)([[:space:]]|$)")?,
        })
    }

    fn get(locale: Locale) -> Result<&'static Self, String> {
        static UTF8: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::Utf8));
        static GNU_UTF8: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::GnuUtf8));
        static C: LazyLock<Result<Patterns, regex::Error>> =
            LazyLock::new(|| Patterns::new(Locale::C));
        match locale {
            Locale::Utf8 => &UTF8,
            Locale::GnuUtf8 => &GNU_UTF8,
            Locale::C => &C,
        }
        .as_ref()
        .map_err(|e| format!("search lane pattern: {e}"))
    }
}

/// The sed continuation join and the awk splitter. awk prints each record without a newline,
/// so the lines of a multi-line command run together; the quote state resets per line.
fn segments(cmd: &str) -> String {
    let mut out = String::new();
    for line in cmd.replace("\\\n", " ").split('\n') {
        let mut quote: Option<char> = None;
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
                out.push(c);
                continue;
            }
            match c {
                '\'' | '"' => {
                    quote = Some(c);
                    out.push(c);
                }
                '|' | '&' if chars.peek() == Some(&c) => {
                    chars.next();
                    out.push_str("\n@C@");
                }
                ';' => out.push_str("\n@C@"),
                '|' => out.push_str("\n@P@"),
                other => out.push(other),
            }
        }
    }
    out.trim_end_matches('\n').to_owned()
}

/// `sed -n -e 's/^@C@//p' -e '1{/^@[CP]@/!p;}'` over the segments.
fn starts(segments: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for (index, line) in segments.split('\n').enumerate() {
        let mut space = line;
        if let Some(rest) = line.strip_prefix("@C@") {
            out.push(rest);
            space = rest;
        }
        if index == 0 && !space.starts_with("@C@") && !space.starts_with("@P@") {
            out.push(space);
        }
    }
    out
}

/// `*.[A-Za-z0-9]` through four characters: a dot and one to four alphanumerics at the end.
fn has_extension(operand: &str) -> bool {
    let bytes = operand.as_bytes();
    (1..=4).any(|k| {
        bytes.len() > k
            && bytes[bytes.len() - k - 1] == b'.'
            && bytes[bytes.len() - k..]
                .iter()
                .all(u8::is_ascii_alphanumeric)
    })
}

const BARE_FILES: &[&str] = &[
    "Makefile",
    "makefile",
    "GNUmakefile",
    "Dockerfile",
    "dockerfile",
    "Containerfile",
    "LICENSE",
    "LICENCE",
    "COPYING",
    "NOTICE",
    "AUTHORS",
    "CONTRIBUTORS",
    "CODEOWNERS",
    "README",
    "CHANGELOG",
    "TODO",
    "VERSION",
    "Procfile",
    "Gemfile",
    "Rakefile",
    "Brewfile",
    "Jenkinsfile",
    "Vagrantfile",
    "Caddyfile",
    "Justfile",
    "justfile",
    "Taskfile",
    "Podfile",
];

/// `names_a_file`: at least one target operand (the pattern skipped) is a file or a root
/// outside the repo.
fn names_a_file(segment: &str, root: &str, host: &Host, repo: &dyn Repo) -> bool {
    let mut operands = Vec::new();
    let mut seen_pattern = false;
    for field in segment.split([' ', '\t']).filter(|f| !f.is_empty()).skip(1) {
        if field.starts_with('-') {
            continue;
        }
        if !seen_pattern {
            seen_pattern = true;
            continue;
        }
        let operand = field
            .trim_start_matches(['"', '\''])
            .trim_end_matches(['"', '\'']);
        if operand.contains('*') || operand.ends_with('/') {
            continue;
        }
        operands.push(operand);
    }
    for operand in operands.into_iter().filter(|o| !o.is_empty()) {
        if operand == "~" || operand.starts_with("~/") {
            return true;
        }
        if operand.starts_with('/') && operand != root && !operand.starts_with(&format!("{root}/"))
        {
            return true;
        }
        if has_extension(operand) {
            return true;
        }
        let base = operand.rsplit('/').next().unwrap_or(operand);
        if BARE_FILES.contains(&base) {
            return true;
        }
        // `[ -f operand ]` from the hook's working directory.
        let path = if operand.starts_with('/') {
            operand.to_owned()
        } else {
            format!("{}/{operand}", host.pwd)
        };
        if repo.is_file(&path) {
            return true;
        }
    }
    false
}

/// `search_block`: fail open without tgrep or an index, else the remedy.
fn block(message: &str, host: &Host, repo: &dyn Repo) -> Search {
    let Some(status) = repo.tgrep_status(host.path.as_deref()) else {
        return Search::FailOpen;
    };
    if status.contains("No index found") {
        return Search::FailOpen;
    }
    let not_running = status
        .find("Server:")
        .is_some_and(|at| status[at + "Server:".len()..].contains("not running"));
    let flags = if not_running { "-n --no-index" } else { "-n" };
    Search::Block {
        stderr: format!(
            "[navori] BLOCKED by guard-search-routing: {message}\n\
             [navori] route content search through tgrep:\n\
             [navori]   tgrep search {flags} -- PATTERN ROOT\n\
             [navori] -i -l -w -F mean the same as in ripgrep; see 'tgrep search --help' for the rest.\n\
             [navori] exit contract: 0 = match, 1 = no match, 2 = NOTHING WAS SEARCHED.\n\
             [navori] this does NOT apply to '| grep' (filtering output) nor to\n\
             [navori] 'grep -n x known-file' (extracting from a file you already found).\n"
        ),
    }
}

/// The plugin block (`case "$cmd" in *grep*|*rg*`) and the script it sources.
///
/// # Errors
/// Returns a description of a pattern that failed to compile.
pub fn evaluate(cmd: &str, host: &Host, repo: &dyn Repo, locale: Locale) -> Result<Search, String> {
    if !cmd.contains("grep") && !cmd.contains("rg") {
        return Ok(Search::Pass);
    }
    let patterns = Patterns::get(locale)?;
    let assignment = ASSIGNMENT
        .as_ref()
        .map_err(|e| format!("search lane pattern: {e}"))?;
    let root = if host.project_dir.is_empty() {
        host.pwd.as_str()
    } else {
        host.project_dir.as_str()
    };
    if cmd.is_empty() || cmd.contains("<<") {
        return Ok(Search::Pass);
    }
    let size = match locale {
        Locale::Utf8 | Locale::GnuUtf8 => cmd.chars().count(),
        Locale::C => cmd.len(),
    };
    if size > CMD_MAX {
        return Ok(Search::Pass);
    }
    let segments = segments(cmd);
    for line in starts(&segments) {
        let mut seg = line.trim_start_matches(|c| locale.whitespace(c));
        while assignment.is_match(seg) {
            match seg.find(|c| locale.whitespace(c)) {
                Some(at) => {
                    let width = seg[at..].chars().next().map_or(1, char::len_utf8);
                    seg = seg[at + width..].trim_start_matches(|c| locale.whitespace(c));
                }
                None => {
                    seg = "";
                    break;
                }
            }
        }
        if seg.is_empty() {
            continue;
        }
        if patterns.grep.is_match(seg)
            && patterns.recursive.is_match(seg)
            && !names_a_file(seg, root, host, repo)
        {
            return Ok(block(
                "recursive content search through the shell",
                host,
                repo,
            ));
        }
        if patterns.rg.is_match(seg)
            && !patterns.no_content.is_match(seg)
            && !names_a_file(seg, root, host, repo)
        {
            return Ok(block(
                "content search through the shell (rg is recursive by default)",
                host,
                repo,
            ));
        }
    }
    Ok(Search::Pass)
}
