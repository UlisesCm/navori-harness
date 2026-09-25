import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { loadPlugin } from "../config/plugins.ts";

/**
 * Spec 0026 T18 (R45, R46) — `publisher.md` gains the comment contract
 * (body always file-backed, never inline; a channel table per tool; Codex
 * hands over draft + command instead of executing) and the `acli`/`gh`
 * plugins each inject a channel-specific sub-block into it.
 */

const PUBLISHER_PATH = resolve(getCoreRoot(), "core-assets", "agents", "publisher.md");

function readPublisher(): string {
  return readFileSync(PUBLISHER_PATH, "utf-8");
}

// Covers: R45, R46
describe("comment contract and channel sub-blocks", () => {
  it("publisher.md requires a file-backed body, never inline", () => {
    const body = readPublisher();
    expect(body).toMatch(/never inline/i);
    expect(body).toContain("--body-file");
  });

  it("publisher.md's channel table covers gh, gh api, gh graphql and acli", () => {
    const body = readPublisher();
    expect(body).toContain("--body-file <path>");
    expect(body).toMatch(/--input <path>|`--input`/);
    expect(body).toContain("-F body=@<path>");
    expect(body).toContain("--body-adf <path>");
  });

  it("publisher.md content comes only from handoff artifacts, never invented", () => {
    const body = readPublisher();
    expect(body).toMatch(/handoff artifact/i);
  });

  it("publisher.md's Codex clause never claims an unpublished URL or id", () => {
    const body = readPublisher();
    expect(body).toMatch(/Codex/);
    expect(body).toMatch(/never state a URL or id you did not yourself publish/i);
    expect(body).toMatch(/report back the resulting URL or id/i);
  });

  it("gh plugin injects a channel sub-block into publisher.md", () => {
    const gh = loadPlugin("gh");
    const skill = gh.skillAssets.find((s) => s.injectInto === ".claude/agents/publisher.md");
    expect(skill, "gh plugin has no skills[] entry injecting into publisher.md").toBeDefined();
    expect(skill!.id).toContain("publisher");
    const content = readFileSync(skill!.absPath, "utf-8");
    expect(content).toContain("--body-file");
    expect(content).toContain("-F body=@");
  });

  it("acli plugin injects a channel sub-block into publisher.md requiring ADF for mentions and forbidding Jira writes via the Atlassian MCP", () => {
    const acli = loadPlugin("acli");
    const skill = acli.skillAssets.find((s) => s.injectInto === ".claude/agents/publisher.md");
    expect(skill, "acli plugin has no skills[] entry injecting into publisher.md").toBeDefined();
    expect(skill!.id).toContain("publisher");
    const content = readFileSync(skill!.absPath, "utf-8");
    expect(content).toMatch(/--body-adf/);
    expect(content).toMatch(/mention/i);
    expect(content).toMatch(/Atlassian.*MCP|MCP.*Atlassian/i);
    expect(content).toMatch(/Never write to Jira/i);
  });
});

/**
 * Issue #1018 — a publisher dispatched async kept acting (re-ran the gate,
 * committed, pushed, opened the PR) after emitting a stop report, because
 * `publisher.md` never says a stop report is the cycle's last action. Also
 * pins that Commit flow step 7 never discards a foreign modified file.
 */
// Covers: #1018
describe("stop report is final; foreign changes are never discarded", () => {
  it("publisher.md declares a stop report as the cycle's last action — no further gate/git/gh after it", () => {
    const body = readPublisher();
    expect(body).toMatch(/last action of this cycle/i);
    expect(body).toMatch(/next invocation/i);
  });

  it("publisher.md's Commit flow step 7 never discards, restores or reverts a foreign modified file", () => {
    const body = readPublisher();
    expect(body).toMatch(/reported as an observation/i);
    expect(body).toMatch(/never discarded, restored or reverted/i);
  });
});

/**
 * Issue #1028 — the publisher drafted PR titles/bodies with claims no
 * handoff backed (inferred paths, commands, counts or decisions), corrected
 * by hand across 5 PRs. `## PR flow` step 3 (Validate) now pins every claim
 * in the title AND body to the cycle's actual evidence: the handoffs on
 * disk, `git log`/`git diff` against the base, or the spec — nothing else.
 */
// Covers: #1028
describe("PR flow step 3 — every title/body claim traces to the cycle's evidence", () => {
  it("publisher.md requires every claim in the title and body to trace to a handoff, git log/diff, or the spec", () => {
    const body = readPublisher();
    expect(body).toMatch(/every claim in the title and body/i);
    expect(body).toMatch(/traces to the cycle's handoffs/i);
    expect(body).toMatch(/git log/);
    expect(body).toMatch(/git diff/);
    expect(body).toMatch(/against the base/i);
    expect(body).toMatch(/or the spec/i);
  });

  it("publisher.md forbids inferred paths, commands, counts or decisions and never fills a missing fact in", () => {
    const body = readPublisher();
    expect(body).toMatch(/no inferred path, command, count or decision/i);
    expect(body).toMatch(/never filled in/i);
  });
});
