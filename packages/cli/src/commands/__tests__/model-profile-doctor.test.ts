import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../doctor.ts";

describe("doctor model profile provenance (Spec 0037 R12)", () => {
  // Covers: R12
  it("serializes mapped and inherited profiles without claiming observed execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-profile-doctor-"));
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "profile-fixture",
        engines: ["codex"],
        preset: "custom",
        branchBase: "main",
        models: { reviewer: "sonnet" },
        effort: { reviewer: "low" },
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(existsSync(join(cwd, ".codex/agents/reviewer.toml"))).toBe(false);
      await doctorCommand.run?.({
        args: { _: [], cwd, json: true, strict: false },
        rawArgs: [],
        cmd: doctorCommand,
      });
      const report = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as {
        modelProfileProvenance: Array<{
          agent: string;
          model: { origin: string; wouldRender: string | null; effectiveObserved: null };
          effort: { origin: string; wouldRender: string | null; effectiveObserved: null };
        }>;
      };
      expect(report.modelProfileProvenance.find((row) => row.agent === "reviewer")).toMatchObject({
        model: { origin: "mapped", wouldRender: "gpt-6-sol", effectiveObserved: null },
        effort: { origin: "explicit", wouldRender: "low", effectiveObserved: null },
      });
      expect(report.modelProfileProvenance.find((row) => row.agent === "architect")).toMatchObject({
        model: { origin: "inherited", wouldRender: null, effectiveObserved: null },
        effort: { origin: "inherited", wouldRender: null, effectiveObserved: null },
      });
      expect(report.modelProfileProvenance.some((row) => row.agent === "orchestrator")).toBe(false);
    } finally {
      output.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
