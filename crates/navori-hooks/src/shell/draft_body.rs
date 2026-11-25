//! The `draft-body` partial (spec 0060 T14): which file or inline text carries the body a
//! confirm hook shows before something is published, and its bounded preview. Shared by
//! `comment-draft-confirm` and the Pi copy of `pr-publisher-confirm`.
//!
//! The ADF and GraphQL extractions run the same `jq` or `node` program the script runs, through a
//! [`DraftHost`]; everything else is reproduced here. Anything Bash would answer with its own
//! diagnostics (a NUL in a capture) or that depends on how a locale slices non-ASCII text the
//! port does not model is a [`Failure`], which defers the call to the shell.

use std::sync::LazyLock;

use regex::Regex;

use super::Locale;
use crate::runner::Failure;

/// What a draft is: the row a confirm hook classified (`nv_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `gh pr|issue comment`.
    GhComment,
    /// `gh pr review` with a body.
    GhReview,
    /// `gh issue create`.
    GhIssueCreate,
    /// `gh pr create` (the Pi copy of pr-publisher-confirm).
    GhPrOpen,
    /// `gh api graphql` with a comment/review mutation.
    GhApiGraphql,
    /// `gh api` REST write to comments/reviews/issues.
    GhApiRest,
    /// `acli jira workitem comment create`.
    AcliCreate,
    /// `acli jira workitem comment update`.
    AcliUpdate,
}

/// The programs the partial runs when only `node` can parse JSON, read from the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePrograms {
    /// `nv_adf_text_from_file`'s `node -e` program.
    pub adf: String,
    /// `nv_gql_body_from_input`'s `node -e` program.
    pub gql: String,
}

impl NodePrograms {
    /// The two `node -e '…'` programs of the expanded partial.
    ///
    /// # Errors
    /// A script without exactly one of each.
    pub fn from_script(source: &str) -> Result<Self, String> {
        let programs: Vec<&str> = source
            .split("node -e '")
            .skip(1)
            .filter_map(|rest| rest.split_once('\'').map(|(program, _)| program))
            .collect();
        let one = |marker: &str, what: &str| -> Result<String, String> {
            let mut found = programs.iter().filter(|p| p.contains(marker));
            let program = found.next().ok_or(format!("{what} program is missing"))?;
            if found.next().is_some() {
                return Err(format!("{what} program is ambiguous"));
            }
            Ok((*program).to_owned())
        };
        Ok(Self {
            adf: one("walk(data)", "ADF")?,
            gql: one("d.variables", "GraphQL body")?,
        })
    }
}

/// Facts the partial reads.
pub trait DraftHost {
    /// `[ -n p ] && [ p != - ] && [ -f p ] && [ -r p ]`, then `head -c 200000 -- p`: the bytes,
    /// `None` when the path is not a readable regular file.
    fn read_head(&self, path: &str) -> Option<Vec<u8>>;
    /// `$(program args… 2>/dev/null)`: stdout whatever the exit status.
    ///
    /// # Errors
    /// A run the port cannot reproduce.
    fn output(&self, program: &str, args: &[&str]) -> Result<Vec<u8>, Failure>;
}

/// What the partial decides (`nv_body_source`, `nv_reason`, `nv_bound_file`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    /// `none`, `inline`, `gql-text` or `file`.
    pub source: &'static str,
    /// The text the user reads before confirming.
    pub reason: String,
    /// The file the preview was bound to, empty when none.
    pub bound_file: String,
}

/// The caller's inputs to `navori_draft_body`.
pub struct Request<'a> {
    /// `$cmd`.
    pub cmd: &'a str,
    /// `nv_kind`.
    pub kind: Kind,
    /// `nv_label`.
    pub label: &'a str,
    /// `NV_FALLBACK_REASON`.
    pub fallback: &'a str,
    /// `nv_have_jq`.
    pub have_jq: bool,
    /// The programs used when only `node` is available.
    pub node: &'a NodePrograms,
    /// The shell locale.
    pub locale: Locale,
}

const PREVIEW_MAX: usize = 1500;

struct Patterns {
    body_inline: Regex,
    gql_body_file: Regex,
    gql_body_inline: Regex,
    rest_field_file: Regex,
}

fn patterns(locale: Locale) -> Result<Patterns, regex::Error> {
    Ok(Patterns {
        body_inline: locale.ere(r"(^|[[:space:]])(-b|--body)([[:space:]=]|$)")?,
        gql_body_file: locale.ere(r"-F[[:space:]]+body=@[^[:space:]]+")?,
        gql_body_inline: locale.ere(r"-f[[:space:]]+body=[^[:space:]]+")?,
        rest_field_file: locale.ere(r"-F[[:space:]]+[A-Za-z0-9_]+=@[^[:space:]]+")?,
    })
}

fn compiled(locale: Locale) -> Result<&'static Patterns, Failure> {
    const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
    static COMPILED: LazyLock<Vec<Result<Patterns, regex::Error>>> =
        LazyLock::new(|| LOCALES.into_iter().map(patterns).collect());
    let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
    COMPILED
        .get(column)
        .ok_or_else(|| Failure("draft patterns missing".to_owned()))?
        .as_ref()
        .map_err(|error| Failure(format!("draft pattern: {error}")))
}

/// `printf '%s' "$text" | grep -qE re`.
pub fn any_line(re: &Regex, text: &str) -> bool {
    text.split('\n').any(|line| re.is_match(line))
}

/// `printf '%s' "$text" | grep -oE re | head -1`, for patterns without alternation, where the
/// leftmost-first match is POSIX's leftmost-longest.
fn first_match<'t>(re: &Regex, text: &'t str) -> Option<&'t str> {
    text.split('\n')
        .find_map(|line| re.find(line).map(|m| m.as_str()))
}

/// The longest value `('[^']*'|"[^"]*"|[^[:space:]]+)` matches at the start of `rest`.
fn flag_value_len(rest: &str, locale: Locale) -> usize {
    let run = rest
        .char_indices()
        .find(|(_, c)| locale.whitespace(*c))
        .map_or(rest.len(), |(at, _)| at);
    let quoted = |quote: char| -> usize {
        rest.strip_prefix(quote)
            .and_then(|inner| inner.find(quote))
            .map_or(0, |end| end + 2)
    };
    run.max(quoted('\'')).max(quoted('"'))
}

/// `nv_flag_value text flags`: the value of the first `(^|[[:space:]])(flags)(=|[[:space:]]+)`
/// occurrence, with one surrounding quote dropped from each end, as the partial's `grep -oE |
/// head -1 | sed` reads it (POSIX leftmost-longest).
#[must_use]
pub fn flag_value(text: &str, flags: &[&str], locale: Locale) -> String {
    for line in text.split('\n') {
        let mut starts: Vec<usize> = vec![0];
        starts.extend(
            line.char_indices()
                .filter(|(_, c)| locale.whitespace(*c))
                .map(|(at, c)| at + c.len_utf8()),
        );
        // Leftmost START: a whitespace boundary at `at` begins the match one character before.
        let mut best: Option<(usize, usize, usize)> = None; // (match start, value start, value len)
        for &flag_at in &starts {
            let rest = &line[flag_at..];
            for flag in flags {
                let Some(after) = rest.strip_prefix(flag) else {
                    continue;
                };
                let sep = if after.starts_with('=') {
                    1
                } else {
                    after
                        .char_indices()
                        .find(|(_, c)| !locale.whitespace(*c))
                        .map_or(after.len(), |(at, _)| at)
                };
                if sep == 0 {
                    continue;
                }
                let value_at = flag_at + flag.len() + sep;
                let len = flag_value_len(&line[value_at..], locale);
                if len == 0 {
                    continue;
                }
                let start = if flag_at == 0 {
                    0
                } else {
                    line[..flag_at]
                        .char_indices()
                        .last()
                        .map_or(0, |(at, _)| at)
                };
                if best.is_none_or(|(s, _, _)| start < s) {
                    best = Some((start, value_at, len));
                }
            }
        }
        if let Some((_, value_at, len)) = best {
            let value = &line[value_at..value_at + len];
            let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
            return value.strip_suffix(['\'', '"']).unwrap_or(value).to_owned();
        }
    }
    String::new()
}

/// `$(…)`: the capture without trailing newlines; a NUL is not reproduced.
pub fn substitution(mut bytes: Vec<u8>) -> Result<Vec<u8>, Failure> {
    if bytes.contains(&0) {
        return Err(Failure(
            "a command substitution printed a NUL byte".to_owned(),
        ));
    }
    while bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    Ok(bytes)
}

fn text(bytes: Vec<u8>) -> Result<String, Failure> {
    String::from_utf8(substitution(bytes)?)
        .map_err(|_| Failure("draft text is not UTF-8".to_owned()))
}

/// `nv_truncate`, as `$(…)` captures it: at most 1,500 characters plus the count of what was
/// cut. Under `LC_ALL=C` the shell counts bytes, so only ASCII text is reproduced there.
fn preview(text: &str, locale: Locale) -> Result<String, Failure> {
    if locale == Locale::C && !text.is_ascii() {
        return Err(Failure(
            "a byte-counted preview of non-ASCII text".to_owned(),
        ));
    }
    let len = text.chars().count();
    let out = if len > PREVIEW_MAX {
        let cut = text
            .char_indices()
            .nth(PREVIEW_MAX)
            .map_or(text.len(), |(at, _)| at);
        format!(
            "{}\n[+{} caracteres omitidos]",
            &text[..cut],
            len - PREVIEW_MAX
        )
    } else {
        text.to_owned()
    };
    Ok(out.trim_end_matches('\n').to_owned())
}

/// `navori_draft_body`.
///
/// # Errors
/// A capture or text the port does not reproduce, or a host failure.
pub fn draft(request: &Request<'_>, host: &dyn DraftHost) -> Result<Draft, Failure> {
    let Request {
        cmd,
        kind,
        label,
        fallback,
        have_jq,
        node,
        locale,
    } = *request;
    let p = compiled(locale)?;
    let mut source = "none";
    let mut body_path = String::new();
    let mut bound_file = String::new();
    let mut sniff_adf = false;
    let mut force_adf = false;
    let mut gql_text = String::new();
    let read = |path: &str| -> Result<Option<String>, Failure> {
        if path.is_empty() || path == "-" {
            return Ok(None);
        }
        host.read_head(path).map(text).transpose()
    };
    let json = |path: &str, jq: &str, program: &str| -> Result<String, Failure> {
        let out = if have_jq {
            host.output("jq", &["-r", jq, path])?
        } else {
            host.output("node", &["-e", program, path])?
        };
        text(out)
    };
    match kind {
        Kind::GhComment | Kind::GhReview | Kind::GhIssueCreate | Kind::GhPrOpen => {
            body_path = flag_value(cmd, &["-F", "--body-file"], locale);
            if !body_path.is_empty() && body_path != "-" {
                source = "file";
            } else if any_line(&p.body_inline, cmd) {
                source = "inline";
            }
        }
        Kind::GhApiGraphql => {
            if let Some(m) = first_match(&p.gql_body_file, cmd) {
                body_path = m
                    .split_once("body=@")
                    .map(|(_, path)| path.to_owned())
                    .unwrap_or_default();
            }
            if !body_path.is_empty() {
                source = "file";
            } else if any_line(&p.gql_body_inline, cmd) {
                source = "inline";
            } else {
                let input = flag_value(cmd, &["--input"], locale);
                if !input.is_empty() && input != "-" && read(&input)?.is_some() {
                    gql_text = json(&input, "(.variables.body // .body // empty)", &node.gql)?;
                    if !gql_text.is_empty() {
                        source = "gql-text";
                        bound_file = input;
                    }
                }
            }
        }
        Kind::GhApiRest => {
            body_path = flag_value(cmd, &["--input"], locale);
            if body_path.is_empty()
                && let Some(m) = first_match(&p.rest_field_file, cmd)
            {
                body_path = m
                    .split_once("=@")
                    .map(|(_, path)| path.to_owned())
                    .unwrap_or_default();
            }
            if !body_path.is_empty() && body_path != "-" {
                source = "file";
            }
        }
        Kind::AcliCreate => {
            body_path = flag_value(cmd, &["-F", "--body-file"], locale);
            if !body_path.is_empty() {
                source = "file";
                sniff_adf = true;
            } else if any_line(&p.body_inline, cmd) {
                source = "inline";
            }
        }
        Kind::AcliUpdate => {
            body_path = flag_value(cmd, &["--body-adf"], locale);
            if !body_path.is_empty() {
                source = "file";
                force_adf = true;
            } else {
                body_path = flag_value(cmd, &["-F", "--body-file"], locale);
                if !body_path.is_empty() {
                    source = "file";
                    sniff_adf = true;
                } else if any_line(&p.body_inline, cmd) {
                    source = "inline";
                }
            }
        }
    }
    let reason = match source {
        "inline" => format!(
            "[navori] this call publishes {label}. Its body is inline in the command above — review it there before confirming."
        ),
        "gql-text" => format!(
            "[navori] this call publishes {label}. `body` variable:\n\n{}",
            preview(&gql_text, locale)?
        ),
        "file" => {
            bound_file.clone_from(&body_path);
            match read(&body_path)? {
                Some(content) => {
                    let leading = content
                        .trim_start_matches(|c| locale.whitespace(c))
                        .starts_with('{');
                    let mut shown = content.clone();
                    if force_adf || (sniff_adf && leading) {
                        let adf = json(
                            &body_path,
                            r#"[.. | .text? // empty] | join(" ")"#,
                            &node.adf,
                        )?;
                        if !adf.is_empty() {
                            shown = adf;
                        }
                    }
                    format!(
                        "[navori] this call publishes {label} from file '{body_path}':\n\n{}",
                        preview(&shown, locale)?
                    )
                }
                None => fallback.to_owned(),
            }
        }
        _ => fallback.to_owned(),
    };
    Ok(Draft {
        source,
        reason,
        bound_file,
    })
}

/// A JSON string as `jq -c` prints it: `\uXXXX` for control characters and DEL.
#[must_use]
pub fn jq_string(text: &str) -> String {
    json_string(text, true)
}

/// A JSON string as `JSON.stringify` prints it: DEL stays raw.
#[must_use]
pub fn js_string(text: &str) -> String {
    json_string(text, false)
}

fn json_string(text: &str, escape_del: bool) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || (escape_del && c == '\u{7f}') => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The hook output the script builds with `jq -cn` (newline-terminated) or with `node -e` and
/// `JSON.stringify` (no newline): the decision, its reason and, when bound, `navoriBodyFiles`.
#[must_use]
pub fn decision_json(decision: &str, reason: &str, body_file: Option<&str>, jq: bool) -> String {
    let s = if jq { jq_string } else { js_string };
    let mut out = format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":{},\"permissionDecisionReason\":{}}}",
        s(decision),
        s(reason)
    );
    if let Some(file) = body_file {
        out.push_str(&format!(",\"navoriBodyFiles\":[{}]", s(file)));
    }
    out.push('}');
    if jq {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Locale, decision_json, flag_value, jq_string, js_string, preview};

    // Covers: R72
    #[test]
    fn flag_values_read_like_grep_o_and_sed() {
        let u = Locale::Utf8;
        assert_eq!(
            flag_value(
                "gh pr comment 5 --body-file /tmp/x.md",
                &["-F", "--body-file"],
                u
            ),
            "/tmp/x.md"
        );
        assert_eq!(
            flag_value("gh pr comment 5 -F 'a b.md' --x", &["-F", "--body-file"], u),
            "a b.md"
        );
        assert_eq!(
            flag_value("gh pr comment 5 -F='a'b", &["-F", "--body-file"], u),
            "a'b"
        );
        assert_eq!(
            flag_value("gh pr comment 5 --body x", &["-F", "--body-file"], u),
            ""
        );
        assert_eq!(
            flag_value("x\ngh api --input  body.json", &["--input"], u),
            "body.json"
        );
        assert_eq!(flag_value("gh-F x", &["-F"], u), "");
    }

    // Covers: R72
    #[test]
    fn previews_and_json_follow_the_script_tools() -> Result<(), super::Failure> {
        let long = "é".repeat(1501);
        assert!(preview(&long, Locale::Utf8)?.ends_with("\n[+1 caracteres omitidos]"));
        assert!(preview(&long, Locale::C).is_err());
        assert_eq!(preview("a\n\n", Locale::Utf8)?, "a");
        assert_eq!(jq_string("a\u{7f}\u{1}\n"), "\"a\\u007f\\u0001\\n\"");
        assert_eq!(js_string("a\u{7f}"), "\"a\u{7f}\"");
        assert!(
            decision_json("ask", "r", Some("f"), true).ends_with("\"navoriBodyFiles\":[\"f\"]}\n")
        );
        assert!(decision_json("ask", "r", None, false).ends_with("\"r\"}}"));
        Ok(())
    }
}
