import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(): { dir: string; failure: string; success: string } {
  const dir = mkdtempSync(join(tmpdir(), "navori-repeat-failure-"));
  dirs.push(dir);
  const script = (name: string): string => {
    const source = resolve(getCoreRoot(), `core-assets/hooks/${name}.sh`);
    const target = join(dir, `${name}.sh`);
    writeFileSync(target, expandHookIncludes(readFileSync(source, "utf8")));
    chmodSync(target, 0o755);
    return target;
  };
  return { dir, failure: script("bash-outcome-watch"), success: script("routing-watch") };
}

function run(
  script: string,
  dir: string,
  payload: Record<string, unknown>,
  success = false,
): { code: number; stdout: string } {
  const result = spawnSync("bash", success ? [script, "claude-post-tool-use"] : [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: "fixture-session" },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "" };
}

function failure(
  dir: string,
  agentId?: string,
  error = "Exit code 3\nreal failure at 12:34:56",
): Record<string, unknown> {
  return {
    session_id: "fixture-session",
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command: "false" },
    error,
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

describe("bash-outcome-watch", () => {
  // Covers: R13, R14, R15
  it("uses the live T2 failure shape, normalizes volatile output and advises only at three", () => {
    const { dir, failure: hook } = setup();
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          getCoreRoot(),
          "../cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe1-posttoolusefailure-bash.json",
        ),
        "utf8",
      ),
    ) as { payload: Record<string, unknown> };
    const first = { ...fixture.payload, session_id: "fixture-session", cwd: dir };
    expect(run(hook, dir, first)).toEqual({ code: 0, stdout: "" });
    expect(run(hook, dir, first).stdout).toBe("");
    const advice = JSON.parse(run(hook, dir, first).stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(advice.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(advice.hookSpecificOutput.additionalContext).toContain("debug-failure");
    expect(run(hook, dir, first).stdout).toBe("");
    const state = readFileSync(
      join(dir, ".navori/state/hooks/bash-outcome-watch/fixture-session"),
      "utf8",
    );
    expect(state.trim().split("\n")).toHaveLength(1);
  });

  // Covers: R13, R14
  it("separates agents and signatures, and resets on success", () => {
    const { dir, failure: hook, success } = setup();
    const a = failure(dir, "agent-a");
    const b = failure(dir, "agent-b");
    expect(run(hook, dir, a).stdout).toBe("");
    expect(run(hook, dir, b).stdout).toBe("");
    expect(run(hook, dir, a).stdout).toBe("");
    expect(
      run(success, dir, { ...a, error: undefined, tool_response: { stdout: "", stderr: "" } }, true)
        .code,
    ).toBe(0);
    expect(run(hook, dir, a).stdout).toBe("");
    expect(run(hook, dir, a).stdout).toBe("");
    expect(run(hook, dir, a).stdout).toContain("debug-failure");
    expect(run(hook, dir, failure(dir, "agent-a", "Exit code 3\na different failure")).stdout).toBe(
      "",
    );
  });

  // Covers: R14, R15
  it("caps state at 50 and fails open for corrupt input and symlink state", () => {
    const { dir, failure: hook } = setup();
    const file = join(dir, ".navori/state/hooks/bash-outcome-watch/fixture-session");
    mkdirSync(join(dir, ".navori/state/hooks/bash-outcome-watch"), { recursive: true });
    writeFileSync(
      file,
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ key: `prior-${i}`, sig: "old", count: 1, epoch: i }),
      ).join("\n") + "\n",
    );
    expect(run(hook, dir, failure(dir)).code).toBe(0);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(50);
    const corrupt = spawnSync("bash", [hook], {
      input: "{",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: "fixture-session" },
    });
    expect(corrupt.status).toBe(0);
    expect(corrupt.stdout).toBe("");
    const other = join(dir, "other-state");
    writeFileSync(other, "sentinel");
    rmSync(file);
    symlinkSync(other, file);
    expect(run(hook, dir, failure(dir)).stdout).toBe("");
    expect(readFileSync(other, "utf8")).toBe("sentinel");
  });
});
