import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../../lib/config/schema.ts";
import { codexInstalledScripts, renderCodexEngine } from "../index.ts";
import { loadEnabledPlugins } from "../../../lib/config/plugins.ts";
import { renderClaudeEngine } from "../../claude/index.ts";
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
    join(cwd, ".codex/orchestrator.md"),
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
  it.each([false, true])("ships the master skills to Codex with masterPlan=%s", (enabled) => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ harness: { masterPlan: enabled } }));
    expect(existsSync(join(cwd, ".agents/skills/master-plan/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".agents/skills/context-intake/SKILL.md"))).toBe(true);
    const index = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(index).toContain("- `master-plan` —");
    expect(index).toContain("- `context-intake` —");
  });

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
    // R9's effort guard lives inside the `claude-stop` branch, and Codex
    // registers only `codex-session-start`, so the render carries it inert. An
    // effort variable in the environment must not reach this path: Codex does
    // not expose effort to hooks at all (R7).
    // Covers: R27 — Codex keeps its own registration; the Claude Stop mode is never wired.
    expect(toml).not.toContain("claude-stop");
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
    // Covers: R1, R9, R12 — both engines cite the same runtime root, separate
    // from versioned `progress/current.md`.
    expect(agentsMd).toContain(".navori/state/handoffs/");
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
    expect(implementer).toContain(".navori/state/handoffs/");
    // Covers: R41 — `maxTurns` is Claude-only; the Codex TOML is built from an explicit key list.
    expect(implementer).not.toMatch(/maxTurns|max_turns/i);
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

  // Covers: R7, R18, R23
  it("renders the full orchestrator playbook as a managed reference, not an agent or always-on copy", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const referencePath = join(cwd, ".codex/orchestrator.md");
    const reference = readFileSync(referencePath, "utf-8");
    const alwaysOn = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    const headings = [
      "Startup protocol",
      "How to decompose work",
      "How to launch in parallel",
      "Frugal delegation",
      "Continuous execution",
      "Anti-broken-telephone rule",
      "Closing the cycle",
      "Second opinion",
      "Reclaim the worktree",
    ];
    for (const heading of headings) {
      expect(reference).toContain(heading);
    }
    expect(reference).toContain('id="orchestrator-codex-base"');
    expect(reference).toContain("(../AGENTS.md)");
    expect(reference).not.toContain("(../../AGENTS.md)");
    expect(reference).not.toContain("`.codex/orchestrator.md` is a depth reference");
    expect(reference).not.toMatch(/^---\nname: orchestrator/m);
    expect(reference).not.toContain("SessionStart` hook delivers");
    expect(alwaysOn).toContain("`.codex/orchestrator.md` is a depth reference");
    expect(alwaysOn).not.toContain("## Anti-broken-telephone rule");
    expect(alwaysOn).toContain('id="engram-orchestrator-extension"');
    expect(reference).not.toContain('id="engram-orchestrator-extension"');
    expect(Buffer.byteLength(alwaysOn)).toBeLessThan(32_768);
    expect(reference.trim().split(/\s+/).length).toBeLessThanOrEqual(3050);
    expect(existsSync(join(cwd, ".codex/agents/orchestrator.toml"))).toBe(false);
    const before = reference;
    const rerender = renderCodexEngine(cwd, config());
    expect(rerender.written).toEqual([]);
    expect(readFileSync(referencePath, "utf-8")).toBe(before);
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

  it("renders the Codex output discriminator only for Stop and SubagentStop advisories", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ hooks: { verifyOnStop: true } }));
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toMatch(/subagent-stop-handoff\.sh\\" codex/);
    expect(toml).toMatch(/stop-verify-reminder\.sh\\" codex/);
    const hooks = resolveCodexHooks(config({ hooks: { verifyOnStop: true } }));
    expect(hooks.filter((hook) => hook.args === "codex").map((hook) => hook.script)).toEqual([
      "subagent-stop-handoff",
      "stop-verify-reminder",
    ]);
  });

  // Covers: R1, R9, R12
  it("renders the same neutral handoff root and shared parser for both engines", () => {
    const cwd = tempRepo();
    const both = config({ engines: ["claude", "codex"] });
    renderClaudeEngine(cwd, both);
    renderCodexEngine(cwd, both);
    const claude = readFileSync(join(cwd, ".claude/context/10-orquestacion.md"), "utf-8");
    const codex = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    const claudeHook = readFileSync(join(cwd, ".claude/hooks/subagent-stop-handoff.sh"), "utf-8");
    const codexHook = readFileSync(join(cwd, ".codex/hooks/subagent-stop-handoff.sh"), "utf-8");
    for (const prose of [claude, codex]) {
      expect(prose).toContain(".navori/state/handoffs/");
    }
    for (const hook of [claudeHook, codexHook]) {
      expect(hook).toContain('".navori/state/handoffs"');
      expect(hook.match(/payload=\$\{payload-\$\(cat\)\}/g)).toHaveLength(1);
      expect(hook).not.toContain("navori_field() {");
    }
    expect(readFileSync(join(cwd, ".codex/config.toml"), "utf-8")).toContain(
      "subagent-stop-handoff.sh",
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

  // Covers: R6, R7, R8, R9
  it("registers plan-gate as the last late row and keeps existing PreToolUse trust positions in both scribe modes", () => {
    for (const scribeOwnsMarkdown of [false, true]) {
      const cwd = tempRepo();
      const cfg = config({ harness: { planTiers: true, scribeOwnsMarkdown } });
      renderCodexEngine(cwd, cfg);
      const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
      const hooks = resolveCodexHooks(cfg);
      expect(hooks.some((entry) => entry.script === "plan-gate")).toBe(true);
      expect(toml).toContain("plan-gate.sh");
      const preTool = hooks.filter((entry) => entry.event === "PreToolUse");
      expect(preTool.map((entry) => entry.script)).toEqual(
        scribeOwnsMarkdown
          ? [
              "guard-destructive",
              "comment-draft-confirm",
              "quality-gate-pre-commit",
              "implementer-no-markdown",
              "role-guard",
              "pr-publisher-confirm",
              "general-purpose-confirm",
              "plan-gate",
              "engram-write-guard",
            ]
          : [
              "guard-destructive",
              "comment-draft-confirm",
              "quality-gate-pre-commit",
              "role-guard",
              "pr-publisher-confirm",
              "general-purpose-confirm",
              "plan-gate",
              "engram-write-guard",
            ],
      );
      // B1: engram-write-guard trails plan-gate so no published trust index moves.
      expect(preTool.at(-2)?.matcher).toBe("spawn_agent$");
      expect(preTool.at(-1)?.matcher).toBe("mcp__engram__|mcp__plugin_engram_engram__");
      expect(toml.includes("implementer-no-markdown.sh")).toBe(scribeOwnsMarkdown);
      expect(toml).toContain("routing-watch.sh");
    }
  });

  // Covers: R9, R10
  it("toggling harness.planTiers never moves the PreToolUse index of the confirmation hooks", () => {
    for (const scribeOwnsMarkdown of [false, true]) {
      const indexes = (planTiers: boolean): Record<string, number> => {
        const cfg = config({ harness: { planTiers, scribeOwnsMarkdown } });
        const scripts = resolveCodexHooks(cfg)
          .filter((entry) => entry.event === "PreToolUse")
          .map((entry) => entry.script);
        return Object.fromEntries(
          ["role-guard", "pr-publisher-confirm", "general-purpose-confirm"].map((s) => [
            s,
            scripts.indexOf(s),
          ]),
        );
      };
      expect(indexes(true)).toEqual(indexes(false));
    }
  });

  // Covers: R9
  it("does not register plan-gate without harness.planTiers", () => {
    const cfg = config({ harness: { planTiers: false } });
    expect(resolveCodexHooks(cfg).some((entry) => entry.script === "plan-gate")).toBe(false);
  });

  // Covers: R10 — publication and general-purpose confirmations are PreToolUse
  // hooks (deny-as-confirmation), never a PermissionRequest registration.
  it("registers the two confirmations as PreToolUse and no PermissionRequest hook", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain("pr-publisher-confirm.sh");
    expect(toml).toContain("general-purpose-confirm.sh");
    expect(toml).not.toContain("PermissionRequest");
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

  /**
   * Spec 0041 R18/R19. A Claude-only tool name or Claude Code version in the
   * Codex render sends the agent to a tool it does not have. Prose spans that
   * only make sense on Claude are wrapped in `navori:if-not onCodex` in the
   * source assets; this sweep fails, naming the file and the managed block, when
   * one slips through. Hook scripts are not prose, but their `[navori]` message
   * lines are shown to the agent, so those are scanned too, with a per-entry
   * allowlist (file + reason) instead of a wildcard.
   */
  // Covers: R18, R19
  it("no Claude-only tool leaks into Codex surfaces", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());

    const forbidden: ReadonlyArray<readonly [name: string, re: RegExp]> = [
      ["SendMessage", /SendMessage/],
      ["TaskCreate", /TaskCreate/],
      ["TaskList", /TaskList/],
      ["TaskStop", /TaskStop/],
      ["ToolSearch", /ToolSearch/],
      ["`Skill`", /`Skill`/],
      ["AskUserQuestion", /AskUserQuestion/],
      ["`Monitor`", /`Monitor`/],
      ["run_in_background", /run_in_background/],
      ["Claude Code <version>", /Claude Code \d/],
    ];
    const markerRe = /navori:managed(?: start)? id="([^"]+)"/;
    const leaks: Array<{ file: string; block: string; term: string; line: string }> = [];

    for (const file of proseSurfaces(cwd)) {
      let block = "(outside any managed block)";
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        block = markerRe.exec(line)?.[1] ?? block;
        for (const [term, re] of forbidden) {
          if (re.test(line)) {
            leaks.push({ file: file.slice(cwd.length + 1), block, term, line: line.slice(0, 120) });
          }
        }
      }
    }

    // Hook `[navori]` messages. Add an entry ONLY with the file and the reason
    // it is safe on Codex; there is no wildcard.
    const hookMessageAllowlist: ReadonlyArray<{ file: string; term: string; reason: string }> = [];
    const hooksDir = join(cwd, ".codex/hooks");
    for (const name of existsSync(hooksDir) ? readdirSync(hooksDir) : []) {
      const rel = `.codex/hooks/${name}`;
      for (const line of readFileSync(join(hooksDir, name), "utf-8").split("\n")) {
        if (!line.includes("[navori]")) continue;
        for (const [term, re] of forbidden) {
          if (!re.test(line)) continue;
          if (hookMessageAllowlist.some((a) => a.file === rel && a.term === term)) continue;
          leaks.push({ file: rel, block: "[navori] hook message", term, line: line.slice(0, 120) });
        }
      }
    }

    expect(leaks).toEqual([]);
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

  // Covers: R32 — a family in codexMap resolves at render time; without a
  // catalog the declared fallback is used and one warning names it.
  it("renders the fallback id and warns once when the catalog lacks the family", () => {
    const cwd = tempRepo();
    const result = renderCodexEngine(
      cwd,
      config({
        models: {
          implementer: "sonnet",
          reviewer: "sonnet",
          scribe: "haiku",
          codexMap: { sonnet: "astra" },
        },
      }),
    );
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'model = "gpt-6-astra"',
    );
    const warns = result.warnings.filter((w) => w.includes("'astra'"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("gpt-6-astra");
  });

  // Covers: R32 — render must not depend on the machine's catalog: a previously
  // rendered newer same-family model survives a render without a catalog.
  it("keeps a previously rendered newer same-family model when no catalog is readable", () => {
    const cwd = tempRepo();
    const cfg = config({ models: { implementer: "sonnet", reviewer: "haiku" } });
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(join(cwd, ".codex/agents/implementer.toml"), 'model = "gpt-6.1-sol"\n');
    const result = renderCodexEngine(cwd, cfg);
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'model = "gpt-6.1-sol"',
    );
    // No previous file: the declared fallback.
    expect(readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8")).toContain(
      'model = "gpt-6-luna"',
    );
    expect(result.warnings.some((w) => w.includes("gpt-6.1-sol"))).toBe(false);
    // Idempotent: a second render keeps it.
    renderCodexEngine(cwd, cfg);
    expect(readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8")).toContain(
      'model = "gpt-6.1-sol"',
    );
  });

  // Covers: R12 — configured tier, mapped output and independent effort override.
  it("renders per-agent model mapping and effort without forcing a root model", () => {
    const cwd = tempRepo();
    renderCodexEngine(
      cwd,
      config({
        models: {
          orchestrator: "opus",
          implementer: "sonnet",
          reviewer: "haiku",
          codexMap: { sonnet: "gpt-6-custom" },
        },
        effort: { implementer: "high", reviewer: "low" },
      }),
    );
    const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
    expect(implementer).toContain('model = "gpt-6-custom"');
    expect(implementer).toContain('model_reasoning_effort = "high"');
    const reviewer = readFileSync(join(cwd, ".codex/agents/reviewer.toml"), "utf-8");
    expect(reviewer).toContain('model = "gpt-6-luna"');
    expect(reviewer).toContain('model_reasoning_effort = "low"');
    expect(readFileSync(join(cwd, ".codex/config.toml"), "utf-8")).not.toMatch(/^model\s*=/m);
    expect(existsSync(join(cwd, ".codex/agents/orchestrator.toml"))).toBe(false);
  });

  // Covers: R12 — omission intentionally inherits host model and effort.
  it("leaves architect model and effort unset when the role has no profile", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ models: { reviewer: "sonnet" }, effort: {} }));
    const architect = readFileSync(join(cwd, ".codex/agents/architect.toml"), "utf-8");
    expect(architect).not.toMatch(/^model\s*=/m);
    expect(architect).not.toMatch(/^model_reasoning_effort\s*=/m);
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
    expect(out).toContain(".claude/progress/review.md");
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

  it("retargets mirrored directories without rewriting legacy progress", () => {
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
    expect(out).toContain(".claude/progress/impl_x.md");
    expect(out).toContain("if `.codex/` looks inconsistent");
    expect(out).not.toContain(".codex/progress/");
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
      "**NEVER delegate it**: do not invoke `spawn_agent(orchestrator)`. `.codex/orchestrator.md` is a depth reference.",
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

describe("renderCodexEngine — navori:if conditions in agent TOMLs (spec 0041 T1)", () => {
  // Covers: R28
  it.each([false, true])(
    "no .codex/agents/*.toml carries a condition marker (scribeOwnsMarkdown=%s)",
    (scribeOwnsMarkdown) => {
      const cwd = tempRepo();
      renderCodexEngine(cwd, config({ harness: { planTiers: true, scribeOwnsMarkdown } }));
      for (const file of readdirSync(join(cwd, ".codex/agents"))) {
        const toml = readFileSync(join(cwd, ".codex/agents", file), "utf-8");
        expect(toml.includes("navori:if"), `agent ${file} still has a navori:if marker`).toBe(
          false,
        );
      }
      const implementer = readFileSync(join(cwd, ".codex/agents/implementer.toml"), "utf-8");
      expect(implementer.includes("write your JSON evidence")).toBe(scribeOwnsMarkdown);
    },
  );
});

describe("renderCodexEngine — installed scripts follow registration (spec 0041 T2)", () => {
  function listed(cwd: string, dir: string): string[] {
    const abs = join(cwd, dir);
    return existsSync(abs) ? readdirSync(abs).map((f) => `${dir}/${f}`) : [];
  }

  // Covers: R13, R30
  it("installs exactly codexInstalledScripts under .codex/hooks and .codex/scripts", () => {
    const cwd = tempRepo();
    const cfg = config({
      harness: { planTiers: true, scribeOwnsMarkdown: true, masterPlan: true },
      plugins: {
        engram: { enabled: true },
        jscpd: { enabled: true },
        semgrep: { enabled: true },
        tgrep: { enabled: true },
      },
    });
    renderCodexEngine(cwd, cfg);
    const expected = codexInstalledScripts(cfg, loadEnabledPlugins(cfg.plugins).loaded);
    const actual = [...listed(cwd, ".codex/hooks"), ...listed(cwd, ".codex/scripts")];
    expect(new Set(actual)).toEqual(new Set(expected));
    for (const gone of [
      ".codex/hooks/bash-outcome-watch.sh",
      ".codex/hooks/subagent-no-background.sh",
    ])
      expect(actual).not.toContain(gone);
    expect(actual).toContain(".codex/scripts/check-jscpd.sh");
    // R29: the guard is installed because the hook extension sources it.
    expect(actual).toContain(".codex/scripts/guard-search-routing.sh");
  });
});

describe("renderCodexEngine — tgrep search lane (spec 0041 T16)", () => {
  const tgrepOn = { plugins: { engram: { enabled: true }, tgrep: { enabled: true } } };
  const hookPath = ".codex/hooks/guard-destructive.sh";
  const scriptPath = ".codex/scripts/guard-search-routing.sh";

  /** Run the rendered Codex hook with a stub `tgrep` that reports a live index. */
  function runCodexGuard(cwd: string, command: string): { status: number | null; stderr: string } {
    const bin = join(cwd, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "tgrep"),
      "#!/bin/sh\nprintf 'Index status for /x\\n  Server:     running\\n'\n",
      {
        mode: 0o755,
      },
    );
    const r = spawnSync("bash", [join(cwd, hookPath)], {
      input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } }),
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      cwd,
      encoding: "utf-8",
    });
    return { status: r.status, stderr: r.stderr };
  }

  // Covers: R29
  it("blocks a recursive shell grep with exit 2 and carries no Claude path", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config(tgrepOn));
    execFileSync("git", ["init", "-q"], { cwd });
    const hook = readFileSync(join(cwd, hookPath), "utf-8");
    expect(hook).toContain('navori:managed start id="tgrep-search-lane"');
    // The base hook mentions CLAUDE_PROJECT_DIR in comments and its Claude arm;
    // the lane is what must stay engine-neutral.
    const lane = hook.slice(
      hook.indexOf('navori:managed start id="tgrep-search-lane"'),
      hook.indexOf('navori:managed end id="tgrep-search-lane"'),
    );
    expect(lane).toContain("guard-search-routing.sh");
    expect(lane).not.toContain("CLAUDE_PROJECT_DIR");
    expect(lane).not.toContain(".claude/scripts");
    expect(existsSync(join(cwd, scriptPath))).toBe(true);
    expect(readFileSync(join(cwd, scriptPath), "utf-8")).not.toContain("${CLAUDE_PROJECT_DIR");

    const blocked = runCodexGuard(cwd, 'grep -rn "foo" src/');
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("BLOCKED by guard-search-routing");
    // Output filtering stays allowed, exactly as under Claude.
    expect(runCodexGuard(cwd, "cat f.txt | grep foo").status).toBe(0);
  });

  // Covers: R29
  it("installs neither the lane nor the script with tgrep off, and strips them when it turns off", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    expect(readFileSync(join(cwd, hookPath), "utf-8")).not.toContain("tgrep-search-lane");
    expect(existsSync(join(cwd, scriptPath))).toBe(false);

    renderCodexEngine(cwd, config(tgrepOn));
    expect(readFileSync(join(cwd, hookPath), "utf-8")).toContain("tgrep-search-lane");
    renderCodexEngine(cwd, config(tgrepOn));
    expect(existsSync(join(cwd, scriptPath))).toBe(true);

    renderCodexEngine(
      cwd,
      config({ plugins: { engram: { enabled: true }, tgrep: { enabled: false } } }),
    );
    expect(readFileSync(join(cwd, hookPath), "utf-8")).not.toContain("tgrep-search-lane");
    expect(existsSync(join(cwd, scriptPath))).toBe(false);
  });
});

describe("renderCodexEngine — master-plan in Codex (spec 0041 T15)", () => {
  const withPlugins = {
    plugins: {
      engram: { enabled: true },
      jscpd: { enabled: true },
      semgrep: { enabled: true },
    },
  } as const;

  // Covers: R20, R21
  it("masterPlan registers master-plan-context and emits both skills", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ harness: { masterPlan: true } }));
    for (const id of ["master-plan", "context-intake"])
      expect(existsSync(join(cwd, `.agents/skills/${id}/SKILL.md`))).toBe(true);
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain(".codex/hooks/master-plan-context.sh");
    expect(existsSync(join(cwd, ".codex/hooks/master-plan-context.sh"))).toBe(true);
    // The shared script carries the Codex branch (decided by `$0`).
    const script = readFileSync(join(cwd, ".codex/hooks/master-plan-context.sh"), "utf-8");
    expect(script).toContain('*".codex/hooks/"*) project_dir=$(git rev-parse --show-toplevel');
  });

  // Covers: R20, R21
  it("without masterPlan neither hook is registered or installed, but the skills still ship", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).not.toContain("master-plan-context");
    expect(toml).not.toContain("master-accept-confirm");
    expect(existsSync(join(cwd, ".codex/hooks/master-plan-context.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/master-plan/SKILL.md"))).toBe(true);
  });

  // Covers: R20
  it("master-accept-confirm carries its Codex deny branch and never allows", () => {
    const cwd = tempRepo();
    renderCodexEngine(cwd, config({ harness: { masterPlan: true } }));
    const script = readFileSync(join(cwd, ".codex/hooks/master-accept-confirm.sh"), "utf-8");
    expect(script).toContain('*".codex/hooks/"*)');
    expect(script).toContain('"permissionDecision":"deny"');
    expect(script).not.toContain('"permissionDecision":"allow"');
  });

  // Covers: R21 — D8: a registered group's `event:index` is its position among
  // the other groups of the same event, so the tail may only grow.
  it("keeps every already-published group index when masterPlan is switched on", () => {
    // Spec 0041 R9/R10: role-guard and the rows after it are the new tail.
    const LATE_TAIL = [
      "role-guard",
      "pr-publisher-confirm",
      "general-purpose-confirm",
      "plan-gate",
      "engram-write-guard",
    ];
    const base = config(withPlugins);
    const on = config({ ...withPlugins, harness: { masterPlan: true } });
    const plugins = loadEnabledPlugins(base.plugins).loaded;
    const slots = (cfg: NavoriConfig): Map<string, string[]> => {
      const byEvent = new Map<string, string[]>();
      // The baseline is dev's table: `role-guard` is the new tail and may follow the
      // master-plan groups, so it is left out of the published-prefix comparison.
      for (const hook of resolveCodexHooks(cfg, plugins).filter(
        (h) => !LATE_TAIL.includes(h.script),
      )) {
        byEvent.set(hook.event, [...(byEvent.get(hook.event) ?? []), hook.script]);
      }
      return byEvent;
    };
    const before = slots(base);
    const after = slots(on);
    for (const [event, scripts] of before) {
      expect(after.get(event)?.slice(0, scripts.length), event).toEqual(scripts);
    }
    expect(before.get("PreToolUse")).toContain("check-jscpd.sh");
    expect(after.get("PreToolUse")?.at(-1)).toBe("master-accept-confirm");
    expect(after.get("SessionStart")?.at(-1)).toBe("master-plan-context");
    // Pinned: the indexes Codex trust already approved.
    expect(before.get("SessionStart")).toEqual([
      "model-advisor",
      "session-start-context",
      "worktree-reclaim",
    ]);
    expect(before.get("PreToolUse")?.slice(0, 3)).toEqual([
      "guard-destructive",
      "comment-draft-confirm",
      "quality-gate-pre-commit",
    ]);
  });

  // Covers: R6, R7, R17 — spec 0041 T8/T9, D7, D8. role-guard is Codex-only and
  // late: it trails the plugin groups and never moves a published index.
  it("registers role-guard late on apply_patch and spawn_agent, with no agents table", () => {
    const base = config(withPlugins);
    const plugins = loadEnabledPlugins(base.plugins).loaded;
    const preTool = resolveCodexHooks(base, plugins).filter((hook) => hook.event === "PreToolUse");
    const scripts = preTool.map((hook) => hook.script);
    expect(scripts.slice(0, 3)).toEqual([
      "guard-destructive",
      "comment-draft-confirm",
      "quality-gate-pre-commit",
    ]);
    expect(scripts.at(-4)).toBe("role-guard");
    expect(scripts.indexOf("role-guard")).toBeGreaterThan(scripts.indexOf("check-jscpd.sh"));
    expect(preTool.find((hook) => hook.script === "role-guard")?.matcher).toBe(
      "^apply_patch$|spawn_agent$",
    );
    // With masterPlan on, role-guard is still the LAST late row: the master-plan
    // groups were published in dev (#1187), so their indexes must not move.
    const on = resolveCodexHooks(config({ ...withPlugins, harness: { masterPlan: true } }), plugins)
      .filter((hook) => hook.event === "PreToolUse")
      .map((hook) => hook.script);
    expect(on.slice(-5)).toEqual([
      "master-accept-confirm",
      "role-guard",
      "pr-publisher-confirm",
      "general-purpose-confirm",
      "engram-write-guard",
    ]);
    const withMaster = resolveCodexHooks(
      config({ ...withPlugins, harness: { masterPlan: true } }),
      plugins,
    );
    const without = resolveCodexHooks(base, plugins);
    const indexOf = (hooks: typeof withMaster, event: string, script: string): number =>
      hooks.filter((hook) => hook.event === event).findIndex((hook) => hook.script === script);
    // Same positions as dev: master-accept-confirm directly after the plugin groups,
    // master-plan-context last in SessionStart; role-guard only appends.
    expect(indexOf(withMaster, "PreToolUse", "master-accept-confirm")).toBe(
      without.filter(
        (hook) =>
          hook.event === "PreToolUse" &&
          ![
            "role-guard",
            "pr-publisher-confirm",
            "general-purpose-confirm",
            "engram-write-guard",
          ].includes(hook.script),
      ).length,
    );
    expect(withMaster.filter((hook) => hook.event === "SessionStart").at(-1)?.script).toBe(
      "master-plan-context",
    );

    const cwd = tempRepo();
    renderCodexEngine(cwd, config());
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain(".codex/hooks/role-guard.sh");
    expect(toml).not.toMatch(/^\[agents\]/m);
    expect(toml).not.toContain("multi_agent_v2");
    expect(toml).not.toContain("max_depth");
    expect(readFileSync(join(cwd, ".codex/hooks/role-guard.sh"), "utf-8")).toContain(
      'id="role-guard-base"',
    );
  });
});
