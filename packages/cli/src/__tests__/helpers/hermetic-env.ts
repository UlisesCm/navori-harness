/**
 * Environment for tests that seed `$HOME/.navori/audits` on purpose. The hermetic suite points
 * `NAVORI_AUDITS_ROOT` at a path that does not exist; dropping it makes the audit root resolve
 * under `HOME` again.
 *
 * @param env Base environment, `process.env` by default; it is not mutated.
 * @returns A copy without `NAVORI_AUDITS_ROOT`.
 */
export function auditsUnderHome(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { NAVORI_AUDITS_ROOT: _override, ...rest } = env;
  return rest;
}
