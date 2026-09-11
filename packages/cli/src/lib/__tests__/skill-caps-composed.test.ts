import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter, countWords, skillComposedCap } from "../skill-meta.ts";
import { listMarkers } from "../health.ts";
import { extractManagedContent } from "../marker.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import type { NavoriConfig } from "../../lib/config.ts";

/**
 * #683 — the word cap was measured over the wrong artifact.
 *
 * `skill-caps.test.ts` checks each ASSET against its own cap, BEFORE render.
 * What an agent loads is the composed `SKILL.md`: every plugin rung appended
 * and the project's own values already interpolated into the managed zone.
 * Nobody measured that file, and it had drifted far — `structural-search`
 * shipped 1348 managed words against a declared `maxWords: 600`, with all 22
 * assets of the package green.
 *
 * Two independent defects add up there, and this one test covers both:
 *
 *  1. NOBODY OWNS THE SUM. Three pieces each inside its own budget
 *     (572/600 core, 199/200 codegraph-rung, 544/550 tgrep-rung) compose into
 *     2.2× the host's cap. Each extension spends its margin against its OWN
 *     number, never against the skill it extends.
 *  2. RENDER INFLATES THE BLOCK. `project.criticalAreas` are interpolated
 *     INSIDE the managed zone, so a repo with verbose areas pushes a skill past
 *     its cap with no plugin involved — `review-diff` measured 1177 as an asset
 *     and 1217 rendered, over its 1200.
 *
 * So the fixture below is not a minimal config on purpose: it enables the
 * plugins that extend skills AND carries deliberately verbose critical areas.
 * That combination is exactly the case the suite had no coverage for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..", "..");
const coreAssets = resolve(cliRoot, "..", "core", "core-assets");

/** Every HOST skill asset by name — the ones that render into a directory. */
function hostAssets(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of [resolve(coreAssets, "skills"), resolve(coreAssets, "lib-skills")]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      byName.set(basename(file, ".md"), resolve(dir, file));
    }
  }
  for (const preset of readdirSync(resolve(coreAssets, "presets"), { withFileTypes: true })) {
    if (!preset.isDirectory()) continue;
    const dir = resolve(coreAssets, "presets", preset.name, "skills");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      byName.set(basename(file, ".md"), resolve(dir, file));
    }
  }
  return byName;
}

/**
 * Words navori generated in a composed file: every managed block, and nothing
 * else.
 *
 * Read through `listMarkers` + `extractManagedContent` rather than a regex over
 * the text, because those are fence-aware: a body that quotes a close marker
 * inside a ```fence``` truncated a naive slice (#459). The user-section is
 * excluded by construction — it lives outside every block, which is the whole
 * point of #323: charging the repo's own knowledge to navori's budget would
 * shrink a skill the more useful the team made it.
 */
function managedWords(file: string): number {
  const raw = readFileSync(file, "utf-8");
  let total = 0;
  for (const marker of listMarkers(file)) {
    const content = extractManagedContent(raw, marker.id);
    if (content !== null) total += countWords(content);
  }
  return total;
}

const CONFIG = {
  name: "fixture-caps",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  plugins: {
    codegraph: { enabled: true },
    tgrep: { enabled: true },
    jscpd: { enabled: true },
    semgrep: { enabled: true },
    engram: { enabled: true },
  },
  project: {
    // Verbose on purpose: this is defect 2. These strings are interpolated
    // INSIDE the managed zone of `review-diff`, so their length is charged to
    // a budget the asset-level test cannot see.
    criticalAreas: [
      "apps/api/src/ingestion — health-data ingestion (PHI): valida siempre contra los schemas de packages/contracts",
      "apps/api/src/db + drizzle-kit — schema y migraciones: nunca editar una migración ya aplicada",
      "packages/contracts — DTOs canónicos + zod schemas compartidos api/mobile: cambio aquí impacta ambos apps",
    ],
  },
} as unknown as NavoriConfig;

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-caps-composed-"));
  renderClaudeEngine(cwd, CONFIG);
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("word cap over the composed SKILL.md (#683)", () => {
  it("renders the skills this test is about", () => {
    // A guard on the fixture itself: if the render stops producing these, the
    // assertions below would pass by measuring nothing.
    const dir = join(cwd, ".claude", "skills");
    const rendered = readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md")));
    expect(rendered).toContain("structural-search");
    expect(rendered).toContain("review-diff");
    expect(rendered.length).toBeGreaterThan(5);
  });

  it("keeps every composed skill inside the budget it declares", () => {
    const assets = hostAssets();
    const dir = join(cwd, ".claude", "skills");
    const over: string[] = [];

    for (const name of readdirSync(dir)) {
      const composed = join(dir, name, "SKILL.md");
      const asset = assets.get(name);
      // A skill with no host asset is project-local: navori indexes it and
      // never writes it, so it has no budget of navori's to blow.
      if (!existsSync(composed) || !asset) continue;

      const { meta } = parseSkillFrontmatter(readFileSync(asset, "utf-8"));
      const cap = skillComposedCap(meta);
      if (cap === null) continue; // no type and no override: skill-caps.test.ts owns that
      const words = managedWords(composed);
      if (words > cap) over.push(`${name}: ${words} words > ${cap}`);
    }

    // Named, not counted: the failure has to say which skill and by how much,
    // because the fix is a judgement about content or about the budget — and
    // the reader cannot make it from a boolean.
    expect(over).toEqual([]);
  });
});
