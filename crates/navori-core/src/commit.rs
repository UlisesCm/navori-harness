//! `commitWrites` (spec 0058 T22, R44, R46; `engines/shared/execute-plan.ts`): back up exactly
//! what a render is about to destroy, write each pending file atomically (the engine's entry
//! point last), `chmod +x` best-effort, remove, and prune the backup store once.
//!
//! Every mutation goes through [`Fs`]. A failure inside the write loop becomes the TS's
//! `RenderWriteError` message; one while taking the backup surfaces as the raw error, as there.

use std::path::{Path, PathBuf};

use jiff::Zoned;

use crate::backup::{BackupStore, MAX_TOTAL_BYTES, RETENTION_DAYS, purge_old_backups};
use crate::fs::{Fs, FsError, Syscall, node_message, write_file_atomic};
use crate::i18n;
use crate::render::collect::PendingWrite;
use crate::render::context::Lang;
use crate::render::nested_gitignore::EPHEMERAL_HARNESS_PATHS;
use crate::render::retirements::PendingRemoval;

/// What `commitWrites` reads besides the plan.
pub struct CommitInput<'a> {
    /// The repo root, absolute.
    pub cwd: &'a Path,
    /// Engine-specific backup excludes, on top of the ephemeral paths.
    pub backup_exclude: &'a [&'a str],
    /// A preview: nothing is backed up, written or removed.
    pub dry_run: bool,
    /// Files written last (the engine's entry point), in a stable sort.
    pub write_last: Option<&'a dyn Fn(&PendingWrite) -> bool>,
    /// The engine name in the failure message.
    pub engine_label: Option<&'a str>,
    /// Removals after the writes, each failure swallowed (Claude), or inside the write loop (Codex).
    pub removals_best_effort: bool,
    /// Output language.
    pub lang: Lang,
    /// Current time, for the backup name and the purge cutoff.
    pub now: &'a Zoned,
}

/// What a commit did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// `(path, status)` of every write, in commit order, then every removal.
    pub written: Vec<(String, &'static str)>,
    /// The pre-write backup, when one copied something.
    pub backup_path: Option<PathBuf>,
    /// `noteRealWrite()` calls: each write and each removal that went through.
    pub real_writes: usize,
}

/// Why a commit stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitError {
    /// Taking the backup failed: nothing was written.
    Backup(FsError),
    /// `RenderWriteError`: a write or removal failed after the backup.
    Write {
        /// The message.
        message: String,
        /// `backupPath`.
        backup_path: Option<PathBuf>,
    },
}

fn removal_status() -> &'static str {
    "removed-condition-false"
}

/// `commitWrites(input)` over `pending` and `removals` (sorted in place when `write_last` is set
/// and the commit is real, as the TS sorts its array).
///
/// # Errors
/// [`CommitError`] where the TS throws.
pub fn commit_writes(
    fs: &mut dyn Fs,
    backups: &mut BackupStore,
    pending: &mut [PendingWrite],
    removals: &[PendingRemoval],
    input: &CommitInput<'_>,
) -> Result<Committed, CommitError> {
    let cwd = input.cwd;
    let mut backup_path = None;
    let mut real_writes = 0;
    if (!pending.is_empty() || !removals.is_empty()) && !input.dry_run {
        let mut targets: Vec<String> = Vec::new();
        let existing = pending
            .iter()
            .filter(|w| cwd.join(&w.rel_path).exists())
            .map(|w| w.rel_path.clone());
        for target in existing.chain(removals.iter().map(|r| r.rel_path.clone())) {
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        if !targets.is_empty() {
            let mut exclude: Vec<&str> = Vec::new();
            for ex in EPHEMERAL_HARNESS_PATHS
                .iter()
                .copied()
                .chain(input.backup_exclude.iter().copied())
            {
                if !exclude.contains(&ex) {
                    exclude.push(ex);
                }
            }
            let handle = backups
                .create(fs, cwd, &targets, &exclude, input.now)
                .map_err(CommitError::Backup)?;
            if !handle.files.is_empty() {
                backup_path = Some(handle.path);
                if let Ok(root) = backups.root.clone() {
                    #[allow(
                        clippy::cast_precision_loss,
                        reason = "`Date.now()` is a JS number of milliseconds"
                    )]
                    let now_ms = input.now.timestamp().as_millisecond() as f64;
                    purge_old_backups(fs, &root, now_ms, RETENTION_DAYS, MAX_TOTAL_BYTES)
                        .map_err(CommitError::Backup)?;
                }
            }
        }
        if let Some(write_last) = input.write_last {
            pending.sort_by_key(|w| write_last(w));
        }
        let mut current = PathBuf::new();
        let mut completed: Vec<String> = Vec::new();
        let result = (|| -> Result<(), FsError> {
            for item in pending.iter() {
                let path = cwd.join(&item.rel_path);
                current.clone_from(&path);
                if let Some(parent) = path.parent() {
                    fs.mkdir_all(parent).map_err(|e| FsError {
                        message: node_message(&e, Syscall::Mkdir, parent, None),
                    })?;
                }
                write_file_atomic(fs, &path, &item.content)?;
                real_writes += 1;
                if item.chmod_exec {
                    // Best effort on filesystems without executable bits.
                    let _ = fs.chmod(&path, 0o755);
                }
                completed.push(item.rel_path.clone());
            }
            if !input.removals_best_effort {
                for removal in removals {
                    let path = cwd.join(&removal.rel_path);
                    current.clone_from(&path);
                    fs.remove(&path, removal.recursive).map_err(|e| FsError {
                        message: node_message(&e, Syscall::Rm, &path, None),
                    })?;
                    real_writes += 1;
                    completed.push(removal.rel_path.clone());
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let hint = backup_path
                .as_ref()
                .map_or_else(String::new, |p: &PathBuf| {
                    i18n::backup_available_at(input.lang, &p.display().to_string())
                });
            let unfinished: Vec<&str> = pending
                .iter()
                .map(|w| w.rel_path.as_str())
                .chain(removals.iter().map(|r| r.rel_path.as_str()))
                .filter(|p| !completed.iter().any(|c| c == p))
                .collect();
            let list = |items: Vec<&str>| {
                if items.is_empty() {
                    "none".to_owned()
                } else {
                    items.join(", ")
                }
            };
            let message = format!(
                "{}. Completed: {}; unfinished: {}.{hint}",
                i18n::render_failed_writing(
                    input.lang,
                    input.engine_label,
                    &current.display().to_string(),
                    &error.message
                ),
                list(completed.iter().map(String::as_str).collect()),
                list(unfinished),
            );
            return Err(CommitError::Write {
                message,
                backup_path,
            });
        }
        if input.removals_best_effort {
            for removal in removals {
                // Best effort: a read-only scripts dir shouldn't crash the render.
                if fs
                    .remove(&cwd.join(&removal.rel_path), removal.recursive)
                    .is_ok()
                {
                    real_writes += 1;
                }
            }
        }
    }
    Ok(Committed {
        written: pending
            .iter()
            .map(|w| (w.rel_path.clone(), w.status.as_str()))
            .chain(
                removals
                    .iter()
                    .map(|r| (r.rel_path.clone(), removal_status())),
            )
            .collect(),
        backup_path,
        real_writes,
    })
}
