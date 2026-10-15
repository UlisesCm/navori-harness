/**
 * The state-root lock shared by every writer of a workplan and of the
 * acceptance index (R11): `plan update` (phase 2), `plan render` and
 * `prepareDeliverySlice`. One lock per state root, not per feature, because
 * `writeAcceptanceIndex` rewrites an index shared by all the features.
 */
import { withFileLock } from "../primitives/lockfile.ts";
import {
  ensureStateDirectory,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";

/** Runs `fn` holding `<stateRoot>/.plan-update.lock`. The state directory is
 * ensured first: without it the lock's `openSync(…, "wx")` would fail `ENOENT`.
 * Throws `LockTimeoutError` when another writer holds the lock for 5 s. */
export function withPlanStateLock<T>(root: StateRoot, fn: () => T): T {
  ensureStateDirectory(root);
  return withFileLock(stateArtifactPath(root, ".plan-update.lock"), fn);
}
