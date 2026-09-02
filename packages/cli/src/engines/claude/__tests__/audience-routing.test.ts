import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { CORE_MANAGED_ASSETS } from "../../../lib/render-plan.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * Spec 0015 (#573) — doctrine addressed to the orchestrator leaves the file
 * every subagent receives.
 *
 * `CLAUDE.md` travels to every non-fork subagent ("every level of the CLAUDE.md
 * hierarchy the main conversation loads"), and `orquestacion` is 73 lines
 * written in the second person to the main agent: routes, thresholds, how to
 * fan out `Agent` calls. No subagent declares the `Agent` tool, so none of them
 * could act on a word of it — and each paid ~3.1k tokens for it at startup,
 * ~60k across the 19 of a measured session.
 *
 * The channel is not new: the global layer has emitted the same block as
 * SessionStart `additionalContext` since spec 0010 FB (#546). What these specs
 * pin is that the repo scope now does the same, and that the block is still a
 * managed file rather than text smuggled into a script.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-audience-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const claudeMd = (): string => readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
const contextFile = (id: string): string =>
  readFileSync(join(cwd, ".claude", "context", `${id}.md`), "utf-8");

describe("a block addressed to the orchestrator leaves CLAUDE.md (#573)", () => {
  it("declares the blocks only the session owner can act on", () => {
    // Anti-vacuity: if the mark disappears from the table, every assertion
    // below still passes while testing nothing. The set is the routing doctrine
    // plus the two session ceremonies (#572) — the agents index rides the same
    // channel but is computed, so it is not in this table.
    const marked = CORE_MANAGED_ASSETS.filter((a) => a.audience === "orchestrator");
    expect(marked.map((a) => a.id).sort()).toEqual([
      "arranque-sesion",
      "cierre-sesion",
      "orquestacion",
    ]);
  });

  it("renders it to .claude/context/ and not into CLAUDE.md", () => {
    renderClaudeEngine(cwd, CONFIG);
    expect(claudeMd()).not.toContain('id="orquestacion"');
    expect(contextFile("orquestacion")).toContain("## Role: orchestrator");
  });

  it("keeps it a managed file: marker, id, version and source", () => {
    renderClaudeEngine(cwd, CONFIG);
    const file = contextFile("orquestacion");
    // Same notation as an agent file, so `sync`, the drift scan and the prune
    // treat it identically — the reason it is a file and not text inside the
    // hook script.
    expect(file).toMatch(/^<!-- navori:managed id="orquestacion" hash="[0-9a-f]+" version="/);
    expect(file).toContain('source="@navori/core"');
    expect(file.trimEnd()).toMatch(/<!-- \/navori:managed id="orquestacion" -->$/);
  });

  it("interpolates the repo's config, so no placeholder reaches the agent", () => {
    renderClaudeEngine(cwd, CONFIG);
    const file = contextFile("orquestacion");
    expect(file).toContain("pnpm typecheck");
    expect(file).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("is idempotent: a second render reports no change", () => {
    renderClaudeEngine(cwd, CONFIG);
    const second = renderClaudeEngine(cwd, CONFIG);
    const write = second.written.find((w) => w.path.endsWith("context/orquestacion.md"));
    expect(write).toBeUndefined();
  });
});

describe("a repo rendered by an earlier navori migrates on the next render (#573)", () => {
  it("strips the block from CLAUDE.md and keeps the user's own prose", () => {
    // The shape a real repo is in before the move: the block inside CLAUDE.md,
    // with the user's section around it.
    renderClaudeEngine(cwd, CONFIG);
    const withBlock = `${readFileSync(join(cwd, ".claude", "context", "orquestacion.md"), "utf-8")}\n`;
    const before = claudeMd();
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      `${before}\n## Mis notas\n\nEsto lo escribí yo.\n\n${withBlock}`,
      "utf-8",
    );
    rmSync(join(cwd, ".claude", "context"), { recursive: true, force: true });

    renderClaudeEngine(cwd, CONFIG);

    expect(claudeMd()).not.toContain('id="orquestacion"');
    expect(claudeMd()).toContain("Esto lo escribí yo.");
    expect(existsSync(join(cwd, ".claude", "context", "orquestacion.md"))).toBe(true);
  });
});

describe("the block still answers to blocks.exclude (#573)", () => {
  it("renders nowhere when the repo opted it out", () => {
    const excluded = {
      ...CONFIG,
      blocks: { exclude: ["orquestacion"] },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, excluded);
    expect(claudeMd()).not.toContain('id="orquestacion"');
    expect(existsSync(join(cwd, ".claude", "context", "orquestacion.md"))).toBe(false);
  });

  it("removes an already-rendered context file when the exclusion lands later", () => {
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(join(cwd, ".claude", "context", "orquestacion.md"))).toBe(true);

    const excluded = {
      ...CONFIG,
      blocks: { exclude: ["orquestacion"] },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, excluded);
    // Opting out has to reach the new channel too, or the doctrine keeps being
    // delivered by a file nobody remembers exists.
    const file = join(cwd, ".claude", "context", "orquestacion.md");
    expect(existsSync(file) && readFileSync(file, "utf-8").includes("Role: orchestrator")).toBe(
      false,
    );
  });
});

describe("the directory is only ever read by the hook (#573)", () => {
  it("is not `.claude/rules/`, which would travel to subagents again", () => {
    renderClaudeEngine(cwd, CONFIG);
    // A rule without `paths:` loads in every session AND reaches subagents as
    // part of the CLAUDE.md hierarchy — the exact cost this routing removes.
    expect(existsSync(join(cwd, ".claude", "rules"))).toBe(false);
    expect(existsSync(join(cwd, ".claude", "context"))).toBe(true);
  });

  it("the SessionStart hook reads the directory it renders into", () => {
    renderClaudeEngine(cwd, CONFIG);
    const hook = readFileSync(join(cwd, ".claude", "hooks", "session-start-context.sh"), "utf-8");
    expect(hook).toContain(".claude/context");
    // Empty dir under zsh is a hard abort without this (#391).
    expect(hook).toContain("NULL_GLOB");
  });

  it("names EVERY engine's context dir, because the body is copied verbatim", () => {
    // `placeHook` copies this script per engine without retargeting its paths —
    // the same reason the progress loop right above it lists three directories.
    // A hook that knew only `.claude/` would be a dead branch under `.codex/`
    // the day a block routes there, and nothing would report the silence.
    renderClaudeEngine(cwd, CONFIG);
    const hook = readFileSync(join(cwd, ".claude", "hooks", "session-start-context.sh"), "utf-8");
    for (const dir of [".claude/context", ".codex/context"]) {
      expect(hook).toContain(dir);
    }
  });
});
