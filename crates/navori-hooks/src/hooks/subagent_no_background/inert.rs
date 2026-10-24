//! Literal policy transforms from inert-skeleton.sh and subagent-no-background.sh.
//!
//! These are the existing conservative text rules, not a shell parser. In particular, quote
//! matching and separator splitting preserve the shell partial's documented limitations.

use std::sync::LazyLock;

use regex::Regex;

use super::input::Locale;
use crate::runner::Failure;

pub(super) const CMD_MAX: usize = 131_072;
const LINE_MAX: usize = 4096;
const HEREDOC_PROBE_MAX: usize = 64;

struct Rules {
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
    background: Regex,
    detached: Regex,
}

impl Rules {
    /// Compile literal ERE equivalents once; newline exclusions model sed's line-by-line input.
    fn new(locale: Locale) -> Result<Self, regex::Error> {
        let re = |pattern: &str| Regex::new(&pattern.replace("[:space:]", locale.space_class()));
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
            background: re(r"(^|[^&>|<\\])&([^&>]|$)")?,
            detached: re(
                r"^[[:space:]]*(((sudo|env|time|command|exec)[[:space:]]+)+)?(nohup|setsid|disown)([[:space:]]|$)",
            )?,
        })
    }
}

static UTF8_RULES: LazyLock<Result<Rules, regex::Error>> =
    LazyLock::new(|| Rules::new(Locale::Utf8));
static GNU_UTF8_RULES: LazyLock<Result<Rules, regex::Error>> =
    LazyLock::new(|| Rules::new(Locale::GnuUtf8));
static C_RULES: LazyLock<Result<Rules, regex::Error>> = LazyLock::new(|| Rules::new(Locale::C));

fn whitespace(c: char, locale: Locale) -> bool {
    locale.whitespace(c)
}

/// sed processes independent lines; an ERE whitespace class cannot consume the next line.
fn sed(re: &Regex, text: &str, replacement: &str) -> String {
    text.split('\n')
        .map(|line| re.replace_all(line, replacement))
        .collect::<Vec<_>>()
        .join("\n")
}

fn remove_quotes(text: &str, rules: &Rules) -> String {
    rules
        .double
        .replace_all(&rules.single.replace_all(text, ""), "")
        .into_owned()
}

/// Keep only the original skeleton's live heredoc lines and preserve its bounded-work guards.
fn skeleton(cmd: &str, rules: &Rules, locale: Locale) -> Result<String, String> {
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
            if line.trim_matches(|c| whitespace(c, locale)) == delimiter {
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
        let probe = remove_quotes(&probe, rules).replace("<<<", " ");
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

/// Apply the existing whole-command execution tell, quoted body flags and segment transforms.
pub(super) fn reason(cmd: &str, locale: Locale) -> Result<Option<String>, Failure> {
    let rules = match locale {
        Locale::Utf8 => &UTF8_RULES,
        Locale::GnuUtf8 => &GNU_UTF8_RULES,
        Locale::C => &C_RULES,
    }
    .as_ref()
    .map_err(|e| Failure(format!("inert policy pattern: {e}")))?;
    let mut live = match skeleton(cmd, rules, locale) {
        Ok(skeleton) => skeleton,
        Err(reason) => return Ok(Some(reason)),
    };
    let whole = has_expansion(&live, rules);
    live = sed(&rules.flags, &live, "${1}${2} ''");
    let tell = sed(&rules.command, &live, "$1");
    let tell = sed(&rules.backslash, &tell, " $1");
    let tell = sed(&rules.wrappers, &tell, " ");
    let tell = sed(&rules.unquote_single, &tell, "$1");
    let tell = sed(&rules.unquote_double, &tell, "$1");
    if whole || tell.split('\n').any(|line| rules.execution.is_match(line)) {
        live = cmd.to_owned();
    }
    let flat = remove_quotes(&live.replace('\n', " "), rules);
    if rules.background.is_match(&flat) {
        return Ok(Some(
            "operador de shell & (segundo plano) dentro de un subagente".to_owned(),
        ));
    }
    let scan = live.replace("\\\n", " ");
    let scan = sed(&rules.command, &scan, "$1");
    let scan = sed(&rules.backslash, &scan, " $1");
    let scan = scan.replace('(', " ");
    let split = scan
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|'], "\n");
    for segment in split.split('\n') {
        let mut segment = segment
            .trim_start_matches(|c| whitespace(c, locale))
            .to_owned();
        while rules.assignment.is_match(&segment) {
            segment = rules.assignment.replace(&segment, "").into_owned();
        }
        if rules.detached.is_match(&segment) {
            return Ok(Some(
                "nohup/setsid/disown dentro de un subagente".to_owned(),
            ));
        }
    }
    Ok(None)
}
