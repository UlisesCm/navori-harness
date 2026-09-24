import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolate } from "../render/interpolate.ts";
import type { NavoriConfig } from "../config/config.ts";

const core = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "core",
  "core-assets",
);
const read = (path: string): string => readFileSync(resolve(core, path), "utf8");

const ARCHITECT = "agents/architect.md";
const SOLUTION_DESIGN = "skills/solution-design.md";
const SCOPED_GATE = "skills/scoped-gate.md";
const TURBO_WORKSPACES = "presets/monorepo-turbopnpm/skills/turbo-workspaces.md";

// #197/#901 pattern: `{{branchBase}}` in prose, `{{shq:branchBase}}` in shell.
// This CONFIG only needs the fields `interpolate` actually reads for these
// four assets (see lib/render/__tests__/interpolate.test.ts for the pattern).
const CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "develop",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

// Covers: R18
describe("no origin/main literal in base-contrasting assets", () => {
  it.each([ARCHITECT, SOLUTION_DESIGN, SCOPED_GATE, TURBO_WORKSPACES])(
    "%s does not hardcode origin/main",
    (path) => {
      expect(read(path)).not.toContain("origin/main");
    },
  );
});

// Covers: R18
describe("branchBase: develop renders origin/develop where the base is contrasted", () => {
  it("architect's Method bullet uses the declared base", () => {
    const rendered = interpolate(read(ARCHITECT), CONFIG);
    expect(rendered).toContain("origin/develop");
    expect(rendered).not.toContain("{{branchBase}}");
  });

  it("solution-design's step 1 uses the declared base", () => {
    const rendered = interpolate(read(SOLUTION_DESIGN), CONFIG);
    expect(rendered).toContain("origin/develop");
    expect(rendered).not.toContain("{{branchBase}}");
  });

  it("turbo-workspaces' turbo filter example uses the declared base", () => {
    const rendered = interpolate(read(TURBO_WORKSPACES), CONFIG);
    expect(rendered).toContain("origin/develop");
    expect(rendered).not.toContain("{{branchBase}}");
  });

  it("scoped-gate's snippet resolves origin/$base with a shell-quoted branchBase", () => {
    const rendered = interpolate(read(SCOPED_GATE), CONFIG);
    expect(rendered).toContain("origin/$base");
    expect(rendered).toContain("base='develop'");
    expect(rendered).not.toContain("{{branchBase}}");
    expect(rendered).not.toContain("{{shq:branchBase}}");
  });
});

// Covers: R19
describe("architect and solution-design declare the fallback when the base can't be verified", () => {
  it.each([ARCHITECT, SOLUTION_DESIGN])(
    "%s names the fallback and the unverified marker",
    (path) => {
      const text = read(path);
      expect(text).toMatch(/unverified/i);
      expect(text).toMatch(/name the ref you actually used/i);
    },
  );
});

// Covers: R18, R19 — the scoped-gate snippet is executed for real, not just
// pattern-matched: R19 is a runtime contract (stderr + exit code), not prose.
describe("scoped-gate rendered snippet, executed in a temp repo without a remote", () => {
  /**
   * Extracts the base-resolution block from the rendered skill: from the
   * `base=` assignment through the closing `fi` of its if/elif/else. Anchored
   * on that structure (not on exact wording) because the markdownRequest for
   * this asset mandates an if/elif/else/fi shape ending before the unrelated
   * `files=`/`eslint` epilogue, which this suite does not exercise.
   */
  function extractBaseResolution(rendered: string): string {
    const start = rendered.indexOf("base=");
    if (start < 0) throw new Error("scoped-gate.md: no 'base=' assignment found");
    const afterStart = rendered.slice(start);
    const fiEnd = afterStart.indexOf("\nfi\n");
    if (fiEnd < 0) throw new Error("scoped-gate.md: no closing 'fi' after the base resolution");
    return afterStart.slice(0, fiEnd + "\nfi\n".length);
  }

  function tempRepoWithoutRemote(): string {
    const cwd = mkdtempSync(join(tmpdir(), "navori-branchbase-"));
    execFileSync("git", ["-C", cwd, "init", "-q", "--initial-branch=trunk"], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "config", "user.name", "test"], { stdio: "ignore" });
    writeFileSync(join(cwd, "file.txt"), "x\n");
    execFileSync("git", ["-C", cwd, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    return cwd;
  }

  function runSnippet(cwd: string, snippet: string): { status: number; stderr: string } {
    const scriptPath = join(cwd, "gate.sh");
    writeFileSync(scriptPath, `#!/bin/sh\n${snippet}\n`);
    chmodSync(scriptPath, 0o755);
    const result = spawnSync("sh", [scriptPath], { cwd, encoding: "utf8" });
    return { status: result.status ?? 1, stderr: result.stderr };
  }

  // Computed lazily inside each `it` (not at describe-body scope) so an
  // unrendered/pre-lote-B asset fails each assertion individually instead of
  // crashing the whole suite before any test registers.
  function renderedSnippet(): string {
    return extractBaseResolution(interpolate(read(SCOPED_GATE), CONFIG));
  }

  it("never runs git fetch (a pre-commit hook must not touch the network)", () => {
    expect(renderedSnippet()).not.toMatch(/git fetch/);
  });

  it("with a local 'develop' ref and no remote, falls back to it and names it in stderr", () => {
    const cwd = tempRepoWithoutRemote();
    execFileSync("git", ["-C", cwd, "branch", "develop"], { stdio: "ignore" });
    const result = runSnippet(cwd, renderedSnippet());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("develop");
  });

  it("with no ref at all (no origin, no local branch), exits non-zero naming the cause", () => {
    const cwd = tempRepoWithoutRemote();
    const result = runSnippet(cwd, renderedSnippet());
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain("develop");
  });
});
