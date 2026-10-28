//! Pre-write backups (spec 0058 T22, R44), `lib/render/backup.ts`: a snapshot directory
//! `<repo>-YYYY-MM-DDTHH-mm-ss-SSS-p<pid>-<seq>` in local time under `$NAVORI_BACKUP_ROOT` or
//! `~/.navori/backups`, holding a copy of each regular file a command is about to destroy.
//!
//! Every mutation goes through [`Fs`]; reads use `std::fs`, following symlinks like `statSync`.

use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use jiff::Zoned;

use crate::fs::{Fs, FsError, Syscall, node_message};
use crate::integrity::{is_js_whitespace, js_trim_end};

/// Env var that redirects the whole backup store (writes and purge).
pub const BACKUP_ROOT_ENV: &str = "NAVORI_BACKUP_ROOT";

/// `HomeError`'s message, when neither the override nor `HOME` gives an absolute path.
pub const HOME_ERROR: &str = "Could not determine home directory: HOME env var is empty or not absolute. Set HOME explicitly (e.g. 'HOME=/home/runner') before running navori.";

/// `path.resolve(path)` against the process cwd: absolute and lexically normalized.
fn resolve(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// `backupRootLazy()`: `$NAVORI_BACKUP_ROOT` (trimmed, resolved) or `~/.navori/backups`.
///
/// # Errors
/// [`HOME_ERROR`] when the home directory is empty or relative.
pub fn backup_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(BACKUP_ROOT_ENV) {
        let value = value.to_string_lossy();
        let trimmed = js_trim_end(value.trim_start_matches(is_js_whitespace));
        if !trimmed.is_empty() {
            return Ok(resolve(Path::new(trimmed)));
        }
    }
    match std::env::home_dir() {
        Some(home) if home.is_absolute() => Ok(home.join(".navori").join("backups")),
        _ => Err(HOME_ERROR.to_owned()),
    }
}

/// `new Date()` read in the system zone (`TZ`, then `/etc/localtime`), as `timestamp()` sees it.
#[must_use]
pub fn local_now() -> Zoned {
    Zoned::now()
}

/// `timestamp()` at `now`: `YYYY-MM-DDTHH-mm-ss-SSS-p<pid>`, in `now`'s time zone.
#[must_use]
pub fn timestamp(now: &Zoned, pid: u32) -> String {
    format!(
        "{}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}-p{pid}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// `backupRepoLabel(repoRoot)`: the directory name with every UTF-16 unit outside
/// `[a-zA-Z0-9._-]` replaced by `-`; `repo` when empty.
#[must_use]
pub fn backup_repo_label(repo_root: &Path) -> String {
    let name = resolve(repo_root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let label: String = name
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            let units = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '-' }, units)
        })
        .collect();
    if label.is_empty() {
        "repo".to_owned()
    } else {
        label
    }
}

/// `BackupHandle`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupHandle {
    /// The snapshot directory.
    pub path: PathBuf,
    /// Repo-relative paths copied, in walk order.
    pub files: Vec<String>,
}

/// The backup store of one process: its root, pid and the `backupSeq` counter.
#[derive(Debug, Clone)]
pub struct BackupStore {
    /// Where snapshots go: [`backup_root`], resolved up front but reported only when used, as
    /// `backupRootLazy` throws only once a backup is taken.
    pub root: Result<PathBuf, String>,
    /// `process.pid`.
    pub pid: u32,
    seq: u64,
}

fn fs_error(error: &std::io::Error, syscall: Syscall, path: &Path, dest: Option<&Path>) -> FsError {
    FsError {
        message: node_message(error, syscall, path, dest),
    }
}

impl BackupStore {
    /// A store at `root` for process `pid`, its counter at 0.
    #[must_use]
    pub const fn new(root: Result<PathBuf, String>, pid: u32) -> Self {
        Self { root, pid, seq: 0 }
    }

    /// `createBackup(repoRoot, paths, { exclude })` at `now`: always creates the snapshot
    /// directory, then copies each existing path (directories recursively, regular files only,
    /// symlinks followed) except the excluded ones.
    ///
    /// # Errors
    /// [`FsError`] with the root's error, or Node's message for the first call that throws.
    pub fn create(
        &mut self,
        fs: &mut dyn Fs,
        repo_root: &Path,
        paths: &[String],
        exclude: &[&str],
        now: &Zoned,
    ) -> Result<BackupHandle, FsError> {
        let root = self.root.clone().map_err(|message| FsError { message })?;
        let dir = root.join(format!(
            "{}-{}-{}",
            backup_repo_label(repo_root),
            timestamp(now, self.pid),
            self.seq
        ));
        self.seq += 1;
        fs.mkdir_all(&dir)
            .map_err(|e| fs_error(&e, Syscall::Mkdir, &dir, None))?;
        let exclude: Vec<&str> = exclude.iter().map(|e| e.trim_end_matches('/')).collect();
        let root = resolve(repo_root);
        let mut copied = Vec::new();
        for path in paths {
            let abs = resolve(&root.join(path));
            if !abs.exists() {
                continue;
            }
            copy_recursive(fs, &abs, &dir, &root, &exclude, &mut copied)?;
        }
        Ok(BackupHandle {
            path: dir,
            files: copied,
        })
    }
}

/// `relative(repoRoot, abs)` for a path under the root.
fn relative(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn is_excluded(rel: &str, exclude: &[&str]) -> bool {
    exclude
        .iter()
        .any(|ex| rel == *ex || rel.strip_prefix(ex).is_some_and(|r| r.starts_with('/')))
}

fn copy_recursive(
    fs: &mut dyn Fs,
    abs: &Path,
    backup_dir: &Path,
    root: &Path,
    exclude: &[&str],
    copied: &mut Vec<String>,
) -> Result<(), FsError> {
    let rel = relative(root, abs);
    if is_excluded(&rel, exclude) {
        return Ok(());
    }
    let meta = std::fs::metadata(abs).map_err(|e| fs_error(&e, Syscall::Stat, abs, None))?;
    if meta.is_dir() {
        let entries =
            std::fs::read_dir(abs).map_err(|e| fs_error(&e, Syscall::Scandir, abs, None))?;
        let mut names = Vec::new();
        for entry in entries {
            names.push(
                entry
                    .map_err(|e| fs_error(&e, Syscall::Scandir, abs, None))?
                    .file_name(),
            );
        }
        // libuv's `scandir` sorts entries bytewise; `read_dir` returns them in disk order.
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        for name in names {
            copy_recursive(fs, &abs.join(name), backup_dir, root, exclude, copied)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Ok(());
    }
    let dest = backup_dir.join(&rel);
    if let Some(parent) = dest.parent() {
        fs.mkdir_all(parent)
            .map_err(|e| fs_error(&e, Syscall::Mkdir, parent, None))?;
    }
    fs.copy(abs, &dest)
        .map_err(|e| fs_error(&e, Syscall::Copyfile, abs, Some(&dest)))?;
    copied.push(rel);
    Ok(())
}

/// `DEFAULT_RETENTION_DAYS`.
pub const RETENTION_DAYS: f64 = 30.0;

/// `DEFAULT_MAX_TOTAL_BYTES`: 2 GiB.
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// `stat.mtimeMs`: milliseconds since the epoch, with the sub-millisecond fraction.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    #[allow(
        clippy::cast_precision_loss,
        reason = "`mtimeMs` is a JS number built from the same seconds and nanoseconds"
    )]
    let ms = meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6;
    ms
}

/// `dirSizeBytes(dir)`: the regular files under `dir`, symlinks followed; a failure mid-walk
/// keeps what was counted so far.
fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let mut walk = || -> std::io::Result<()> {
        let mut names: Vec<_> = std::fs::read_dir(dir)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect::<Result<_, _>>()?;
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        for name in names {
            let full = dir.join(name);
            let meta = std::fs::metadata(&full)?;
            if meta.is_dir() {
                total += dir_size_bytes(&full);
            } else if meta.is_file() {
                total += meta.len();
            }
        }
        Ok(())
    };
    let _ = walk();
    total
}

/// `purgeOldBackups({ retentionDays, maxTotalBytes })` at `now_ms` over `root`: first every
/// backup older than the retention, then oldest-first until the rest fits under the cap. An entry
/// that vanishes or fails mid-scan is skipped. The pruned directories, in order.
///
/// # Errors
/// [`FsError`] with Node's message when `root` exists but cannot be listed, where the TS throws.
pub fn purge_old_backups(
    fs: &mut dyn Fs,
    root: &Path,
    now_ms: f64,
    retention_days: f64,
    max_total_bytes: u64,
) -> Result<Vec<PathBuf>, FsError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let cutoff = now_ms - retention_days * 24.0 * 60.0 * 60.0 * 1000.0;
    let entries =
        std::fs::read_dir(root).map_err(|e| fs_error(&e, Syscall::Scandir, root, None))?;
    let mut names = Vec::new();
    for entry in entries {
        names.push(
            entry
                .map_err(|e| fs_error(&e, Syscall::Scandir, root, None))?
                .file_name(),
        );
    }
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut pruned = Vec::new();
    let mut survivors: Vec<(PathBuf, f64)> = Vec::new();
    for name in names {
        let full = root.join(name);
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mtime = mtime_ms(&meta);
        if mtime < cutoff {
            if fs.remove(&full, true).is_ok() {
                pruned.push(full);
            }
        } else {
            survivors.push((full, mtime));
        }
    }
    // `Array.prototype.sort` is stable, as is `sort_by`.
    survivors.sort_by(|a, b| a.1.total_cmp(&b.1));
    let sized: Vec<(PathBuf, u64)> = survivors
        .into_iter()
        .map(|(path, _)| {
            let bytes = dir_size_bytes(&path);
            (path, bytes)
        })
        .collect();
    let mut total: u64 = sized.iter().map(|(_, bytes)| bytes).sum();
    for (path, bytes) in sized {
        if total <= max_total_bytes {
            break;
        }
        if fs.remove(&path, true).is_ok() {
            pruned.push(path);
        }
        total = total.saturating_sub(bytes);
    }
    Ok(pruned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_replace_each_utf16_unit_outside_the_safe_set() {
        assert_eq!(backup_repo_label(Path::new("/w/my repo.v2")), "my-repo.v2");
        assert_eq!(backup_repo_label(Path::new("/w/caf\u{e9}")), "caf-");
        assert_eq!(backup_repo_label(Path::new("/w/a\u{1f600}b")), "a--b");
        assert_eq!(backup_repo_label(Path::new("/")), "repo");
        assert_eq!(backup_repo_label(Path::new("/w/x/../y")), "y");
    }

    #[test]
    fn exclusion_matches_the_path_or_its_subtree() {
        let exclude = [".claude/worktrees", ".navori/state"];
        assert!(is_excluded(".claude/worktrees", &exclude));
        assert!(is_excluded(".claude/worktrees/a/b", &exclude));
        assert!(!is_excluded(".claude/worktrees-old", &exclude));
        assert!(!is_excluded(".claude", &exclude));
    }
}
