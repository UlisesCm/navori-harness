import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LANG } from "../i18n.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../schema.ts";
import { placeholderFallback } from "../placeholders.ts";
import { scanInterpolationArtifacts } from "../interpolation-artifacts.ts";

/**
 * #440 — the complement of `engines/__tests__/empty-placeholder-render.test.ts`.
 *
 * That suite pins a FRESH render: no artifact ever leaves the interpolator. This
 * one pins the case it cannot see by definition — the file already existed, so
 * `rerender` rewrote the managed zone and left the user zone exactly as it was,
 * tokens included (render-managed-file.ts:73-95). A repo onboarded before the
 * fix stays broken through any number of re-renders, and until this check
 * nothing said so.
 *
 * The negative cases matter as much: a check that fires on healthy repos is one
 * people learn to ignore.
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-interp-artifacts-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

/** Write a rendered file, returning its lines so a test can locate one by hand. */
function write(rel: string, lines: string[]): string[] {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf-8");
  return lines;
}

/** The two halves of a rendered agent file, managed then user-owned. */
function agentFile(userLines: string[], managedLines: string[] = ["Managed body."]): string[] {
  return [
    '<!-- navori:managed id="implementer-base" hash="abc" version="0.6.0" source="@navori/core" -->',
    ...managedLines,
    '<!-- /navori:managed id="implementer-base" -->',
    "",
    "## Project rules",
    "",
    ...userLines,
  ];
}

/** 1-based line number of `needle` in a rendered file's lines. */
function lineOf(lines: string[], needle: string): number {
  const idx = lines.findIndex((l) => l.includes(needle));
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx + 1;
}

describe("scanInterpolationArtifacts (#440)", () => {
  it("says nothing about a clean rendered tree", () => {
    write("CLAUDE.md", ["# CLAUDE.md", "", "Nothing unresolved here."]);
    write(".claude/agents/implementer.md", agentFile(["- Nothing unresolved here either."]));
    write(".claude/skills/verify-before-done/SKILL.md", ["# verify-before-done", "", "Prose."]);

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([]);
  });

  // The measured case: the 9 tokens #375 had to fix BY HAND in this repo's own
  // mirror, in the one zone `render` is contractually forbidden to touch.
  it("reports a token frozen in the user zone with its path and line", () => {
    const token = "<not configured: project.criticalAreas>";
    const lines = write(
      ".claude/agents/implementer.md",
      agentFile([`- Critical areas where extra care applies: ${token}`]),
    );

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([
      {
        path: ".claude/agents/implementer.md",
        line: lineOf(lines, token),
        token,
        reason: "unresolved-placeholder",
      },
    ]);
  });

  it("reports a token in the managed zone too", () => {
    const token = "<not configured: project.legacyPaths>";
    const lines = write(".claude/agents/reviewer.md", agentFile(["- User prose."], [token]));

    const found = scanInterpolationArtifacts(cwd, config());
    expect(found).toEqual([
      {
        path: ".claude/agents/reviewer.md",
        line: lineOf(lines, token),
        token,
        reason: "unresolved-placeholder",
      },
    ]);
  });

  it("sweeps CLAUDE.md and the skills tree, not just agents", () => {
    write("CLAUDE.md", ["# CLAUDE.md", "<not configured: project.stack>"]);
    write(".claude/skills/review-diff/SKILL.md", ["# review-diff", "<not configured: language>"]);

    expect(
      scanInterpolationArtifacts(cwd, config())
        .map((a) => a.path)
        .sort(),
    ).toEqual([".claude/skills/review-diff/SKILL.md", "CLAUDE.md"]);
  });

  it("reports the qualityGate soft fallback: published prose that means 'not configured'", () => {
    const token = placeholderFallback("qualityGate.full", DEFAULT_LANG);
    const lines = write(".claude/agents/commit-pr-pilot.md", agentFile([`- Gate: ${token}`]));

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([
      {
        path: ".claude/agents/commit-pr-pilot.md",
        line: lineOf(lines, token),
        token,
        reason: "unconfigured-gate",
      },
    ]);
  });

  // #445 — the token was written by a PAST render, so it carries that render's
  // locale, not the config's current one. A repo that switched `language` (or
  // that was rendered by a navori older than #445) must not go unreported.
  it.each([
    { rendered: "es", configured: "en" },
    { rendered: "en", configured: "es" },
    { rendered: "en", configured: "en" },
    { rendered: "es", configured: "es" },
  ] as const)(
    "reports the qualityGate fallback written in $rendered while the config says $configured",
    ({ rendered, configured }) => {
      const token = placeholderFallback("qualityGate.fast", rendered);
      const lines = write(".claude/agents/implementer.md", agentFile([`- Gate: ${token}`]));

      expect(scanInterpolationArtifacts(cwd, config({ language: configured }))).toEqual([
        {
          path: ".claude/agents/implementer.md",
          line: lineOf(lines, token),
          token,
          reason: "unconfigured-gate",
        },
      ]);
    },
  );

  // `project.criticalAreas` / `project.legacyPaths` resolve to a generic default
  // ("the sensible baseline every repo has"), not a diagnostic — flagging that
  // prose would make the check fire on every repo that didn't declare the field.
  it("does not flag the generic soft defaults", () => {
    write(".claude/agents/leader.md", [
      ...agentFile([
        `- Critical areas: ${placeholderFallback("project.criticalAreas", DEFAULT_LANG)}`,
        `- Legacy paths: ${placeholderFallback("project.legacyPaths", DEFAULT_LANG)}`,
      ]),
    ]);

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([]);
  });

  // The point of the issue: the strings come from `placeholderFallback`, so a
  // change to the fallback's wording keeps being detected instead of silently
  // slipping past a hardcoded copy.
  it("derives what it looks for from placeholderFallback, whatever the path", () => {
    const token = placeholderFallback("some.brand.new.field", DEFAULT_LANG);
    expect(token).not.toBe("");
    write(".claude/agents/researcher.md", agentFile([`- Field: ${token}`]));

    const found = scanInterpolationArtifacts(cwd, config());
    expect(found).toHaveLength(1);
    expect(found[0].token).toBe(token);
  });

  it("reports every occurrence on its own line, deduped per line", () => {
    const lines = write(
      ".claude/agents/explorer.md",
      agentFile([
        "- <not configured: a> and <not configured: a> on one line",
        "- <not configured: b> on the next",
      ]),
    );

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([
      {
        path: ".claude/agents/explorer.md",
        line: lineOf(lines, "<not configured: a>"),
        token: "<not configured: a>",
        reason: "unresolved-placeholder",
      },
      {
        path: ".claude/agents/explorer.md",
        line: lineOf(lines, "<not configured: b>"),
        token: "<not configured: b>",
        reason: "unresolved-placeholder",
      },
    ]);
  });

  // Agent handoffs quote these tokens all the time — the report for this very
  // issue does. They are not rendered output, so they are not the scan's business.
  it("ignores ephemeral agent handoffs under .claude/progress", () => {
    write(".claude/progress/impl_440.md", ["A report quoting <not configured: project.stack>."]);

    expect(scanInterpolationArtifacts(cwd, config())).toEqual([]);
  });

  it("only sweeps the outputs of the configured engines", () => {
    write("AGENTS.md", ["# AGENTS.md", "<not configured: project.stack>"]);

    expect(scanInterpolationArtifacts(cwd, config({ engines: ["claude"] }))).toEqual([]);
    expect(scanInterpolationArtifacts(cwd, config({ engines: ["codex"] }))).toEqual([
      {
        path: "AGENTS.md",
        line: 2,
        token: "<not configured: project.stack>",
        reason: "unresolved-placeholder",
      },
    ]);
  });
});
