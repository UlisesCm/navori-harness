import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSession, sumTokens, readJsonl } from "../parse.ts";

const FIXTURE = join(
  fileURLToPath(new URL("../../../__tests__/fixtures/audit/", import.meta.url)),
  "-tmp-fixture-repo",
  "sess-aaa11111.jsonl",
);

describe("parse: token dedupe", () => {
  it("counts a streaming-duplicated message once, not twice", () => {
    const { lines } = readJsonl(FIXTURE);
    const total = sumTokens(lines);

    // msg_dup (10/20/100/50/5) appears on TWO lines with an identical usage
    // payload; msg_two adds (1/2/3/4/1); msg_end adds zeros.
    expect(total).toEqual({
      input: 11,
      output: 22,
      cacheRead: 103,
      cacheCreation: 54,
      thinking: 6,
    });

    // Without dedupe every figure would be inflated — this is the number the
    // naive sum would produce, kept here so the regression is unmistakable.
    const naive = lines
      .filter((l) => l.type === "assistant")
      .reduce((acc, l) => {
        const u = (l.message as { usage?: Record<string, number> } | undefined)?.usage ?? {};
        return acc + (u.output_tokens ?? 0);
      }, 0);
    expect(naive).toBe(42);
  });
});

describe("parse: tolerance", () => {
  it("counts a malformed line instead of throwing, and keeps the rest", () => {
    const s = parseSession(FIXTURE);
    expect(s.parseErrors).toBe(1);
    expect(s.linesRead).toBe(12);
    // The unknown record type is skipped without becoming an error.
    expect(s.prs).toEqual([42]);
  });
});

describe("parse: session shape", () => {
  const s = parseSession(FIXTURE);

  it("takes the typed prompt, not the injected one", () => {
    expect(s.initialPrompt).toBe("arregla el bug en audit mode");
  });

  it("records the permission mode, which the tool histogram depends on", () => {
    expect(s.permissionModes).toEqual({ auto: 2 });
  });

  it("counts hook blocks that reached the context", () => {
    expect(s.orchestrator.frictionEvents).toBe(1);
  });

  it("detects skills read through Bash, not only the Skill tool", () => {
    expect(s.orchestrator.skillsRead).toEqual(["review-diff"]);
  });

  it("flags a command repeated 3+ times", () => {
    expect(s.orchestrator.repeatedCommands).toEqual({ "pnpm test": 3 });
  });
});

describe("parse: subagents", () => {
  const s = parseSession(FIXTURE);

  it("reads agentType from the sidecar meta.json", () => {
    const withMeta = s.agents.find((a) => a.agentId === "withmeta1");
    expect(withMeta?.agentType).toBe("implementer");
    expect(withMeta?.description).toBe("implementa X");
  });

  it("falls back to the parent's subagent_type when the sidecar is missing", () => {
    const orphan = s.agents.find((a) => a.agentId === "orphan2");
    expect(orphan?.agentType).toBe("implementer");
  });

  it("attributes startup cost to the first assistant message", () => {
    expect(s.agents.find((a) => a.agentId === "withmeta1")?.startupTokens).toBe(1000);
    expect(s.agents.find((a) => a.agentId === "orphan2")?.startupTokens).toBe(500);
  });

  it("dedupes each subagent's own transcript too", () => {
    const withMeta = s.agents.find((a) => a.agentId === "withmeta1");
    expect(withMeta?.tokens).toEqual({
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheCreation: 1000,
      thinking: 2,
    });
  });

  it("captures the review verdict", () => {
    expect(s.agents.find((a) => a.agentId === "withmeta1")?.verdict).toBe("CHANGES_REQUESTED");
  });

  it("marks non-overlapping windows as non-parallel", () => {
    for (const a of s.agents) expect(a.overlapsWith).toEqual([]);
  });
});

describe("parse: missing input", () => {
  it("returns an empty result instead of throwing", () => {
    expect(readJsonl("/nonexistent/path.jsonl")).toEqual({
      lines: [],
      parseErrors: 0,
      linesRead: 0,
    });
  });
});
