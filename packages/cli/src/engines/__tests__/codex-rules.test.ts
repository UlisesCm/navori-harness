import { describe, expect, it } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";
import { buildClaudeSettings } from "../claude/build-settings.ts";
import { buildCodexRules } from "../codex/build-rules.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../codex/hook-registrations.ts";
import { collectShellPermissionRules } from "../shared/permission-rules.ts";

const MINIMAL_CONFIG = {
  name: "test",
  engines: ["claude", "codex"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm test", full: "pnpm test" },
} as unknown as NavoriConfig;

/**
 * Spec 0035 D5/T6. `buildCodexRules` takes a `ShellPermissionRules` triple
 * directly (unit-level), so most cases here build a synthetic one instead of
 * paying for a full config + plugin load — `"settings.json and navori.rules
 * share one source"` is the one test that goes through the real
 * `collectShellPermissionRules` to pin the invariant end to end.
 *
 * `allow` is never translated (review finding, Lote C round 1): a Codex
 * `allow` rule runs the command OUTSIDE the sandbox
 * (`core/src/exec_policy.rs`: `Decision::Allow` →
 * `ExecApprovalRequirement::Skip { bypass_sandbox }`), so translating
 * Claude's allow-list would be a privilege escalation. `rules.allow` entries
 * are skipped by design, never counted in `dropped`.
 */

describe("buildCodexRules — translation (spec 0035 D5)", () => {
  // Covers: R9
  it("translates ask/deny and never emits allow", () => {
    const result = buildCodexRules({
      allow: ["Bash(git status*)", "Bash(git add:*)", "Bash(git push -u origin HEAD)"],
      ask: ["Bash(rm -rf *)"],
      deny: ["Bash(rm -rf /)"],
    });

    expect(result.body).toMatch(/pattern = \["rm", "-rf"\][\s\S]*?decision = "prompt"/);
    expect(result.body).toMatch(/pattern = \["rm", "-rf", "\/"\][\s\S]*?decision = "forbidden"/);
    // The allow entries never reach translation: no trace of them, and no
    // `decision = "allow"` anywhere in the file.
    expect(result.body).not.toContain('decision = "allow"');
    expect(result.body).not.toContain('pattern = ["git", "status"]');
    expect(result.body).not.toContain('pattern = ["git", "add"]');
    expect(result.dropped).toEqual([]);
  });

  // Covers: R9
  it("an exact (wildcard-free) pattern becomes a prefix rule", () => {
    const result = buildCodexRules({ allow: [], ask: [], deny: ["Bash(git push -u origin HEAD)"] });
    expect(result.body).toContain('pattern = ["git", "push", "-u", "origin", "HEAD"]');
    expect(result.body).toMatch(
      /pattern = \["git", "push", "-u", "origin", "HEAD"\][\s\S]*?decision = "forbidden"/,
    );
    // No wildcard was stripped, so it is not reported as narrowed.
    expect(result.narrowed).toEqual([]);
  });

  // Covers: R9, R5
  it("always adds the gh pr create → prompt rule, replacing pr-publisher-confirm", () => {
    const result = buildCodexRules({ allow: [], ask: [], deny: [] });
    expect(result.body).toContain('pattern = ["gh", "pr", "create"]');
    expect(result.body).toMatch(/pattern = \["gh", "pr", "create"\][\s\S]*?decision = "prompt"/);
    expect(result.body).toContain("justification");
  });

  // Covers: R9, R10
  it("narrows a trailing glued asterisk and reports it", () => {
    const result = buildCodexRules({
      allow: [],
      ask: ["Bash(git push --force*)"],
      deny: ["Bash(mkfs*)"],
    });
    expect(result.body).toContain('pattern = ["git", "push", "--force"]');
    expect(result.body).toContain('pattern = ["mkfs"]');
    expect(result.narrowed).toEqual([
      { pattern: "Bash(git push --force*)", decision: "prompt" },
      { pattern: "Bash(mkfs*)", decision: "forbidden" },
    ]);
  });

  // Covers: R10
  it("drops inner wildcards and non-Bash rules, and reports each with its reason", () => {
    const result = buildCodexRules({
      allow: ["Read", "Glob"],
      ask: [],
      deny: ["Agent(orchestrator)", "Bash(rm -rf /ho*me/*)"],
    });
    // `Read`/`Glob` are in `allow`, never even reaches `translatePattern` — not
    // dropped, simply excluded by design (see module doc).
    expect(result.dropped).toEqual([
      { pattern: "Agent(orchestrator)", reason: "not-bash" },
      { pattern: "Bash(rm -rf /ho*me/*)", reason: "inner-wildcard" },
    ]);
    expect(result.body).not.toContain("ho*me");
  });

  // Covers: R9
  it("dedupes identical (tokens, decision) pairs from different source patterns", () => {
    const result = buildCodexRules({
      allow: [],
      ask: ["Bash(git push --force*)", "Bash(git push --force *)"],
      deny: [],
    });
    const matches = result.body.match(/pattern = \["git", "push", "--force"\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // Covers: R9 — the single-source invariant D5 requires.
  it("settings.json and navori.rules share one source (collectShellPermissionRules)", () => {
    const rules = collectShellPermissionRules(MINIMAL_CONFIG, []);
    const settings = buildClaudeSettings(MINIMAL_CONFIG, []);
    const settingsAllow = (settings.permissions as { allow: string[] }).allow;

    // What buildClaudeSettings actually writes IS collectShellPermissionRules's
    // result (build-settings.ts deep-merges it in as the final `permissions`).
    expect(settingsAllow).toEqual(rules.allow);

    const codexRules = buildCodexRules(rules);
    // A rule real in the base ask-list (rm -rf) must show up translated as prompt.
    expect(rules.ask).toContain("Bash(rm -rf *)");
    expect(codexRules.body).toMatch(/pattern = \["rm", "-rf"\][\s\S]*?decision = "prompt"/);
    // The base allow-list (git status, …) must never appear.
    expect(rules.allow).toContain("Bash(git status*)");
    expect(codexRules.body).not.toContain('pattern = ["git", "status"]');
    expect(codexRules.body).not.toContain('decision = "allow"');
  });
});

describe("Codex permission translation guarantees (spec 0041)", () => {
  // Covers: R14, R15
  it("never emits allow, even for the real merged rule set", () => {
    const rules = collectShellPermissionRules(MINIMAL_CONFIG, []);
    expect(rules.allow.length).toBeGreaterThan(0);
    const { body } = buildCodexRules(rules);
    expect(body).not.toContain('decision = "allow"');
  });

  // Covers: R14
  it("reports the only non-Bash entry as dropped instead of losing it silently", () => {
    const { dropped } = buildCodexRules(collectShellPermissionRules(MINIMAL_CONFIG, []));
    expect(dropped).toEqual([{ pattern: "Agent(orchestrator)", reason: "not-bash" }]);
  });

  // Covers: R10
  it("registers no PermissionRequest handler: confirmations are rules, not hooks", () => {
    const events = CODEX_HOOK_REGISTRATIONS.flatMap((row) =>
      row.registration ? [row.registration.event] : [],
    );
    expect(events).not.toContain("PermissionRequest");
  });
});
