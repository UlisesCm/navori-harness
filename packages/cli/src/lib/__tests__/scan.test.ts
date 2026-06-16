import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanMonorepoWorkspaces,
  collectWorkspacePatterns,
  parsePnpmWorkspaceYaml,
  expandPattern,
} from "../scan.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-scan-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writePkg(path: string, pkg: object): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("parsePnpmWorkspaceYaml", () => {
  it("parses block-form packages", () => {
    const content = `packages:\n  - 'apps/*'\n  - "packages/*"\n  - tools/script\n`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual([
      "apps/*",
      "packages/*",
      "tools/script",
    ]);
  });

  it("parses inline-form packages", () => {
    const content = `packages: ['apps/*', "packages/*"]\n`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });

  it("ignores negation patterns", () => {
    const content = `packages:\n  - 'apps/*'\n  - '!apps/legacy'\n`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*"]);
  });

  it("ignores comments and blank lines inside the block", () => {
    const content = `packages:\n  # private\n  - 'apps/*'\n\n  - 'packages/*'\n`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });

  it("stops at next top-level key", () => {
    const content = `packages:\n  - 'apps/*'\nother:\n  - 'ignored'\n`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*"]);
  });

  it("returns [] when packages: is absent", () => {
    expect(parsePnpmWorkspaceYaml("other: value\n")).toEqual([]);
  });
});

describe("expandPattern", () => {
  it("expands a single-level glob to child directories with package.json", () => {
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    writePkg(join(cwd, "apps/storefront"), { name: "storefront" });
    mkdirSync(join(cwd, "apps/.cache"), { recursive: true });

    const result = expandPattern(cwd, "apps/*").sort();
    // expandPattern itself doesn't filter by package.json — it just enumerates dirs.
    // It skips dot-prefixed dirs.
    expect(result).toEqual(["apps/backend", "apps/storefront"]);
  });

  it("resolves a literal path", () => {
    mkdirSync(join(cwd, "tools/script"), { recursive: true });
    expect(expandPattern(cwd, "tools/script")).toEqual(["tools/script"]);
  });

  it("returns [] when literal path is missing", () => {
    expect(expandPattern(cwd, "apps/missing")).toEqual([]);
  });

  it("returns [] when glob parent is missing", () => {
    expect(expandPattern(cwd, "apps/*")).toEqual([]);
  });

  it("handles nested globs apps/*/inner", () => {
    mkdirSync(join(cwd, "apps/a/inner"), { recursive: true });
    mkdirSync(join(cwd, "apps/b/inner"), { recursive: true });
    mkdirSync(join(cwd, "apps/c"), { recursive: true }); // no inner
    const result = expandPattern(cwd, "apps/*/inner").sort();
    expect(result).toEqual(["apps/a/inner", "apps/b/inner"]);
  });
});

describe("collectWorkspacePatterns", () => {
  it("reads pnpm-workspace.yaml when present", () => {
    writeFileSync(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:\n  - 'apps/*'\n  - 'packages/*'\n`,
    );
    expect(collectWorkspacePatterns(cwd)).toEqual(["apps/*", "packages/*"]);
  });

  it("falls back to package.json#workspaces (array form)", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
    );
    expect(collectWorkspacePatterns(cwd)).toEqual(["apps/*"]);
  });

  it("falls back to package.json#workspaces (yarn object form)", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["apps/*"] } }),
    );
    expect(collectWorkspacePatterns(cwd)).toEqual(["apps/*"]);
  });

  it("pnpm-workspace.yaml takes precedence over package.json#workspaces", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["should-be-ignored/*"] }),
    );
    expect(collectWorkspacePatterns(cwd)).toEqual(["apps/*"]);
  });

  it("returns [] when no source declares workspaces", () => {
    expect(collectWorkspacePatterns(cwd)).toEqual([]);
  });
});

describe("scanMonorepoWorkspaces", () => {
  it("returns workspaces with suggested preset per stack", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg(join(cwd, "apps/backend"), {
      name: "backend",
      dependencies: { "@medusajs/medusa": "^2.0.0" },
    });
    writePkg(join(cwd, "apps/storefront"), {
      name: "storefront",
      dependencies: { next: "^15.0.0" },
    });

    const result = scanMonorepoWorkspaces(cwd);

    expect(result).toHaveLength(2);
    const backend = result.find((w) => w.path === "apps/backend")!;
    const storefront = result.find((w) => w.path === "apps/storefront")!;

    expect(backend.name).toBe("backend");
    expect(backend.suggestedPreset).toBe("medusa");
    expect(backend.framework).toBe("@medusajs/medusa");

    expect(storefront.name).toBe("storefront");
    expect(storefront.suggestedPreset).toBe("nextjs");
    expect(storefront.framework).toBe("next");
  });

  it("skips directories without package.json", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg(join(cwd, "apps/backend"), { name: "backend" });
    mkdirSync(join(cwd, "apps/empty-dir"), { recursive: true });

    const result = scanMonorepoWorkspaces(cwd);

    expect(result.map((w) => w.path)).toEqual(["apps/backend"]);
  });

  it("deduplicates overlapping patterns", () => {
    writeFileSync(
      join(cwd, "pnpm-workspace.yaml"),
      `packages:\n  - 'apps/*'\n  - 'apps/backend'\n`,
    );
    writePkg(join(cwd, "apps/backend"), { name: "backend" });

    const result = scanMonorepoWorkspaces(cwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("apps/backend");
  });

  it("falls back to directory basename when package.json has no name", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg(join(cwd, "apps/anonymous"), { version: "1.0.0" });

    const result = scanMonorepoWorkspaces(cwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("anonymous");
  });

  it("returns [] when no workspace patterns are declared", () => {
    expect(scanMonorepoWorkspaces(cwd)).toEqual([]);
  });

  it("orders results by path", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg(join(cwd, "apps/zed"), { name: "zed" });
    writePkg(join(cwd, "apps/alpha"), { name: "alpha" });
    writePkg(join(cwd, "apps/mid"), { name: "mid" });

    const result = scanMonorepoWorkspaces(cwd);

    expect(result.map((w) => w.path)).toEqual(["apps/alpha", "apps/mid", "apps/zed"]);
  });
});
