// Generate the public JSON Schema files that back every `$schema` URL navori
// writes into the configs/manifests it emits. The CLI stamps
// `https://navori.dev/schema/<name>.json` into each generated file; those URLs
// 404 unless the matching JSON Schema is published on the website. The website
// (Astro) serves `apps/website/public/` at the site root, so a file at
// `apps/website/public/schema/navori.config.v1.json` becomes reachable at
// `https://navori.dev/schema/navori.config.v1.json`.
//
// Single source of truth: the JSON Schemas are DERIVED from the zod schemas via
// `z.toJSONSchema()` (native in zod v4), so editors validate against the exact
// shape the CLI enforces. A drift test (schema-publish.test.ts) regenerates in
// memory and fails if the checked-in files fall behind the zod definitions —
// run `pnpm gen:schemas` to refresh them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NavoriConfigSchema } from "../src/lib/schema.ts";
import { WorkspaceConfigSchema } from "../src/lib/workspace.ts";
import { PresetDefinitionSchema } from "../src/lib/presets.ts";
import { CorePromptsFileSchema } from "../src/engines/claude/prompts-loader.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, ".."); // packages/cli
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");

/** Where the website serves static files from ({site}/schema/<file>). */
export const OUT_DIR = resolve(REPO_ROOT, "apps", "website", "public", "schema");

/** Base URL the CLI stamps into every emitted `$schema`. */
const BASE_URL = "https://navori.dev/schema";

/**
 * Each spec pairs a zod schema with the exact filename its `$schema` URL points
 * at. The `file` values MUST match the URLs the CLI writes:
 *   - lib/config.ts        → navori.config.v1.json
 *   - lib/workspace.ts     → navori.workspace.v1.json
 *   - commands/preset.ts   → navori.preset.v1.json
 *   - core-assets/prompts.json → prompts.v1.json
 */
export const SCHEMA_SPECS = [
  {
    file: "navori.config.v1.json",
    schema: NavoriConfigSchema,
    title: "navori.config.json",
    description:
      "Source-of-truth config checked into a repo that uses navori. `navori render` reconstructs the harness from this file.",
  },
  {
    file: "navori.workspace.v1.json",
    schema: WorkspaceConfigSchema,
    title: "navori workspace manifest",
    description:
      "Machine-local workspace manifest (~/.navori/workspaces/<name>/workspace.json) linking related repos and cross-repo defaults.",
  },
  {
    file: "navori.preset.v1.json",
    schema: PresetDefinitionSchema,
    title: "navori preset definition",
    description:
      "Stack-specific preset manifest declaring the EXTRA managed assets (managed blocks, agents, skills, hooks) a preset contributes on top of the core baseline.",
  },
  {
    file: "prompts.v1.json",
    schema: CorePromptsFileSchema,
    title: "navori init prompts",
    description:
      "Project-customization questions the `init` wizard asks; answers persist to config.project.<key> and render into the managed project-context block.",
  },
];

/** Build the published JSON Schema object for one spec (pure — no I/O). */
export function buildSchema(spec) {
  const { $schema, ...body } = z.toJSONSchema(spec.schema);
  return {
    $schema,
    $id: `${BASE_URL}/${spec.file}`,
    title: spec.title,
    description: spec.description,
    ...body,
  };
}

/** Canonical on-disk representation (stable formatting + trailing newline). */
export function serializeSchema(spec) {
  return `${JSON.stringify(buildSchema(spec), null, 2)}\n`;
}

export function schemaPath(spec) {
  return resolve(OUT_DIR, spec.file);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of SCHEMA_SPECS) {
    const path = schemaPath(spec);
    writeFileSync(path, serializeSchema(spec));
    console.log(`wrote ${path}`);
  }
}

// Only write files when run directly (`pnpm gen:schemas`), not when imported by
// the drift test. Compare filesystem paths (not the URL) so a repo path with
// spaces — which `import.meta.url` percent-encodes — still matches argv[1].
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
