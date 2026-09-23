import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../../lib/config/config.ts";

/**
 * spec 0026 T10 (R39, R41) — the agent half of retirement reconciliation, and
 * the "kept, with reason" report that R39/R41 add on top of what T8 (`retired-
 * skills.test.ts`, `retired-hooks.test.ts`) already exercises for skills/hooks.
 *
 * `RETIRED_AGENTS` ships empty in production (spec 0026 T8 — see
 * `roster.ts`'s JSDoc: an entry lands in the SAME commit that stops rendering
 * the old id, which is T11, not this batch). So — same anti-false-green shape
 * `roster-parity.test.ts` uses for `assertRosterIds` — this file mocks
 * `harness-assets.ts` with ONE seeded entry to exercise the real §8.7d loop
 * end to end, instead of asserting behavior nothing here would otherwise run.
 */

vi.mock(import("../../shared/harness-assets.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/harness-assets.ts")>();
  return {
    ...actual,
    RETIRED_AGENTS: [
      {
        id: "leader",
        successor: "orchestrator",
        harnessKey: "leader",
        markerIdByAdapter: { claude: "leader-base", codex: "leader-codex-base" },
      },
    ],
  };
});

const { renderClaudeEngine } = await import("../index.ts");
const { readCliVersion } = await import("../../../lib/render/bundled-assets.ts");

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const RETIRED_ID = "leader";
const MARKER_ID = "leader-base";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-retired-agent-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function agentPath(): string {
  return join(cwd, ".claude/agents", `${RETIRED_ID}.md`);
}

/** Seed a retired agent file with the marker navori itself would stamp. */
function seedManaged(version: string): void {
  const dir = join(cwd, ".claude/agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    agentPath(),
    `<!-- navori:managed id="${MARKER_ID}" hash="deadbeef" version="${version}" source="@navori/core" -->\n` +
      `# ${RETIRED_ID}\n` +
      `<!-- /navori:managed id="${MARKER_ID}" -->\n`,
    "utf-8",
  );
}

describe("render — poda un agente retirado del roster (spec 0026 T10, R39)", () => {
  // Covers: R39
  it("borra un agente propio de navori con el marcador real por adapter", () => {
    seedManaged(readCliVersion());
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(agentPath())).toBe(false);
  });

  // Covers: R39, R41
  it("NO toca un agente sin marcador de navori (ajeno) y lo reporta con motivo", () => {
    mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
    writeFileSync(agentPath(), "# la mía, escrita a mano\n", "utf-8");
    const result = renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(agentPath())).toBe(true);
    expect(result.warnings.some((w) => w.includes("foreign") && w.includes(RETIRED_ID))).toBe(true);
    expect(result.warnings.some((w) => w.includes("orchestrator"))).toBe(true);
  });

  // Covers: R39, R41
  it("NO borra un agente escrito por un navori MÁS NUEVO y lo reporta con motivo", () => {
    seedManaged("99.0.0");
    const result = renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(agentPath())).toBe(true);
    expect(result.warnings.some((w) => w.includes("newer") && w.includes(RETIRED_ID))).toBe(true);
  });

  it("no reporta nada cuando el repo nunca tuvo el agente retirado", () => {
    const result = renderClaudeEngine(cwd, CONFIG);
    expect(result.warnings.some((w) => w.includes(RETIRED_ID))).toBe(false);
  });

  it("una vez borrado, no se reporta también como conservado", () => {
    seedManaged(readCliVersion());
    const result = renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(agentPath())).toBe(false);
    expect(result.warnings.some((w) => w.startsWith("kept "))).toBe(false);
  });
});

describe("workspace full (monorepo) reconciliación (R39)", () => {
  // Covers: R39
  it("un agente retirado también se poda cuando cwd es un workspace anidado", () => {
    // `renderClaudeEngine` is invoked once per workspace by its caller
    // (`commands/render.ts`/`commands/sync.ts`), each with its own `cwd`. §8.7d
    // reads that `cwd` like every other reconciliation loop in this function —
    // nothing in it assumes the repo root — so a nested `cwd` (what a
    // `workspaceHarness: "full"` workspace renders into) is exercised directly
    // instead of asserting the workspace-selection plumbing, which is covered
    // elsewhere.
    const wsCwd = join(cwd, "packages/app");
    mkdirSync(join(wsCwd, ".claude/agents"), { recursive: true });
    writeFileSync(
      join(wsCwd, ".claude/agents", `${RETIRED_ID}.md`),
      `<!-- navori:managed id="${MARKER_ID}" hash="deadbeef" version="${readCliVersion()}" source="@navori/core" -->\n` +
        `# ${RETIRED_ID}\n` +
        `<!-- /navori:managed id="${MARKER_ID}" -->\n`,
      "utf-8",
    );

    renderClaudeEngine(wsCwd, CONFIG);

    expect(existsSync(join(wsCwd, ".claude/agents", `${RETIRED_ID}.md`))).toBe(false);
  });
});
