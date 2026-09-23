import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Spec 0003 §3.4.7 — bundle size guard.
 *
 * Tracks dist/index.js as a regression tripwire, not an optimization target.
 * As of the bundle-footprint change the build minifies AND inlines every
 * runtime dependency (`deps.alwaysBundle` in tsdown.config.ts), so
 * dist/index.js now
 * carries zod + citty + clack + picocolors on purpose (~775KB, tsdown/rolldown
 * as of #890). That's the deliberate trade for a ~82% smaller install
 * footprint (6.1MB → 1.1MB, zero third-party node_modules). The limit sits
 * above today's size with headroom so it still catches a runaway dependency
 * — a NEW heavy dep would push the bundle past 1200KB — without flagging
 * normal first-party growth.
 *
 * Raised 800 -> 900 when `audit` landed. Measured at that point: 792KB
 * without the feature, 816KB with it — the headroom this comment promises had
 * already been spent by first-party growth, so the guard was about to fire on
 * exactly the case it says it does not police. `audit` adds ~24KB and ZERO
 * dependencies; the new limit restores ~84KB of room for a dep to trip.
 *
 * Raised 900 -> 1000 by the audit signal work (#603/#605/#607), and the
 * measurement says the same thing again: `main` alone already built to 900KB,
 * sitting ON the limit before the branch added anything. The four changes add
 * ~4KB of first-party code and ZERO dependencies. Restores ~96KB of room.
 *
 * If a third raise ever gets proposed for first-party growth, the guard has
 * stopped measuring what it claims to: at that point split the check in two —
 * a hard ceiling for bundled deps and a soft trend line for our own code.
 *
 * Raised 1000 -> 1200 by the pnpm -> bun migration, and NOT for first-party
 * growth (zero lines of `src/` changed): moving off `pnpm-lock.yaml` to a
 * fresh `bun.lock` re-resolved every `^`-ranged dependency against today's
 * registry instead of reusing the versions pnpm had pinned. `zod` alone moved
 * 4.4.3 -> 4.6.5 (still inside `^4.4.3`, so semver-legitimate) and that one
 * bump is the whole difference: 984KB -> 1107KB. Pinning zod to dodge it was
 * considered and rejected — it would silently freeze a dependency range this
 * repo does not otherwise pin, for a metric's sake, and the same re-resolution
 * will happen again at the next `bun install` regardless. Measured at 1107KB;
 * restores ~93KB of headroom.
 */
const LIMIT_KB = 1200;

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "..", "dist", "index.js");

let sizeKb;
try {
  sizeKb = statSync(bundle).size / 1024;
} catch {
  console.error(`✗ bundle not found at ${bundle} — run 'bun run build' first`);
  process.exit(1);
}

const rounded = Math.round(sizeKb * 10) / 10;
if (sizeKb > LIMIT_KB) {
  console.error(`✗ bundle ${rounded}KB exceeds the ${LIMIT_KB}KB limit`);
  process.exit(1);
}
console.log(`✓ bundle ${rounded}KB (limit ${LIMIT_KB}KB)`);
