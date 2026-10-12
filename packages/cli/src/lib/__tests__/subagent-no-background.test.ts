import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for `subagent-no-background.sh` (#1003). Each case
 * installs the RENDERED script (includes expanded, exactly what ships to a
 * repo) into a temp dir and drives it with its PreToolUse payload on stdin.
 */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets/hooks");
const SCRIPT = "subagent-no-background.sh";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-no-bg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Payload {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
}

/** Install the rendered hook and run it under every available shell (#391). */
function runHook(payload: Payload): { status: number; stderr: string } {
  const raw = expandHookIncludes(readFileSync(join(HOOKS_DIR, SCRIPT), "utf-8"));
  const path = join(dir, SCRIPT);
  writeFileSync(path, raw);
  chmodSync(path, 0o755);
  const nodeDir = dirname(process.execPath);
  return acrossShells((shell) => {
    const r = spawnSync(shell, [path], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      },
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  });
}

function bashPayload(runInBackground: unknown, agentId?: string): Payload {
  const payload: Payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "sleep 1", run_in_background: runInBackground },
  };
  if (agentId !== undefined) payload.agent_id = agentId;
  return payload;
}

function monitorPayload(agentId?: string): Payload {
  const payload: Payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Monitor",
    tool_input: {},
  };
  if (agentId !== undefined) payload.agent_id = agentId;
  return payload;
}

describe("subagent-no-background hook — main thread stays legitimate (#1003)", () => {
  it("allows the main thread (no agent_id) to background a Bash call", () => {
    const r = runHook(bashPayload(true));
    expect(r.status).toBe(0);
  });

  it("allows the main thread (no agent_id) to call Monitor", () => {
    const r = runHook(monitorPayload());
    expect(r.status).toBe(0);
  });
});

describe("subagent-no-background hook — blocks a subagent (#1003)", () => {
  it("blocks Bash run_in_background: true when agent_id is present", () => {
    const r = runHook(bashPayload(true, "impl-1"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("verify-before-done");
  });

  it("blocks Monitor unconditionally when agent_id is present", () => {
    const r = runHook(monitorPayload("impl-1"));
    expect(r.status).toBe(2);
  });
});

describe("subagent-no-background hook — allows a subagent's legitimate calls (#1003)", () => {
  it("allows a subagent's Bash call with run_in_background: false", () => {
    const r = runHook(bashPayload(false, "impl-1"));
    expect(r.status).toBe(0);
  });

  it("allows a subagent's Bash call with run_in_background absent", () => {
    const r = runHook(bashPayload(undefined, "impl-1"));
    expect(r.status).toBe(0);
  });

  it("allows a subagent calling a non-Bash, non-Monitor tool", () => {
    const r = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "src/x.ts" },
      agent_id: "impl-1",
    });
    expect(r.status).toBe(0);
  });
});

function cmdPayload(command: string, agentId?: string): Payload {
  const payload: Payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  if (agentId !== undefined) payload.agent_id = agentId;
  return payload;
}

const HEREDOC_AMP = "cat > notes.txt <<'EOF'\nstart server &\nnohup x\nEOF";

describe("background operators blocked in subagents", () => {
  const blocked: Array<[string, string]> = [
    ["trailing &", "sleep 30 &"],
    ["& between commands", "sleep 30 & echo started"],
    ["& after a chain", "bun run check:fast && sleep 30 &"],
    ["nohup", "nohup bun run check:fast"],
    ["setsid", "setsid bun run check:fast"],
    ["disown", "sleep 30; disown"],
    ["nohup behind env prefix", "FOO=1 nohup bun run check:fast"],
    ["nohup behind sudo", "sudo nohup bun run check:fast"],
    ["nohup in a later chain segment", "cd x && nohup bun run check:fast > out.log"],
  ];

  for (const [label, command] of blocked) {
    // Covers: R8
    it(`blocks ${label}`, () => {
      const r = runHook(cmdPayload(command, "impl-1"));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("subagent-no-background");
    });
  }

  // Covers: R8
  it("does not block the same commands in the main thread", () => {
    for (const [, command] of blocked) {
      expect(runHook(cmdPayload(command)).status).toBe(0);
    }
  });

  const allowed: Array<[string, string]> = [
    ["&& chain", "bun run lint && bun run typecheck"],
    ["|| chain", "bun run lint || echo failed"],
    ["2>&1 redirect", "bun run check:fast 2>&1 | tail -5"],
    ["&> redirect", "bun run check:fast &> out.log"],
    ["|& pipe", "bun run check:fast |& tail -5"],
    [">&2 redirect", "echo oops >&2"],
    ["& inside double quotes", 'echo "a & b"'],
    ["& inside single quotes", "echo 'start &'"],
    ["URL query in quotes", "curl 'https://x.test/?a=1&b=2'"],
    ["& in a heredoc body", HEREDOC_AMP],
    ["& in a commit message", 'git commit -m "fix a & b; nohup is mentioned"'],
    ["nohup as an argument", "grep -rn nohup src"],
    ["plain foreground command", "bun run --cwd packages/cli test src/x.test.ts"],
  ];

  for (const [label, command] of allowed) {
    // Covers: R8
    it(`allows ${label}`, () => {
      const r = runHook(cmdPayload(command, "impl-1"));
      expect({ command, status: r.status }).toEqual({ command, status: 0 });
    });
  }

  // Covers: R8
  it("blocks a heredoc that writes a script and then backgrounds it", () => {
    const command = "cat > run.sh <<'EOF'\necho hi\nEOF\nbash run.sh &";
    expect(runHook(cmdPayload(command, "impl-1")).status).toBe(2);
  });

  // Covers: R8
  it("fails closed on a command too large to inspect", () => {
    const command = `echo ${"x".repeat(131100)}`;
    expect(runHook(cmdPayload(command, "impl-1")).status).toBe(2);
  });
});
