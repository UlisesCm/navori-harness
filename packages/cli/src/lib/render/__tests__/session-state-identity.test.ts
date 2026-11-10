import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { conditionOrchestration } from "../render-plan.ts";
import { interpolate } from "../interpolate.ts";
import { getCoreRoot } from "../bundled-assets.ts";
import { HARNESS_DEFAULTS } from "../../config/schema.ts";
import type { NavoriConfig } from "../../config/config.ts";

/**
 * #1579 identity: `harness.sessionState` defaults to true, so a config that never
 * mentions it must render every conditioned asset exactly as before. This repo
 * turns the key off, so `render:apply` here cannot prove the absent-key case;
 * this test does. Snippets are the verbatim pre-change sentences.
 */
const ABSENT = {} as unknown as NavoriConfig;
const ON = { harness: { sessionState: true } } as unknown as NavoriConfig;
const OFF = { harness: { sessionState: false } } as unknown as NavoriConfig;

const ASSETS: ReadonlyArray<{ path: string; snippets: string[] }> = [
  {
    path: "core-assets/skills/verify-before-done.md",
    snippets: [
      "2. **History**: `progress/history.md` entry `## YYYY-MM-DD HH:MM <agent> — <summary>` + changes + gate status; one redaction for every destination (memory included).\n3. **Clear** `progress/current.md` to `idle` or the next step; drop scratch files and commented-out code.\n4. **Commit** inside the work PR before it opens, never a `progress/`-only PR; no work PR → `progress/` alone.",
      "nor the `history.md` entry whenever there WAS a commit.",
    ],
  },
  {
    path: "core-assets/skills/resolve-ticket.md",
    snippets: [
      "you: `mem_search`, `cat progress/current.md`, `git status/log`",
      "report it with its evidence, leave `progress/current.md` at `idle`, stop",
      "- Either way, `progress/current.md` at `idle`.",
    ],
  },
  {
    path: "core-assets/skills/plan-simple.md",
    snippets: [
      "decisions); `progress/current.md` points at the workplan, it doesn't copy it. Acceptance",
    ],
  },
  {
    path: "core-assets/agents/orchestrator.md",
    snippets: [
      "3. Read `progress/current.md` (repo root) if it exists — the previous session's state.",
      "lives in `progress/current.md` (repo root, persists in git) and you consolidate",
      "you record the blocker in `progress/current.md` along with the next step.",
      "Versioned `progress/current.md` and `progress/history.md` are exempt.",
    ],
  },
  {
    path: "core-assets/managed/arranque-sesion.md",
    snippets: [
      "branch, recent commits, and the previous session's `progress/current.md` — at the top of the session; read it to resume. Otherwise, read `progress/current.md` yourself. Then",
    ],
  },
];

const read = (rel: string): string => readFileSync(resolve(getCoreRoot(), rel), "utf-8");
const PROGRESS_MENTION = /progress\/(current|history)\.md|history\.md|current\.md/;

describe("harness.sessionState — default and identity (#1579)", () => {
  it("defaults to on", () => {
    expect(HARNESS_DEFAULTS.sessionState).toBe(true);
  });

  describe.each(ASSETS)("$path", ({ path, snippets }) => {
    const source = read(path);

    it("renders with the key absent exactly as with the key true", () => {
      expect(conditionOrchestration(source, ABSENT)).toBe(conditionOrchestration(source, ON));
    });

    it("keeps every pre-change sentence verbatim and leaves no marker behind", () => {
      const out = conditionOrchestration(source, ABSENT);
      for (const snippet of snippets) expect(out).toContain(snippet);
      expect(out).not.toContain("navori:if");
    });

    it("with the key off, asks for no progress file", () => {
      const out = conditionOrchestration(source, OFF);
      expect(out).not.toMatch(PROGRESS_MENTION);
      expect(out).not.toContain("navori:if");
    });
  });

  describe("session-start-context.sh", () => {
    const hook = read("core-assets/hooks/session-start-context.sh");

    it("with the key absent, interpolates the exact pre-change loop and sentence", () => {
      const out = interpolate(hook, ABSENT);
      expect(out).toContain(
        'for f in "progress/current.md" ".claude/progress/current.md" ".codex/progress/current.md"; do',
      );
      expect(out).toContain(
        'guarda el resumen con tu herramienta de memoria y/o anota en progress/current.md las decisiones y los bugs con causa raíz de esta sesión."',
      );
    });

    it("never renders a blank value as <not configured> in either state", () => {
      for (const config of [ABSENT, ON, OFF]) {
        const out = interpolate(hook, config);
        expect(out).not.toContain("<not configured: navori.progressFiles>");
        expect(out).not.toContain("<not configured: navori.compactSummaryTail>");
      }
    });

    it("with the key off, loops over an empty quoted word and drops the file pointer", () => {
      const out = interpolate(hook, OFF);
      expect(out).toContain('for f in ""; do');
      expect(out).not.toContain("anota en progress/current.md");
    });
  });
});
