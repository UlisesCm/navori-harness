import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

interface Sandbox {
  project: string;
  baseEnv: NodeJS.ProcessEnv;
  env: (audit: "absent") => NodeJS.ProcessEnv;
  cleanup: () => void;
}
const ROOT = resolve(import.meta.dirname, "../../../..");
const script = (name: string): string => pathToFileURL(join(ROOT, "scripts/js", name)).href;
const { createSandbox } = (await import(script("bench-hooks.mjs"))) as {
  createSandbox: () => Sandbox;
};
const { renderNeutralHooks } = (await import(script("bench-context.mjs"))) as {
  renderNeutralHooks: (sandbox: Sandbox) => void;
};

describe("neutral context measurement", () => {
  // Covers: R28, R13
  it("sin señal no hay additionalContext", () => {
    const sandbox = createSandbox();
    try {
      renderNeutralHooks(sandbox);
      expect(
        JSON.parse(readFileSync(join(sandbox.project, "navori.config.json"), "utf8")),
      ).toMatchObject({ audit: { mode: "opt-in" } });
      for (const engine of ["claude"]) {
        const hook = join(sandbox.project, `.${engine}/hooks/audit-mode-trigger.sh`);
        expect(readFileSync(hook, "utf8")).toContain("audit_mode='opt-in'");
        const run = spawnSync("bash", [hook], {
          cwd: sandbox.project,
          env: sandbox.env("absent"),
          encoding: "utf8",
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: `neutral-${engine}`,
            cwd: sandbox.project,
            prompt: "hello",
          }),
        });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toBe("");
      }
    } finally {
      sandbox.cleanup();
    }
  });

  // Covers: R28
  it("pins the always policy in the sandbox hook and keeps the activation signal", () => {
    const sandbox = createSandbox();
    try {
      const hook = join(sandbox.project, ".claude/hooks/audit-mode-trigger.sh");
      const source = readFileSync(hook, "utf8");
      expect(source).toContain("audit_mode='opt-in'");
      writeFileSync(hook, source.replace("audit_mode='opt-in'", "audit_mode='always'"));
      const run = spawnSync("bash", [hook], {
        cwd: sandbox.project,
        env: sandbox.env("absent"),
        encoding: "utf8",
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "always-positive",
          cwd: sandbox.project,
          prompt: "hello",
        }),
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("audit-mode ACTIVE");
    } finally {
      sandbox.cleanup();
    }
  });
});
