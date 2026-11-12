//! Port of `lib/workspace/workspace-patterns.ts` (spec 0060 T23): the workspace patterns a
//! monorepo declares (`pnpm-workspace.yaml`, else `package.json#workspaces`) and their one
//! segment at a time expansion.
//!
//! Input the TS would read differently from what Rust models (text that is not UTF-8, JSON
//! [`js_json::parse`] declines, line terminators other than `\n`/`\r\n`, `.`/`..` segments that
//! `path.join` normalizes lexically, entry names that are not UTF-8) is [`Unmodeled`]: the caller
//! hands the invocation to the TS before any output.

use std::path::Path;

use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsValue};
use crate::posix::js_trim;

/// The input is outside what the port reproduces; the TS must handle it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unmodeled;

/// `readFileSync(path, "utf-8")` for a path that exists: `Ok(None)` when the read throws.
fn read_text(path: &Path) -> Result<Option<String>, Unmodeled> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| Unmodeled),
        Err(_) => Ok(None),
    }
}

/// `JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""))` for a path that exists:
/// `Ok(None)` when the read throws.
///
/// # Errors
/// [`Unmodeled`] for text that is not UTF-8 or that [`js_json::parse`] declines (including JSON
/// the TS rejects: its catch would take a branch Rust does not tell apart).
pub fn read_json(path: &Path) -> Result<Option<JsValue>, Unmodeled> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    js_json::parse(text).map(Some).ok_or(Unmodeled)
}

/// `collectWorkspacePatterns(cwd)`: `pnpm-workspace.yaml` wins over `package.json#workspaces`;
/// `[]` when neither declares a package pattern.
///
/// # Errors
/// [`Unmodeled`] where the TS reads the files differently from this port.
pub fn collect_workspace_patterns(cwd: &Path) -> Result<Vec<String>, Unmodeled> {
    let pnpm_yaml = cwd.join("pnpm-workspace.yaml");
    if pnpm_yaml.exists() {
        return match read_text(&pnpm_yaml)? {
            Some(text) => parse_pnpm_workspace_yaml(&text),
            None => Ok(Vec::new()),
        };
    }
    let pkg_path = cwd.join("package.json");
    if pkg_path.exists() {
        return match read_json(&pkg_path)? {
            Some(JsValue::Object(pkg)) => read_package_json_workspaces(pkg.get("workspaces")),
            _ => Ok(Vec::new()),
        };
    }
    Ok(Vec::new())
}

/// The `[^\n]` of a JS `.`: the line terminators a `/^…$/` line regex would stop at.
fn has_other_line_terminator(line: &str) -> bool {
    line.contains(['\r', '\u{2028}', '\u{2029}'])
}

/// `parsePnpmWorkspaceYaml(content)`: the `packages:` patterns (block or inline form), without
/// negations.
///
/// # Errors
/// [`Unmodeled`] when a line the parser reads holds a lone `\r`, `U+2028` or `U+2029`.
pub fn parse_pnpm_workspace_yaml(content: &str) -> Result<Vec<String>, Unmodeled> {
    let lines: Vec<&str> = split_lines(content);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if has_other_line_terminator(line) {
            return Err(Unmodeled);
        }
        if let Some(inline) = packages_key(line) {
            let inline = js_trim(inline);
            if inline.starts_with('[') {
                return Ok(parse_inline_yaml_array(inline));
            }
            let mut items = Vec::new();
            i += 1;
            while i < lines.len() {
                let cur = lines[i];
                if has_other_line_terminator(cur) {
                    return Err(Unmodeled);
                }
                let rest = cur.trim_start_matches(is_js_whitespace);
                if rest.is_empty() || rest.starts_with('#') {
                    i += 1;
                    continue;
                }
                let Some(raw) = block_item(cur) else {
                    break;
                };
                let unquoted = strip_yaml_quotes(js_trim(raw));
                if !unquoted.is_empty() && !unquoted.starts_with('!') {
                    items.push(unquoted.to_owned());
                }
                i += 1;
            }
            return Ok(items);
        }
        i += 1;
    }
    Ok(Vec::new())
}

/// `content.split(/\r?\n/)`.
fn split_lines(content: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = content.split('\n').collect();
    let last = lines.len() - 1;
    // Every piece but the last was followed by `\n`; a `\r` right before it is the CRLF.
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// `line.match(/^packages\s*:\s*(.*)$/)?.[1]`.
fn packages_key(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("packages")?;
    let rest = rest.trim_start_matches(is_js_whitespace);
    let rest = rest.strip_prefix(':')?;
    Some(rest.trim_start_matches(is_js_whitespace))
}

/// `line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/)?.[1]`, for a line without other line terminators.
fn block_item(line: &str) -> Option<&str> {
    let after_indent = line.trim_start_matches(is_js_whitespace);
    if after_indent.len() == line.len() {
        return None;
    }
    let after_dash = after_indent.strip_prefix('-')?;
    let value = after_dash.trim_start_matches(is_js_whitespace);
    let gap = &after_dash[..after_dash.len() - value.len()];
    if gap.is_empty() {
        return None;
    }
    if value.is_empty() {
        // `\s+` gives its last whitespace back so `.+?` takes one character.
        let mut chars = gap.chars();
        chars.next_back()?;
        return (!chars.as_str().is_empty()).then(|| &gap[chars.as_str().len()..]);
    }
    // The shortest non-empty capture whose remainder is `\s*` then nothing or a `#` comment.
    let mut ends = value.char_indices().map(|(at, c)| at + c.len_utf8());
    ends.find_map(|end| {
        let tail = value[end..].trim_start_matches(is_js_whitespace);
        (tail.is_empty() || tail.starts_with('#')).then(|| &value[..end])
    })
}

/// `parseInlineYamlArray(inline)`.
fn parse_inline_yaml_array(inline: &str) -> Vec<String> {
    let Some(closed) = inline.rfind(']') else {
        return Vec::new();
    };
    // `inline` starts with `[`, a single byte.
    let body = inline.get(1..closed).unwrap_or("");
    body.split(',')
        .map(|s| strip_yaml_quotes(js_trim(s)))
        .filter(|s| !s.is_empty() && !s.starts_with('!'))
        .map(str::to_owned)
        .collect()
}

/// `stripYamlQuotes(raw)`.
fn strip_yaml_quotes(raw: &str) -> &str {
    for quote in ['"', '\''] {
        if raw.len() >= 2 && raw.starts_with(quote) && raw.ends_with(quote) {
            return &raw[1..raw.len() - 1];
        }
    }
    raw
}

/// `readPackageJsonWorkspaces(raw)`: an array, or yarn's `{ packages: [...] }`.
fn read_package_json_workspaces(raw: Option<&JsValue>) -> Result<Vec<String>, Unmodeled> {
    let list = match raw {
        Some(JsValue::Array(items)) => items,
        Some(JsValue::Object(object)) => match object.get("packages") {
            Some(JsValue::Array(items)) => items,
            _ => return Ok(Vec::new()),
        },
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for item in list {
        if let JsValue::String(text) = item {
            let text = text.to_rust().ok_or(Unmodeled)?;
            if !text.starts_with('!') {
                out.push(text);
            }
        }
    }
    Ok(out)
}

/// `expandPattern(cwd, pattern)`: the relative paths under `cwd` the pattern names, where a `*`
/// segment matches every non-dot directory and any other segment is literal.
///
/// # Errors
/// [`Unmodeled`] for a `.`/`..` segment or a matched entry name that is not UTF-8.
pub fn expand_pattern(cwd: &Path, pattern: &str) -> Result<Vec<String>, Unmodeled> {
    let segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Ok(Vec::new());
    }
    if segments.iter().any(|s| *s == "." || *s == "..") {
        return Err(Unmodeled);
    }
    let mut out = Vec::new();
    walk(cwd, &mut Vec::new(), &segments, &mut out)?;
    Ok(out)
}

fn walk(
    cwd: &Path,
    accum: &mut Vec<String>,
    remaining: &[&str],
    out: &mut Vec<String>,
) -> Result<(), Unmodeled> {
    let Some((head, tail)) = remaining.split_first() else {
        out.push(accum.join("/"));
        return Ok(());
    };
    let current = accum.iter().fold(cwd.to_path_buf(), |path, s| path.join(s));
    if *head == "*" {
        if !current.exists() {
            return Ok(());
        }
        let Ok(entries) = std::fs::read_dir(&current) else {
            return Ok(());
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return Err(Unmodeled);
            };
            let is_dir = entry.file_type().map_err(|_| Unmodeled)?.is_dir();
            let name = entry.file_name();
            let name = name.to_str().ok_or(Unmodeled)?;
            if !is_dir || name.starts_with('.') {
                continue;
            }
            accum.push(name.to_owned());
            walk(cwd, accum, tail, out)?;
            accum.pop();
        }
        return Ok(());
    }
    if !current.join(head).exists() {
        return Ok(());
    }
    accum.push((*head).to_owned());
    walk(cwd, accum, tail, out)?;
    accum.pop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("navori-patterns-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap_or_default();
        dir
    }

    // Covers: R73
    #[test]
    fn pnpm_yaml_block_and_inline_forms() {
        let block = "packages:\n  - 'apps/*'\n  # note\n\n  - \"packages/*\"  # c\n  - '!apps/x'\nother: 1\n";
        assert_eq!(
            parse_pnpm_workspace_yaml(block),
            Ok(vec!["apps/*".to_owned(), "packages/*".to_owned()])
        );
        assert_eq!(
            parse_pnpm_workspace_yaml("packages: ['apps/*', \"libs/*\", '!x']\r\n"),
            Ok(vec!["apps/*".to_owned(), "libs/*".to_owned()])
        );
        assert_eq!(
            parse_pnpm_workspace_yaml("onlyBuiltDependencies:\n  - esbuild\n"),
            Ok(Vec::new())
        );
        assert_eq!(
            parse_pnpm_workspace_yaml("packages:\n  -apps/*\n"),
            Ok(Vec::new())
        );
        assert_eq!(
            parse_pnpm_workspace_yaml("packages:\r  - a\n"),
            Err(Unmodeled)
        );
        assert_eq!(block_item("  - a#b"), Some("a"));
        assert_eq!(block_item("  - #b"), Some("#b"));
        assert_eq!(block_item("  -  "), Some(" "));
        assert_eq!(block_item("  - "), None);
    }

    // Covers: R73
    #[test]
    fn package_json_workspaces_and_expansion() -> Result<(), Unmodeled> {
        let root = temp("expand");
        let write = |rel: &str, text: &str| {
            let path = root.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap_or_default();
            }
            std::fs::write(path, text).unwrap_or_default();
        };
        write(
            "package.json",
            "{\"workspaces\":{\"packages\":[\"apps/*\",\"!apps/b\",\"tools/cli\",3]}}",
        );
        write("apps/a/package.json", "{}");
        write("apps/.hidden/package.json", "{}");
        write("apps/file.txt", "");
        write("tools/cli/package.json", "{}");
        assert_eq!(
            collect_workspace_patterns(&root)?,
            vec!["apps/*".to_owned(), "tools/cli".to_owned()]
        );
        assert_eq!(expand_pattern(&root, "apps/*")?, vec!["apps/a".to_owned()]);
        assert_eq!(
            expand_pattern(&root, "/tools//cli/")?,
            vec!["tools/cli".to_owned()]
        );
        assert_eq!(expand_pattern(&root, "missing/*")?, Vec::<String>::new());
        assert_eq!(expand_pattern(&root, "apps/**")?, Vec::<String>::new());
        assert_eq!(expand_pattern(&root, "./apps/*"), Err(Unmodeled));
        write("pnpm-workspace.yaml", "packages: []\n");
        assert_eq!(collect_workspace_patterns(&root)?, Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }
}
