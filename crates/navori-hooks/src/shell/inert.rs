//! Literal transforms of `_partials/inert-skeleton.sh`: skeleton, live text, scan and segments.
//!
//! These are the partial's conservative text rules, not a shell parser. Quote matching and
//! separator splitting preserve the partial's documented limitations. sed and grep read one
//! line at a time, so every pattern here is applied per line.

use std::sync::LazyLock;

use regex::Regex;

use super::Locale;

/// Total bytes the partial inspects (`CMD_MAX`).
pub const CMD_MAX: usize = 131_072;
const LINE_MAX: usize = 4096;
const HEREDOC_PROBE_MAX: usize = 64;

/// Compiled patterns of the partial for one locale.
pub struct Rules {
    single: Regex,
    double: Regex,
    quoted_single_delimiter: Regex,
    quoted_double_delimiter: Regex,
    escaped_delimiter: Regex,
    opener: Regex,
    script: Regex,
    flags: Regex,
    command: Regex,
    backslash: Regex,
    wrappers: Regex,
    unquote_single: Regex,
    unquote_double: Regex,
    execution: Regex,
    assignment: Regex,
    /// Locale whose space class these patterns use.
    pub locale: Locale,
}

impl Rules {
    /// Compile literal ERE equivalents once; newline exclusions model sed's line-by-line input.
    fn new(locale: Locale) -> Result<Self, regex::Error> {
        let re = |pattern: &str| locale.ere(pattern);
        Ok(Self {
            single: re(r"'[^'\n]*'")?,
            double: re(r#""[^"\n]*""#)?,
            quoted_single_delimiter: re(r"<<(-?)[[:space:]]*'([A-Za-z_][A-Za-z0-9_]*)'")?,
            quoted_double_delimiter: re(r#"<<(-?)[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)""#)?,
            escaped_delimiter: re(r"<<(-?)[[:space:]]*\\([A-Za-z_][A-Za-z0-9_]*)")?,
            opener: re(r"^[^<]*<<-?[[:space:]]*(@navoriQ@)?([A-Za-z_][A-Za-z0-9_]*)")?,
            script: re(
                r#"(?i)\.(sh|bash|zsh|ksh|fish|py|rb|pl|js|jsx|mjs|cjs|ts|tsx|command|bat|ps1|scpt)([[:space:]]|["'`]|$)"#,
            )?,
            flags: re(
                r#"(?m)(^|[[:space:]])(-m|--message|--body|--title|--description|--notes)([[:space:]]+|=)('[^'\n]*'|"[^"\n]*")"#,
            )?,
            command: re(r"(?m)(^|[;&|]|[[:space:]])command[[:space:]]+")?,
            backslash: re(r"\\([A-Za-z])")?,
            wrappers: re(r"[(){}]")?,
            unquote_single: re(r"'([^'\n]*)'")?,
            unquote_double: re(r#""([^"\n]*)""#)?,
            execution: re(concat!(
                r"(?m)(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*",
                r"((sudo|doas|env|command|nohup|timeout|time|nice|ionice|stdbuf|setsid)",
                r"([[:space:]]+(-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|[0-9][^[:space:]]*))*[[:space:]]+)*",
                r"((bash|sh|zsh|ksh|dash|ash|fish|tcsh|csh|source|eval|exec|xargs|python[0-9.]*|node|deno|bun|perl|ruby|osascript)([[:space:]]|$)|\.[[:space:]]|[.~]?/|\$[A-Za-z_])"
            ))?,
            assignment: re(r"^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*([[:space:]]+|$)")?,
            locale,
        })
    }

    /// Rules for `locale`, compiled once per process.
    ///
    /// # Errors
    /// Returns a description of a pattern that failed to compile.
    pub fn get(locale: Locale) -> Result<&'static Self, String> {
        static UTF8: LazyLock<Result<Rules, regex::Error>> =
            LazyLock::new(|| Rules::new(Locale::Utf8));
        static GNU_UTF8: LazyLock<Result<Rules, regex::Error>> =
            LazyLock::new(|| Rules::new(Locale::GnuUtf8));
        static C: LazyLock<Result<Rules, regex::Error>> = LazyLock::new(|| Rules::new(Locale::C));
        match locale {
            Locale::Utf8 => &UTF8,
            Locale::GnuUtf8 => &GNU_UTF8,
            Locale::C => &C,
        }
        .as_ref()
        .map_err(|e| format!("inert policy pattern: {e}"))
    }

    /// Drop single- then double-quoted spans, as `sed -E "s/'[^']*'//g" -e 's/"[^"]*"//g'`.
    #[must_use]
    pub fn remove_quotes(&self, text: &str) -> String {
        self.double
            .replace_all(&self.single.replace_all(text, ""), "")
            .into_owned()
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
/// ceilings. An `Err` carries the `block` message of a ceiling (audit reason `oversize`).
///
/// # Errors
/// Returns the ceiling message when the command has too many lines or heredoc openers.
pub fn skeleton(cmd: &str, rules: &Rules) -> Result<String, String> {
    if !cmd.contains("<<") {
        return Ok(format!("{cmd}\n"));
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
            return Err(format!(
                "too many lines to inspect (> {LINE_MAX}) — nothing in it was evaluated"
            ));
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
            return Err(format!(
                "too many heredoc openers to inspect (> {HEREDOC_PROBE_MAX}) — nothing in it was evaluated"
            ));
        }
        let probe = rules
            .quoted_single_delimiter
            .replace_all(line, "<<${1}@navoriQ@${2}");
        let probe = rules
            .quoted_double_delimiter
            .replace_all(&probe, "<<${1}@navoriQ@${2}");
        let probe = rules
            .escaped_delimiter
            .replace_all(&probe, "<<${1}@navoriQ@${2}");
        let probe = rules.remove_quotes(&probe).replace("<<<", " ");
        if probe.contains(['\'', '"']) {
            continue;
        }
        if let Some(caps) = rules.opener.captures(&probe) {
            delimiter = caps.get(2).map_or("", |m| m.as_str()).to_owned();
            inert = !rules.script.is_match(line);
            expand = caps.get(1).is_none();
        }
    }
    Ok(format!("{}\n", kept.join("\n").trim_end_matches('\n')))
}

fn has_expansion(text: &str, rules: &Rules) -> bool {
    let unquoted = rules.single.replace_all(text, "");
    unquoted.contains("$(")
        || unquoted.contains('`')
        || rules
            .double
            .find_iter(text)
            .any(|m| m.as_str().contains("$(") || m.as_str().contains('`'))
}

/// `navori_inert_live`: the elided skeleton, or the whole command when anything in it can run
/// what was written (a substitution, or a segment starting with an interpreter or a path).
#[must_use]
pub fn live(cmd: &str, skeleton: &str, rules: &Rules) -> String {
    let whole = has_expansion(skeleton, rules);
    let elided = sed(&rules.flags, skeleton, "${1}${2} ''");
    let tell = sed(&rules.command, &elided, "$1");
    let tell = sed(&rules.backslash, &tell, " $1");
    let tell = sed(&rules.wrappers, &tell, " ");
    let tell = sed(&rules.unquote_single, &tell, "$1");
    let tell = sed(&rules.unquote_double, &tell, "$1");
    if whole || tell.split('\n').any(|line| rules.execution.is_match(line)) {
        cmd.to_owned()
    } else {
        elided
    }
}

/// `scan` of `navori_inert_segments`: continuations joined, `command `, `\x` and `(` neutralized.
#[must_use]
pub fn scan(live: &str, rules: &Rules) -> String {
    let scan = live.replace("\\\n", " ");
    let scan = sed(&rules.command, &scan, "$1");
    let scan = sed(&rules.backslash, &scan, " $1");
    scan.replace('(', " ")
}

/// `segments` of `navori_inert_segments`: one per separator, leading blanks and `VAR=value`
/// prefixes peeled so each starts with its command word.
#[must_use]
pub fn segments(scan: &str, rules: &Rules) -> Vec<String> {
    scan.replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|'], "\n")
        .split('\n')
        .map(|segment| {
            let mut segment = segment
                .trim_start_matches(|c| rules.locale.whitespace(c))
                .to_owned();
            while rules.assignment.is_match(&segment) {
                segment = rules.assignment.replace(&segment, "").into_owned();
            }
            segment
        })
        .collect()
}
