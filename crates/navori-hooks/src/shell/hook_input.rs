//! The `hook-input` partial: the host facts a hook reads from its environment and
//! `nv_project_dir`, resolved per engine from the payload's `cwd`.

use super::repo::Repo;
use crate::runner::Engine;

/// Host facts the shell reads from its environment before the rules run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Host {
    /// `nv_project_dir`: `$CLAUDE_PROJECT_DIR` under Claude; under Codex and Pi the git
    /// toplevel of the payload's `cwd`, else that `cwd`, else `.`.
    pub project_dir: String,
    /// The payload's `cwd` field (`payload_field cwd`), empty when absent.
    pub cwd: String,
    /// `PWD` of the hook process.
    pub pwd: String,
    /// `HOME`, `None` when unset (rule 7 expands `~` with it).
    pub home: Option<String>,
    /// `CLAUDE_PROJECT_DIR` as the environment holds it, under every engine (rule 1b's home
    /// repository and its fallback comparison).
    pub claude_project_dir: Option<String>,
    /// `CDPATH`: a non-empty value leaves a relative `cd` unproven in rule 1b.
    pub cdpath: Option<String>,
    /// `navori_hook_path`: `$0`, prefixed with `PWD/` when relative.
    pub hook_path: String,
    /// `PATH`, where the search lane looks for `tgrep`.
    pub path: Option<String>,
}

/// `nv_project_dir`: `$CLAUDE_PROJECT_DIR` under Claude; under Codex and Pi the git toplevel of
/// the payload's `cwd` (`.` when empty), falling back to that directory outside a work tree.
#[must_use]
pub fn project_dir(
    engine: Engine,
    claude_project_dir: Option<&str>,
    cwd: &str,
    repo: &dyn Repo,
) -> String {
    if engine == Engine::Claude {
        claude_project_dir.unwrap_or_default().to_owned()
    } else {
        let dir = if cwd.is_empty() { "." } else { cwd };
        repo.toplevel(dir).unwrap_or_else(|| dir.to_owned())
    }
}
