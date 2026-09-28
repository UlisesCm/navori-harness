import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../index.ts";

vi.mock(import("../../shared/harness-plan.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveHarnessPlan: (...args: Parameters<typeof actual.resolveHarnessPlan>) => {
      const plan = actual.resolveHarnessPlan(...args);
      const scout = plan.agents.find((agent) => agent.id === "scout");
      if (!scout) throw new Error("Scout fixture is missing");
      plan.agents.push({ ...scout, id: "read-only-fixture", sandbox: "read-only" });
      return plan;
    },
  };
});

const cwd = mkdtempSync(join(tmpdir(), "navori-codex-read-only-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("Codex explicit agent sandbox override", () => {
  // Covers: R20
  it("keeps an explicitly read-only agent narrower than the full-access project default", () => {
    const config = NavoriConfigSchema.parse({
      name: "read-only-demo",
      engines: ["codex"],
      preset: "custom",
      branchBase: "main",
    });
    renderCodexEngine(cwd, config);

    const project = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    const narrowAgent = readFileSync(join(cwd, ".codex/agents/read-only-fixture.toml"), "utf-8");
    const normalAgent = readFileSync(join(cwd, ".codex/agents/scout.toml"), "utf-8");

    expect(project).toContain('sandbox_mode = "danger-full-access"');
    expect(project).toContain('approval_policy = "on-request"');
    expect(project).toContain('approvals_reviewer = "user"');
    expect(narrowAgent).toContain('sandbox_mode = "read-only"');
    expect(normalAgent).not.toContain("sandbox_mode");
  });
});
