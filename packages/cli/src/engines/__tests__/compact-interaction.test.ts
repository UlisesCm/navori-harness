import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";

const config = NavoriConfigSchema.parse({
  name: "compact-interaction",
  engines: ["claude", "codex"],
  preset: "custom",
  branchBase: "main",
  qualityGate: { fast: "bun lint", full: "bun run check" },
});
const canonicalPath = fileURLToPath(
  new URL("../../../../core/core-assets/managed/formato-respuesta.md", import.meta.url),
);

let claudeRoot: string;
let codexRoot: string;

beforeEach((): void => {
  claudeRoot = mkdtempSync(join(tmpdir(), "navori-compact-claude-"));
  codexRoot = mkdtempSync(join(tmpdir(), "navori-compact-codex-"));
  renderClaudeEngine(claudeRoot, config);
  renderCodexEngine(codexRoot, config);
});

afterEach((): void => {
  rmSync(claudeRoot, { recursive: true, force: true });
  rmSync(codexRoot, { recursive: true, force: true });
});

function readRendered(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = body.slice(start + heading.length);
  const end = rest.search(/^#{2,3} /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim().replace(/\s+/g, " ");
}

function decisionContract(body: string): string {
  const contract = section(body, "### Resumen de decisión en el chat");
  expect(contract).toMatch(
    /Antes de pedir aprobación, resume recomendación y motivo, alcance, riesgos pertinentes, bloqueos y verificación prevista o realizada/,
  );
  expect(contract).toMatch(/No se deben omitir garantías, riesgos ni bloqueos/);
  expect(contract).toMatch(/el artefacto complementa el resumen/);
  expect(contract).toMatch(/Aprobar producto o plan no autoriza despliegue/);
  return contract;
}

function skillStep(body: string, anchor: string, next: string): string {
  const start = body.indexOf(anchor);
  expect(start, `missing approval step ${anchor}`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf(next, start + anchor.length);
  expect(end, `missing step boundary ${next}`).toBeGreaterThan(start);
  return body.slice(start, end).replace(/\s+/g, " ");
}

describe("compact interaction and informed approval", () => {
  it("renders the bounded canonical decision contract identically to both engines", (): void => {
    const source = readFileSync(canonicalPath, "utf8");
    const expected = decisionContract(source);
    for (const [root, path] of [
      [claudeRoot, "CLAUDE.md"],
      [codexRoot, "AGENTS.md"],
    ] as const) {
      expect(decisionContract(readRendered(root, path))).toBe(expected);
    }
  });

  it("rejects an omitted guarantee, risk, blocker, or deployment boundary", (): void => {
    const source = readFileSync(canonicalPath, "utf8");
    for (const fragment of [
      "No se deben omitir garantías, riesgos ni bloqueos",
      "Aprobar producto o plan no autoriza despliegue",
    ]) {
      expect((): string => decisionContract(source.replace(fragment, ""))).toThrow();
    }
  });

  it("requires the summary at each approval step while retaining existing gates", (): void => {
    for (const root of [claudeRoot, codexRoot]) {
      const prefix = root === claudeRoot ? ".claude" : ".agents";
      const readSkill = (name: string): string =>
        readRendered(root, `${prefix}/skills/${name}/SKILL.md`);

      const simple = skillStep(readSkill("plan-simple"), "3. Run `navori plan render", "4. ");
      expect(simple).toMatch(/plan check.*green.*resumen de decisión.*chat.*rendered.*approval/i);
      expect(readSkill("plan-simple")).toMatch(/plan classify/);

      const advancedChoice = skillStep(readSkill("plan-advanced"), "3. ", "4. ");
      expect(advancedChoice).toMatch(/challenge.*resumen de decisión.*chat.*user.*picks/i);
      const advancedApproval = skillStep(readSkill("plan-advanced"), "5. Write", "6. ");
      expect(advancedApproval).toMatch(/render and check.*resumen de decisión.*chat.*approval/i);
      expect(readSkill("plan-advanced")).toMatch(/auditor.*challenge/);

      const design = skillStep(readSkill("solution-design"), "4. **Choose**", "5. ");
      expect(design).toMatch(/Before asking the user to choose.*resumen de decisión.*chat/i);
      expect(readSkill("solution-design")).toMatch(/Challenge it in a fresh context/);

      const ticket = section(readSkill("resolve-ticket"), "## Hard rules");
      expect(ticket).toMatch(
        /For `proceed` or `proceed-differently`.*resumen de decisión.*chat.*before asking approval/,
      );
      expect(ticket).toMatch(/no-work verdicts.*without approval/);

      const spec = section(readSkill("spec-bootstrap"), "## When to use this skill");
      expect(spec).toMatch(/Before asking acceptance.*resumen de decisión.*chat/);
      expect(spec).toMatch(/proposal or summary is not authorization to scaffold/);
      expect(readSkill("spec-bootstrap")).toMatch(/Do not write anything.*explicitly accepted/);
    }
  });
});
