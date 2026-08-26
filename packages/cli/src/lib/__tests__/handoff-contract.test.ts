import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";
import { AGENTS_DIR, isInvokable, listAgentAssets } from "./helpers/agent-assets.ts";

/**
 * #500 — the harness runs on "the subagent writes a file, answers one line",
 * and the host that runs those subagents injects the opposite order into every
 * one of their system prompts:
 *
 *   "Do NOT Write report/summary/findings/analysis .md files. Return findings
 *    directly as your final assistant message — the parent agent reads your text
 *    output, not files you create. (Files written as input to another tool are
 *    fine; this note is about report files.)"
 *
 * That text is not on disk and navori cannot edit it, so the contract survives
 * on two things, and this suite pins both:
 *
 *   1. The EXEMPTION the host itself grants. A handoff file IS input to another
 *      tool — the `reviewer` opens the `implementer`'s, the `commit-pr-pilot`
 *      opens the `reviewer`'s. Every agent that writes one says so, quoting the
 *      host's own wording, so the file falls outside the prohibition instead of
 *      colliding with it. (The `SubagentStop` hook is NOT a third consumer: it
 *      only flags a handoff that landed empty or malformed — it cannot see one
 *      that never landed. `hook-claims-vs-scripts.test.ts` keeps the prose from
 *      claiming otherwise again.)
 *   2. The LITERAL PATH in the encargo. Measured, not assumed: in the session
 *      that produced this issue the five auditors DID write their file, because
 *      the encargo carried the exact path. The explicit encargo beats the host's
 *      instruction — but only while the orchestrator actually ships the path, so
 *      the delegation format states it as a fixed field, not a suggestion.
 *
 * The failure mode is silent: no file, no error, and the pilot stalls looking
 * for a `review_<feature>.md` that nobody wrote. A regression here has to fail
 * in the suite, because it will not fail anywhere else.
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const ORQUESTACION = resolve(CORE_ASSETS, "managed", "orquestacion.md");
const LEADER = resolve(AGENTS_DIR, "leader.md");

/**
 * The host's own wording for what it exempts, quoted verbatim in the assets so
 * a subagent can match its system prompt's exemption instead of arguing with it.
 */
const HOST_EXEMPTION = "files written as input to another tool";

/** The closing handoff an agent hands back: `<verdict> -> <target>`. */
const CLOSING_LINE = /^(?:done|blocked|APPROVED|CHANGES_REQUESTED) -> (.+)$/gm;

/** A full path under the handoff dir, placeholders and globs included. */
const LITERAL_HANDOFF = /\.claude\/progress\/[\w<>*.+-]+\.(?:md|txt)/;

/** An artifact filename with no directory in front of it. */
const BARE_ARTIFACT = /(?:^|[\s(])([\w<>*.+-]+\.(?:md|txt))/g;

const read = (path: string): string => readFileSync(path, "utf-8");

/** Every closing line's target, in file order. */
function closingTargets(content: string): string[] {
  return [...content.matchAll(CLOSING_LINE)].map(([, target]) => (target ?? "").trim());
}

/**
 * Artifacts a closing line names WITHOUT the handoff dir in front — the exact
 * regression this guards: `done -> impl_<feature>.md` still reads like a
 * contract and still leaves the orchestrator (and the hook) with no path.
 */
function bareArtifacts(target: string): string[] {
  const stripped = target.replaceAll(/\.claude\/progress\/[\w<>*.+-]+\.(?:md|txt)/g, " ");
  return [...stripped.matchAll(BARE_ARTIFACT)].map(([, name]) => name ?? "");
}

/**
 * Agent id -> its closing targets, for every LAUNCHABLE agent that closes with
 * a handoff. `leader.md` quotes the same `done -> …` shape to describe what it
 * RECEIVES, and it declares itself un-launchable — counting it as a writer
 * would demand a handoff from the one agent that never produces one.
 */
function handoffWriters(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const asset of listAgentAssets()) {
    if (!isInvokable(asset)) continue;
    const targets = closingTargets(asset.content);
    if (targets.some((t) => LITERAL_HANDOFF.test(t))) out.set(asset.id, targets);
  }
  return out;
}

const WRITERS = handoffWriters();

describe("handoff contract — the literal path survives in every writer (#500)", () => {
  /**
   * Anti-vacuity, and a roster in one move: the set is derived from the
   * directory, so a broken extractor (or an agent that dropped its closing
   * line altogether) empties it and every case below would pass on nothing.
   */
  it("derives the writers from disk and finds the full roster", () => {
    expect([...WRITERS.keys()].sort()).toEqual([
      "auditor",
      "explorer",
      "implementer",
      "researcher",
      "reviewer",
      "ticket-audit",
    ]);
  });

  for (const [id, targets] of WRITERS) {
    describe(id, () => {
      it("names its handoff by the full `.claude/progress/…` path", () => {
        const named = targets.filter((t) => LITERAL_HANDOFF.test(t));
        expect(
          named.length,
          `${id} closes without naming its handoff file by path — the orchestrator ` +
            "gets a verdict it cannot open",
        ).toBeGreaterThan(0);
      });

      it("never abbreviates a second artifact to a bare filename", () => {
        const bare = targets.flatMap((t) => bareArtifacts(t));
        expect(
          bare,
          `${id}'s closing line names an artifact with no directory. Spell the ` +
            "whole `.claude/progress/<file>` path: a bare filename reads like a contract " +
            "and lands wherever the agent's cwd happens to be.",
        ).toEqual([]);
      });

      it("claims the host's own exemption for the file it writes", () => {
        expect(
          read(resolve(AGENTS_DIR, `${id}.md`)),
          `${id} does not state that its handoff is input to another tool. Without ` +
            "that clause the host's 'do NOT write report .md files' rule applies head-on, " +
            "and obeying either side breaks the other.",
        ).toContain(HOST_EXEMPTION);
      });
    });
  }
});

describe("handoff contract — the delegating side ships the path (#500)", () => {
  it.each([
    ["managed/orquestacion.md", ORQUESTACION],
    ["agents/leader.md", LEADER],
  ])("%s makes the literal path part of the delegation format", (_label, path) => {
    const text = read(path);
    expect(text).toMatch(/\*\*literal path\*\*/);
    expect(text).toContain(".claude/progress/");
    // Prose gets summarized on the way to the subagent; a path does not. The
    // asset has to say which one is required, or this degrades to advice.
    expect(text).toMatch(/summarized/i);
  });

  it.each([
    ["managed/orquestacion.md", ORQUESTACION],
    ["agents/leader.md", LEADER],
  ])("%s tells the orchestrator the file is a tool's input, not a report", (_label, path) => {
    expect(read(path)).toContain(HOST_EXEMPTION);
  });
});

describe("the closing-line extractor reports a lost path (#500)", () => {
  // Positive control: the assertions above are only worth their green if the
  // helpers actually fire on the regression they describe.
  it("flags a bare filename and a closing line with no path at all", () => {
    const regressed = ["```", "done -> impl_<feature>.md", "```"].join("\n");
    expect(closingTargets(regressed)).toEqual(["impl_<feature>.md"]);
    expect(LITERAL_HANDOFF.test("impl_<feature>.md")).toBe(false);
    expect(bareArtifacts("impl_<feature>.md")).toEqual(["impl_<feature>.md"]);
  });

  it("accepts the canonical form, including a second artifact spelled in full", () => {
    const target = ".claude/progress/audit_deep_<scope>.md (+ .claude/progress/plan_<scope>.md)";
    expect(LITERAL_HANDOFF.test(target)).toBe(true);
    expect(bareArtifacts(target)).toEqual([]);
  });
});
