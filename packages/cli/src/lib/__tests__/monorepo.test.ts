import { describe, it, expect } from "vitest";
import { effectiveConfigForWorkspace } from "../monorepo.ts";
import type { NavoriConfig } from "../config.ts";

const ROOT_CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "monorepo-turbopnpm",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm -w typecheck", full: "pnpm -w test" },
  monorepo: {
    enabled: true,
    tool: "turbo",
    workspaces: [
      { name: "backend", path: "apps/backend" },
    ],
  },
} as unknown as NavoriConfig;

describe("effectiveConfigForWorkspace", () => {
  it("inherits root fields when workspace declares no overrides", () => {
    const ws = { name: "backend", path: "apps/backend" };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.preset).toBe("monorepo-turbopnpm");
    expect(eff.qualityGate).toEqual({ fast: "pnpm -w typecheck", full: "pnpm -w test" });
    expect(eff.language).toBe("es");
  });

  it("overrides preset when workspace declares one", () => {
    const ws = { name: "backend", path: "apps/backend", preset: "medusa" };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.preset).toBe("medusa");
    expect(eff.qualityGate).toEqual({ fast: "pnpm -w typecheck", full: "pnpm -w test" });
  });

  it("overrides qualityGate when workspace declares one", () => {
    const ws = {
      name: "backend",
      path: "apps/backend",
      qualityGate: { fast: "pnpm -F backend lint", full: "pnpm -F backend test" },
    };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.qualityGate).toEqual({ fast: "pnpm -F backend lint", full: "pnpm -F backend test" });
    expect(eff.preset).toBe("monorepo-turbopnpm");
  });

  it("strips monorepo from the effective config so nested renders don't recurse", () => {
    const ws = { name: "backend", path: "apps/backend" };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.monorepo).toBeUndefined();
  });

  it("does not mutate the root config", () => {
    const before = JSON.parse(JSON.stringify(ROOT_CONFIG));
    effectiveConfigForWorkspace(ROOT_CONFIG, {
      name: "backend",
      path: "apps/backend",
      preset: "medusa",
    });
    expect(ROOT_CONFIG).toEqual(before);
  });

  it("scopes library skills to the workspace's own declared list", () => {
    const ws = { name: "storefront", path: "apps/storefront", libraries: ["stripe"] };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.project?.libraries).toEqual(["stripe"]);
  });

  it("gives a lib-less workspace an EMPTY list, never the root's (anti-spray)", () => {
    // Root ships zod-validation; a workspace that declares no libraries must NOT
    // inherit it — that would re-introduce the cross-app spray scoping prevents.
    const rootWithLibs = {
      ...ROOT_CONFIG,
      project: { libraries: ["zod-validation"], libraryMigrations: [] },
    } as unknown as NavoriConfig;
    const ws = { name: "backend", path: "apps/backend" };
    const eff = effectiveConfigForWorkspace(rootWithLibs, ws);
    expect(eff.project?.libraries).toEqual([]);
  });

  it("scopes library migrations to the workspace's own declared list", () => {
    const migration = { legacy: "moment", preferred: "date-fns", domain: "dates" };
    const ws = { name: "backend", path: "apps/backend", libraryMigrations: [migration] };
    const eff = effectiveConfigForWorkspace(ROOT_CONFIG, ws);
    expect(eff.project?.libraryMigrations).toEqual([migration]);
  });
});
