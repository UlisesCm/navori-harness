import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, readConfig } from "../../lib/config.ts";
import { runScan } from "../scan.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-scan-cmd-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writePkg(path: string, pkg: object): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify(pkg, null, 2));
}

function writePnpmYaml(): void {
  writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
}

describe("runScan", () => {
  it("returns no-config when navori.config.json is missing", () => {
    const r = runScan({ cwd, yes: true });
    expect(r.kind).toBe("no-config");
  });

  it("returns not-monorepo when config has no 'monorepo' field", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "single-app",
      engines: ["claude"],
      preset: "nextjs",
    });
    const r = runScan({ cwd, yes: true });
    expect(r.kind).toBe("not-monorepo");
  });

  it("returns no-patterns when monorepo declares no workspace globs", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      monorepo: { enabled: true, tool: "pnpm", workspaces: [] },
    });
    // No pnpm-workspace.yaml, no package.json#workspaces
    const r = runScan({ cwd, yes: true });
    expect(r.kind).toBe("no-patterns");
  });

  it("detects new workspaces and writes them to config when yes=true", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), {
      name: "backend",
      dependencies: { "@medusajs/medusa": "^2.0.0" },
    });
    writePkg(join(cwd, "apps/storefront"), {
      name: "storefront",
      dependencies: { next: "^15.0.0" },
    });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: { enabled: true, tool: "turbo", workspaces: [] },
    });

    const r = runScan({ cwd, yes: true });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    expect(r.wrote).toBe(true);
    expect(r.added).toHaveLength(2);
    expect(r.added.map((w) => w.path).sort()).toEqual(["apps/backend", "apps/storefront"]);

    const after = readConfig(join(cwd, "navori.config.json"));
    expect(after.monorepo?.workspaces).toHaveLength(2);
    const backend = after.monorepo!.workspaces!.find((w) => w.name === "backend")!;
    expect(backend.path).toBe("apps/backend");
    expect(backend.preset).toBe("medusa");
    const storefront = after.monorepo!.workspaces!.find((w) => w.name === "storefront")!;
    expect(storefront.preset).toBe("nextjs");
  });

  it("does not write preset when suggested preset matches the root preset", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), {
      name: "backend",
      dependencies: { next: "^15.0.0" },
    });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "nextjs", // root already says nextjs
      monorepo: { enabled: true, tool: "pnpm", workspaces: [] },
    });

    const r = runScan({ cwd, yes: true });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    const after = readConfig(join(cwd, "navori.config.json"));
    const backend = after.monorepo!.workspaces![0]!;
    expect(backend.name).toBe("backend");
    // Inherits from root — no per-workspace override.
    expect(backend.preset).toBeUndefined();
  });

  it("classifies existing workspaces and skips them", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [{ name: "backend", path: "apps/backend" }],
      },
    });

    const r = runScan({ cwd, yes: true });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    expect(r.added).toHaveLength(0);
    expect(r.existing).toHaveLength(1);
    expect(r.existing[0]!.name).toBe("backend");
    expect(r.wrote).toBe(false);
  });

  it("classifies orphans (in config, missing on disk)", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [
          { name: "backend", path: "apps/backend" },
          { name: "deleted", path: "apps/deleted" },
        ],
      },
    });

    const r = runScan({ cwd, yes: true });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    expect(r.orphan).toHaveLength(1);
    expect(r.orphan[0]!.path).toBe("apps/deleted");
  });

  it("dry-run (yes=false) does not write even when there are new workspaces", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: { enabled: true, tool: "turbo", workspaces: [] },
    });

    const r = runScan({ cwd, yes: false });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    expect(r.added).toHaveLength(1);
    expect(r.wrote).toBe(false);

    // Config unchanged
    const after = readConfig(join(cwd, "navori.config.json"));
    expect(after.monorepo?.workspaces).toHaveLength(0);
  });

  it("applies presetOverrides to specific workspace paths", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), {
      name: "backend",
      dependencies: { "@medusajs/medusa": "^2.0.0" },
    });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: { enabled: true, tool: "turbo", workspaces: [] },
    });

    const r = runScan({
      cwd,
      yes: true,
      presetOverrides: { "apps/backend": "custom-medusa" },
    });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    const after = readConfig(join(cwd, "navori.config.json"));
    const backend = after.monorepo!.workspaces![0]!;
    expect(backend.preset).toBe("custom-medusa");
  });

  it("preserves the order of existing workspaces and appends new ones at the end", () => {
    writePnpmYaml();
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    writePkg(join(cwd, "apps/web"), { name: "web", dependencies: { next: "^15.0.0" } });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [{ name: "backend", path: "apps/backend", preset: "medusa" }],
      },
    });

    const r = runScan({ cwd, yes: true });
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);

    const after = readConfig(join(cwd, "navori.config.json"));
    expect(after.monorepo!.workspaces!.map((w) => w.path)).toEqual(["apps/backend", "apps/web"]);
  });
});
