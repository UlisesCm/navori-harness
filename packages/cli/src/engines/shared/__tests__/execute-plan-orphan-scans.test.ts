import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectManagedSection } from "../../../lib/marker.ts";
import { writeFileAtomic } from "../../../lib/atomic.ts";
import { readCliVersion } from "../../../lib/bundled-assets.ts";
import { collectPlan, type AdapterCtx, type EngineAdapter } from "../execute-plan.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import type { HarnessPlan } from "../harness-plan.ts";

/**
 * #823 — isolates the "skill-nested-file" orphan shape (a skill's
 * `agents/openai.yaml` sidecar) from "skill-dir" (the whole skill). The
 * render-codex.test.ts prune spec covers the common case where the skill
 * itself is also removed, which exercises both shapes at once; this pins the
 * shape that matters most — the skill SURVIVES, only the nested file is gone.
 */

const CLI_VERSION = readCliVersion();

function fakeConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "orphan-scan-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
  });
}

function fakeAdapter(desiredYaml: ReadonlySet<string>): EngineAdapter {
  return {
    id: "fake",
    placeAgent: () => null,
    placeSkill: () => null,
    placeHook: () => null,
    extraFiles: () => [],
    orphanScans: () => [
      {
        dir: ".agents/skills",
        match: () => true,
        desired: desiredYaml,
        shape: "skill-nested-file",
        nestedRelPath: "agents/openai.yaml",
      },
    ],
  };
}

function writeManagedYaml(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const result = injectManagedSection(
    "",
    "foo-openai-policy",
    "policy:\n  allow_implicit_invocation: false\n",
    { source: "@navori/core", version: CLI_VERSION },
    "shell",
  );
  writeFileAtomic(path, result.output);
}

function ctxFor(cwd: string): AdapterCtx {
  return {
    cwd,
    config: fakeConfig(),
    repoRoot: cwd,
    isWorkspace: false,
    coreAssets: cwd,
    preset: null,
    plugins: [],
  };
}

const EMPTY_PLAN: HarnessPlan = { agents: [], skills: [], hooks: [] };

describe("collectOrphans — skill-nested-file shape (#823)", () => {
  it("removes a stale openai.yaml but keeps the skill directory it lives under", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-orphan-nested-"));
    try {
      const yamlPath = join(cwd, ".agents/skills/foo/agents/openai.yaml");
      writeManagedYaml(yamlPath);
      // A sibling file the skill still owns — proves only the sidecar is
      // slated for removal, not the whole `foo/` skill directory.
      mkdirSync(join(cwd, ".agents/skills/foo"), { recursive: true });
      writeFileAtomic(join(cwd, ".agents/skills/foo/SKILL.md"), "# foo\n");

      const { removals } = collectPlan(EMPTY_PLAN, fakeAdapter(new Set()), ctxFor(cwd));

      expect(removals).toHaveLength(1);
      // Only the nested `agents/` dir goes (openai.yaml was its only child) —
      // the skill's own `SKILL.md` next door is untouched.
      expect(removals[0]?.path).toBe(join(cwd, ".agents/skills/foo/agents"));
      expect(removals[0]?.recursive).toBe(true);
      expect(existsSync(join(cwd, ".agents/skills/foo/SKILL.md"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a desired openai.yaml in place", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-orphan-nested-"));
    try {
      const yamlPath = join(cwd, ".agents/skills/foo/agents/openai.yaml");
      writeManagedYaml(yamlPath);

      const desired = new Set([".agents/skills/foo/agents/openai.yaml"]);
      const { removals } = collectPlan(EMPTY_PLAN, fakeAdapter(desired), ctxFor(cwd));

      expect(removals).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
