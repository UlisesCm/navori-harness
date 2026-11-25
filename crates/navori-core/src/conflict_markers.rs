//! Unresolved git conflict markers in the files navori manages (#1660).
//!
//! Rust-only, with no TS counterpart: the frozen TS keeps everything outside a managed block as
//! user text, so a conflict there survives every render (and, in a native hook, de-nativizes it).
//! `render`, `sync` and `remove` refuse before writing or delegating when [`scan`] finds one.
//!
//! The scan reads raw bytes: the triple is ASCII, so a file that is not UTF-8 is scanned like any
//! other and never forces a delegation.

use std::collections::BTreeSet;
use std::path::Path;

/// Where a conflict starts in a managed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictFile {
    /// Repo-relative path, `/`-separated.
    pub path: String,
    /// 1-based line of the `<<<<<<<` that opens the first complete conflict.
    pub line: usize,
}

/// One managed location: a single file or every regular file below a directory.
#[derive(Clone, Copy)]
enum Entry {
    File(&'static str),
    Tree(&'static str),
}

use Entry::{File, Tree};

/// The five ignore files `render` rewrites, whatever the engines.
const IGNORE_FILES: [Entry; 5] = [
    File(".gitignore"),
    File(".claude/.gitignore"),
    File(".codex/.gitignore"),
    File(".navori/.gitignore"),
    File(".prettierignore"),
];

/// What each engine writes. Explicit on purpose: `.claude` and `.pi` also hold user data and, in
/// this repo, `.claude/worktrees`, so no whole-root walk. Every path a full render writes must be
/// covered here (see `every_path_a_full_render_writes_is_scanned`).
const ENGINES: [(&str, &[Entry]); 6] = [
    (
        "claude",
        &[
            File("CLAUDE.md"),
            File(".claude/settings.json"),
            File(".mcp.json"),
            Tree(".claude/agents"),
            Tree(".claude/skills"),
            Tree(".claude/hooks"),
            Tree(".claude/context"),
            Tree(".claude/scripts"),
        ],
    ),
    (
        "codex",
        &[File("AGENTS.md"), Tree(".agents/skills"), Tree(".codex")],
    ),
    (
        "pi",
        &[
            File("AGENTS.md"),
            File(".pi/navori.json"),
            File(".pi/extensions/navori.ts"),
            Tree(".agents/skills"),
            Tree(".pi/agents"),
            Tree(".pi/navori"),
        ],
    ),
    ("agents-md", &[File("AGENTS.md")]),
    ("cursor", &[File(".cursor/rules/navori.mdc")]),
    ("copilot", &[File(".github/copilot-instructions.md")]),
];

/// Deepest directory level walked below a [`Tree`] root.
const MAX_DEPTH: usize = 8;

fn is_marker(line: &[u8], sign: u8) -> bool {
    line.len() >= 7 && line[..7].iter().all(|&b| b == sign)
}

/// The 1-based line of the first complete git conflict in `bytes`, if any.
///
/// A conflict is an ordered triple in column 0 (a trailing `\r` is ignored): `<<<<<<<` followed
/// by a space or the end of the line, then `=======` alone (trailing blanks allowed), then
/// `>>>>>>>` followed by a space or the end of the line. Eight or more signs, indented markers,
/// a lone `=======` (a Markdown/RST underline), an incomplete or out-of-order triple do not
/// match. diff3's `|||||||` between the first two is tolerated. Assumes git's default marker
/// size of 7.
#[must_use]
pub fn find_conflict(bytes: &[u8]) -> Option<usize> {
    let mut start: Option<usize> = None;
    let mut mid = false;
    for (index, raw) in bytes.split(|&b| b == b'\n').enumerate() {
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        let boundary = |rest: &[u8]| rest.is_empty() || rest[0] == b' ';
        if is_marker(line, b'<') && boundary(&line[7..]) {
            start = Some(index + 1);
            mid = false;
        } else if start.is_some() && !mid {
            mid = is_marker(line, b'=') && line[7..].iter().all(|&b| b == b' ' || b == b'\t');
        } else if mid && is_marker(line, b'>') && boundary(&line[7..]) {
            return start;
        }
    }
    None
}

fn walk(root: &Path, rel: &str, depth: usize, out: &mut BTreeSet<String>) {
    if depth > MAX_DEPTH {
        return;
    }
    // `read_dir` follows a symlinked root: refuse it here, children are checked below.
    if depth == 0
        && !std::fs::symlink_metadata(root.join(rel)).is_ok_and(|meta| meta.file_type().is_dir())
    {
        return;
    }
    let Ok(read) = std::fs::read_dir(root.join(rel)) else {
        return;
    };
    for entry in read.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let child = format!("{rel}/{}", entry.file_name().to_string_lossy());
        if kind.is_dir() {
            walk(root, &child, depth + 1, out);
        } else if kind.is_file() {
            out.insert(child);
        }
    }
}

/// The existing regular files (no symlinks) navori manages for `engines`, repo-relative and
/// sorted, with the ignore files always included. Unknown engines contribute nothing.
#[must_use]
pub fn managed_files(root: &Path, engines: &[String]) -> Vec<String> {
    let mut found = BTreeSet::new();
    let selected = ENGINES
        .iter()
        .filter(|(name, _)| engines.iter().any(|e| e == name))
        .flat_map(|(_, entries)| entries.iter())
        .chain(IGNORE_FILES.iter());
    for entry in selected {
        match *entry {
            File(rel) => {
                let is_file = std::fs::symlink_metadata(root.join(rel))
                    .is_ok_and(|meta| meta.file_type().is_file());
                if is_file {
                    found.insert(rel.to_owned());
                }
            }
            Tree(rel) => walk(root, rel, 0, &mut found),
        }
    }
    found.into_iter().collect()
}

/// Every managed file of `engines` that holds an unresolved conflict, in path order. Unreadable
/// files are skipped: they cannot be told apart from absent ones, and the writes that follow
/// would fail the same way.
#[must_use]
pub fn scan(root: &Path, engines: &[String]) -> Vec<ConflictFile> {
    managed_files(root, engines)
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(root.join(&path)).ok()?;
            find_conflict(&bytes).map(|line| ConflictFile { path, line })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: &str = "<<<<<<< HEAD";
    const MID: &str = "=======";
    const CLOSE: &str = ">>>>>>> branch";

    fn conflict(parts: &[&str]) -> Option<usize> {
        find_conflict(parts.join("\n").as_bytes())
    }

    #[test]
    fn conflict_markers_minimal_triple_reports_the_opening_line() {
        assert_eq!(conflict(&[OPEN, "a", MID, "b", CLOSE]), Some(1));
        assert_eq!(conflict(&["x", "y", OPEN, MID, CLOSE, ""]), Some(3));
        assert_eq!(conflict(&["<<<<<<<", MID, ">>>>>>>"]), Some(1));
    }

    #[test]
    fn conflict_markers_crlf_and_diff3_are_tolerated() {
        let crlf = format!("{OPEN}\r\na\r\n{MID}\r\nb\r\n{CLOSE}\r\n");
        assert_eq!(find_conflict(crlf.as_bytes()), Some(1));
        assert_eq!(
            conflict(&[OPEN, "a", "||||||| base", "o", MID, "b", CLOSE]),
            Some(1)
        );
        assert_eq!(conflict(&[OPEN, "a", "=======  \t", "b", CLOSE]), Some(1));
    }

    #[test]
    fn conflict_markers_lookalikes_do_not_match() {
        // Setext/RST underline and a Markdown rule.
        assert_eq!(conflict(&["Title", MID, "text"]), None);
        // Eight signs, indented, glued text.
        assert_eq!(conflict(&["<<<<<<<< x", MID, ">>>>>>> y"]), None);
        assert_eq!(conflict(&[OPEN, "========", CLOSE]), None);
        assert_eq!(conflict(&[OPEN, MID, ">>>>>>>>"]), None);
        assert_eq!(conflict(&[" <<<<<<< x", MID, ">>>>>>> y"]), None);
        assert_eq!(conflict(&[OPEN, " =======", CLOSE]), None);
        assert_eq!(conflict(&[OPEN, MID, "  >>>>>>> y"]), None);
        assert_eq!(conflict(&["<<<<<<<x", MID, ">>>>>>> y"]), None);
        assert_eq!(conflict(&[OPEN, "=======x", CLOSE]), None);
    }

    #[test]
    fn conflict_markers_incomplete_or_out_of_order_do_not_match() {
        assert_eq!(conflict(&[OPEN, "a"]), None);
        assert_eq!(conflict(&[OPEN, MID]), None);
        assert_eq!(conflict(&[MID, CLOSE]), None);
        assert_eq!(conflict(&[CLOSE, MID, OPEN]), None);
        assert_eq!(conflict(&[MID, OPEN, CLOSE]), None);
        assert_eq!(conflict(&[OPEN, CLOSE, MID]), None);
        assert_eq!(conflict(&[]), None);
    }

    #[test]
    fn conflict_markers_a_later_opening_restarts_the_triple() {
        assert_eq!(conflict(&[OPEN, "a", "<<<<<<< two", MID, CLOSE]), Some(3));
    }

    #[test]
    fn conflict_markers_bytes_that_are_not_utf8_are_scanned() {
        let mut bytes = b"\xff\xfe\n".to_vec();
        bytes.extend_from_slice(format!("{OPEN}\n{MID}\n{CLOSE}\n").as_bytes());
        assert_eq!(find_conflict(&bytes), Some(2));
    }

    #[test]
    fn conflict_markers_no_embedded_asset_holds_the_triple() {
        // A shipped asset with the triple in column 0 would make every render refuse.
        let offenders: Vec<&str> = crate::assets::ASSETS
            .iter()
            .filter(|(_, bytes)| find_conflict(bytes).is_some())
            .map(|(path, _)| *path)
            .collect();
        assert!(offenders.is_empty(), "{offenders:?}");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "navori-conflict-markers-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    }

    #[test]
    fn conflict_markers_scan_covers_the_set_and_skips_the_rest() {
        let root = scratch("scan");
        let bad = format!("{OPEN}\n{MID}\n{CLOSE}\n");
        for rel in [
            "CLAUDE.md",
            ".claude/hooks/a/b.sh",
            ".claude/scripts/s.py",
            ".gitignore",
            ".pi/agents/x.md",
            ".codex/rules/navori.rules",
            // Not managed: a worktree checkout and an unknown engine's tree.
            ".claude/worktrees/w/CLAUDE.md",
            ".cursor/rules/navori.mdc",
        ] {
            put(&root, rel, &bad);
        }
        put(&root, ".claude/hooks/clean.sh", "echo ok\n");
        let claude = scan(&root, &["claude".to_owned()]);
        let paths: Vec<&str> = claude.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                ".claude/hooks/a/b.sh",
                ".claude/scripts/s.py",
                ".gitignore",
                "CLAUDE.md"
            ]
        );
        assert!(claude.iter().all(|c| c.line == 1));
        let all: Vec<String> = ["claude", "codex", "pi", "cursor"]
            .map(str::to_owned)
            .into();
        let count = scan(&root, &all).len();
        assert_eq!(count, 7, "{:?}", scan(&root, &all));
    }

    #[test]
    fn conflict_markers_symlinks_are_not_followed() {
        let root = scratch("symlink");
        let bad = format!("{OPEN}\n{MID}\n{CLOSE}\n");
        put(&root, "elsewhere/real.md", &bad);
        let _ = std::fs::create_dir_all(root.join(".claude"));
        let _ = std::os::unix::fs::symlink(root.join("elsewhere/real.md"), root.join("CLAUDE.md"));
        let _ = std::os::unix::fs::symlink(root.join("elsewhere"), root.join(".claude/hooks"));
        assert!(scan(&root, &["claude".to_owned()]).is_empty());
    }

    /// A full render of every engine with every bundled plugin: each file it leaves in the repo
    /// must be scanned, or be one of the explicit exclusions below.
    #[test]
    fn conflict_markers_every_path_a_full_render_writes_is_scanned() {
        use crate::backup::{BackupStore, local_now};
        use crate::config;
        use crate::fs::RealFs;
        use crate::render::collect::DiskView;
        use crate::render::command::{Apply, RenderOptions, run_render};

        let root = scratch("coverage");
        let engines = ["claude", "codex", "pi", "agents-md", "cursor", "copilot"];
        let text = r#"{"name":"cov","preset":"custom","language":"en","engines":["claude","codex","pi","agents-md","cursor","copilot"],"plugins":{"tgrep":{"enabled":true},"codegraph":{"enabled":true},"gh":{"enabled":true},"acli":{"enabled":true}}}"#;
        put(&root, "navori.config.json", text);
        let Ok(read) = config::read(text.as_bytes()) else {
            panic!("config rejected");
        };
        let mut fs = RealFs::default();
        let mut backups = BackupStore::new(Ok(root.join("../cov-backups")), 0);
        let now = local_now();
        let mut apply = Apply {
            fs: &mut fs,
            backups: &mut backups,
            now: &now,
        };
        let plan = run_render(
            &DiskView(&root),
            &read,
            &root,
            &RenderOptions::default(),
            Some(&mut apply),
        );
        assert!(plan.is_ok(), "render did not apply natively");

        let scanned: BTreeSet<String> = managed_files(&root, &engines.map(str::to_owned))
            .into_iter()
            .collect();
        let mut on_disk = BTreeSet::new();
        collect_all(&root, "", &mut on_disk);
        // Not scanned on purpose: the config and `progress/*` are the user's (render only seeds
        // them once, never rewrites them), and `.navori/` state files hold navori's own
        // bookkeeping, not rendered text.
        let excluded = |path: &str| {
            path == "navori.config.json"
                || path.starts_with("progress/")
                || path.starts_with(".navori/") && path != ".navori/.gitignore"
        };
        let missing: Vec<&String> = on_disk
            .iter()
            .filter(|path| !scanned.contains(*path) && !excluded(path))
            .collect();
        assert!(missing.is_empty(), "written but not scanned: {missing:?}");
        assert!(
            scanned.len() > 20,
            "the fixture rendered too little: {scanned:?}"
        );
    }

    fn collect_all(root: &Path, rel: &str, out: &mut BTreeSet<String>) {
        let Ok(read) = std::fs::read_dir(root.join(rel)) else {
            return;
        };
        for entry in read.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => collect_all(root, &child, out),
                Ok(kind) if kind.is_file() => {
                    out.insert(child);
                }
                _ => {}
            }
        }
    }
}
