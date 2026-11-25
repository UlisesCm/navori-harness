//! `navori_progress_ratchet_lane` (#1263, #1266): a session-state file over the ceiling and
//! larger than at HEAD blocks the commit. Sizes come from [`Repo`], measured from `root`.

use super::repo::Repo;

const PATHS: [&str; 3] = [
    "progress/current.md",
    ".claude/progress/current.md",
    ".codex/progress/current.md",
];

/// Run the lane from `root` with the rendered ceiling. `Ok(Some(stderr))` blocks.
///
/// # Errors
/// A ceiling of digits that the shell's `[ -gt ]` cannot compare.
pub(crate) fn lane(root: &str, cap: &str, repo: &dyn Repo) -> Result<Option<String>, String> {
    // A placeholder or anything but digits turns the lane off.
    if cap.is_empty() || !cap.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    let ceiling: i64 = cap
        .parse()
        .map_err(|_| format!("progress ceiling {cap} is out of the shell's integer range"))?;
    for path in PATHS {
        if repo.ignored(root, path) {
            continue;
        }
        let worktree = repo.file_size(root, path);
        let index = repo.blob_size(root, &format!(":{path}"));
        let head = repo.blob_size(root, &format!("HEAD:{path}"));
        let size = worktree.max(index);
        if i128::from(size) > i128::from(ceiling) && size > head {
            return Ok(Some(format!(
                "[navori] Commit BLOCKED: {path} is {size} bytes, over the {cap}-byte ceiling, and larger than at HEAD ({head} bytes).\n[navori] It must hold only the current state and the next step. Trim it (move older checkpoints to progress/history.md) and commit again.\n"
            )));
        }
    }
    Ok(None)
}
