import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Spec 0003 §3.4.7 — bundle size guard.
 *
 * Tracks dist/index.js as a regression tripwire, not an optimization target.
 * As of the bundle-footprint change the build minifies AND inlines every
 * runtime dependency (`noExternal` in tsup.config.ts), so dist/index.js now
 * carries zod + citty + clack + picocolors on purpose (~657KB). That's the
 * deliberate trade for a ~82% smaller install footprint (6.1MB → 1.1MB, zero
 * third-party node_modules). The limit sits above today's size with headroom
 * so it still catches a runaway dependency — a NEW heavy dep would push the
 * bundle past 800KB — without flagging normal first-party growth.
 *
 * Raised 800 -> 900 when `audit` landed. Measured at that point: 792KB
 * without the feature, 816KB with it — the headroom this comment promises had
 * already been spent by first-party growth, so the guard was about to fire on
 * exactly the case it says it does not police. `audit` adds ~24KB and ZERO
 * dependencies; the new limit restores ~84KB of room for a dep to trip.
 */
const LIMIT_KB = 900;

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "..", "dist", "index.js");

let sizeKb;
try {
  sizeKb = statSync(bundle).size / 1024;
} catch {
  console.error(`✗ bundle not found at ${bundle} — run 'pnpm build' first`);
  process.exit(1);
}

const rounded = Math.round(sizeKb * 10) / 10;
if (sizeKb > LIMIT_KB) {
  console.error(`✗ bundle ${rounded}KB exceeds the ${LIMIT_KB}KB limit`);
  process.exit(1);
}
console.log(`✓ bundle ${rounded}KB (limit ${LIMIT_KB}KB)`);
