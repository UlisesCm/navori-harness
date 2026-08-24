import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { renderCodexEngine } from "../index.ts";
import { adaptHarnessTextForCodex } from "../compat.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codex-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "codex-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    models: { implementer: "sonnet", reviewer: "haiku" },
    effort: { implementer: "high", reviewer: "medium" },
    ...overrides,
  });
}

describe("renderCodexEngine", () => {
  it("creates a full Codex harness using the v0.145 project paths", () => {
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config());

    expect(result.written.length).toBeGreaterThan(10);
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("orchestrat");
    expect(agentsMd).toContain("## Agentes disponibles"); // es is the default language (#289)
    expect(agentsMd).toContain("`spawn_agent`");
    // #209 + #375: the commit-hygiene line USED to be the one literal `CLAUDE.md`
    // mention Codex kept (it named what not to commit). `gitignoreHarness` owns
    // that rule now and the line is gone, so the retarget must be total.
    expect(agentsMd).not.toContain("CLAUDE.md");
    expect(agentsMd).not.toContain(".claude/agents");
    // #208: ephemeral inter-agent handoffs live in the engine dir, kept apart from
    // the git-persisted session-state dir (`progress/current.md`).
    expect(agentsMd).toContain(".codex/progress/");
    expect(agentsMd).not.toContain(".claude/progress");
    expect(existsSync(join(cwd, ".agents/skills/verify-before-done/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".agents/skills/structural-search/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/hooks/guard-destructive.sh"))).toBe(true);

    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).not.toContain("[agents.");
    expect(toml).not.toContain("config_file");
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'name = "implementer"',
    );
    expect(toml).toContain('[mcp_servers."engram"]');
    expect(toml).toContain('args = ["mcp", "--tools=agent"]');
    expect(toml).toContain("[[hooks.PreToolUse]]");
    expect(agentsMd).toContain("topic_key");
    // M6: Codex has no engram start hook, so the protocol makes the mem_context
    // startup call an explicit first step in-prose.
    expect(agentsMd).toContain("mem_context");

    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    expect(implementer).toContain('model = "gpt-5.6-terra"');
    expect(implementer).toContain('model_reasoning_effort = "high"');
    expect(implementer).toContain("AGENTS.md");
    expect(implementer).not.toContain("CLAUDE.md");
    expect(implementer).not.toContain(".claude/progress");
    expect(existsSync(join(cwd, ".codex/agents/leader.toml"))).toBe(false);
    // #280: the auditor is workspace-write like the reviewer/researcher/explorer/
    // ticket-audit roles — it writes its durable outputs (audit_deep/plan/SDD drafts)
    // to disk, so a read-only sandbox would break its contract. "never edits code" is
    // enforced by its prose contract + tool set, not the sandbox → no override emitted.
    expect(readFileSync(join(cwd, ".codex/agents/auditor.toml"), "utf-8")).not.toContain(
      "sandbox_mode",
    );
    expect(readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8")).not.toContain(
      "sandbox_mode",
    );
  });

  /**
   * Anti-drift gate (#364). Four findings in a row had the same shape: a feature
   * is wired for Claude and the Codex path arrives late, so an asset ships with
   * a `.claude/…` path the Codex agents cannot reach. Asserting file by file
   * only pins the assets someone remembered; this sweeps every PROSE surface the
   * adapter owns, so a NEW asset that skips it fails here instead of in a repo.
   *
   * Hooks are deliberately out of scope: `placeHook` does not retarget paths
   * either, but a shell script is not prose and fixing it is its own unit.
   */
  it("emits no unreachable `.claude/` path in any adapted prose surface (#364)", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());

    const surfaces = [
      join(cwd, "AGENTS.md"),
      ...readdirSync(join(cwd, ".codex/agents")).map((f) => join(cwd, ".codex/agents", f)),
      ...readdirSync(join(cwd, ".agents/skills")).map((d) =>
        join(cwd, ".agents/skills", d, "SKILL.md"),
      ),
    ];
    expect(surfaces.length).toBeGreaterThan(10);

    for (const file of surfaces) {
      // No exception left: #375 removed the commit-hygiene line that used to be
      // the only surface allowed to name `.claude/` under Codex.
      const body = readFileSync(file, "utf-8");
      expect({ file, hit: body.includes(".claude/") }).toEqual({ file, hit: false });
    }
  });

  it("appends a leader-targeted plugin skill to AGENTS.md as a managed sub-block (#277)", () => {
    // engram's `engram-leader-extension` injects into `.claude/agents/leader.md`.
    // Codex embodies the leader in the main thread (no leader.toml), so without the
    // append the skill vanished silently. It must land in AGENTS.md, marked as a
    // managed sub-block owned by the plugin so re-render is idempotent.
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config());
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");

    // A phrase unique to the leader extension (absent from the base engram protocol).
    expect(agentsMd).toContain("decomposing work");
    // Marked as a managed sub-block owned by the engram plugin.
    expect(agentsMd).toContain('id="engram-leader-extension"');
    expect(agentsMd).toContain('source="@navori/plugin-engram"');
    // No warning: the append covers the leader target.
    expect(result.warnings.some((w) => w.includes("engram-leader-extension"))).toBe(false);

    // Re-render is byte-idempotent — the sub-block does not accrete.
    const before = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    const rerender = renderCodexEngine(cwd, config());
    expect(rerender.written).toEqual([]);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(before);
  });

  it("points the workspace config.toml hook command at the workspace's own hooks (#279)", () => {
    // In a monorepo the hooks are written per workspace (apps/backend/.codex/hooks),
    // but `git rev-parse --show-toplevel` resolves to the repo root. The command must
    // interpolate the workspace subpath so it targets the co-located hook, not the
    // root's.
    const repoRoot = tempRepo();
    const wsCwd = join(repoRoot, "apps/backend");
    mkdirSync(wsCwd, { recursive: true });
    renderCodexEngine(
      wsCwd,
      config({ qualityGate: { fast: "pnpm -F backend test", full: "pnpm -F backend test" } }),
      { repoRoot },
    );

    const toml = readFileSync(join(wsCwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain(
      "$(git rev-parse --show-toplevel)/apps/backend/.codex/hooks/guard-destructive.sh",
    );
    expect(toml).toContain(
      "$(git rev-parse --show-toplevel)/apps/backend/.codex/hooks/quality-gate-pre-commit.sh",
    );
    // The bare toplevel path (root's hook) must not appear for these commands.
    expect(toml).not.toContain("$(git rev-parse --show-toplevel)/.codex/hooks/");

    // At the repo root the path stays bare (subpath is empty).
    const rootRepo = tempRepo();
    renderCodexEngine(rootRepo, config());
    const rootToml = readFileSync(join(rootRepo, ".codex/config.toml"), "utf-8");
    expect(rootToml).toContain(
      "$(git rev-parse --show-toplevel)/.codex/hooks/guard-destructive.sh",
    );
  });

  it("localizes the '## Available agents' heading via config.language (#289)", () => {
    // Codex shares the Claude engine's localized heading; the descriptions stay
    // Codex's own (each agent's frontmatter), only the heading is now i18n.
    const esRepo = tempRepo();
    renderCodexEngine(esRepo, config());
    expect(readFileSync(join(esRepo, "AGENTS.md"), "utf-8")).toContain("## Agentes disponibles");

    const enRepo = tempRepo();
    renderCodexEngine(enRepo, config({ language: "en" }));
    const enMd = readFileSync(join(enRepo, "AGENTS.md"), "utf-8");
    expect(enMd).toContain("## Available agents");
    expect(enMd).not.toContain("## Agentes disponibles");
  });

  it("models.codexMap overrides the built-in tier→model map, tier by tier (M3)", () => {
    const cwd = tempRepo();
    // implementer=sonnet, reviewer=haiku (from config()); override only sonnet.
    renderCodexEngine(
      cwd,
      config({
        models: { implementer: "sonnet", reviewer: "haiku", codexMap: { sonnet: "gpt-6-custom" } },
      }),
    );
    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    expect(implementer).toContain('model = "gpt-6-custom"');
    // haiku has no override → falls back to the built-in default.
    const reviewer = readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8");
    expect(reviewer).toContain('model = "gpt-5.6-luna"');
  });

  it("is byte-idempotent and preserves user-owned config/guidance", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const agentsPath = join(cwd, "AGENTS.md");
    const configPath = join(cwd, ".codex/config.toml");
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf-8")}\n## Mi dominio\nNo borrar.\n`);
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf-8")}\nmodel = "custom-user-model"\n`,
    );

    const beforeAgents = readFileSync(agentsPath, "utf-8");
    const beforeConfig = readFileSync(configPath, "utf-8");
    const result = renderCodexEngine(cwd, config());

    expect(result.written).toEqual([]);
    expect(readFileSync(agentsPath, "utf-8")).toBe(beforeAgents);
    expect(readFileSync(configPath, "utf-8")).toBe(beforeConfig);
  });

  it("dry-run reports files without writing them", () => {
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config(), { dryRun: true });
    expect(result.written.some(({ path }) => path === "AGENTS.md")).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });

  it("reconciles disabled managed agents, skills, and hooks without deleting user or newer files", () => {
    const cwd = tempRepo();
    renderCodexEngine(
      cwd,
      config({
        project: { libraries: ["zod-validation"] },
      }),
    );

    const userAgent = join(cwd, ".codex/agents/my-agent.toml");
    writeFileSync(userAgent, 'name = "my-agent"\n');
    const newerReviewer = join(cwd, ".codex/agents/reviewer.toml");
    writeFileSync(
      newerReviewer,
      readFileSync(newerReviewer, "utf-8").replace(/version="[^"]+"/, 'version="99.0.0"'),
    );
    const userSkillDir = join(cwd, ".agents/skills/my-skill");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(join(userSkillDir, "SKILL.md"), "# My skill\n");

    const reduced = config({
      harness: { implementer: false, reviewer: false },
      qualityGate: undefined,
      project: { libraries: [] },
    });
    const preview = renderCodexEngine(cwd, reduced, { dryRun: true });

    expect(
      preview.written.some(
        ({ path, status }) =>
          path === ".codex/agents/implementer.toml" && status === "removed-condition-false",
      ),
    ).toBe(true);
    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(true);

    renderCodexEngine(cwd, reduced);

    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/zod-validation"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/hooks/quality-gate-pre-commit.sh"))).toBe(false);
    expect(existsSync(newerReviewer)).toBe(true);
    expect(existsSync(userAgent)).toBe(true);
    expect(existsSync(join(userSkillDir, "SKILL.md"))).toBe(true);
  });
});

describe("adaptHarnessTextForCodex — the commit-hygiene shield (#209)", () => {
  // #375 deleted the phrase from the core assets, so nothing navori ships hits
  // this path any more — but the adapter also rewrites USER-ZONE prose, and a
  // user who wrote the line by hand must not be told to stop committing their
  // own AGENTS.md. These cases are now the only thing pinning the sentinel:
  // they also prove it still round-trips after #375 rewrote its raw NUL
  // delimiters as escape sequences (same runtime value, grep-able source).
  it("keeps a user-written line literal while retargeting everything around it", () => {
    const input = [
      "- Never commit `.claude/` or `CLAUDE.md` in this repo.",
      "- Apply `.claude/skills/review-diff/SKILL.md` and write `.claude/progress/review.md`.",
    ].join("\n");

    const out = adaptHarnessTextForCodex(input, config());

    expect(out).toContain("Never commit `.claude/` or `CLAUDE.md`");
    expect(out).toContain(".agents/skills/review-diff/SKILL.md");
    expect(out).toContain(".codex/progress/review.md");
    // The sentinel is an internal marker: it must be fully restored, never
    // emitted. A leaked U+0000 would make the OUTPUT binary to git/grep too.
    expect(out).not.toContain("\u0000");
  });

  it("emits no sentinel residue for text that never had the phrase", () => {
    const out = adaptHarnessTextForCodex("Read `CLAUDE.md` before touching `.claude/`.", config());
    expect(out).toBe("Read `AGENTS.md` before touching `.codex/`.");
    expect(out).not.toContain("\u0000");
    expect(out).not.toContain("navori:never-commit");
  });
});
