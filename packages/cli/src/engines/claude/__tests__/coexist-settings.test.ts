import { describe, it, expect } from "vitest";
import { mergeCoexistSettings } from "../coexist-settings.ts";

/**
 * Coexist merge (issue #69): navori injects its defensive layers (guard +
 * quality-gate hooks, deny/ask rules) into a user-owned settings.json without
 * taking ownership, idempotently, preserving every user key.
 */

/** A representative buildClaudeSettings() result (defensive bits only shown). */
function navoriSettings(): Record<string, unknown> {
  return {
    $navori: { managed: true, version: "0.2.7" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "bash .claude/hooks/guard-destructive.sh",
              timeout: 10,
              statusMessage: "navori: guard-destructive",
            },
            {
              type: "command",
              command: "bash .claude/hooks/quality-gate-pre-commit.sh",
              timeout: 180,
              statusMessage: "navori: quality-gate fast",
            },
          ],
        },
      ],
    },
    permissions: {
      allow: ["Bash(ls:*)"],
      ask: ["Bash(rm -rf *)", "Bash(git reset --hard*)"],
      deny: ["Bash(rm -rf /)", "Bash(mkfs*)"],
    },
  };
}

describe("mergeCoexistSettings", () => {
  it("injects navori hooks + deny/ask into a user file, preserving user keys", () => {
    const user = {
      $schema: "https://example/schema.json",
      env: { FOO: "bar" },
      permissions: { allow: ["Bash(pnpm:*)"] },
    };
    const merged = mergeCoexistSettings(user, navoriSettings());

    // user keys untouched
    expect(merged.$schema).toBe("https://example/schema.json");
    expect(merged.env).toEqual({ FOO: "bar" });
    expect((merged.permissions as { allow: string[] }).allow).toEqual(["Bash(pnpm:*)"]);

    // navori defensive layers present
    const bash = (
      merged.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    ).PreToolUse[0];
    expect(bash.matcher).toBe("Bash");
    expect(bash.hooks.map((h) => h.command)).toEqual([
      "bash .claude/hooks/guard-destructive.sh",
      "bash .claude/hooks/quality-gate-pre-commit.sh",
    ]);
    expect((merged.permissions as { deny: string[] }).deny).toEqual([
      "Bash(rm -rf /)",
      "Bash(mkfs*)",
    ]);
    expect((merged.permissions as { ask: string[] }).ask).toEqual([
      "Bash(rm -rf *)",
      "Bash(git reset --hard*)",
    ]);

    // does NOT claim ownership
    expect((merged.$navori as { managed?: boolean }).managed).toBeUndefined();
    // records what it injected
    expect((merged.$navori as { managedHooks: string[] }).managedHooks).toHaveLength(2);
  });

  it("is idempotent — merging twice yields the same object", () => {
    const user = { permissions: { allow: ["Bash(pnpm:*)"] } };
    const once = mergeCoexistSettings(user, navoriSettings());
    const twice = mergeCoexistSettings(once, navoriSettings());
    expect(twice).toEqual(once);
  });

  it("does not mutate the input", () => {
    const user = { permissions: { allow: ["Bash(pnpm:*)"] } };
    const snapshot = JSON.stringify(user);
    mergeCoexistSettings(user, navoriSettings());
    expect(JSON.stringify(user)).toBe(snapshot);
  });

  it("merges navori hooks into an existing user Bash matcher group, keeping user hooks", () => {
    const user = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "bash .claude/hooks/my-own.sh" }],
          },
        ],
      },
    };
    const merged = mergeCoexistSettings(user, navoriSettings());
    const groups = (
      merged.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    ).PreToolUse;
    // single Bash group, user hook first, navori hooks appended
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks.map((h) => h.command)).toEqual([
      "bash .claude/hooks/my-own.sh",
      "bash .claude/hooks/guard-destructive.sh",
      "bash .claude/hooks/quality-gate-pre-commit.sh",
    ]);
  });

  it("preserves user deny/ask rules and dedupes overlaps", () => {
    const user = {
      permissions: { deny: ["Bash(rm -rf /)", "Bash(:(){ :|:& };:)"], ask: ["Bash(chmod -R *)"] },
    };
    const merged = mergeCoexistSettings(user, navoriSettings());
    const deny = (merged.permissions as { deny: string[] }).deny;
    // user's unique deny kept, navori's added, overlap not duplicated
    expect(deny).toContain("Bash(:(){ :|:& };:)");
    expect(deny).toContain("Bash(mkfs*)");
    expect(deny.filter((d) => d === "Bash(rm -rf /)")).toHaveLength(1);
    expect((merged.permissions as { ask: string[] }).ask).toContain("Bash(chmod -R *)");
  });

  it("removes stale navori entries when the desired set shrinks (e.g. gate disabled)", () => {
    const user = { permissions: { allow: ["Bash(pnpm:*)"] } };
    const withGate = mergeCoexistSettings(user, navoriSettings());

    // Now navori no longer wants the quality-gate hook nor one deny rule.
    const shrunk = navoriSettings();
    (shrunk.hooks as { PreToolUse: Array<{ hooks: unknown[] }> }).PreToolUse[0].hooks.pop();
    (shrunk.permissions as { deny: string[] }).deny = ["Bash(rm -rf /)"];

    const merged = mergeCoexistSettings(withGate, shrunk);
    const cmds = (
      merged.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    ).PreToolUse[0].hooks.map((h) => h.command);
    expect(cmds).toEqual(["bash .claude/hooks/guard-destructive.sh"]);
    expect((merged.permissions as { deny: string[] }).deny).toEqual(["Bash(rm -rf /)"]);
    // user key survived the whole dance
    expect((merged.permissions as { allow: string[] }).allow).toEqual(["Bash(pnpm:*)"]);
  });
});
