//! `navori adopt` (`commands/adopt.ts`, spec 0014, spec 0058 T26): wrap a hand-made `.claude/`
//! markdown file in a managed block, leaving its bytes untouched. Preview by default; with
//! `--apply`, a backup of the file before the first byte.
//!
//! [`plan_adoption`] is `planAdoption`: decided without touching the disk beyond reads, so the
//! preview and the apply answer the same question. Paths follow Node's posix `path.resolve` and
//! `path.relative`, quirks included (`..foo` at the root reads as outside the repo).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use jiff::Zoned;
use regex::Regex;

use crate::backup::BackupStore;
use crate::fs::{Fs, FsError, Syscall, node_message};
use crate::markers::{
    CommentStyle, InjectOptions, MarkerMeta, inject_managed_section, prose_lines,
};

/// Why a path cannot be adopted (`AdoptRefusal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdoptRefusal {
    /// The path resolves outside the repo.
    OutsideRepo,
    /// Nothing there.
    Missing,
    /// A directory or something else that is not a file.
    NotAFile,
    /// Not markdown under `.claude/`.
    NotAdoptablePath,
    /// The file already carries a managed block of another id.
    AlreadyManaged,
}

/// `AdoptPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptPlan {
    /// Refused; `path` is the absolute target for `OutsideRepo`, else the relative one.
    Refuse {
        /// Why.
        reason: AdoptRefusal,
        /// The path the message names.
        path: String,
    },
    /// Already adopted: nothing to do, and not an error.
    Noop {
        /// Relative path.
        path: String,
    },
    /// Wrap the file.
    Adopt {
        /// The target as the TS writes to it.
        path: PathBuf,
        /// Relative to the repo.
        rel_path: String,
        /// `adoptedMarkerId(relPath)`.
        marker_id: String,
        /// The file after wrapping.
        content: String,
    },
}

/// The file cannot be read as the TS reads it (not UTF-8, or unreadable): the TS handles it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdoptDelegate;

/// `adoptedMarkerId(relPath)`: `adopted-` plus the path without `.md`, every run of
/// non-alphanumerics a dash, trimmed of dashes and lowercased.
#[must_use]
pub fn adopted_marker_id(rel_path: &str) -> String {
    let stem = rel_path.strip_suffix(".md").unwrap_or(rel_path);
    let mut slug = String::new();
    let mut dash = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    format!("adopted-{}", slug.trim_matches('-'))
}

/// `path.posix.normalize` of an absolute path, as `path.resolve` leaves it.
fn normalize_absolute(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `path.resolve(cwd, target)` with an absolute `cwd`.
fn resolve(cwd: &str, target: &str) -> String {
    if target.starts_with('/') {
        normalize_absolute(target)
    } else {
        normalize_absolute(&format!("{cwd}/{target}"))
    }
}

/// `path.relative(from, to)` between absolute paths.
fn relative(from: &str, to: &str) -> String {
    let from = normalize_absolute(from);
    let to = normalize_absolute(to);
    if from == to {
        return String::new();
    }
    let a: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut out: Vec<&str> = vec![".."; a.len() - common];
    out.extend(&b[common..]);
    out.join("/")
}

/// `MARKER_TAG_RE`.
static MARKER_TAG: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?:<!-- navori:managed|# navori:managed start)[ \t]+id="([^"\n]+)"[^\n>]*"#).ok()
});

/// `listMarkers(file)`'s ids: open markers on prose lines, both syntaxes.
#[must_use]
pub fn marker_ids(content: &str) -> Vec<String> {
    let Some(tag) = MARKER_TAG.as_ref() else {
        return Vec::new();
    };
    prose_lines(content, &[CommentStyle::Html, CommentStyle::Shell])
        .iter()
        .flat_map(|line| {
            tag.captures_iter(line.text)
                .filter_map(|c| c.get(1).map(|m| m.as_str().to_owned()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `planAdoption(cwd, target)` with an absolute `cwd`.
///
/// # Errors
/// [`AdoptDelegate`] when the target exists as a file that is not UTF-8 or cannot be read.
pub fn plan_adoption(cwd: &str, target: &str, version: &str) -> Result<AdoptPlan, AdoptDelegate> {
    let abs = if target.starts_with('/') {
        target.to_owned()
    } else {
        resolve(cwd, target)
    };
    let rel_path = relative(cwd, &abs);
    if rel_path.starts_with("..") || rel_path.starts_with('/') {
        return Ok(AdoptPlan::Refuse {
            reason: AdoptRefusal::OutsideRepo,
            path: abs,
        });
    }
    let refuse = |reason| {
        Ok(AdoptPlan::Refuse {
            reason,
            path: rel_path.clone(),
        })
    };
    let path = PathBuf::from(&abs);
    let Ok(meta) = std::fs::metadata(&path) else {
        // `existsSync` is false for a dangling link too.
        return refuse(AdoptRefusal::Missing);
    };
    if !meta.is_file() {
        return refuse(AdoptRefusal::NotAFile);
    }
    if !(rel_path.starts_with(".claude/") || rel_path.starts_with(".claude\\"))
        || !rel_path.ends_with(".md")
    {
        return refuse(AdoptRefusal::NotAdoptablePath);
    }
    let bytes = std::fs::read(&path).map_err(|_| AdoptDelegate)?;
    let existing = String::from_utf8(bytes).map_err(|_| AdoptDelegate)?;
    let marker_id = adopted_marker_id(&rel_path);
    let ids = marker_ids(&existing);
    if !ids.is_empty() {
        return if ids.contains(&marker_id) {
            Ok(AdoptPlan::Noop { path: rel_path })
        } else {
            refuse(AdoptRefusal::AlreadyManaged)
        };
    }
    let body = if existing.ends_with('\n') {
        existing
    } else {
        format!("{existing}\n")
    };
    let meta = MarkerMeta {
        source: Some("adopted".to_owned()),
        version: Some(version.to_owned()),
        ..MarkerMeta::default()
    };
    let content =
        inject_managed_section("", &marker_id, &body, &meta, InjectOptions::default()).output;
    Ok(AdoptPlan::Adopt {
        path,
        rel_path,
        marker_id,
        content,
    })
}

/// The apply half of `adoptCommand`: a backup of `rel_path`, then `writeFileSync` (not atomic,
/// as the TS). Returns the backup directory.
///
/// # Errors
/// [`FsError`] with Node's message for the call that throws.
pub fn apply_adoption(
    fs: &mut dyn Fs,
    backups: &mut BackupStore,
    cwd: &Path,
    path: &Path,
    rel_path: &str,
    content: &str,
    now: &Zoned,
) -> Result<PathBuf, FsError> {
    let handle = backups.create(fs, cwd, &[rel_path.to_owned()], &[], now)?;
    let error = |e: &std::io::Error| FsError {
        message: node_message(e, Syscall::Open, path, None),
    };
    let file = fs.create(path, 0o666).map_err(|e| error(&e))?;
    let written = fs.write(file, content.as_bytes());
    let closed = fs.close(file);
    written.map_err(|e| FsError {
        message: node_message(&e, Syscall::Write, path, None),
    })?;
    closed.map_err(|e| FsError {
        message: node_message(&e, Syscall::Close, path, None),
    })?;
    Ok(handle.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_ids_follow_the_ts_slug() {
        assert_eq!(
            adopted_marker_id(".claude/agents/Mia.md"),
            "adopted-claude-agents-mia"
        );
        assert_eq!(
            adopted_marker_id(".claude/x.y.md.md"),
            "adopted-claude-x-y-md"
        );
        assert_eq!(adopted_marker_id(".claude/ñ.md"), "adopted-claude");
    }

    #[test]
    fn paths_follow_node_posix() {
        assert_eq!(resolve("/r", "a/../b/./c"), "/r/b/c");
        assert_eq!(relative("/r", "/r/.claude/x.md"), ".claude/x.md");
        assert_eq!(relative("/r/a", "/r/b"), "../b");
        assert_eq!(relative("/r", "/r"), "");
        assert_eq!(relative("/r", "/r/..foo"), "..foo");
    }
}
