//! `impl_<feature>.json` (`ImplHandoffSchema`), its template (`renderImplHandoff`), the legacy
//! `.md` status line and the `markdownRequests` path rule of `lib/handoff`.

use std::sync::LazyLock;

use regex::Regex;

use super::{non_empty, object, optional, safe_integer, strings, text};
use crate::js_json::{JsValue, number_to_js};
use crate::posix::{normalize, relative, resolve};

/// One `markdownRequests` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkdownRequest {
    pub path: String,
    pub intent: String,
    pub evidence: String,
}

/// One `doubts` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Doubt {
    pub file: String,
    pub reason: String,
}

/// `verification`.
#[derive(Debug, Clone, PartialEq)]
pub struct Verification {
    pub command: String,
    pub exit_code: f64,
    pub summary: String,
}

/// The fields of `ImplHandoffSchema` the CLI reads, as zod returns them.
#[derive(Debug, Clone, PartialEq)]
pub struct ImplHandoff {
    pub feature: String,
    pub status: String,
    pub worktree: String,
    pub branch: String,
    pub commits: Vec<String>,
    pub files_touched: Vec<String>,
    pub verification: Verification,
    pub markdown_requests: Vec<MarkdownRequest>,
    pub root_cause: Option<String>,
    /// `.default([])`.
    pub blockers: Vec<String>,
    pub head: Option<String>,
    pub acceptance: Option<Vec<JsValue>>,
    pub doubts: Option<Vec<Doubt>>,
}

fn is_git_sha(text: &str) -> bool {
    text.len() == 40
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn markdown_request(value: &JsValue) -> Option<MarkdownRequest> {
    let o = object(value)?;
    Some(MarkdownRequest {
        path: non_empty(o.get("path")?)?,
        intent: non_empty(o.get("intent")?)?,
        evidence: non_empty(o.get("evidence")?)?,
    })
}

fn doubt(value: &JsValue) -> Option<Doubt> {
    let o = object(value)?;
    Some(Doubt {
        file: non_empty(o.get("file")?)?,
        reason: non_empty(o.get("reason")?)?,
    })
}

fn list<T>(value: &JsValue, item: fn(&JsValue) -> Option<T>) -> Option<Vec<T>> {
    match value {
        JsValue::Array(items) => items.iter().map(item).collect(),
        _ => None,
    }
}

/// `ImplHandoffSchema.safeParse(raw)`: `Some` when zod accepts it and every text is carried.
#[must_use]
pub fn parse(raw: &JsValue) -> Option<ImplHandoff> {
    let o = object(raw)?;
    let v = object(o.get("verification")?)?;
    let status = non_empty(o.get("status")?)?;
    if status != "DONE" && status != "BLOCKED" {
        return None;
    }
    let head = optional(o, "head", text)?;
    if head.as_deref().is_some_and(|h| !is_git_sha(h)) {
        return None;
    }
    let acceptance = optional(o, "acceptance", |value| match value {
        JsValue::Array(items) => Some(items.clone()),
        _ => None,
    })?;
    Some(ImplHandoff {
        feature: non_empty(o.get("feature")?)?,
        status,
        worktree: non_empty(o.get("worktree")?)?,
        branch: non_empty(o.get("branch")?)?,
        commits: strings(o.get("commits")?)?,
        files_touched: strings(o.get("filesTouched")?)?,
        verification: Verification {
            command: non_empty(v.get("command")?)?,
            exit_code: safe_integer(v.get("exitCode")?)?,
            summary: non_empty(v.get("summary")?)?,
        },
        markdown_requests: list(o.get("markdownRequests")?, markdown_request)?,
        root_cause: optional(o, "rootCause", text)?,
        blockers: optional(o, "blockers", strings)?.unwrap_or_default(),
        head,
        acceptance,
        doubts: optional(o, "doubts", |value| list(value, doubt))?,
    })
}

/// One `acceptance` entry (`acceptanceLine`); `None` for text Rust cannot carry.
fn acceptance_line(entry: &JsValue) -> Option<String> {
    let record = match entry {
        JsValue::Object(record) => Some(record),
        // An array is a record to `typeof`, with none of the keys.
        JsValue::Array(_) => None,
        _ => return Some(format!("- {}", entry.stringify(None)?)),
    };
    let field = |key: &str| record.and_then(|r| r.get(key));
    let text_of = |key: &str| match field(key) {
        Some(JsValue::String(s)) => s.to_rust(),
        _ => Some(String::new()),
    };
    let exit = match field("exitCode") {
        Some(JsValue::Number(n)) => format!(" exit {}", number_to_js(*n)),
        _ => String::new(),
    };
    let excerpt = text_of("excerpt")?;
    let excerpt = if excerpt.is_empty() {
        String::new()
    } else {
        format!(" — {excerpt}")
    };
    let id = text_of("id")?;
    let id = if id.is_empty() { "?".to_owned() } else { id };
    Some(format!("- {id}: `{}`{exit}{excerpt}", text_of("command")?))
}

/// `renderImplHandoff(impl)`; `None` for an `acceptance` entry with a lone surrogate.
#[must_use]
pub fn render(impl_: &ImplHandoff) -> Option<String> {
    let list = |items: Vec<String>| {
        if items.is_empty() {
            vec!["(none)".to_owned()]
        } else {
            items.into_iter().map(|item| format!("- {item}")).collect()
        }
    };
    let commits = if impl_.commits.is_empty() {
        "(none)".to_owned()
    } else {
        impl_.commits.join(", ")
    };
    let mut lines = vec![
        format!("# Implementation handoff: {}", impl_.feature),
        String::new(),
        format!("- Status: {}", impl_.status),
        format!("- Worktree: {}", impl_.worktree),
        format!("- Branch: {}", impl_.branch),
        format!(
            "- Head: {}",
            impl_.head.as_deref().unwrap_or("(not recorded)")
        ),
        format!("- Commits: {commits}"),
    ];
    if let Some(root_cause) = &impl_.root_cause {
        lines.extend([
            String::new(),
            "## Root cause".to_owned(),
            String::new(),
            root_cause.clone(),
        ]);
    }
    lines.extend([String::new(), "## Files touched".to_owned(), String::new()]);
    lines.extend(list(
        impl_
            .files_touched
            .iter()
            .map(|f| format!("`{f}`"))
            .collect(),
    ));
    let v = &impl_.verification;
    lines.extend([
        String::new(),
        "## Verification".to_owned(),
        String::new(),
        format!("- Command: `{}`", v.command),
        format!("- Exit code: {}", number_to_js(v.exit_code)),
        format!("- Summary: {}", v.summary),
    ]);
    if let Some(acceptance) = impl_.acceptance.as_ref().filter(|a| !a.is_empty()) {
        lines.extend([String::new(), "## Acceptance".to_owned(), String::new()]);
        for entry in acceptance {
            lines.push(acceptance_line(entry)?);
        }
    }
    if let Some(doubts) = impl_.doubts.as_ref().filter(|d| !d.is_empty()) {
        lines.extend([String::new(), "## Doubts".to_owned(), String::new()]);
        lines.extend(
            doubts
                .iter()
                .map(|d| format!("- `{}`: {}", d.file, d.reason)),
        );
    }
    lines.extend([String::new(), "## Blockers".to_owned(), String::new()]);
    lines.extend(list(impl_.blockers.clone()));
    lines.extend([
        String::new(),
        "## Markdown requests".to_owned(),
        String::new(),
    ]);
    lines.extend(list(
        impl_
            .markdown_requests
            .iter()
            .map(|r| format!("`{}`: {} (evidence: {})", r.path, r.intent, r.evidence))
            .collect(),
    ));
    lines.push(String::new());
    Some(lines.join("\n"))
}

static STATUS_LINE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?:\A|[\n\r\u{2028}\u{2029}])\*{0,2}[sS][tT][aA][tT][uU][sS]").ok()
});

/// `/^\*{0,2}status:?\*{0,2}/im.test(content)`: a line that opens with at most two `*` and
/// `status` in any ASCII case (the rest of the pattern is optional).
#[must_use]
pub fn has_status_line(content: &str) -> Option<bool> {
    STATUS_LINE.as_ref().map(|re| re.is_match(content))
}

/// `PROGRESS_DIRS` (`primitives/progress-dirs.ts`).
const PROGRESS_DIRS: [&str; 4] = [
    ".claude/progress/",
    ".codex/progress/",
    ".navori/state/",
    "progress/",
];

/// Node's `path.posix.extname`.
fn extname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let mut start_dot: Option<usize> = None;
    let mut start_part = 0;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    let mut pre_dot_state = 0;
    for i in (0..bytes.len()).rev() {
        let byte = bytes[i];
        if byte == b'/' {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
        if byte == b'.' {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0
                && !(pre_dot_state == 1 && dot + 1 == end && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => "",
    }
}

/// Node's `path.posix.dirname` of a resolved absolute path.
fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

/// `realpathSync(path)` (relative to the process's directory) as text: `Some(None)` when it
/// throws, `None` when Rust cannot carry the result.
fn realpath(path: &str) -> Option<Option<String>> {
    match std::fs::canonicalize(path) {
        Ok(real) => real.to_str().map(|s| Some(s.to_owned())),
        Err(_) => Some(None),
    }
}

/// `validateRequestPath(worktree, path)` (R16): `Some(None)` when valid, `Some(Some(detail))`
/// with the failure, `None` when a path on disk is not UTF-8.
pub fn validate_request_path(
    worktree: &str,
    path: &str,
    process_cwd: &str,
) -> Option<Option<String>> {
    let drive = path.as_bytes().get(..3).is_some_and(|p| {
        p[0].is_ascii_alphabetic() && p[1] == b':' && (p[2] == b'/' || p[2] == b'\\')
    });
    if path.starts_with('/') || drive || path.contains('\\') {
        return Some(Some(format!(
            "markdownRequests path \"{path}\" must be relative to the repo (no absolute path, no drive letter, no backslash)"
        )));
    }
    let normalized = normalize(path);
    if normalized.split('/').any(|part| part == "..") {
        return Some(Some(format!(
            "markdownRequests path \"{path}\" escapes the repo (contains \"..\")"
        )));
    }
    if PROGRESS_DIRS.iter().any(|dir| normalized.starts_with(dir)) {
        return Some(Some(format!(
            "markdownRequests path \"{path}\" is under a session/handoff state directory"
        )));
    }
    if ![".md", ".mdx"].contains(&extname(&normalized)) {
        return Some(Some(format!(
            "markdownRequests path \"{path}\" must end in .md or .mdx"
        )));
    }
    let absolute = resolve(&resolve(process_cwd, worktree), &normalized);
    let parent = dirname(&absolute);
    if std::fs::metadata(parent).is_ok() {
        let (Some(real_parent), Some(real_worktree)) = (realpath(parent)?, realpath(worktree)?)
        else {
            return Some(Some(format!(
                "markdownRequests path \"{path}\" could not be resolved on disk"
            )));
        };
        let rel = relative(&real_worktree, &real_parent);
        if rel == ".." || rel.starts_with("../") || rel.starts_with('/') {
            return Some(Some(format!(
                "markdownRequests path \"{path}\" escapes the repo via a symlink"
            )));
        }
    }
    Some(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn parse_accepts_what_zod_accepts_and_render_fills_the_template() {
        let raw = crate::js_json::parse(
            r#"{"feature":"f","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":-0,"summary":"s","x":1},"markdownRequests":[],"extra":null}"#,
        );
        let parsed = raw.as_ref().and_then(parse);
        let text = parsed.as_ref().and_then(render).unwrap_or_default();
        assert!(text.starts_with("# Implementation handoff: f\n"), "{text}");
        assert!(text.contains("- Exit code: 0\n"), "{text}");
        assert!(text.ends_with("## Markdown requests\n\n(none)\n"), "{text}");
        for invalid in [
            r#"{"feature":"f","status":"WIP","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":0,"summary":"s"},"markdownRequests":[]}"#,
            r#"{"feature":"f","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":0.5,"summary":"s"},"markdownRequests":[]}"#,
            r#"{"feature":"f","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":0,"summary":"s"},"markdownRequests":[],"head":"ABC"}"#,
            r#"{"feature":"","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":0,"summary":"s"},"markdownRequests":[]}"#,
            r#"{"feature":"f","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":{"command":"c","exitCode":0,"summary":"s"},"markdownRequests":[],"blockers":null}"#,
        ] {
            let raw = crate::js_json::parse(invalid);
            assert!(raw.as_ref().and_then(parse).is_none(), "{invalid}");
        }
    }

    // Covers: R73
    #[test]
    fn request_paths_follow_the_r16_rules() {
        let check = |path: &str| validate_request_path("/nonexistent-root", path, "/");
        assert_eq!(check("docs/a.md"), Some(None));
        for (path, rule) in [
            ("/a.md", "must be relative"),
            ("c:\\a.md", "must be relative"),
            ("a/../../b.md", "escapes the repo"),
            ("./progress/a.md", "state directory"),
            ("a.txt", "must end in"),
        ] {
            let detail = check(path).flatten().unwrap_or_default();
            assert!(detail.contains(rule), "{path}: {detail}");
        }
    }

    // Covers: R73
    #[test]
    fn extname_follows_node() {
        for (path, ext) in [
            ("a.md", ".md"),
            ("docs/a.mdx", ".mdx"),
            (".md", ""),
            ("..md", ".md"),
            ("a.md/", ".md"),
            ("a.", "."),
            ("a", ""),
            ("..", ""),
            ("dir.md/a", ""),
        ] {
            assert_eq!(extname(path), ext, "{path}");
        }
    }

    // Covers: R73
    #[test]
    fn status_line_needs_status_at_a_line_start() {
        assert_eq!(has_status_line("**Status:** DONE"), Some(true));
        assert_eq!(has_status_line("x\r STATUS"), Some(false));
        assert_eq!(has_status_line("x\rstatus"), Some(true));
        assert_eq!(has_status_line("***status"), Some(false));
        assert_eq!(has_status_line("the status"), Some(false));
    }
}
