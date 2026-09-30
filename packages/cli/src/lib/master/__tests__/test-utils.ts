import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeConfig } from "../../config/config.ts";
import { masterMarkers } from "../markers.ts";
import { readTemplateFile, splitTemplateSections } from "../templates.ts";
import { UX_SECTION_KINDS } from "../ux.ts";
import type { AssetLanguage } from "../../render/render-plan.ts";

export function createGitHelper(cwd: string) {
  return (args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
}

export function createCommitHelper(git: (args: string[]) => void) {
  return (message: string): void => {
    git(["add", "-A"]);
    git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message]);
  };
}

export function createSeedConfigHelper(cwd: string) {
  return (overrides: Record<string, unknown> = {}): void => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...overrides,
    });
  };
}

// --- UX contract fixtures (ux.test.ts, close.test.ts) ----------------------

const UX_BODIES: Readonly<Record<string, string>> = {
  surfaces: "### MOBILE — Móvil\nRequisitos: RF-1, P1\n",
  actors: "### ACT-CLIENT — Cliente\nUsa MOBILE.\n",
  journeys: "### J01 — Usar\nFlows: F01 Buscar\n",
  flows: "### F01 — Buscar\nPantallas: SCR-MOBILE-01\n",
  screens: "### SCR-MOBILE-01 — Inicio\nRequisitos: RF-1, P1\n",
  components: "### C01 — Tarjeta\nAparece en SCR-MOBILE-01.\n",
  patterns: "### PT01 — Búsqueda\nUsada en SCR-MOBILE-01.\n",
  "ux-requirements": "### UX-1 — El usuario conoce su estado\nDeriva de RF-1.\n",
  traceability:
    "| Requirement | Journey | Flow | Screens | Patterns |\n|---|---|---|---|---|\n| RF-1 | J01 | F01 | SCR-MOBILE-01 | PT01 |\n",
  "heron-handoff":
    "### Heron MUST preserve\nReglas.\n\n### Heron MAY improve\nNavegación.\n\n### Heron owns\nLayout.\n",
};

/** Writes a compact `ux` template (every `ux-kind`, es + en) under `root`. */
export function writeUxTemplateFixture(root: string): void {
  const sections = UX_SECTION_KINDS.map(
    (kind) =>
      `## Sec ${kind}\n<!-- ux-kind: ${kind} -->\n${kind === "checklist" ? "- [ ] uno\n- [ ] dos" : "guía"}\n`,
  ).join("\n");
  for (const dir of ["master-plan", "master-plan/en"]) {
    mkdirSync(join(root, "core-assets", dir), { recursive: true });
    writeFileSync(join(root, "core-assets", dir, "ux.md"), sections);
  }
}

/** A coherent UX.md built from the given template (fixture or bundled); `overrides` swap a section body by kind. */
export function validUxMd(
  language: AssetLanguage,
  root?: string,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const { ninguna } = masterMarkers(language);
  return splitTemplateSections(readTemplateFile("ux", language, { root }))
    .map((s) => {
      const kind = s.kind ?? "";
      const checks = (s.body.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? [])
        .map(() => "- [x] ok")
        .join("\n");
      const body =
        overrides[kind] ??
        (kind === "open-questions"
          ? ninguna
          : kind === "checklist"
            ? checks
            : (UX_BODIES[kind] ?? "Texto."));
      return `## ${s.heading}\n\n${body}\n`;
    })
    .join("\n");
}

/** A `ux.json` whose ids equal `validUxMd`'s. */
export function validUxJson(stageDir: string): Record<string, unknown> {
  const refs = ["RF-1", "P1"];
  return {
    schemaVersion: 1,
    masterStage: stageDir,
    surfaces: [{ id: "MOBILE", name: "Móvil", purpose: "Usar", requirements: refs }],
    actors: [{ id: "ACT-CLIENT", name: "Cliente", goal: "Usar", surfaces: ["MOBILE"] }],
    journeys: [
      {
        id: "J01",
        name: "Usar",
        actor: "ACT-CLIENT",
        goal: "g",
        trigger: "t",
        initialState: "i",
        expectedResult: "r",
        flows: ["F01"],
      },
    ],
    flows: [
      {
        id: "F01",
        name: "Buscar",
        actor: "ACT-CLIENT",
        purpose: "p",
        trigger: "t",
        steps: ["uno"],
        result: "r",
        screens: ["SCR-MOBILE-01"],
      },
    ],
    screens: [
      {
        id: "SCR-MOBILE-01",
        name: "Inicio",
        surface: "MOBILE",
        actors: ["ACT-CLIENT"],
        purpose: "p",
        requirements: refs,
        states: ["ready"],
      },
    ],
    functionalComponents: [
      { id: "C01", name: "Tarjeta", responsibility: "r", screens: ["SCR-MOBILE-01"] },
    ],
    patterns: [{ id: "PT01", name: "Búsqueda", purpose: "p", screens: ["SCR-MOBILE-01"] }],
    uxRequirements: [{ id: "UX-1", statement: "s", derivedFrom: ["RF-1"] }],
    traceability: [
      { requirement: "RF-1", journeys: ["J01"], flows: ["F01"], screens: ["SCR-MOBILE-01"] },
    ],
  };
}

/** MASTER.md / parts.json / DECISIONS.md that the default UX fixtures cite (RF-1, P1, D1).
 * If parts.json already exists (from seed()), preserve it. */
export function seedUxSources(stagePath: string): void {
  mkdirSync(stagePath, { recursive: true });
  writeFileSync(join(stagePath, "MASTER.md"), "RF-1 RN-2\n");
  writeFileSync(join(stagePath, "DECISIONS.md"), "## D1\n\nPregunta: x\n");
  const partsPath = join(stagePath, "parts.json");
  if (!existsSync(partsPath)) {
    writeFileSync(
      partsPath,
      JSON.stringify({
        version: 1,
        parts: [
          {
            id: "P1",
            title: "t",
            objective: "o",
            acceptance: [
              { id: "A1", description: "d", method: "manual", manual: { check: "c", how: "h" } },
            ],
          },
        ],
      }),
    );
  }
}
