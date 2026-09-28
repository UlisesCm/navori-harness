import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildClaudeSettings } from "../build-settings.ts";
import { expandHookIncludes } from "../../../lib/render/hook-includes.ts";
import { interpolate } from "../../../lib/render/interpolate.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

const config = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  sdd: { specsDir: "specs" },
} as unknown as NavoriConfig;
const asset = resolve(
  import.meta.dirname,
  "../../../../../core/core-assets/hooks/master-plan-context.sh",
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { dir: string; script: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "navori-master-hook-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = join(dir, "hook.sh");
  writeFileSync(script, interpolate(expandHookIncludes(readFileSync(asset, "utf8")), config));
  return { dir, script, bin };
}

function run(
  shell: string,
  f: { dir: string; script: string; bin: string },
): { status: number | null; stdout: string } {
  const result = spawnSync(shell, [f.script], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: f.dir, PATH: `${f.bin}:/usr/bin:/bin` },
  });
  return { status: result.status, stdout: result.stdout };
}

for (const shell of ["bash", "zsh"]) {
  describe(`master-plan SessionStart (${shell})`, () => {
    // Covers: R38, R39, R54
    it("registers only with the flag and emits a bounded status line", () => {
      const off = JSON.stringify(buildClaudeSettings(config, []));
      const on = JSON.stringify(
        buildClaudeSettings({ ...config, harness: { masterPlan: true } } as NavoriConfig, []),
      );
      expect(off).not.toContain("master-plan-context.sh");
      expect(on).toContain("master-plan-context.sh");
      const f = fixture();
      writeFileSync(
        join(f.bin, "navori"),
        "#!/bin/sh\nprintf 'Plan maestro — etapa 01-mvp: parte P1.\\n'\n",
        { mode: 0o755 },
      );
      const result = run(shell, f);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("etapa 01-mvp: parte P1");
      expect(result.stdout).not.toContain("INDEX.md");
    });

    // Covers: R38, R54
    it("falls back to a validated active-stage pointer when status fails or exceeds budget", () => {
      const f = fixture();
      mkdirSync(join(f.dir, "specs/_master"), { recursive: true });
      writeFileSync(
        join(f.dir, "specs/_master/INDEX.md"),
        "Etapa activa: specs/_master/01-mvp/STATUS.md\n",
      );
      writeFileSync(join(f.bin, "navori"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expect(run(shell, f).stdout).toContain("specs/_master/01-mvp/STATUS.md");
      writeFileSync(join(f.bin, "navori"), "#!/bin/sh\nprintf '%0700d' 0\n", { mode: 0o755 });
      expect(run(shell, f).stdout).toContain("specs/_master/01-mvp/STATUS.md");
    });

    // Covers: R38, R54
    it("rejects unsafe INDEX paths and still offers without the binary", () => {
      const f = fixture();
      mkdirSync(join(f.dir, "specs/_master"), { recursive: true });
      writeFileSync(
        join(f.dir, "specs/_master/INDEX.md"),
        "Etapa activa: $(touch /tmp/bad)/STATUS.md\n",
      );
      const result = run(shell, f);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("specs/_master/INDEX.md");
      expect(result.stdout).not.toContain("touch");
      expect(result.stdout).toContain("ofrece continuar");
    });
  });
}
