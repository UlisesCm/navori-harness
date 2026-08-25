import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #401 — the memory ceremony is paid once, not two or three times.
 *
 * Two halves of the same waste. At STARTUP, the engram block used to demand
 * `mem_context` "at the start of EVERY session" while, on Claude, the plugin's
 * own SessionStart hook had already injected that very context (~10.2 KB, the
 * largest fixed injector of the startup); navori's own
 * `session-start-context.sh` says so in a comment and refuses to duplicate it.
 * At CLOSE, the closeout's `history.md` entry and `mem_session_summary`
 * persisted the SAME text written twice, and the curation added a third pass as
 * a separate turn.
 *
 * The fix is not to drop a destination — both are legitimate (`history.md`
 * travels in git, engram crosses repos) — but to write ONCE and reuse, and to
 * skip the call whose payload is already in context. This file pins both
 * halves, plus the boundary that makes them safe: the core closeout must state
 * the single-redaction rule WITHOUT naming a plugin's tools, and #378's "R1
 * lean close" lane must survive untouched (this change is orthogonal to it —
 * #378 exempts ceremony in trivial R1 sessions, #401 removes duplication in ALL
 * of them).
 */

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "..", "..", "..", "..");
const coreAssets = resolve(packages, "core", "core-assets");
const engram = resolve(packages, "plugins", "engram");

const readCore = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");
const readEngram = (rel: string): string => readFileSync(resolve(engram, rel), "utf-8");

/** The single line of a block that carries `needle`, asserted to exist. */
function lineWith(text: string, needle: string, label: string): string {
  const line = text.split("\n").find((l) => l.includes(needle));
  expect(line, `${label}: no line carries "${needle}"`).toBeDefined();
  return line as string;
}

describe("memory startup — the call is conditioned on the absence of a hook (#401)", () => {
  const block = readEngram("managed/engram-protocol.md");

  it("keeps the explicit call for hostless engines (Codex renders this prose)", () => {
    // `render-codex.test.ts` asserts AGENTS.md carries `mem_context`: on Codex
    // there is no startup hook, so this in-prose call IS the memory startup.
    expect(block).toContain("mem_context");
    const line = lineWith(block, "mem_context", "engram-protocol.md");
    expect(line).toMatch(/no startup hook \(e\.g\. Codex\)/i);
    expect(line).toMatch(/IS the memory startup/);
    expect(line).toMatch(/mandatory first step/i);
  });

  it("tells the hooked host to work with what was injected instead of re-fetching", () => {
    const line = lineWith(block, "mem_context", "engram-protocol.md");
    expect(line).toMatch(/already injected/i);
    expect(line).toMatch(/`SessionStart`/);
    expect(line).toMatch(/only re-fetches it/i);
  });

  it("never states the mandate unconditionally", () => {
    // The pre-#401 wording ("at the start of EVERY session") applied to Claude
    // too. It may only survive alongside the HOOKED-host branch — keying on
    // `startup hook` alone was too weak: the pre-#401 line carried that phrase
    // in its Codex branch, so a full revert slipped through this assert (1.1 and
    // 1.2 caught it). `already injected` exists only in the post-#401 wording.
    for (const line of block.split("\n")) {
      if (/at the start of EVERY session/i.test(line)) {
        expect(line, "the mem_context mandate lost its host condition").toMatch(
          /already injected/i,
        );
      }
    }
  });
});

describe("session close — one redaction serves every destination (#401)", () => {
  const closeout = readCore("managed/cierre-sesion.md");
  const protocol = readEngram("managed/engram-protocol.md");

  it("the closeout's history step states the single-redaction rule", () => {
    const step2 = lineWith(closeout, "2. **History**", "cierre-sesion.md");
    expect(step2).toMatch(/One redaction, every destination/);
    expect(step2).toMatch(/write that summary once and reuse the same text/i);
    expect(step2).toMatch(/never write the same session up twice/i);
  });

  it("the core states it without naming a plugin's tools", () => {
    // The engram block ships with a PLUGIN that may not be installed, and this
    // line renders ALWAYS-ON into every repo's CLAUDE.md — so naming
    // `mem_session_summary` here would dangle for every repo without engram.
    // The bar is exposure, not the whole core: an on-demand skill may name a
    // plugin tool (`core-assets/skills/ticket-intake.md` names `mem_search`),
    // because it is only read when invoked. The rule is phrased over
    // destinations, not over tools.
    const step2 = lineWith(closeout, "2. **History**", "cierre-sesion.md");
    expect(step2).not.toMatch(/mem_/);
    expect(step2).toMatch(/a memory store, for instance/i);
  });

  it("the memory protocol reuses that same text instead of re-writing it", () => {
    const summary = lineWith(protocol, "`mem_session_summary` is mandatory", "engram-protocol.md");
    expect(summary).toMatch(/same redaction/i);
    expect(summary).toContain("`history.md`");
    expect(summary).toMatch(/write it once and reuse that text/i);
    // Both destinations stay: the waste was the double writing, not the pair.
    expect(summary).toMatch(/one travels in git, the other crosses repos/i);
  });

  it("curation folds into the summary's turn instead of being a separate pass", () => {
    const curation = lineWith(protocol, "**Curation at close:**", "engram-protocol.md");
    expect(curation).toMatch(/in the SAME turn as the summary/);
    expect(curation).toMatch(/never a separate pass/i);
    expect(curation).not.toMatch(/after the summary/i);
    // The leader-injected copy must not re-open the extra turn the block closed.
    const skill = readEngram("skills/engram-leader.md");
    expect(skill).toMatch(/In the same turn as the summary, curate the session/);
    expect(skill).not.toMatch(/After the summary, curate/i);
  });
});

describe("#401 leaves #378's R1 lean close lane intact", () => {
  const closeout = readCore("managed/cierre-sesion.md");
  const protocol = readEngram("managed/engram-protocol.md");

  it("the closeout still owns the lane's three verifiable conditions", () => {
    const lane = lineWith(closeout, "**R1 lean close**", "cierre-sesion.md");
    expect(lane).toMatch(/\*\*R1\*\* route/);
    expect(lane).toMatch(/\*\*one\*\* user task/);
    expect(lane).toContain("{{project.criticalAreas}}");
    expect(lane).toMatch(/skip step 2 when nothing was committed/i);
  });

  it("the memory protocol still exempts the summary and the curation under it", () => {
    const lane = lineWith(protocol, "**R1 lean close**", "engram-protocol.md");
    expect(lane).toMatch(/summary and the curation step are exempt/i);
    expect(lane).toMatch(/`mem_save` is not/i);
    const { invariants } = JSON.parse(readEngram("plugin.json")) as { invariants: string[] };
    for (const token of invariants) {
      expect(protocol, `the engram block lost the doctor invariant ${token}`).toContain(token);
    }
  });

  it("neither half reintroduces the self-judged exemption #378 rejected", () => {
    // "no durable finding" is judged by the closing agent — the failure mode
    // #378 replaced with checkable conditions. #401 rewrote both blocks, so the
    // denylist is re-asserted here over the new prose.
    for (const [label, text] of [
      ["managed/cierre-sesion.md", closeout],
      ["engram/managed/engram-protocol.md", protocol],
    ] as const) {
      expect(text, `${label} reintroduced a self-judged exemption`).not.toMatch(
        /durable (finding|hallazgo)/i,
      );
    }
  });

  it("single-redaction does not turn into a second mandatory pass", () => {
    // The rule must REPLACE a write, never add one: no wording that asks for a
    // copy/sync step on top of the two destinations.
    for (const text of [closeout, protocol]) {
      expect(text).not.toMatch(/copy (it|the summary) (in)?to (both|the other)/i);
      expect(text).not.toMatch(/then (also )?(write|repeat) (it|the same)/i);
    }
  });
});
