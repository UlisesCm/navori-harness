import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexHookHash,
  codexHookKey,
  isValidToml,
  planTrustEdit,
  readCodexTrustState,
  type CodexTrustState,
} from "../codex/trust.ts";
import {
  resolveCodexHooks,
  type ResolvedCodexHook,
} from "../../engines/codex/hook-registrations.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cx",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

// Real `trusted_hash` values Codex 0.157 wrote for THIS repo's own
// `.codex/config.toml` (verified read-only against `~/.codex/config.toml`,
// see the workplan/encargo). Golden — a change to the four pre-existing
// registrations moves these (hook-registrations.ts's ordering contract).
const GOLDEN_ROOT = "/Users/ulisescm/Documents/Dev - Docs/navori-harness";
const GOLDEN_HASHES: Record<string, string> = {
  "pre_tool_use:0:0": "sha256:9cbd61c21c0df4c1090ebbbd3d7e6d940843bd9043ed1ae8b8904cf12cef6ff5",
  "pre_tool_use:1:0": "sha256:119086685199cae55d52a279dc2ff9bf426280651aefc7814d6cef21836469ee",
  "pre_tool_use:2:0": "sha256:5c73b49f07866bd54d8676edae83f0c7e2ac69f020b7cb1ef92a61754fa9b377",
  "session_start:0:0": "sha256:25446669b6ffb75c7f25a49d66273c95a9fb4445ed38ce0abb98b91a4fb548a9",
};

function goldenHomeConfig(root: string): string {
  const lines = [`[projects."${root}"]`, `trust_level = "trusted"`, ""];
  for (const [suffix, hash] of Object.entries(GOLDEN_HASHES)) {
    lines.push(
      `[hooks.state."${root}/.codex/config.toml:${suffix}"]`,
      `trusted_hash = "${hash}"`,
      "",
    );
  }
  return lines.join("\n");
}

describe("codexHookKey (spec 0035 D9)", () => {
  // Covers: R14, R16
  it("matches the real key shape Codex writes to hooks.state", () => {
    expect(codexHookKey(`${GOLDEN_ROOT}/.codex/config.toml`, "PreToolUse", 0, 0)).toBe(
      `${GOLDEN_ROOT}/.codex/config.toml:pre_tool_use:0:0`,
    );
    expect(codexHookKey(`${GOLDEN_ROOT}/.codex/config.toml`, "SessionStart", 0, 0)).toBe(
      `${GOLDEN_ROOT}/.codex/config.toml:session_start:0:0`,
    );
  });
});

describe("readCodexTrustState — reproduces the four real Codex hashes (spec 0035 T8)", () => {
  // Covers: R14, R16 — this is an integration-level cross-check: it exercises
  // codexHookKey + the internal command builder + codexHookHash together
  // against real values Codex itself wrote, which also pins that the
  // internal command construction has not drifted from build-config-toml.ts.
  it("classifies the four pre-existing registrations as Trusted against the real hashes", () => {
    const cfg = config({ qualityGate: { fast: "pnpm test", full: "pnpm test" } });
    const hooks = resolveCodexHooks(cfg);
    const configTomlPath = `${GOLDEN_ROOT}/.codex/config.toml`;
    const homeText = goldenHomeConfig(GOLDEN_ROOT);
    const state = readCodexTrustState(GOLDEN_ROOT, configTomlPath, hooks, {
      codexHomeConfigPath: writeTempHome(homeText),
    });
    const byScript = (script: string) => state.hooks.find((h) => h.script === script);
    expect(state.projectTrusted).toBe(true);
    expect(byScript("guard-destructive")?.status).toBe("Trusted");
    expect(byScript("comment-draft-confirm")?.status).toBe("Trusted");
    expect(byScript("quality-gate-pre-commit")?.status).toBe("Trusted");
    expect(byScript("model-advisor")?.status).toBe("Trusted");
    // Newly registered (spec 0035 Lote A) hooks have no entry yet — Untrusted.
    expect(byScript("session-start-context")?.status).toBe("Untrusted");
  });
});

describe("readCodexTrustState — classifies Trusted, Modified and Untrusted", () => {
  // Covers: R16
  it("tells the three states apart", () => {
    const hooks: ResolvedCodexHook[] = [
      { script: "guard-destructive", event: "PreToolUse", matcher: "^Bash$", timeout: 30 },
      { script: "comment-draft-confirm", event: "PreToolUse", matcher: "^Bash$", timeout: 10 },
      { script: "model-advisor", event: "SessionStart", timeout: 10, args: "codex-session-start" },
    ];
    const configTomlPath = "/tmp/fake-repo/.codex/config.toml";
    const trusted = codexHookHash(
      hooks[0]!,
      `bash "$(git rev-parse --show-toplevel)/.codex/hooks/guard-destructive.sh"`,
    );
    const homeText = [
      `[projects."/tmp/fake-repo"]`,
      `trust_level = "trusted"`,
      "",
      `[hooks.state."${configTomlPath}:pre_tool_use:0:0"]`,
      `trusted_hash = "${trusted}"`,
      "",
      `[hooks.state."${configTomlPath}:pre_tool_use:1:0"]`,
      `trusted_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"`,
      "",
    ].join("\n");
    const state = readCodexTrustState("/tmp/fake-repo", configTomlPath, hooks, {
      codexHomeConfigPath: writeTempHome(homeText),
    });
    expect(state.hooks.find((h) => h.script === "guard-destructive")?.status).toBe("Trusted");
    expect(state.hooks.find((h) => h.script === "comment-draft-confirm")?.status).toBe("Modified");
    expect(state.hooks.find((h) => h.script === "model-advisor")?.status).toBe("Untrusted");
  });

  it("reports everything Untrusted, and the project not trusted, when the file is absent", () => {
    const hooks: ResolvedCodexHook[] = [
      { script: "guard-destructive", event: "PreToolUse", matcher: "^Bash$", timeout: 30 },
    ];
    const state = readCodexTrustState(
      "/tmp/fake-repo",
      "/tmp/fake-repo/.codex/config.toml",
      hooks,
      {
        codexHomeConfigPath: "/tmp/does-not-exist-navori-codex-trust-test/config.toml",
      },
    );
    expect(state.projectTrusted).toBe(false);
    expect(state.hooks[0]?.status).toBe("Untrusted");
  });
});

describe("planTrustEdit — bounded text edit (spec 0035 D9)", () => {
  // Covers: R14, R15
  it("preserves every other byte of a config with comments and foreign tables", () => {
    const raw = [
      "# a developer's own comment",
      "",
      '[projects."/some/other/repo"]',
      'trust_level = "trusted"',
      "",
      "[some_foreign_table]",
      'x = "y"',
      "",
    ].join("\n");
    const state: CodexTrustState = {
      configTomlPath: "/tmp/fake-repo/.codex/config.toml",
      projectRoot: "/tmp/fake-repo",
      projectTrusted: false,
      hooks: [
        {
          script: "guard-destructive",
          event: "PreToolUse",
          matcher: "^Bash$",
          key: "/tmp/fake-repo/.codex/config.toml:pre_tool_use:0:0",
          expectedHash: "sha256:aaaa",
          status: "Untrusted",
        },
      ],
    };
    const plan = planTrustEdit(raw, state);
    expect(plan.changed).toBe(true);
    // Everything that was already there survives untouched.
    expect(plan.text).toContain("# a developer's own comment");
    expect(plan.text).toContain('[projects."/some/other/repo"]');
    expect(plan.text).toContain("[some_foreign_table]");
    expect(plan.text).toContain('x = "y"');
    // The new project + hook tables are appended.
    expect(plan.text).toContain('[projects."/tmp/fake-repo"]');
    expect(plan.text).toContain('trust_level = "trusted"');
    expect(plan.text).toContain(
      '[hooks.state."/tmp/fake-repo/.codex/config.toml:pre_tool_use:0:0"]',
    );
    expect(plan.text).toContain('trusted_hash = "sha256:aaaa"');
    expect(isValidToml(plan.text)).toBe(true);
  });

  it("replaces only the trusted_hash line of an existing hook table", () => {
    const raw = [
      '[hooks.state."/tmp/fake-repo/.codex/config.toml:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:old"',
      "",
    ].join("\n");
    const state: CodexTrustState = {
      configTomlPath: "/tmp/fake-repo/.codex/config.toml",
      projectRoot: "/tmp/fake-repo",
      projectTrusted: true,
      hooks: [
        {
          script: "guard-destructive",
          event: "PreToolUse",
          matcher: "^Bash$",
          key: "/tmp/fake-repo/.codex/config.toml:pre_tool_use:0:0",
          expectedHash: "sha256:new",
          status: "Modified",
        },
      ],
    };
    const plan = planTrustEdit(raw, state);
    expect(plan.text).toContain('trusted_hash = "sha256:new"');
    expect(plan.text).not.toContain('"sha256:old"');
    expect((plan.text.match(/trusted_hash/g) ?? []).length).toBe(1);
  });

  it("is idempotent: nothing to change when everything is already Trusted", () => {
    const state: CodexTrustState = {
      configTomlPath: "/tmp/fake-repo/.codex/config.toml",
      projectRoot: "/tmp/fake-repo",
      projectTrusted: true,
      hooks: [
        {
          script: "guard-destructive",
          event: "PreToolUse",
          matcher: "^Bash$",
          key: "/tmp/fake-repo/.codex/config.toml:pre_tool_use:0:0",
          expectedHash: "sha256:new",
          status: "Trusted",
        },
      ],
    };
    const raw = "";
    const plan = planTrustEdit(raw, state);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(raw);
  });
});

describe("isValidToml — invalid result is never written (spec 0035 D9)", () => {
  // Covers: R14
  it("rejects a file that doesn't parse, even after a well-formed edit", () => {
    const brokenRaw = '[projects."/tmp/fake-repo\ntrust_level = "trusted"\n'; // unterminated key string
    const state: CodexTrustState = {
      configTomlPath: "/tmp/fake-repo/.codex/config.toml",
      projectRoot: "/tmp/fake-repo",
      projectTrusted: false,
      hooks: [],
    };
    const plan = planTrustEdit(brokenRaw, state);
    expect(isValidToml(plan.text)).toBe(false);
  });

  it("accepts a well-formed edit", () => {
    expect(isValidToml('[projects."/x"]\ntrust_level = "trusted"\n')).toBe(true);
  });
});

/** Writes the fixture text to a throwaway file under the OS temp dir — never
 *  the developer's real ~/.codex, which this test file never touches. */
function writeTempHome(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-codex-trust-lib-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, text, "utf-8");
  return path;
}
