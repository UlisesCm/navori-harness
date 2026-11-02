#!/usr/bin/env node
/**
 * Derives `crates/navori-core/assets/pi/extension.ts.in` from the built TS CLI (spec 0059 D29).
 *
 * Renders a temporary repo with `engines: ["pi"]` and no MCP plugin through `packages/cli/dist`
 * (the binary the oracle compares against: `serializeAnonymousFunction` output depends on the
 * bundler), reads `.pi/extensions/navori.ts` and turns it into a template:
 *   - drops the first line (`// navori:managed-file …`), which Rust recomputes;
 *   - `const MCP_PLUGIN_IDS: readonly string[] = [];` → `… = {{json:mcpPluginIds}};`
 *   - each `  <role>: new Set(<base tools>),` of `ROLE_TOOLS` → `  <role>: new Set({{json:roleTools.<role>}}),`
 *     (the knowledge grants of `knowledge-tools.ts` extend a role's tools; amendment to D29).
 * Each replaced line must appear exactly once, and `{{json:` must not appear before replacing.
 *
 *   node scripts/js/gen-pi-extension-asset.mjs           write the asset
 *   node scripts/js/gen-pi-extension-asset.mjs --check   exit 1 when the asset is stale
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = process.env.NAVORI_TS_CLI || join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const ASSET = join(REPO_ROOT, "crates", "navori-core", "assets", "pi", "extension.ts.in");

/** `PI_ROLE_NAMES` and `PI_ROLE_TOOLS` of `engines/pi/role-tools.ts`. */
const ROLE_TOOLS = {
  scout: ["read", "grep", "find", "ls", "write"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash", "write"],
  scribe: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  auditor: ["read", "grep", "find", "ls", "bash", "write"],
  architect: ["read", "grep", "find", "ls", "bash", "write"],
  publisher: ["read", "grep", "find", "ls", "bash"],
};

const CONFIG = {
  name: "pi-asset",
  version: "1.0.0",
  engines: ["pi"],
  preset: "custom",
  language: "en",
  plugins: { engram: { enabled: false }, codegraph: { enabled: false } },
};

/** Replaces the single occurrence of `from` with `to`, or throws. */
function replaceOnce(text, from, to) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + 1) >= 0) {
    throw new Error(`gen-pi-extension-asset: expected exactly one ${JSON.stringify(from)}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** The template text derived from a fresh Pi render. */
export function deriveAsset() {
  const work = mkdtempSync(join(tmpdir(), "navori-pi-asset-"));
  try {
    const repo = join(work, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(work, "home"), { recursive: true });
    writeFileSync(join(repo, "navori.config.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
    writeFileSync(join(repo, "package.json"), '{"name":"pi-asset","version":"1.0.0"}\n');
    const run = spawnSync(process.execPath, [DIST, "render", "--apply"], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", HOME: join(work, "home"), NO_COLOR: "1" },
      encoding: "utf8",
    });
    if (run.status !== 0) {
      throw new Error(`gen-pi-extension-asset: render failed: ${run.stdout}${run.stderr}`);
    }
    const source = readFileSync(join(repo, ".pi", "extensions", "navori.ts"), "utf8");
    if (source.includes("{{json:")) throw new Error("gen-pi-extension-asset: source already has {{json:");
    let text = source.slice(source.indexOf("\n") + 1);
    text = replaceOnce(
      text,
      "const MCP_PLUGIN_IDS: readonly string[] = [];",
      "const MCP_PLUGIN_IDS: readonly string[] = {{json:mcpPluginIds}};",
    );
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      text = replaceOnce(
        text,
        `  ${role}: new Set(${JSON.stringify(tools)}),`,
        `  ${role}: new Set({{json:roleTools.${role}}}),`,
      );
    }
    return text;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const text = deriveAsset();
  if (argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(ASSET, "utf8");
    } catch {
      // Missing asset: stale.
    }
    if (current !== text) {
      process.stderr.write(
        "gen-pi-extension-asset: crates/navori-core/assets/pi/extension.ts.in is stale; run node scripts/js/gen-pi-extension-asset.mjs\n",
      );
      return 1;
    }
    process.stdout.write("gen-pi-extension-asset: up to date\n");
    return 0;
  }
  mkdirSync(dirname(ASSET), { recursive: true });
  writeFileSync(ASSET, text);
  process.stdout.write(`gen-pi-extension-asset: wrote ${ASSET}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
