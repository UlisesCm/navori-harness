import { assert, describe, it, expect } from "vitest";
import { PluginManifestSchema, listKnownPluginIds, loadPlugin } from "../plugins.ts";

/**
 * Schema parser tests. Containment of resolved paths (scripts.src,
 * skills.file, managed.file) lives in loadPlugin and is exercised by
 * the e2e flow — these tests cover the declarative shape only.
 */

const MINIMAL = {
  id: "my-plugin",
  name: "My Plugin",
  description: "...",
  version: "0.0.1",
  managed: [],
};

describe("PluginManifestSchema — minimal shape", () => {
  it("accepts a minimal manifest", () => {
    const result = PluginManifestSchema.safeParse(MINIMAL);
    expect(result.success).toBe(true);
  });

  it("rejects non-kebab plugin id", () => {
    const result = PluginManifestSchema.safeParse({ ...MINIMAL, id: "My_Plugin" });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — settingsFragment", () => {
  it("accepts an arbitrary object", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      settingsFragment: { permissions: { allow: ["Bash(ls)"] }, nested: { x: 1 } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      settingsFragment: "not an object",
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — hooks", () => {
  it("accepts a valid PreToolUse hook with matcher and timeout", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [
        {
          event: "PreToolUse",
          matcher: "Bash",
          command: "bash .claude/scripts/check.sh",
          timeout: 180,
          statusMessage: "Checking…",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [{ event: "OnSubmit", command: "echo" }],
    });
    expect(result.success).toBe(false);
  });

  // Covers: R7 — SessionStart joined the contract (spec 0017) so a plugin can
  // announce itself when a session opens.
  it("accepts a SessionStart hook", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [
        {
          event: "SessionStart",
          command: 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/session-fixture.sh"',
          timeout: 30,
          statusMessage: "navori/fixture: session notice",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // Covers: R7 — the enum stays the only gate: a plausible-looking neighbour of
  // the new event is still rejected, so widening it once didn't widen it twice.
  it("rejects a lookalike event outside the contract (SessionResume)", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [{ event: "SessionResume", command: "echo" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty command", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [{ event: "PreToolUse", command: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a zero or negative timeout", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      hooks: [{ event: "PreToolUse", command: "echo", timeout: 0 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — scripts", () => {
  it("accepts a basic script entry", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      scripts: [{ src: "scripts/check.sh", dest: "check.sh" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scripts?.[0]?.exec).toBe(true);
    }
  });

  it("rejects an absolute dest path", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      scripts: [{ src: "scripts/check.sh", dest: "/etc/passwd" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a dest path containing '..'", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      scripts: [{ src: "scripts/check.sh", dest: "../../escape.sh" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an src path containing '..'", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      scripts: [{ src: "../../etc/passwd", dest: "check.sh" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — skills", () => {
  it("accepts a standalone skill", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [{ id: "check-foo", file: "skills/check-foo.md" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sub-block skill with injectInto", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [
        {
          id: "engram-leader-extension",
          file: "skills/engram-leader.md",
          injectInto: "agents/leader.md",
          recommendedAgent: "orchestrator",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sub-block skill that narrows its MCP grant with mcpTools", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [
        {
          id: "engram-implementer-extension",
          file: "skills/engram-subagent-readonly.md",
          injectInto: "agents/implementer.md",
          mcpTools: ["mem_search", "mem_get_observation"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("omitting mcpTools stays valid — the wildcard grant is unchanged (backward compat)", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [{ id: "x", file: "skills/x.md", injectInto: "agents/leader.md" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects recommendedAgent not in the known roles", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [
        {
          id: "x",
          file: "skills/x.md",
          recommendedAgent: "unknown-role",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects skills.file with '..'", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      skills: [{ id: "bad", file: "../../etc/passwd" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — prompts", () => {
  it("accepts a valid prompt entry", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      prompts: [
        {
          key: "project.legacyPaths",
          question: { es: "¿Qué carpetas son legacy?", en: "Which folders are legacy?" },
          type: "string-list",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompts?.[0]?.optional).toBe(false);
    }
  });

  it("rejects a key with invalid format (uppercase, spaces, leading dot)", () => {
    for (const bad of ["Project.Foo", ".project.foo", "project foo", "1project"]) {
      const result = PluginManifestSchema.safeParse({
        ...MINIMAL,
        prompts: [
          {
            key: bad,
            question: { es: "¿?", en: "?" },
            type: "string",
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a prompt missing one of the languages", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      prompts: [
        {
          key: "project.testRunner",
          question: { es: "¿Qué runner usas?" },
          type: "string",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown type", () => {
    const result = PluginManifestSchema.safeParse({
      ...MINIMAL,
      prompts: [
        {
          key: "project.x",
          question: { es: "¿?", en: "?" },
          type: "uuid",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema — backward compat", () => {
  it("existing manifest with only managed[] still validates", () => {
    const result = PluginManifestSchema.safeParse({
      id: "engram",
      name: "Engram",
      description: "Persistent memory",
      version: "0.0.1",
      managed: [
        {
          id: "engram-protocol",
          file: "managed/engram-protocol.md",
          recommendedAgent: "orchestrator",
        },
      ],
      externalTool: {
        name: "engram",
        checkBinary: "engram",
        install: { darwin: "brew install engram" },
      },
    });
    expect(result.success).toBe(true);
  });
});

/**
 * #965 — `install` was `z.record(z.string(), z.string())`, so a key like
 * `"macos"` validated and then never matched the lookup in `add`/`doctor`: a
 * typo was indistinguishable from a deliberate hole. The fix must keep holes
 * legal (some platforms genuinely have no single install command) while
 * rejecting keys outside the matrix — which is `z.partialRecord`, not
 * `z.record`: with an enum key, plain `z.record` is EXHAUSTIVE in zod 4 and
 * would reject every bundled manifest.
 */
describe("PluginManifestSchema — externalTool.install platform keys (#965)", () => {
  const withTool = (externalTool: Record<string, unknown>): { success: boolean } =>
    PluginManifestSchema.safeParse({ ...MINIMAL, externalTool });

  it("accepts a partial matrix — omitting a platform is legal", () => {
    expect(withTool({ name: "t", install: { darwin: "brew install t" } }).success).toBe(true);
  });

  it("accepts the full matrix", () => {
    const install = { darwin: "a", linux: "b", win32: "c" };
    expect(withTool({ name: "t", install }).success).toBe(true);
  });

  it("rejects a key outside PLATFORMS — 'macos' used to validate and never match", () => {
    expect(withTool({ name: "t", install: { macos: "brew install t" } }).success).toBe(false);
  });

  it("accepts installDocs as a URL and rejects anything that is not one", () => {
    expect(withTool({ name: "t", installDocs: "https://example.com/install" }).success).toBe(true);
    expect(withTool({ name: "t", installDocs: "run the installer" }).success).toBe(false);
  });
});

/**
 * Covers: R13 — `mcpServer.alwaysLoad` (spec 0017 T7). The field exists because
 * of a measurement, not a preference: with an MCP server deferred, two full
 * sessions in this repo called its tools zero times; declaring `alwaysLoad`
 * dropped the session's deferred-tool count from 68 to 67 and put the server's
 * tools in the eagerly-loaded set (Claude Code 2.1.236, 2026-09-09). The numbers
 * and the server they were measured on are in
 * `docs/research/tgrep-como-funcionaba.md` §7.
 *
 * Pinned here rather than left to the renderer alone: the whole point is that
 * an optional boolean survives the schema, and `false` stays out of the emitted
 * registry — the absent key already means it.
 */
describe("PluginManifestSchema — mcpServer.alwaysLoad", () => {
  const withServer = (mcpServer: unknown) =>
    PluginManifestSchema.safeParse({ ...MINIMAL, mcpServer });

  it("accepts a server that omits alwaysLoad", () => {
    const result = withServer({ command: "srv", args: [] });
    expect(result.success).toBe(true);
    expect(result.success && result.data.mcpServer?.alwaysLoad).toBeUndefined();
  });

  it("accepts alwaysLoad: true", () => {
    const result = withServer({ command: "srv", args: [], alwaysLoad: true });
    expect(result.success && result.data.mcpServer?.alwaysLoad).toBe(true);
  });

  it("rejects a non-boolean alwaysLoad", () => {
    expect(withServer({ command: "srv", args: [], alwaysLoad: "yes" }).success).toBe(false);
  });

  it("keeps `false` distinguishable from absent, since the emitted registry omits both", () => {
    const parsed = withServer({ command: "srv", args: [], alwaysLoad: false });
    // Two steps, not `parsed.success && parsed.data…`: that expression collapses
    // to `false` when the parse FAILS, so the one-liner form ends in
    // `.toBe(false)` and goes green against a schema that rejects the field
    // outright — passing for the exact reason this case exists to rule out.
    // (The sibling cases above end in `.toBe(true)`/`.toBeUndefined()`, which a
    // failed parse cannot satisfy, so only this one needed splitting.)
    assert.isTrue(parsed.success, "the schema must ACCEPT an explicit alwaysLoad: false");
    expect(parsed.data.mcpServer?.alwaysLoad).toBe(false);
  });
});

/**
 * Spec 0026 T13 (R28): a plugin that injects into an agent's managed body may
 * add at most one sub-block PER agent file — two entries targeting the same
 * `injectInto` collide inside that file's marker namespace. Each sub-block's
 * id names the agent it lands in (`<skill>-<agentId>`), so a reader scanning
 * `plugin.json` sees the target without opening the agent file.
 */
// Covers: R28
describe("real plugin manifests — one sub-block per agent file, id and source named after its target", () => {
  const pluginIds = listKnownPluginIds();
  // Anti-vacuity: this suite is pointless if no real manifest injects into more
  // than one agent file — assert the fixture it depends on actually exists.
  it("at least one real plugin injects into 2+ distinct agent files", () => {
    const injectingPlugins = pluginIds.filter((id) => {
      const targets = new Set(
        loadPlugin(id)
          .skillAssets.map((s) => s.injectInto)
          .filter((t): t is string => Boolean(t)),
      );
      return targets.size >= 2;
    });
    expect(injectingPlugins.length).toBeGreaterThan(0);
  });

  it.each(pluginIds)("%s — no two sub-blocks target the same agent file", (pluginId) => {
    const skills = loadPlugin(pluginId).skillAssets.filter((s) => s.injectInto);
    const byTarget = new Map<string, string[]>();
    for (const skill of skills) {
      const target = skill.injectInto!;
      byTarget.set(target, [...(byTarget.get(target) ?? []), skill.id]);
    }
    for (const [target, ids] of byTarget) {
      expect(
        ids,
        `${pluginId}: ${target} receives ${ids.length} sub-blocks (${ids.join(", ")})`,
      ).toHaveLength(1);
    }
  });

  it.each(pluginIds)(
    "%s — each sub-block injected into an agent file names that agent",
    (pluginId) => {
      // R28 scopes the roster's agent-facing naming rule; a plugin injecting into
      // a skill file (e.g. semgrep into `security-guidance/SKILL.md`) is out of
      // scope here — that file has no "target agent" id to name.
      const agentSkills = loadPlugin(pluginId).skillAssets.filter((s) =>
        /\.claude\/agents\/[\w-]+\.md$/.test(s.injectInto ?? ""),
      );
      for (const skill of agentSkills) {
        const agentId = skill.injectInto!.match(/\.claude\/agents\/([\w-]+)\.md$/)![1];
        expect(
          skill.id,
          `${pluginId}: sub-block id "${skill.id}" does not name its target agent "${agentId}"`,
        ).toContain(agentId);
      }
    },
  );
});
