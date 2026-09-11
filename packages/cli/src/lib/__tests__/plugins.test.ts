import { describe, it, expect } from "vitest";
import { PluginManifestSchema, loadPlugin } from "../plugins.ts";

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
          command: 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/tgrep-session.sh"',
          timeout: 30,
          statusMessage: "navori/tgrep: search index",
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
          recommendedAgent: "leader",
        },
      ],
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
        { id: "engram-protocol", file: "managed/engram-protocol.md", recommendedAgent: "leader" },
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
 * Covers: R10 — the tgrep plugin's own manifest (spec 0017). Bundling is
 * automatic (a readdir over packages/plugins), so what is worth pinning is the
 * manifest's shape: it has to load, and its external-tool contract is what
 * `doctor` and `add` read to report and install the binary.
 */
describe("tgrep plugin manifest", () => {
  it("loads and validates, declaring tgrep as its external tool", () => {
    const plugin = loadPlugin("tgrep");
    expect(plugin.manifest.id).toBe("tgrep");
    expect(plugin.manifest.externalTool?.checkBinary).toBe("tgrep");
  });

  it("installs via brew on darwin and linux, and declares nothing for win32", () => {
    // win32 is omitted deliberately: there is no install command anyone
    // verified there, and `add.ts` already warns cleanly for a missing platform
    // — which beats running something unverified on a user's machine.
    const install = loadPlugin("tgrep").manifest.externalTool?.install ?? {};
    expect(install.darwin).toBe("brew install tgrep");
    expect(install.linux).toBe("brew install tgrep");
    expect(install.win32).toBeUndefined();
  });

  it("ships its three scripts and wires a hook per phase it owns", () => {
    const manifest = loadPlugin("tgrep").manifest;
    expect(manifest.scripts?.map((s) => s.dest).sort()).toEqual([
      "guard-search-routing.sh",
      "tgrep-search.sh",
      "tgrep-session.sh",
    ]);
    // Two phases, two jobs: SessionStart rebuilds the trigram index, and
    // PreToolUse(Bash) is the routing guard — content search goes through the
    // wrapper because a hook says so, not because prose asks. The prose version
    // shipped in 0.7.8 and measured 7.4% adoption over 2,761 real searches.
    expect(manifest.hooks?.map((h) => h.event)).toEqual(["SessionStart", "PreToolUse"]);
    const guard = manifest.hooks?.find((h) => h.event === "PreToolUse");
    // Without the matcher the guard would run on EVERY tool call, paying its
    // cost on Read/Edit/Task where it can never fire.
    expect(guard?.matcher).toBe("Bash");
  });
});

/**
 * Covers: R13 — `mcpServer.alwaysLoad` (spec 0017 T7). The field exists because
 * of a measurement, not a preference: with codegraph deferred, two full sessions
 * in this repo called its tools zero times; declaring `alwaysLoad` dropped the
 * session's deferred-tool count from 68 to 67 and put `codegraph_explore` in the
 * eagerly-loaded set (same Claude Code 2.1.236, 2026-09-09).
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

  it("is declared by the codegraph plugin — the server the experiment was run on", () => {
    expect(loadPlugin("codegraph").manifest.mcpServer?.alwaysLoad).toBe(true);
  });
});
