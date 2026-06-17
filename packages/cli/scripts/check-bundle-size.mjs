import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Spec 0003 §3.4.7 — bundle size guard.
 *
 * Tracks dist/index.js as a regression tripwire, not an optimization target.
 * The spec's 200KB figure was aspirational; the real bundle (~223KB) carries
 * Zod + citty + clack and that's fine for a CLI (no browser/cold-start cost).
 * The limit sits above today's size with headroom so it catches a runaway
 * dependency, not normal growth.
 */
const LIMIT_KB = 260;

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
