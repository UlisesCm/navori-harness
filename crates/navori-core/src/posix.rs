//! Node's `path.posix` string functions the ported primitives depend on, kept lexical (no
//! filesystem access), plus the JS `String.prototype.trim` they pair with.

use crate::integrity::is_js_whitespace;

/// `String.prototype.trimEnd`: JS whitespace and line terminators at the end.
pub use crate::integrity::js_trim_end;

/// `String.prototype.trim`: JS whitespace and line terminators at both ends.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `path.posix.normalize`: collapses `//`, `.` and `..` (kept above a relative root), keeps a
/// trailing `/`, and turns an empty result into `.` (or `./`, `/`).
#[must_use]
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out = segments(path, !absolute).join("/");
    if out.is_empty() {
        return match (absolute, trailing) {
            (true, _) => "/".to_owned(),
            (false, true) => "./".to_owned(),
            (false, false) => ".".to_owned(),
        };
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// `path.posix.basename(path)` (no extension): the last non-slash segment, `""` for `""` or only
/// slashes.
#[must_use]
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `path.posix.dirname`: everything before the last segment; `.` for none, `/` for the root, and
/// Node's `//` when the path starts with `//` and has no other segment (`//a`).
#[must_use]
pub fn dirname(path: &str) -> &str {
    if path.is_empty() {
        return ".";
    }
    let has_root = path.starts_with('/');
    let bytes = path.as_bytes();
    let mut matched_slash = true;
    let mut end = None;
    for i in (1..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => "/",
        None => ".",
        Some(1) if has_root => "//",
        Some(end) => &path[..end],
    }
}

/// `path.posix.join`: the non-empty parts joined by `/`, then [`normalize`]d.
#[must_use]
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_owned();
    }
    normalize(&joined.join("/"))
}

/// `path.posix.resolve(base, path)` for an absolute `base`: no trailing `/`, `/` at most.
#[must_use]
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{base}/{path}")
    };
    format!("/{}", segments(&joined, false).join("/"))
}

/// `path.posix.relative(from, to)` for two [`resolve`]d paths.
#[must_use]
pub fn relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let ups = std::iter::repeat_n("..", from.len() - common);
    ups.chain(to[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

/// Node's `normalizeString`: the segment stack of `path`, `..` kept only above a relative root.
fn segments(path: &str, allow_above_root: bool) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| *last != "..") {
                    out.pop();
                } else if allow_above_root {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{basename, dirname, join, normalize, relative, resolve};

    #[test]
    fn basename_and_dirname_match_node_posix() {
        // Expected values from `node -p` on `path.posix.basename` / `dirname`.
        assert_eq!(dirname("/.git"), "/");
        assert_eq!(basename("/.git"), ".git");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("a/b//c"), "a/b/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(basename("a"), "a");
        assert_eq!(dirname("/"), "/");
        assert_eq!(basename("/"), "");
        assert_eq!(dirname("//"), "/");
        assert_eq!(dirname("//a"), "//");
        assert_eq!(dirname(""), ".");
        assert_eq!(basename(""), "");
        assert_eq!(dirname("a/"), ".");
    }

    #[test]
    fn matches_node_posix() {
        assert_eq!(normalize(""), ".");
        assert_eq!(normalize("./"), "./");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(normalize("../a/../../b/"), "../../b/");
        assert_eq!(normalize("/../a//b/."), "/a/b");
        assert_eq!(join(&[".", "/abs"]), "abs");
        assert_eq!(join(&["..", "x"]), "../x");
        assert_eq!(resolve("/r", "../x/./y/"), "/x/y");
        assert_eq!(resolve("/r", "/"), "/");
        assert_eq!(relative("/r", "/r"), "");
        assert_eq!(relative("/r", "/r/..x/l"), "..x/l");
        assert_eq!(relative("/r/a", "/r/b"), "../b");
    }
}
