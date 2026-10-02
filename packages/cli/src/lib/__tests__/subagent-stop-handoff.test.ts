import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { interpolate } from "../render/interpolate.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import type { NavoriConfig } from "../config/schema.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Compaction lane of `subagent-stop-handoff.sh` (spec 0039 R44, R70). The
 * script is rendered like `navori render` does (includes expanded, then
 * interpolated with a config) and driven with a PostToolUse(Agent) payload plus
 * a fixture transcript.
 */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets/hooks");
const THRESHOLD = 1000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-compact-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function usageLine(input: number, read: number, create: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
      },
    },
  });
}

/** Writes the rendered hook, a transcript and runs it; returns the parsed output. */
function run(opts: {
  transcript: string;
  subagentType?: string;
  agentId?: string;
  mode?: "codex";
  threshold?: number;
  runs?: number;
  payload?: Record<string, unknown>;
}): { text: string | undefined; context: string | undefined; second: string | undefined } {
  const config = {
    harness: opts.threshold === undefined ? undefined : { compactAdviceTokens: opts.threshold },
  } as unknown as NavoriConfig;
  const rendered = interpolate(
    expandHookIncludes(readFileSync(join(HOOKS_DIR, "subagent-stop-handoff.sh"), "utf-8")),
    config,
  );
  const script = join(dir, "hook.sh");
  writeFileSync(script, rendered);
  chmodSync(script, 0o755);
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, opts.transcript);
  const payload = {
    session_id: "s1",
    transcript_path: transcript,
    tool_input: { subagent_type: opts.subagentType ?? "publisher" },
    ...(opts.agentId ? { agent_id: opts.agentId } : {}),
    ...opts.payload,
  };
  const nodeDir = dirname(process.execPath);
  return acrossShells((shell) => {
    const tmp = join(dir, `tmp-${shell}`);
    mkdirSync(tmp, { recursive: true });
    const exec = (): { text: string | undefined; context: string | undefined } => {
      const r = spawnSync(shell, [script, ...(opts.mode ? [opts.mode] : [])], {
        cwd: dir,
        input: JSON.stringify(payload),
        encoding: "utf-8",
        env: {
          ...process.env,
          TMPDIR: tmp,
          PATH: `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
        },
      });
      expect(r.status).toBe(0);
      if (!r.stdout.trim()) return { text: undefined, context: undefined };
      const parsed = JSON.parse(r.stdout) as {
        systemMessage?: string;
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(parsed).not.toHaveProperty("decision");
      if (opts.mode !== "codex") {
        expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      }
      return {
        text: parsed.systemMessage,
        context: parsed.hookSpecificOutput?.additionalContext,
      };
    };
    const first = exec();
    return { ...first, second: exec().text };
  });
}

const OVER = `${usageLine(1, 600, 500)}\n`; // 1101 > 1000
const UNDER = `${usageLine(1, 400, 500)}\n`; // 901

describe("subagent-stop-handoff compaction lane", () => {
  // Covers: R44, R70
  it("advises once per session when the last usage is over the threshold after a publisher", () => {
    const r = run({ transcript: OVER, threshold: THRESHOLD });
    expect(r.text).toContain("/compact");
    expect(r.text).toContain("1101");
    expect(r.second).toBeUndefined();
  });

  // Covers: R44
  it("stays silent at or under the threshold", () => {
    expect(run({ transcript: UNDER, threshold: THRESHOLD }).text).toBeUndefined();
    expect(
      run({ transcript: `${usageLine(0, 1000, 0)}\n`, threshold: THRESHOLD }).text,
    ).toBeUndefined();
  });

  // Covers: R44
  it("uses the previous complete line when the last one is truncated", () => {
    const truncated = `${UNDER}${OVER}${usageLine(9, 9, 9).slice(0, 40)}`;
    expect(run({ transcript: truncated, threshold: THRESHOLD }).text).toContain("1101");
    const underThenCut = `${OVER}${UNDER}${usageLine(9999, 0, 0).slice(0, 40)}`;
    expect(run({ transcript: underThenCut, threshold: THRESHOLD }).text).toBeUndefined();
  });

  // Covers: R44
  it("fires for the publisher only, and never inside a subagent", () => {
    expect(
      run({ transcript: OVER, threshold: THRESHOLD, subagentType: "reviewer" }).text,
    ).toBeUndefined();
    expect(run({ transcript: OVER, threshold: THRESHOLD, agentId: "a1" }).text).toBeUndefined();
  });

  // Covers: R44
  it("emits nothing in Codex mode", () => {
    expect(run({ transcript: OVER, threshold: THRESHOLD, mode: "codex" }).text).toBeUndefined();
  });

  // Covers: R44
  it("0 disables the lane and an absent harness section falls back to 175000", () => {
    expect(run({ transcript: OVER, threshold: 0 }).text).toBeUndefined();
    const big = `${usageLine(1, 175000, 0)}\n`;
    expect(run({ transcript: big }).text).toContain("175001");
    expect(run({ transcript: `${usageLine(0, 175000, 0)}\n` }).text).toBeUndefined();
  });
});

describe("subagent-stop-handoff partial lane", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(
        getCoreRoot(),
        "../cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe2-agent-posttooluse-foreground-partial.json",
      ),
      "utf-8",
    ),
  ) as { payload: Record<string, unknown> };

  // Covers: R42
  it("warns on the live foreground turn-limit marker through both parent channels", () => {
    const result = run({ transcript: "", payload: fixture.payload, subagentType: "capped" });
    expect(result.text).toContain("handoff PARCIAL de capped");
    expect(result.context).toBe(result.text);
    expect(result.second).toContain("handoff PARCIAL");
  });

  // Covers: R42
  it("does not infer a partial from an absent handoff without the marker", () => {
    const result = run({ transcript: "", subagentType: "implementer" });
    expect(result.text).toBeUndefined();
    expect(result.context).toBeUndefined();
  });

  // Covers: R42
  it("ignores a marker outside the foreground Agent response and in Codex mode", () => {
    const payload = fixture.payload;
    expect(
      run({
        transcript: "",
        payload: {
          ...payload,
          tool_response: {},
          tool_input: { prompt: "stopped at its 3-turn limit" },
        },
      }).text,
    ).toBeUndefined();
    expect(
      run({
        transcript: "",
        payload: {
          ...payload,
          tool_input: { ...(payload.tool_input as object), run_in_background: true },
        },
      }).text,
    ).toBeUndefined();
    expect(run({ transcript: "", payload, mode: "codex" }).text).toBeUndefined();
  });
});
