import { describe, it, expect } from "vitest";
import { resolveSyncTargets } from "../sync.ts";
import type { NavoriConfig } from "../../lib/config.ts";

const ROOT_CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "monorepo-turbopnpm",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
  monorepo: {
    enabled: true,
    tool: "turbo",
    workspaces: [
      { name: "backend", path: "apps/backend", preset: "medusa" },
      { name: "storefront", path: "apps/storefront", preset: "nextjs" },
    ],
  },
} as unknown as NavoriConfig;

const SINGLE_APP_CONFIG = {
  name: "single",
  engines: ["claude"],
  preset: "nextjs",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

describe("resolveSyncTargets", () => {
  describe("no filter", () => {
    it("returns root + every declared workspace, in declaration order", () => {
      const r = resolveSyncTargets("/repo", ROOT_CONFIG, null);
      if (!r.ok) throw new Error(r.reason);

      expect(r.targets).toHaveLength(3);
      expect(r.targets.map((t) => t.label)).toEqual([
        "root",
        "workspace:backend",
        "workspace:storefront",
      ]);
    });

    it("root target has the unmodified config (monorepo block preserved)", () => {
      const r = resolveSyncTargets("/repo", ROOT_CONFIG, null);
      if (!r.ok) throw new Error(r.reason);
      expect(r.targets[0]!.config.monorepo).toBeDefined();
      expect(r.targets[0]!.config.preset).toBe("monorepo-turbopnpm");
    });

    it("workspace targets carry the effective config (preset overridden, monorepo stripped)", () => {
      const r = resolveSyncTargets("/repo", ROOT_CONFIG, null);
      if (!r.ok) throw new Error(r.reason);
      const backend = r.targets.find((t) => t.label === "workspace:backend")!;
      expect(backend.config.preset).toBe("medusa");
      expect(backend.config.monorepo).toBeUndefined();
      expect(backend.cwd).toBe("/repo/apps/backend");
    });

    it("single-app config returns only root", () => {
      const r = resolveSyncTargets("/repo", SINGLE_APP_CONFIG, null);
      if (!r.ok) throw new Error(r.reason);
      expect(r.targets).toHaveLength(1);
      expect(r.targets[0]!.label).toBe("root");
    });
  });

  describe("with --workspace filter", () => {
    it("returns only the matched workspace, skipping root", () => {
      const r = resolveSyncTargets("/repo", ROOT_CONFIG, "backend");
      if (!r.ok) throw new Error(r.reason);
      expect(r.targets).toHaveLength(1);
      expect(r.targets[0]!.label).toBe("workspace:backend");
      expect(r.targets[0]!.config.preset).toBe("medusa");
    });

    it("returns ok:false with helpful reason when workspace name doesn't match", () => {
      const r = resolveSyncTargets("/repo", ROOT_CONFIG, "ghost");
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected error");
      expect(r.reason).toContain("ghost");
      expect(r.reason).toContain("backend");
      expect(r.reason).toContain("storefront");
    });

    it("returns ok:false when config has no monorepo declared", () => {
      const r = resolveSyncTargets("/repo", SINGLE_APP_CONFIG, "backend");
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected error");
      expect(r.reason).toMatch(/requires a monorepo|requiere un monorepo/); // localized by config.language (es)
    });

    it("returns ok:false when monorepo has empty workspaces[]", () => {
      const config = {
        ...SINGLE_APP_CONFIG,
        monorepo: { enabled: true, tool: "pnpm", workspaces: [] },
      } as unknown as NavoriConfig;
      const r = resolveSyncTargets("/repo", config, "backend");
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected error");
      expect(r.reason).toMatch(/requires a monorepo|requiere un monorepo/); // localized by config.language (es)
    });

    it("preserves the workspace's own qualityGate override in the effective config", () => {
      const config = {
        ...ROOT_CONFIG,
        monorepo: {
          enabled: true,
          tool: "turbo",
          workspaces: [
            {
              name: "backend",
              path: "apps/backend",
              qualityGate: { fast: "pnpm -F backend lint", full: "pnpm -F backend test" },
            },
          ],
        },
      } as unknown as NavoriConfig;
      const r = resolveSyncTargets("/repo", config, "backend");
      if (!r.ok) throw new Error(r.reason);
      expect(r.targets[0]!.config.qualityGate).toEqual({
        fast: "pnpm -F backend lint",
        full: "pnpm -F backend test",
      });
    });
  });
});
