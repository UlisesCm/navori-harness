import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Lang } from "../../lib/i18n.ts";
import { placeholderFallback } from "../../lib/placeholders.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";

/**
 * #375 — a placeholder that resolves to NOTHING must never reach the prose.
 *
 * `project.criticalAreas` / `project.legacyPaths` are `z.array().default([])`,
 * so a config that merely HAS a `project` section (every config `init` writes)
 * gets `[]` for the ones it left out. The interpolator serialized that as ""
 * — not `null` — so `placeholderFallback` never fired and the empty value was
 * substituted mid-sentence: the R2-architectural signal list rendered as
 * "· a `` area ·", a rule that still asserts a value is there.
 *
 * The fix has two halves and this suite pins BOTH — either one alone regresses:
 *  - a blank resolution counts as unresolved (lib/interpolate.ts), and
 *  - every optional path used inline has a readable SOFT_FALLBACK
 *    (lib/placeholders.ts). Without it the first half would only swap "" for a
 *    raw `<not configured: project.legacyPaths>` leaking into the same sentence.
 *
 * Both config shapes are swept because they fail differently: an ABSENT
 * `project` section never reached the array default (so it exercises only the
 * fallback half), while an EMPTY one is the actual repro.
 */

/** Recursively list every file render emitted (repo-relative). */
function listFiles(cwd: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(cwd, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(cwd, relPath)).isDirectory()) out.push(...listFiles(cwd, relPath));
    else out.push(relPath);
  }
  return out;
}

/** Prose/config surfaces the sweep reads (same set as the #392 citation sweep). */
const SWEPT_EXTENSIONS = /\.(md|mdc|toml|json)$/;

/**
 * An inline code span with nothing in it — the fingerprint of a placeholder
 * that collapsed to "" inside backticks. Exactly two backticks: the lookaround
 * pair lets a ``` fence (or a longer run) through untouched.
 */
const EMPTY_CODE_SPAN = /(?<!`)``(?!`)/;

type Renderer = (cwd: string, config: NavoriConfig) => void;

type EngineCase = { id: string; engines: NavoriConfig["engines"]; render: Renderer };

const CLAUDE: EngineCase = {
  id: "claude",
  engines: ["claude"],
  render: (cwd, c) => void renderClaudeEngine(cwd, c),
};
const CODEX: EngineCase = {
  id: "codex",
  engines: ["codex"],
  render: (cwd, c) => void renderCodexEngine(cwd, c),
};

const ENGINES: readonly EngineCase[] = [CLAUDE, CODEX];

/** Minimal configs: no `qualityGate`, no plugins, nothing optional filled in. */
const PROJECT_SHAPES: ReadonlyArray<{ id: string; project?: Record<string, unknown> }> = [
  { id: "no project section" },
  { id: "empty project section (the #375 repro: zod fills criticalAreas with [])", project: {} },
  // #439: a detected library pulls in its lib-skill, and a skill that documents a
  // library whose own syntax IS `{{token}}` (i18next) used to have its examples
  // eaten by the interpolator — `{{count}}` rendered as `<not configured: count>`.
  {
    id: "a detected library whose skill writes literal {{...}} (#439)",
    project: { libraries: ["i18next"] },
  },
];

const tempDirs: string[] = [];

function render(
  engine: EngineCase,
  project: Record<string, unknown> | undefined,
  language?: Lang,
): string {
  const cwd = mkdtempSync(join(tmpdir(), `navori-empty-ph-${engine.id}-`));
  tempDirs.push(cwd);
  engine.render(
    cwd,
    NavoriConfigSchema.parse({
      name: "empty-placeholder-demo",
      engines: engine.engines,
      preset: "custom",
      ...(language === undefined ? {} : { language }),
      ...(project === undefined ? {} : { project }),
    }),
  );
  return cwd;
}

/** Every swept surface's content, so a test can assert over the whole tree. */
function sweptContents(cwd: string): string[] {
  const surfaces = listFiles(cwd).filter((f) => SWEPT_EXTENSIONS.test(f));
  expect(surfaces.length).toBeGreaterThan(0);
  return surfaces.map((f) => readFileSync(join(cwd, f), "utf-8"));
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("a minimal config renders no empty / unconfigured placeholder (#375)", () => {
  for (const engine of ENGINES) {
    for (const shape of PROJECT_SHAPES) {
      it(`${engine.id} — ${shape.id}: no artifact leaks a <not configured: …> token`, () => {
        const cwd = render(engine, shape.project);
        const surfaces = listFiles(cwd).filter((f) => SWEPT_EXTENSIONS.test(f));
        expect(surfaces.length).toBeGreaterThan(0);

        const leaks = surfaces.filter((f) =>
          readFileSync(join(cwd, f), "utf-8").includes("<not configured:"),
        );
        expect(leaks).toEqual([]);
      });

      it(`${engine.id} — ${shape.id}: no artifact leaves an empty value in the prose`, () => {
        const cwd = render(engine, shape.project);
        const hits: Array<{ file: string; line: string }> = [];
        for (const file of listFiles(cwd).filter((f) => SWEPT_EXTENSIONS.test(f))) {
          for (const line of readFileSync(join(cwd, file), "utf-8").split("\n")) {
            if (EMPTY_CODE_SPAN.test(line)) hits.push({ file, line: line.trim() });
          }
        }
        expect(hits).toEqual([]);
      });
    }
  }

  it("substitutes the critical-areas fallback in the R2-architectural signal list", () => {
    // The exact sentence the bug rendered as "· a `` area ·" (CLAUDE.md:72 here).
    const claudeMd = readFileSync(join(render(CLAUDE, {}), "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("a critical area (`auth, permissions, payments, data integrity`)");
  });

  it("still prefers the configured value over the fallback", () => {
    const cwd = render(CLAUDE, { criticalAreas: ["src/auth", "src/billing"] });
    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("a critical area (`src/auth, src/billing`)");
    expect(claudeMd).not.toContain("a critical area (`auth, permissions");
  });
});

/**
 * #445 — the same sweep, aimed at the OTHER way the fallback can be wrong: not
 * absent or empty, but in the wrong language.
 *
 * `{{qualityGate.fast|full}}` appears ~82 times across the core assets, and the
 * soft fallback was a Spanish literal with no access to the config, so every
 * `language:"en"` repo without an inferable gate published Spanish prose in all
 * of them. Worse, the sites that land in a user zone freeze there forever (#440),
 * so configuring the gate later never cleans them up.
 */
describe("the qualityGate fallback is published in the repo's language (#445)", () => {
  const OTHER: Record<Lang, Lang> = { es: "en", en: "es" };

  for (const engine of ENGINES) {
    for (const lang of ["en", "es"] as const) {
      it(`${engine.id} — language:"${lang}" publishes only the ${lang} diagnostic`, () => {
        // No `qualityGate` in this config, so every one of those sites falls back.
        const contents = sweptContents(render(engine, {}, lang));
        const own = placeholderFallback("qualityGate.fast", lang);
        const foreign = placeholderFallback("qualityGate.fast", OTHER[lang]);

        expect(contents.filter((c) => c.includes(foreign))).toEqual([]);
        // Assert the diagnostic IS there in the repo's language: without this the
        // test would also pass if the fallback stopped being emitted at all.
        expect(contents.some((c) => c.includes(own))).toBe(true);
      });
    }

    it(`${engine.id} — a configured gate publishes no diagnostic in any language`, () => {
      const cwd = mkdtempSync(join(tmpdir(), `navori-gate-lang-${engine.id}-`));
      tempDirs.push(cwd);
      engine.render(
        cwd,
        NavoriConfigSchema.parse({
          name: "empty-placeholder-demo",
          engines: engine.engines,
          preset: "custom",
          language: "en",
          qualityGate: { fast: "pnpm lint", full: "pnpm test && pnpm lint" },
        }),
      );

      const contents = sweptContents(cwd);
      for (const lang of ["en", "es"] as const) {
        expect(
          contents.some((c) => c.includes(placeholderFallback("qualityGate.fast", lang))),
        ).toBe(false);
      }
      expect(contents.some((c) => c.includes("pnpm test && pnpm lint"))).toBe(true);
    });
  }
});
