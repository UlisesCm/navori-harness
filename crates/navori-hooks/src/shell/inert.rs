//! Literal transforms of `_partials/inert-skeleton.sh`: skeleton, live text, scan and segments.
//!
//! These are the partial's conservative text rules, not a shell parser. Quote matching and
//! separator splitting preserve the partial's documented limitations. sed and grep read one
//! line at a time, so every pattern here is applied per line.

use std::sync::{LazyLock, OnceLock};

use regex::Regex;

use super::Locale;

/// Total bytes the partial inspects (`CMD_MAX`).
pub const CMD_MAX: usize = 131_072;
const LINE_MAX: usize = 4096;
const HEREDOC_PROBE_MAX: usize = 64;

/// One lazily compiled pattern: built on first use, the outcome kept for the process.
type Lazy = OnceLock<Result<Regex, String>>;

/// Compile-on-demand cells, one per pattern of the partial.
#[derive(Default)]
struct Cells {
    single: Lazy,
    double: Lazy,
    quoted_single_delimiter: Lazy,
    quoted_double_delimiter: Lazy,
    escaped_delimiter: Lazy,
    opener: Lazy,
    script: Lazy,
    flags: Lazy,
    command: Lazy,
    backslash: Lazy,
    wrappers: Lazy,
    unquote_single: Lazy,
    unquote_double: Lazy,
    execution: Lazy,
    assignment: Lazy,
}

const EXECUTION: &str = concat!(
    r"(?m)(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*",
    r"((sudo|doas|env|command|nohup|timeout|time|nice|ionice|stdbuf|setsid)",
    r"([[:space:]]+(-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|[0-9][^[:space:]]*))*[[:space:]]+)*",
    r"((bash|sh|zsh|ksh|dash|ash|fish|tcsh|csh|source|eval|exec|xargs|python[0-9.]*|node|deno|bun|perl|ruby|osascript)([[:space:]]|$)|\.[[:space:]]|[.~]?/|\$[A-Za-z_])"
);

/// The partial's patterns for one locale, each compiled on first use: a short command that
/// never reaches a rule (no `<<`, cut by the fast path) pays for none of them. They are static,
/// so the only error is an invalid pattern, a build defect `every_inert_pattern_compiles` rules
/// out, never an input-dependent failure.
pub struct Rules {
    cells: Cells,
    /// Locale whose space class these patterns use.
    pub locale: Locale,
}

impl Rules {
    /// Rules for `locale`, one per process; nothing is compiled until a pattern is used.
    #[must_use]
    pub fn get(locale: Locale) -> &'static Self {
        static UTF8: LazyLock<Rules> = LazyLock::new(|| Rules::new(Locale::Utf8));
        static GNU_UTF8: LazyLock<Rules> = LazyLock::new(|| Rules::new(Locale::GnuUtf8));
        static C: LazyLock<Rules> = LazyLock::new(|| Rules::new(Locale::C));
        match locale {
            Locale::Utf8 => &UTF8,
            Locale::GnuUtf8 => &GNU_UTF8,
            Locale::C => &C,
        }
    }

    fn new(locale: Locale) -> Self {
        Self {
            cells: Cells::default(),
            locale,
        }
    }

    /// Rules whose every pattern failed to compile: the build defect
    /// `every_inert_pattern_compiles` rules out, for the callers' fail-closed branches.
    #[cfg(test)]
    pub(crate) fn broken(locale: Locale) -> Self {
        let rules = Self::new(locale);
        let c = &rules.cells;
        for cell in [
            &c.single,
            &c.double,
            &c.quoted_single_delimiter,
            &c.quoted_double_delimiter,
            &c.escaped_delimiter,
            &c.opener,
            &c.script,
            &c.flags,
            &c.command,
            &c.backslash,
            &c.wrappers,
            &c.unquote_single,
            &c.unquote_double,
            &c.execution,
            &c.assignment,
        ] {
            let _ = cell.set(Err("inert policy pattern: broken for a test".to_owned()));
        }
        rules
    }

    /// Literal ERE equivalent of `pattern`, compiled once; newline exclusions model sed's
    /// line-by-line input.
    fn re<'a>(&self, cell: &'a Lazy, pattern: &str) -> Result<&'a Regex, String> {
        cell.get_or_init(|| {
            self.locale
                .ere(pattern)
                .map_err(|e| format!("inert policy pattern: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
    }

    fn single(&self) -> Result<&Regex, String> {
        self.re(&self.cells.single, r"'[^'\n]*'")
    }

    fn double(&self) -> Result<&Regex, String> {
        self.re(&self.cells.double, r#""[^"\n]*""#)
    }

    fn quoted_single_delimiter(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.quoted_single_delimiter,
            r"<<(-?)[[:space:]]*'([A-Za-z_][A-Za-z0-9_]*)'",
        )
    }

    fn quoted_double_delimiter(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.quoted_double_delimiter,
            r#"<<(-?)[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)""#,
        )
    }

    fn escaped_delimiter(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.escaped_delimiter,
            r"<<(-?)[[:space:]]*\\([A-Za-z_][A-Za-z0-9_]*)",
        )
    }

    fn opener(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.opener,
            r"^[^<]*<<-?[[:space:]]*(@navoriQ@)?([A-Za-z_][A-Za-z0-9_]*)",
        )
    }

    fn script(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.script,
            r#"(?i)\.(sh|bash|zsh|ksh|fish|py|rb|pl|js|jsx|mjs|cjs|ts|tsx|command|bat|ps1|scpt)([[:space:]]|["'`]|$)"#,
        )
    }

    fn flags(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.flags,
            r#"(?m)(^|[[:space:]])(-m|--message|--body|--title|--description|--notes)([[:space:]]+|=)('[^'\n]*'|"[^"\n]*")"#,
        )
    }

    fn command(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.command,
            r"(?m)(^|[;&|]|[[:space:]])command[[:space:]]+",
        )
    }

    fn backslash(&self) -> Result<&Regex, String> {
        self.re(&self.cells.backslash, r"\\([A-Za-z])")
    }

    fn wrappers(&self) -> Result<&Regex, String> {
        self.re(&self.cells.wrappers, r"[(){}]")
    }

    fn unquote_single(&self) -> Result<&Regex, String> {
        self.re(&self.cells.unquote_single, r"'([^'\n]*)'")
    }

    fn unquote_double(&self) -> Result<&Regex, String> {
        self.re(&self.cells.unquote_double, r#""([^"\n]*)""#)
    }

    fn execution(&self) -> Result<&Regex, String> {
        self.re(&self.cells.execution, EXECUTION)
    }

    fn assignment(&self) -> Result<&Regex, String> {
        self.re(
            &self.cells.assignment,
            r"^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*([[:space:]]+|$)",
        )
    }

    /// Drop single- then double-quoted spans, as `sed -E "s/'[^']*'//g" -e 's/"[^"]*"//g'`.
    ///
    /// # Errors
    /// Returns the message of an invalid pattern (a build defect, see [`Rules`]).
    pub fn remove_quotes(&self, text: &str) -> Result<String, String> {
        let single = self.single()?;
        Ok(self
            .double()?
            .replace_all(&single.replace_all(text, ""), "")
            .into_owned())
    }
}

/// sed processes independent lines; an ERE whitespace class cannot consume the next line.
#[must_use]
pub fn sed(re: &Regex, text: &str, replacement: &str) -> String {
    text.split('\n')
        .map(|line| re.replace_all(line, replacement))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `navori_inert_skeleton`: keep only live heredoc lines, with the partial's bounded-work
/// ceilings. The inner `Err` carries the `block` message of a ceiling (audit reason
/// `oversize`); the outer one an invalid pattern (a build defect, see [`Rules`]).
///
/// # Errors
/// Returns the message of an invalid pattern.
pub fn skeleton(cmd: &str, rules: &Rules) -> Result<Result<String, String>, String> {
    if !cmd.contains("<<") {
        return Ok(Ok(format!("{cmd}\n")));
    }
    let mut kept = Vec::new();
    let mut delimiter = String::new();
    let mut inert = false;
    let mut expand = false;
    let mut probes = 0;
    // A here-string appends a newline; split includes the final empty line if cmd already ended
    // in one, just as read does. No extra final empty line is added for a non-newline suffix.
    for (index, line) in cmd.split('\n').enumerate() {
        if index >= LINE_MAX {
            return Ok(Err(format!(
                "too many lines to inspect (> {LINE_MAX}) — nothing in it was evaluated"
            )));
        }
        if !delimiter.is_empty() {
            if line.trim_matches(|c| rules.locale.whitespace(c)) == delimiter {
                delimiter.clear();
            } else if !inert || (expand && (line.contains("$(") || line.contains('`'))) {
                kept.push(line);
            }
            continue;
        }
        kept.push(line);
        if !line.contains("<<") {
            continue;
        }
        probes += 1;
        if probes > HEREDOC_PROBE_MAX {
            return Ok(Err(format!(
                "too many heredoc openers to inspect (> {HEREDOC_PROBE_MAX}) — nothing in it was evaluated"
            )));
        }
        let probe = rules
            .quoted_single_delimiter()?
            .replace_all(line, "<<${1}@navoriQ@${2}");
        let probe = rules
            .quoted_double_delimiter()?
            .replace_all(&probe, "<<${1}@navoriQ@${2}");
        let probe = rules
            .escaped_delimiter()?
            .replace_all(&probe, "<<${1}@navoriQ@${2}");
        let probe = rules.remove_quotes(&probe)?.replace("<<<", " ");
        if probe.contains(['\'', '"']) {
            continue;
        }
        if let Some(caps) = rules.opener()?.captures(&probe) {
            delimiter = caps.get(2).map_or("", |m| m.as_str()).to_owned();
            inert = !rules.script()?.is_match(line);
            expand = caps.get(1).is_none();
        }
    }
    Ok(Ok(format!("{}\n", kept.join("\n").trim_end_matches('\n'))))
}

fn has_expansion(text: &str, rules: &Rules) -> Result<bool, String> {
    let unquoted = rules.single()?.replace_all(text, "");
    Ok(unquoted.contains("$(")
        || unquoted.contains('`')
        || rules
            .double()?
            .find_iter(text)
            .any(|m| m.as_str().contains("$(") || m.as_str().contains('`')))
}

/// `navori_inert_live`: the elided skeleton, or the whole command when anything in it can run
/// what was written (a substitution, or a segment starting with an interpreter or a path).
///
/// # Errors
/// Returns the message of an invalid pattern (a build defect, see [`Rules`]).
pub fn live(cmd: &str, skeleton: &str, rules: &Rules) -> Result<String, String> {
    let whole = has_expansion(skeleton, rules)?;
    let elided = sed(rules.flags()?, skeleton, "${1}${2} ''");
    let tell = sed(rules.command()?, &elided, "$1");
    let tell = sed(rules.backslash()?, &tell, " $1");
    let tell = sed(rules.wrappers()?, &tell, " ");
    let tell = sed(rules.unquote_single()?, &tell, "$1");
    let tell = sed(rules.unquote_double()?, &tell, "$1");
    let execution = rules.execution()?;
    Ok(
        if whole || tell.split('\n').any(|line| execution.is_match(line)) {
            cmd.to_owned()
        } else {
            elided
        },
    )
}

/// `scan` of `navori_inert_segments`: continuations joined, `command `, `\x` and `(` neutralized.
///
/// # Errors
/// Returns the message of an invalid pattern (a build defect, see [`Rules`]).
pub fn scan(live: &str, rules: &Rules) -> Result<String, String> {
    let scan = live.replace("\\\n", " ");
    let scan = sed(rules.command()?, &scan, "$1");
    let scan = sed(rules.backslash()?, &scan, " $1");
    Ok(scan.replace('(', " "))
}

/// `segments` of `navori_inert_segments`: one per separator, leading blanks and `VAR=value`
/// prefixes peeled so each starts with its command word.
///
/// # Errors
/// Returns the message of an invalid pattern (a build defect, see [`Rules`]).
pub fn segments(scan: &str, rules: &Rules) -> Result<Vec<String>, String> {
    let assignment = rules.assignment()?;
    Ok(scan
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|'], "\n")
        .split('\n')
        .map(|segment| {
            let mut segment = segment
                .trim_start_matches(|c| rules.locale.whitespace(c))
                .to_owned();
            while assignment.is_match(&segment) {
                segment = assignment.replace(&segment, "").into_owned();
            }
            segment
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lazy compilation moves an invalid pattern from `Rules::get` to its first use; this keeps
    /// it a build defect by compiling every pattern of every locale.
    #[test]
    fn every_inert_pattern_compiles() {
        for locale in [Locale::Utf8, Locale::GnuUtf8, Locale::C] {
            let r = Rules::get(locale);
            let regexes = [
                r.single(),
                r.double(),
                r.quoted_single_delimiter(),
                r.quoted_double_delimiter(),
                r.escaped_delimiter(),
                r.opener(),
                r.script(),
                r.flags(),
                r.command(),
                r.backslash(),
                r.wrappers(),
                r.unquote_single(),
                r.unquote_double(),
                r.execution(),
                r.assignment(),
            ];
            for (i, regex) in regexes.iter().enumerate() {
                assert!(
                    regex.is_ok(),
                    "{locale:?} inert regex #{i}: {:?}",
                    regex.as_ref().err()
                );
            }
        }
    }

    /// A command without `<<` builds its skeleton without compiling a single pattern.
    #[test]
    fn a_skeleton_without_heredoc_compiles_nothing() {
        let rules = Rules::new(Locale::C);
        assert_eq!(skeleton("ls -la", &rules), Ok(Ok("ls -la\n".to_owned())));
        assert!(rules.cells.single.get().is_none());
        assert!(rules.cells.opener.get().is_none());
    }
}
