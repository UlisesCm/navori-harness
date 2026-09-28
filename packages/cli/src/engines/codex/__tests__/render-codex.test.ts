import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../index.ts";
import { adaptHarnessTextForCodex } from "../compat.ts";
import { resolveCodexHooks } from "../hook-registrations.ts";
import { buildCodexConfigToml } from "../build-config-toml.ts";
import { codexHookHash } from "../../../lib/codex/trust.ts";
import { PluginManifestSchema, type LoadedPlugin } from "../../../lib/config/plugins.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codex-"));
}

/**
 * Every PROSE surface a Codex render pushes through `adaptHarnessTextForCodex`:
 * `AGENTS.md`, one TOML per agent, one `SKILL.md` per skill. Hooks are shell
 * scripts, not prose, and the adapter never sees them.
 */
function proseSurfaces(cwd: string): string[] {
  return [
    join(cwd, "AGENTS.md"),
    ...readdirSync(join(cwd, ".codex/agents")).map((f) => join(cwd, ".codex/agents", f)),
    ...readdirSync(join(cwd, ".agents/skills")).map((d) =>
      join(cwd, ".agents/skills", d, "SKILL.md"),
    ),
  ];
}

/** Overrides are merged BEFORE `parse`, so they are schema INPUT (every field
 * with a default is optional there) — not the fully-defaulted `NavoriConfig`. */
function config(overrides: Partial<NavoriConfigInput> = {}): NavoriConfig {
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

function testPlugin(id: string, capabilities: Record<string, unknown>): LoadedPlugin {
  return {
    manifest: PluginManifestSchema.parse({
      id,
      name: id,
      description: id,
      version: "1.0.0",
      ...capabilities,
    }),
    packageRoot: "",
    managedAssets: [],
    scriptAssets: [],
    skillAssets: [],
  };
}

describe("renderCodexEngine", () => {
  // Covers: R20
  it("warns that full access is not path isolation or universal approval", () => {
    const result = buildCodexConfigToml(config(), []);

    expect(result.warnings).toContainEqual(
      expect.stringContaining("sin aislamiento de archivos ni red"),
    );
    expect(result.warnings).toContainEqual(expect.stringContaining("on-request/user no exige"));
    expect(result.warnings).toContainEqual(expect.stringContaining("confianza del proyecto"));
    expect(result.warnings).toContainEqual(expect.stringContaining("únicamente Bash"));
    expect(result.warnings).toContainEqual(expect.stringContaining("apply_patch"));
    expect(result.warnings).not.toContainEqual(
      expect.stringContaining("guard-destructive conserva la defensa crítica"),
    );
  });

  // Covers: R19
  it("distinguishes CLI-only, MCP-only, and unconfigured plugins in Codex config", () => {
    const cliOnly = testPlugin("cli-only", {
      externalTool: { name: "Example", checkBinary: "example" },
    });
    const mcpOnly = testPlugin("mcp-only", { mcpServer: { command: "example-mcp", args: [] } });
    const neither = testPlugin("neither", {});
    const result = buildCodexConfigToml(config(), [cliOnly, mcpOnly, neither]);

    expect(result.body).not.toContain('[mcp_servers."cli-only"]');
    expect(result.body).toContain('[mcp_servers."mcp-only"]');
    expect(result.body).toContain('command = "example-mcp"');
    expect(result.body).not.toContain('[mcp_servers."neither"]');
    expect(result.warnings).not.toContainEqual(expect.stringContaining("cli-only"));
    expect(result.warnings).not.toContainEqual(expect.stringContaining("mcp-only"));
    expect(result.warnings).toContainEqual(expect.stringContaining("Plugin 'neither'"));
  });

  // Covers: R3, R4, R5, R6, R7
  it("registers the Astra-only SessionStart advisor without changing agent profiles", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());

    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf8");
    expect(toml).toContain("[[hooks.SessionStart]]");
    expect(toml).toMatch(/model-advisor\.sh\\" codex-session-start/);
    const hook = readFileSync(join(cwd, ".codex/hooks/model-advisor.sh"), "utf8");
    expect(hook).toContain('payload.model !== "gpt-6-astra"');
    expect(hook).toContain("eficiencia de tokens");
    expect(hook).toContain("`/model`");
    expect(hook).not.toContain("gpt-5.6-sol/high");
    // R9's effort guard lives inside the `claude-pre-tool-use` branch, and Codex
    // registers only `codex-session-start`, so the render carries it inert. An
    // effort variable in the environment must not reach this path: Codex does
    // not expose effort to hooks at all (R7).
    expect(toml).not.toContain("claude-pre-tool-use");
    expect(
      execFileSync("bash", [join(cwd, ".codex/hooks/model-advisor.sh"), "codex-session-start"], {
        cwd,
        input: JSON.stringify({ model: "gpt-6-astra" }),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_EFFORT: "medium" },
      }),
    ).toContain("Modelo recomendado disponible");
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf8")).toContain(
      'model_reasoning_effort = "high"',
    );
  });
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
    expect(existsSync(join(cwd, ".agents/skills/locate-code/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/agents/implementer.toml"))).toBe(true);
    expect(existsSync(join(cwd, ".codex/hooks/guard-destructive.sh"))).toBe(true);

    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    // Covers: R20 — the project default applies to inherited agents, while
    // approvals remain user-controlled rather than disabled or auto-reviewed.
    expect(toml).toContain('sandbox_mode = "danger-full-access"');
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('approvals_reviewer = "user"');
    expect(toml).not.toContain('approval_policy = "never"');
    expect(toml).not.toContain('approvals_reviewer = "auto_review"');
    expect(toml).not.toContain("[agents.");
    expect(toml).not.toContain("config_file");
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'name = "implementer"',
    );
    expect(toml).toContain('[mcp_servers."engram"]');
    expect(toml).toContain(
      'args = ["mcp", "--tools=mem_search,mem_get_observation,mem_context,mem_save,mem_session_summary,mem_update,mem_judge"]',
    );
    expect(toml).toContain("[[hooks.PreToolUse]]");
    expect(agentsMd).toContain("topic_key");
    // M6: Codex has no engram start hook, so the protocol makes the mem_context
    // startup call an explicit first step in-prose.
    expect(agentsMd).toContain("mem_context");

    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    // Spec 0035 D7: sonnet → gpt-6-sol (shared with opus; effort tells them apart).
    expect(implementer).toContain('model = "gpt-6-sol"');
    expect(implementer).toContain('model_reasoning_effort = "high"');
    expect(implementer).toContain("AGENTS.md");
    expect(implementer).not.toContain("CLAUDE.md");
    expect(implementer).not.toContain(".claude/progress");
    expect(existsSync(join(cwd, ".codex/agents/leader.toml"))).toBe(false);
    // #280: the auditor writes durable outputs, so a read-only override would
    // break its contract. No override is emitted: it inherits the project mode.
    expect(readFileSync(join(cwd, ".codex/agents/auditor.toml"), "utf-8")).not.toContain(
      "sandbox_mode",
    );
    expect(readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8")).not.toContain(
      "sandbox_mode",
    );
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).not.toContain(
      "sandbox_mode",
    );
  });

  // Covers: R3, R18 — spec 0035 T1/D9. Golden values: the 4 real
  // `trusted_hash` Codex 0.157 wrote for this repo's `.codex/config.toml`
  // (see the workplan/encargo). A change to the four pre-existing
  // registrations (command, matcher, timeout, statusMessage or their index)
  // moves this hash and silently un-approves the hook in every repo that
  // already ran `navori codex trust` — see hook-registrations.ts's ordering
  // contract.
  it("keeps the trusted_hash of the four pre-existing registrations", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ qualityGate: { fast: "pnpm test", full: "pnpm test" } }));
    const hookBase = `$(git rev-parse --show-toplevel)/.codex/hooks`;
    const commandFor = (hook: { script: string; args?: string }): string =>
      `bash "${hookBase}/${hook.script}.sh"${hook.args ? ` ${hook.args}` : ""}`;

    const resolved = resolveCodexHooks(
      config({ qualityGate: { fast: "pnpm test", full: "pnpm test" } }),
    );
    const byScript = (script: string) => {
      const hook = resolved.find((h) => h.script === script);
      if (!hook) throw new Error(`missing resolved hook: ${script}`);
      return hook;
    };

    expect(
      codexHookHash(byScript("guard-destructive"), commandFor(byScript("guard-destructive"))),
    ).toBe("sha256:9cbd61c21c0df4c1090ebbbd3d7e6d940843bd9043ed1ae8b8904cf12cef6ff5");
    expect(
      codexHookHash(
        byScript("comment-draft-confirm"),
        commandFor(byScript("comment-draft-confirm")),
      ),
    ).toBe("sha256:119086685199cae55d52a279dc2ff9bf426280651aefc7814d6cef21836469ee");
    expect(
      codexHookHash(
        byScript("quality-gate-pre-commit"),
        commandFor(byScript("quality-gate-pre-commit")),
      ),
    ).toBe("sha256:5c73b49f07866bd54d8676edae83f0c7e2ac69f020b7cb1ef92a61754fa9b377");
    expect(codexHookHash(byScript("model-advisor"), commandFor(byScript("model-advisor")))).toBe(
      "sha256:25446669b6ffb75c7f25a49d66273c95a9fb4445ed38ce0abb98b91a4fb548a9",
    );
  });

  // Covers: R1, R2
  it("registers session-start-context on SessionStart for all five sources", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain("session-start-context.sh");
    expect(toml).toContain('matcher = "startup|resume|clear|compact|fork"');
  });

  // Covers: R6, R7, R8
  it("omits deferred plan-gate while retaining the other Codex hooks", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ harness: { planTiers: true, scribeOwnsMarkdown: true } }));
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    const hooks = resolveCodexHooks(
      config({ harness: { planTiers: true, scribeOwnsMarkdown: true } }),
    );
    expect(hooks.some((entry) => entry.script === "plan-gate")).toBe(false);
    expect(toml).not.toContain("plan-gate.sh");
    for (const script of ["implementer-no-markdown", "routing-watch", "guard-destructive"]) {
      expect(hooks.some((entry) => entry.script === script)).toBe(true);
      expect(toml).toContain(`${script}.sh`);
    }
  });

  // Covers: R10, R13
  it("registers comment-draft-confirm as PreToolUse", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());

    expect(existsSync(join(cwd, ".codex/hooks/comment-draft-confirm.sh"))).toBe(true);
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain("comment-draft-confirm.sh");
    // Unconditional (R10): the same registration guard-destructive gets, not
    // the `config.qualityGate?.fast`-gated one — no plugin/config toggle owns it.
    const matches = toml.match(/\[\[hooks\.PreToolUse\]\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
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

    const surfaces = proseSurfaces(cwd);
    expect(surfaces.length).toBeGreaterThan(10);

    for (const file of surfaces) {
      // No exception left: #375 removed the commit-hygiene line that used to be
      // the only surface allowed to name `.claude/` under Codex.
      const body = readFileSync(file, "utf-8");
      expect({ file, hit: body.includes(".claude/") }).toEqual({ file, hit: false });
    }
  });

  it("appends an orchestrator-targeted plugin skill to AGENTS.md as a managed sub-block (#277)", () => {
    // engram's `engram-orchestrator-extension` injects into
    // `.claude/agents/orchestrator.md`. Codex embodies the orchestrator in the
    // main thread (no orchestrator.toml), so without the append the skill
    // vanished silently. It must land in AGENTS.md, marked as a managed
    // sub-block owned by the plugin so re-render is idempotent.
    const cwd = tempRepo();
    const result = renderCodexEngine(cwd, config());
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");

    // A phrase unique to the orchestrator extension.
    expect(agentsMd).toContain("Before decomposing");
    // Marked as a managed sub-block owned by the engram plugin.
    expect(agentsMd).toContain('id="engram-orchestrator-extension"');
    expect(agentsMd).toContain('source="@navori/plugin-engram"');
    // No warning: the append covers the orchestrator target.
    expect(result.warnings.some((w) => w.includes("engram-orchestrator-extension"))).toBe(false);

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
    expect(reviewer).toContain('model = "gpt-6-luna"');
  });

  // Covers: R11 — spec 0035 D7, user decision 2026-09-25.
  it("maps tiers to gpt-6 unless codexMap overrides", () => {
    const cwd = tempRepo();
    renderCodexEngine(
      cwd,
      config({ models: { orchestrator: "opus", implementer: "sonnet", reviewer: "haiku" } }),
    );
    // The orchestrator is embodied by the main thread (no orchestrator.toml);
    // implementer/reviewer are the two rendered agents this fixture assigns a
    // tier to.
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'model = "gpt-6-sol"', // sonnet
    );
    expect(readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8")).toContain(
      'model = "gpt-6-luna"', // haiku
    );
  });

  // Covers: R12 — spec 0035 D8. `buildCodexConfigToml` is exercised directly:
  // reliably pushing a REAL rendered AGENTS.md past 32768 bytes would need a
  // giant fixture, and the boundary itself is what R12 is about.
  describe("project_doc_max_bytes (D8)", () => {
    it("stays absent when the planned AGENTS.md is at or under 32768 bytes", () => {
      const atThreshold = buildCodexConfigToml(config(), [], "", 32768);
      const underThreshold = buildCodexConfigToml(config(), [], "", 100);
      expect(atThreshold.body).not.toContain("project_doc_max_bytes");
      expect(underThreshold.body).not.toContain("project_doc_max_bytes");
    });

    it("writes the next power of two >= size + 8192 once the plan exceeds 32768 bytes", () => {
      // 32769 + 8192 = 40961 → next power of two is 65536.
      const overThreshold = buildCodexConfigToml(config(), [], "", 32769);
      expect(overThreshold.body).toContain("project_doc_max_bytes = 65536");
    });

    it("the render itself omits it for this fixture's default-sized AGENTS.md", () => {
      const cwd = tempRepo();
      renderCodexEngine(cwd, config());
      expect(readFileSync(join(cwd, ".codex/config.toml"), "utf-8")).not.toContain(
        "project_doc_max_bytes",
      );
    });
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

describe("adaptHarnessTextForCodex — only mirrored dirs get retargeted (#428)", () => {
  // The blanket `.claude/` → `.codex/` catch-all this replaced invented paths no
  // render ever emits: only the Claude engine copies plugin scripts, so a prose
  // citation of `.claude/scripts/check-semgrep.sh` became a plausible-looking
  // `.codex/scripts/check-semgrep.sh` that cannot exist in any repo.
  it("leaves a plugin-script citation spelled `.claude/`, never `.codex/scripts/`", () => {
    const out = adaptHarnessTextForCodex(
      "Mirrors `.claude/scripts/check-semgrep.sh`, copied by the Claude engine.",
      config(),
    );

    expect(out).not.toContain(".codex/scripts/");
    expect(out).toContain(".claude/scripts/check-semgrep.sh");
  });

  it("does not resolve a segment that names an Object.prototype member", () => {
    // The lookup key is the first segment of an arbitrary citation. Held in an
    // object literal, `.claude/constructor` and `.claude/__proto__` resolved
    // through the prototype chain and substituted a Function's source text (or
    // `[object Object]`) into the rendered prose. A Map has no such chain.
    const out = adaptHarnessTextForCodex(
      "See `.claude/constructor` and `.claude/__proto__` and `.claude/toString`.",
      config(),
    );

    expect(out).toBe("See `.claude/constructor` and `.claude/__proto__` and `.claude/toString`.");
  });

  it("leaves any other unmirrored path alone instead of inventing a Codex twin", () => {
    // Codex's project config is `.codex/config.toml`, so `.codex/settings.json`
    // would be exactly the same class of invented path as `.codex/scripts/`.
    const out = adaptHarnessTextForCodex("Permissions live in `.claude/settings.json`.", config());

    expect(out).toBe("Permissions live in `.claude/settings.json`.");
  });

  it("still retargets every directory Codex does mirror", () => {
    const out = adaptHarnessTextForCodex(
      [
        "Run `.claude/hooks/guard-destructive.sh`.",
        "Agents live in `.claude/agents/` and skills in `.claude/skills`.",
        "Handoffs go to `.claude/progress/impl_x.md`.",
        "Run doctor if `.claude/` looks inconsistent.",
      ].join("\n"),
      config(),
    );

    expect(out).toContain(".codex/hooks/guard-destructive.sh");
    expect(out).toContain(".codex/agents/");
    // Codex reads skills from `.agents/skills`, NOT from its engine dir — the
    // bare (slash-less) spelling used to fall through to `.codex/skills`.
    expect(out).toContain(".agents/skills");
    expect(out).not.toContain(".codex/skills");
    expect(out).toContain(".codex/progress/impl_x.md");
    expect(out).toContain("if `.codex/` looks inconsistent");
    expect(out).not.toContain(".claude/");
  });
});

describe("adaptHarnessTextForCodex — the vocabulary rules (#443)", () => {
  /**
   * End-to-end evidence that the two rewritten rules land on the orchestration
   * block. `vocabulary-alive.test.ts` owns the general "no rule may go dead"
   * guard; this pins the two sentences #443 reported, in the artifact a Codex
   * repo actually reads.
   */
  it("names Codex's tool and Codex itself in the rendered orchestration prose", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ language: "en" }));
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");

    expect(agentsMd).toContain("do not invoke `spawn_agent(orchestrator)`");
    expect(agentsMd).not.toContain("Agent(subagent_type: orchestrator)");
    // The harness of a Codex repo must not explain Claude's behaviour as if it
    // were its own; the instruction the clause qualifies is unchanged.
    expect(agentsMd).toContain("Codex serializes by default");
    expect(agentsMd).not.toContain("Claude serializes by default");
  });

  /**
   * The complement: the adapter must not author prose. `Agent(subagent_type:
   * leader)` → `un subagente \`leader\`` translated the phrase around the term,
   * so every Codex render carried that Spanish fragment inside an otherwise
   * English `AGENTS.md`, and `language: "en"` could not turn it off because the
   * rule never consulted the config. Which language a block is served in belongs
   * to the asset layer (`resolveAssetPath` + `baseLanguage`), not here.
   *
   * Pinned as the EXACT fragment the old rule emitted, not a looser "no Spanish"
   * sweep: an `es` render legitimately carries Spanish (`idioma-rol` and
   * `formato-respuesta` are Spanish-authored blocks), so a broad match would go
   * red on an unrelated asset edit. Both languages are checked because the
   * injection was invisible to `language` in the first place.
   */
  it("authors none of the Spanish it used to inject, at any language", () => {
    for (const language of ["es", "en"] as const) {
      const cwd = tempRepo();
      renderCodexEngine(cwd, config({ language }));
      for (const file of proseSurfaces(cwd)) {
        const hit = readFileSync(file, "utf-8").includes("un subagente `leader`");
        expect({ file, language, hit }).toEqual({ file, language, hit: false });
      }
    }
  });

  it("rewrites the orchestrator citation's TERM and leaves the sentence around it", () => {
    const out = adaptHarnessTextForCodex(
      "**NEVER delegate it**: do not invoke `Agent(subagent_type: orchestrator)`. `.claude/agents/orchestrator.md` is a depth reference.",
      config({ language: "en" }),
    );

    expect(out).toBe(
      "**NEVER delegate it**: do not invoke `spawn_agent(orchestrator)`. `AGENTS.md` is a depth reference.",
    );
  });

  /**
   * Pins the deliberate NON-rule documented in `compat.ts`. The dead `"En Claude
   * Code" → "En Codex"` rule was aimed at this sentence, and reviving it as
   * `"On Claude" → "On Codex"` would claim a session-start hook Codex does not
   * register (`build-config-toml.ts` emits only `[[hooks.PreToolUse]]`) and
   * swallow the "Otherwise" branch, which is the instruction Codex must follow.
   */
  it("leaves the engine-conditional session-start sentence verbatim", () => {
    const input =
      "On Claude, a `SessionStart` hook injects the live context at the top of the session; read it to resume. Otherwise, read `progress/current.md` yourself.";

    expect(adaptHarnessTextForCodex(input, config({ language: "en" }))).toBe(input);
  });

  // #823 — Codex has no `/` slash commands; a manual-only skill is invoked
  // with `$<skill>` (https://developers.openai.com/codex/skills).
  it("rewrites the /spec-bootstrap citation to $spec-bootstrap", () => {
    expect(adaptHarnessTextForCodex("ask the user to run `/spec-bootstrap`.", config())).toBe(
      "ask the user to run `$spec-bootstrap`.",
    );
  });
});

/**
 * #892 dropped `disable-model-invocation` from `spec-bootstrap.md` — the only
 * asset in the whole catalog that ever declared it, and the fixture the
 * manual-only sidecar tests below relied on. No real skill triggers this
 * Codex mechanism anymore (kept as a general engine capability per #892's
 * decision), so these tests now build a SYNTHETIC skill via a local preset
 * (`.navori/presets/<id>/<id>.json`, resolved local-first by `loadPreset`)
 * that still declares the flag, purely to keep the sidecar generation/pruning
 * logic covered.
 */
function manualOnlyPresetConfig(cwd: string): NavoriConfig {
  const presetId = "manual-only-fixture";
  const presetDir = join(cwd, ".navori/presets", presetId);
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(
    join(presetDir, "manual-only-demo.md"),
    "---\nname: manual-only-demo\ndescription: Use when testing the manual-only sidecar.\ndisable-model-invocation: true\nmetadata:\n  type: reference\n---\n\n# manual-only-demo\n\nSynthetic fixture skill, not shipped to any real repo.\n",
  );
  writeFileSync(
    join(presetDir, `${presetId}.json`),
    JSON.stringify({
      id: presetId,
      displayName: "Manual-only fixture",
      extends: "core",
      extras: {
        skills: [
          {
            id: "manual-only-demo",
            relPath: "manual-only-demo.md",
            destRelPath: "skills/manual-only-demo.md",
          },
        ],
      },
    }),
  );
  return config({ preset: presetId });
}

describe("renderCodexEngine — manual-only skill sidecar (#823)", () => {
  it("does not copy disable-model-invocation into the rendered SKILL.md", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, manualOnlyPresetConfig(cwd));
    const skill = readFileSync(join(cwd, ".agents/skills/manual-only-demo/SKILL.md"), "utf-8");
    expect(skill).not.toContain("disable-model-invocation");
  });

  it("emits agents/openai.yaml for a flagged skill", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, manualOnlyPresetConfig(cwd));
    const yaml = readFileSync(
      join(cwd, ".agents/skills/manual-only-demo/agents/openai.yaml"),
      "utf-8",
    );
    expect(yaml).toContain("policy:");
    expect(yaml).toContain("allow_implicit_invocation: false");
  });

  it("does not emit agents/openai.yaml for an unflagged skill", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, manualOnlyPresetConfig(cwd));
    // locate-code has no disable-model-invocation in its source frontmatter.
    expect(existsSync(join(cwd, ".agents/skills/locate-code/agents/openai.yaml"))).toBe(false);
  });

  it("uses Codex's $ invocation, not the slash form, in AGENTS.md", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("$spec-bootstrap");
    expect(agentsMd).not.toContain("/spec-bootstrap");
  });

  it("prunes a stale openai.yaml once the skill stops declaring disable-model-invocation", () => {
    const cwd = tempRepo();
    const withFlag = manualOnlyPresetConfig(cwd);
    renderCodexEngine(cwd, withFlag);
    const yamlPath = join(cwd, ".agents/skills/manual-only-demo/agents/openai.yaml");
    expect(existsSync(yamlPath)).toBe(true);

    // Simulate the flag being dropped between renders by removing the skill
    // from the plan entirely (switching back to the flag-free "custom"
    // preset) — the orphan scan re-reads each skill's own frontmatter, so it
    // must prune BOTH the stale SKILL.md and the now-orphaned sidecar.
    renderCodexEngine(cwd, config());

    expect(existsSync(yamlPath)).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/manual-only-demo/SKILL.md"))).toBe(false);
  });
});

describe("renderCodexEngine — plugin skill extension, jscpdThreshold retired (#1060)", () => {
  it("review-diff/SKILL.md carries no raw placeholder and no --threshold", () => {
    const cwd = tempRepo();
    renderCodexEngine(
      cwd,
      config({ preset: "vite-react-ts", plugins: { jscpd: { enabled: true } } }),
    );
    const skill = readFileSync(join(cwd, ".agents/skills/review-diff/SKILL.md"), "utf-8");
    expect(skill).not.toContain("<not configured: jscpdThreshold>");
    expect(skill).not.toContain("--threshold");
    expect(skill).toContain("--baseline-from-ref");
    expect(skill).toContain("--fail-on-new-clones 0");
  });
});
