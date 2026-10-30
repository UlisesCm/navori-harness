//! Host facts the shell reads from its environment, and `hook-input`'s project directory
//! (spec 0059 D32): shared by every ported hook that resolves a repository from a payload.

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

impl Host {
    /// `hook-input`'s `nv_project_dir` for a payload whose `cwd` is `cwd`: `$CLAUDE_PROJECT_DIR`
    /// under Claude; under Codex and Pi the git toplevel of `cwd`, else `cwd`, else `.`.
    #[must_use]
    pub fn project_dir_for(&self, engine: Engine, cwd: &str, repo: &dyn Repo) -> String {
        if engine == Engine::Claude {
            self.claude_project_dir.clone().unwrap_or_default()
        } else {
            let dir = if cwd.is_empty() { "." } else { cwd };
            repo.toplevel(dir).unwrap_or_else(|| dir.to_owned())
        }
    }
}
