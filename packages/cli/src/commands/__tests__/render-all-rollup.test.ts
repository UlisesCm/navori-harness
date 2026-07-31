import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender, renderRepoRows, rollupRenderRows } from "../render.ts";

/**
 * #276: the multi-repo roll-up (`render --all` / `workspace render`) must count a
 * repo whose ONLY pending change is a non-Claude engine file (AGENTS.md, cursor,
 * …). Before the fix, `renderRepoRows` looked only at the Claude CLAUDE.md
 * `written` flags, so such a repo reported `up-to-date` (and dropped out of the
 * "N would change" roll-up) even while its detail said "1 created".
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-render-all-rollup-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function seedClaudeAgentsRepo(): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "roll-a",
    engines: ["claude", "agents-md"],
    preset: "custom",
    qualityGate: { fast: "pnpm lint", full: "pnpm test" },
  });
}

describe("renderRepoRows roll-up includes non-Claude engines (#276)", () => {
  it("reports would-write when only a non-Claude engine file is pending", () => {
    seedClaudeAgentsRepo();
    // Full apply writes CLAUDE.md, the .claude/ tree AND AGENTS.md.
    expect(runRender(cwd).ok).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);

    // Delete ONLY the non-Claude engine file: CLAUDE.md stays byte-identical, so
    // the sole pending change is re-creating AGENTS.md.
    unlinkSync(join(cwd, "AGENTS.md"));

    const rows = renderRepoRows([{ name: "roll-a", path: cwd }], {
      preview: true,
      force: false,
    });

    expect(rows).toHaveLength(1);
    // Was "up-to-date" before the fix.
    expect(rows[0].status).toBe("would-write");
    expect(rows[0].detail).toContain("created");

    // And the roll-up counts it as pending.
    expect(rollupRenderRows(rows).pending).toBe(1);
  });

  it("reports up-to-date once every engine file (Claude + non-Claude) is written", () => {
    seedClaudeAgentsRepo();
    expect(runRender(cwd).ok).toBe(true);

    const rows = renderRepoRows([{ name: "roll-a", path: cwd }], {
      preview: true,
      force: false,
    });

    expect(rows[0].status).toBe("up-to-date");
    expect(rollupRenderRows(rows).pending).toBe(0);
  });
});
