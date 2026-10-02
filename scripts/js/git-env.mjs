/**
 * Repository-local Git variables. Git exports them into hooks (a commit from a
 * linked worktree sets `GIT_DIR` and `GIT_INDEX_FILE`), and every child Git
 * process that inherits them acts on THAT repository, whatever its `cwd`.
 * Mirrors `git rev-parse --local-env-vars` (hardcoded to stay pure and
 * deterministic; a test checks it is a superset of what git reports).
 */
export const REPO_LOCAL_GIT_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/**
 * Copy of `env` without the repository-local Git variables, for spawning
 * processes (Vitest, whose fixtures run `git init`) that must not touch the
 * repository the hook runs in.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function withoutRepoGitEnv(env) {
  const clean = { ...env };
  for (const name of REPO_LOCAL_GIT_VARS) delete clean[name];
  // `GIT_CONFIG_COUNT` is paired with indexed entries that are meaningless alone.
  for (const name of Object.keys(clean)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete clean[name];
  }
  return clean;
}
