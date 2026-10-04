import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { expandHookIncludes } from "../../../lib/render/hook-includes.ts";
import { acrossShells, type HookShell } from "../../../lib/__tests__/helpers/shells.ts";
import { buildClaudeSettings, claudeHookCommand } from "../build-settings.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

const runsBash = process.platform !== "win32";
const hookPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "navori-master-accept-src-"));
  const path = join(dir, "master-accept-confirm.sh");
  writeFileSync(
    path,
    expandHookIncludes(
      readFileSync(resolve(getCoreRoot(), "core-assets/hooks/master-accept-confirm.sh"), "utf-8"),
    ),
  );
  chmodSync(path, 0o755);
  return path;
})();

interface HookRun {
  code: number;
  stdout: string;
}

function payload(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "master-accept-1",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

function runHook(
  shell: HookShell,
  input: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): HookRun {
  const cwd = mkdtempSync(join(tmpdir(), "navori-master-accept-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const result = spawnSync(shell, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "" };
}

function run(input: Record<string, unknown>, env?: NodeJS.ProcessEnv): HookRun {
  return acrossShells((shell) => runHook(shell, input, env));
}

function expectAsk(input: Record<string, unknown>, env?: NodeJS.ProcessEnv): void {
  const result = run(input, env);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.permissionDecision).toBe("ask");
  expect(parsed.hookSpecificOutput?.permissionDecisionReason).toBe(
    "[navori] this records that you approved a manual criterion. Confirm only if you reviewed it.",
  );
}

describe.runIf(runsBash)("master-accept-confirm.sh", () => {
  // Covers: R62
  it("asks on navori master part P2 --accept A3 --approved-by user (main thread)", () => {
    expectAsk(payload("navori master part P2 --accept A3 --approved-by user"));
  });

  // Covers: R62
  it("asks on approved-by from a subagent", () => {
    expectAsk(
      payload("navori master part P2 --accept A3 --approved-by user", {
        agent_id: "a1",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under auto", () => {
    expectAsk(
      payload("navori master part P2 --accept A3 --approved-by user", {
        permission_mode: "auto",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under bypassPermissions", () => {
    expectAsk(
      payload("navori master part P2 --accept A3 --approved-by user", {
        permission_mode: "bypassPermissions",
      }),
    );
  });

  // Covers: R62
  it("asks on approved-by under dontAsk", () => {
    expectAsk(
      payload("navori master part P2 --accept A3 --approved-by user", {
        permission_mode: "dontAsk",
      }),
    );
  });

  // Covers: R62
  it("ignores --accept of a test criterion (--command … --result …)", () => {
    expect(
      run(
        payload("navori master part P2 --accept A3 --command 'bun test' --result pass"),
      ).stdout.trim(),
    ).toBe("");
  });

  // Covers: R62
  it("ignores --accept of a comando criterion", () => {
    expect(
      run(
        payload("navori master part P2 --accept A3 --command 'bun run check' --result pass"),
      ).stdout.trim(),
    ).toBe("");
  });

  // Covers: R62
  it("ignores navori master status and check", () => {
    expect(run(payload("navori master status --json")).stdout.trim()).toBe("");
    expect(run(payload("navori master check --part P2 --approved-by user")).stdout.trim()).toBe("");
  });

  // Covers: R62
  it("asks on chained cd x && navori master part … --approved-by user", () => {
    expectAsk(payload("cd x && navori master part P2 --accept A3 --approved-by user"));
  });

  // Covers: R62
  it("asks on chained true; navori master part … --approved-by user", () => {
    expectAsk(payload("true; navori master part P2 --accept A3 --approved-by user"));
  });

  // Covers: R62
  it("asks on subshell (navori master part … --approved-by user)", () => {
    expectAsk(payload("(navori master part P2 --accept A3 --approved-by user)"));
  });

  // Covers: R62
  it("asks on command substitution $(navori master part … --approved-by user)", () => {
    expectAsk(payload("$(navori master part P2 --accept A3 --approved-by user)"));
  });

  // Covers: R58
  it.each([
    "navori master part P2 --accept A3 --approved-by=user",
    "navori master part P2 --approved-by user --accept A3",
    "npx navori master part P2 --accept A3 --approved-by user",
    "npx --yes navori master part P2 --accept A3 --approved-by=user",
    "bunx navori master part P2 --accept A3 --approved-by user",
    "pnpm exec navori master part P2 --accept A3 --approved-by user",
    "pnpm dlx navori master part P2 --accept A3 --approved-by user",
    "./node_modules/.bin/navori master part P2 --accept A3 --approved-by user",
    "/usr/local/bin/navori master part P2 --accept A3 --approved-by=user",
    "navori master close",
    "navori master close --abandon --reason x",
    "navori master close --convert specs/0001-x --reason x",
    "npx navori master close",
    "bunx navori master close --abandon --reason x",
    "pnpm exec navori master close",
    "pnpm dlx navori master close --abandon --reason x",
    "/opt/bin/navori master close",
    "cd x && navori master close",
    "(navori master close)",
    "x=$(navori master close)",
    "echo $(navori master close)",
    "navori master close>/dev/null",
    "navori master close;true",
    "navori master close|cat",
    "npx navori@latest master close",
    "npx -y navori@latest master close",
    "npx navori@1.2 master close --abandon --reason x",
    "bunx navori@latest master close",
    "bunx navori@1.2.3 master part P2 --accept A3 --approved-by user",
    "npx -y navori@latest master part P2 --accept A3 --approved-by=user",
  ])("asks on %s", (command) => {
    expectAsk(payload(command));
  });

  // Covers: R58
  it.each([
    "git push origin master",
    "navori master status",
    "navori master advance",
    "navori master check --part P2",
    "echo navori master closet",
    'echo "navori master close"',
  ])("stays silent on %s", (command) => {
    expect(run(payload(command)).stdout.trim()).toBe("");
  });

  // Covers: R62
  it("emits the fixed reason without jq or node", () => {
    expectAsk(payload("navori master part P2 --accept A3 --approved-by user"), {
      PATH: "/usr/bin:/bin",
    });
  });
});

const base = {
  name: "master-accept-demo",
  engines: ["claude"],
  preset: "custom",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

describe("master-accept-confirm wiring", () => {
  // Covers: R62
  it("registers the hook only with masterPlan enabled", () => {
    const hookCommands = (settings: Record<string, unknown>): string[] => {
      const hooks = settings.hooks as {
        PreToolUse?: Array<{ hooks: Array<{ command: string }> }>;
      };
      return (hooks.PreToolUse ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
    };

    const enabled = buildClaudeSettings(
      { ...base, harness: { masterPlan: true } } as NavoriConfig,
      [],
    );
    const disabled = buildClaudeSettings(
      { ...base, harness: { masterPlan: false } } as NavoriConfig,
      [],
    );

    expect(hookCommands(enabled)).toContain(
      claudeHookCommand("PreToolUse", ".claude/hooks/master-accept-confirm.sh"),
    );
    expect(hookCommands(disabled)).not.toContain(
      claudeHookCommand("PreToolUse", ".claude/hooks/master-accept-confirm.sh"),
    );
  });
});

// Covers: R20 — the Codex copy (installed under .codex/hooks/) cannot ask, so it denies.
describe.runIf(runsBash)("master-accept-confirm.sh installed for Codex", () => {
  const codexPath = (() => {
    const dir = join(mkdtempSync(join(tmpdir(), "navori-master-accept-codex-")), ".codex/hooks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "master-accept-confirm.sh");
    writeFileSync(path, readFileSync(hookPath, "utf-8"));
    chmodSync(path, 0o755);
    return path;
  })();

  it("denies a manual approval and never asks or allows", () => {
    const result = spawnSync("bash", [codexPath], {
      input: JSON.stringify(payload("navori master part P2 --accept A3 --approved-by user")),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    expect(decision).toBe("deny");
  });

  it("stays silent on an unrelated command", () => {
    const result = spawnSync("bash", [codexPath], {
      input: JSON.stringify(payload("git status")),
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
