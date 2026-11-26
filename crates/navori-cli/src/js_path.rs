//! Node's `path` functions over UTF-8 POSIX paths, for native commands that print or compare
//! paths the way the TS does.

/// Node's `path.resolve` (POSIX) over UTF-8 segments: right to left until an absolute one, empty
/// segments skipped, then normalized. The first segment is always absolute here.
pub(crate) fn js_resolve(segments: &[&str]) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let start = segments
        .iter()
        .rposition(|s| s.starts_with('/'))
        .unwrap_or(0);
    for segment in &segments[start..] {
        for part in segment.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
    }
    format!("/{}", parts.join("/"))
}

/// Node's `path.relative` between two resolved POSIX paths.
pub(crate) fn js_relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|p| !p.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_and_relative_follow_node_posix() {
        assert_eq!(js_resolve(&["/a/b", "../c/./d/"]), "/a/c/d");
        assert_eq!(js_resolve(&["/a", "/x", "y"]), "/x/y");
        assert_eq!(js_resolve(&["/a", ""]), "/a");
        assert_eq!(js_resolve(&["/", ".."]), "/");
        assert_eq!(
            js_relative("/a/b", "/a/b/specs/x/tasks.md"),
            "specs/x/tasks.md"
        );
        assert_eq!(js_relative("/a/b", "/a/c/tasks.md"), "../c/tasks.md");
        assert_eq!(js_relative("/a", "/a"), "");
    }
}
