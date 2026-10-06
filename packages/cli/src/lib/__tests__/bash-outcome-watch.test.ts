import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { HOOK_SHELLS, type HookShell } from "./helpers/shells.ts";
import {
  fingerprintTree,
  readEvidenceLog,
  type DeliveryEvidenceBinding,
} from "../plan/evidence.ts";

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

describe("producer-bound delivery success lane", () => {
  // Covers: R7, R8, R9
  it.each(HOOK_SHELLS)(
    "preserves legacy and exact bound fingerprints under nounset in %s",
    (shell: HookShell) => {
      const { dir, success } = setup();
      execFileSync("git", ["init", "-q", dir]);
      const stagePath = "stage";
      mkdirSync(join(dir, stagePath));
      writeFileSync(join(dir, stagePath, "state.json"), "lifecycle");
      writeFileSync(join(dir, stagePath, "STATUS.md"), "view");
      const partial = resolve(getCoreRoot(), "core-assets/hooks/_partials/bash-outcome.sh");
      const fingerprint = (stage?: string): string => {
        const result = spawnSync(
          shell,
          [
            "-uc",
            'source "$1"; navori_tree_fingerprint "$2" "${3:-}"',
            "fixture",
            partial,
            dir,
            ...(stage === undefined ? [] : [stage]),
          ],
          { encoding: "utf8" },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        return result.stdout.trim();
      };
      const legacy = fingerprint();
      expect(fingerprint("")).toBe(legacy);
      expect(fingerprintTree(dir)).toEqual({ ok: true, tree: legacy });
      const bound = fingerprint(stagePath);
      writeFileSync(join(dir, stagePath, "state.json"), "accepted");
      writeFileSync(join(dir, stagePath, "STATUS.md"), "derived acceptance");
      expect(fingerprint(stagePath)).toBe(bound);
      expect(fingerprint()).not.toBe(legacy);
      writeFileSync(join(dir, stagePath, "parts.json"), "source changed");
      expect(fingerprint(stagePath)).not.toBe(bound);

      const stateDir = join(dir, ".navori/state/handoffs");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "acceptance-index"), `true\tlegacy\tA1\t${stateDir}\tnull\t\n`);
      const record = (): ReturnType<typeof spawnSync> =>
        spawnSync(shell, [success, "claude-post-tool-use"], {
          input: JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command: "true" } }),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        });
      expect(record().status).toBe(0);
      const evidence = join(stateDir, "workplan_legacy.evidence.jsonl");
      expect(existsSync(evidence)).toBe(false);
      writeFileSync(join(stateDir, "acceptance-index"), `true\tlegacy\tA1\t${stateDir}\n`);
      const result = record();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const lines = readEvidenceLog(evidence);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.deliveryBinding).toBeUndefined();
      expect(fingerprintTree(dir)).toEqual({ ok: true, tree: lines[0]!.worktreeTree });

      symlinkSync(join(dir, stagePath), join(dir, "redirected"));
      const redirected = spawnSync(
        shell,
        ["-uc", 'source "$1"; navori_tree_fingerprint "$2" redirected', "fixture", partial, dir],
        { encoding: "utf8" },
      );
      expect(redirected.status).toBe(1);
      expect(redirected.stdout).toBe("");
    },
  );

  // Covers: R7, R8, R9
  it("carries CLI-captured binding and agrees with the reader on exact stage exclusions", () => {
    const { dir, success } = setup();
    execFileSync("git", ["init", "-q", dir]);
    const stagePath = "specs/_master/01-proof";
    mkdirSync(join(dir, stagePath), { recursive: true });
    writeFileSync(join(dir, stagePath, "state.json"), "lifecycle");
    writeFileSync(join(dir, stagePath, "STATUS.md"), "view");
    const binding: DeliveryEvidenceBinding = {
      policy: "deliveries-content-v1" as const,
      authorityGeneration: 1,
      stagePath,
      sourceIdentity: "a".repeat(64),
      baselineIdentity: "b".repeat(64),
      queueIdentity: "c".repeat(64),
      qualifiedId: "P1.A1",
      criterionIdentity: "d".repeat(64),
    };
    const stateDir = join(dir, ".navori/state/handoffs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "acceptance-index"),
      `true\tdelivery-proof-p1\tA1\t${stateDir}\t${JSON.stringify(binding)}\t${stagePath}\n`,
    );
    const payload = {
      session_id: "fixture-session",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "true" },
      tool_response: { stdout: "", stderr: "" },
    };
    expect(run(success, dir, payload, true).code).toBe(0);
    const lines = readEvidenceLog(join(stateDir, "workplan_delivery-proof-p1.evidence.jsonl"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.deliveryBinding).toEqual(binding);
    const expected = fingerprintTree(dir, binding);
    expect(expected).toEqual({ ok: true, tree: lines[0]!.worktreeTree });
    writeFileSync(join(dir, stagePath, "state.json"), "accepted");
    writeFileSync(join(dir, stagePath, "STATUS.md"), "derived acceptance");
    expect(fingerprintTree(dir, binding)).toEqual(expected);
    writeFileSync(join(dir, stagePath, "parts.json"), "changed source");
    expect(fingerprintTree(dir, binding)).not.toEqual(expected);
  });

  // Covers: R7, R8, R9
  it("writes no bound success for redirected stages or unknown Codex correlation", () => {
    const { dir, success } = setup();
    execFileSync("git", ["init", "-q", dir]);
    const stateDir = join(dir, ".navori/state/handoffs");
    mkdirSync(stateDir, { recursive: true });
    const binding = {
      policy: "deliveries-content-v1" as const,
      authorityGeneration: 1,
      stagePath: "stage",
      sourceIdentity: "a".repeat(64),
      baselineIdentity: "b".repeat(64),
      queueIdentity: "c".repeat(64),
      qualifiedId: "P1.A1",
      criterionIdentity: "d".repeat(64),
    };
    const physical = join(dir, "physical");
    mkdirSync(physical);
    writeFileSync(join(physical, "state.json"), "state");
    symlinkSync(physical, join(dir, "stage"));
    writeFileSync(
      join(stateDir, "acceptance-index"),
      `true\tdelivery-proof-p1\tA1\t${stateDir}\t${JSON.stringify(binding)}\tstage\n`,
    );
    const payload = {
      session_id: "fixture-session",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "true" },
    };
    expect(run(success, dir, payload, true).code).toBe(0);
    const evidence = join(stateDir, "workplan_delivery-proof-p1.evidence.jsonl");
    expect(existsSync(evidence)).toBe(false);
    const codex = spawnSync("bash", [success, "codex-post-tool-use"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    expect(codex.status).toBe(0);
    expect(existsSync(evidence)).toBe(false);
  });
});
