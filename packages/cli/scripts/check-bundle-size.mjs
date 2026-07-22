import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Spec 0003 §3.4.7 — bundle size guard.
 *
 * Tracks dist/index.js as a regression tripwire, not an optimization target.
 * The spec's 200KB figure was aspirational; the real bundle (~325KB) carries
 * Zod + citty + clack and that's fine for a CLI (no browser/cold-start cost).
 * The limit sits above today's size with headroom so it catches a runaway
 * dependency, not normal growth (e.g. the audit waves #69/#70 added stack
 * detection, monorepo scan and doctor checks; ronda 2 #79-#83 added the
 * anti-retroceso guard, advisory locking, plugin remove/cleanup and semver;
 * the audit-followup batch #84/#86-#92/#9 added dep-usage scanning, i18n
 * runtime catalogs, three engine adapters and more library skills — all
 * first-party, zero new deps).
 */
const LIMIT_KB = 400;

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
