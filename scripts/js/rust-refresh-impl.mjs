#!/usr/bin/env node
/**
 * Rewrites every `hooks.<id>.impl` of `crates/ported.json` to the implementation hash of the
 * current `crates/navori-hooks/src` (spec 0057 D8). The hash covers the shared runtime and the
 * hook's own sources, so any commit that touches them must refresh it; the job `manifest`
 * (`rust-manifest-check.mjs`) fails otherwise. Run it from the repository root.
 *
 *   node scripts/js/rust-refresh-impl.mjs           rewrite ported.json and say what changed
 *   node scripts/js/rust-refresh-impl.mjs --check   exit 1 when a hash is stale, write nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { implementationHash } from "./rust-manifest-check.mjs";

const MANIFEST = "crates/ported.json";
const check = process.argv.includes("--check");

let text = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(text);
let stale = 0;
for (const id of Object.keys(manifest.hooks ?? {})) {
  const current = manifest.hooks[id].impl;
  const fresh = implementationHash(".", id);
  if (current === fresh) continue;
  stale += 1;
  console.log(`${id}: ${current.slice(0, 18)} -> ${fresh.slice(0, 18)}`);
  text = text.replace(current, fresh);
}
if (stale === 0) console.log("rust-refresh-impl: every impl hash is current");
else if (check) process.exit(1);
else writeFileSync(MANIFEST, text);
