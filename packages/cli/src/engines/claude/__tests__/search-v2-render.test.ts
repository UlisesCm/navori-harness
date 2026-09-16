import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { renderClaudeEngine } from "../index.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";
import { splitFrontmatter, getFrontmatterField } from "../../../lib/frontmatter.ts";
import { readCliVersion } from "../../../lib/bundled-assets.ts";
import { RETIRED_PLUGINS, RETIRED_PLUGIN_BLOCKS, KNOWN_PLUGINS } from "../../../lib/plugins.ts";
import { countWords } from "../../../lib/skill-meta.ts";
import { getCoreRoot, getPluginPath } from "../../../lib/bundled-assets.ts";
import { writeConfig } from "../../../lib/config.ts";
import { removeCommand } from "../../../commands/remove.ts";

// `removeCommand` prompts via @clack/prompts when `--yes` is absent; R08's
// remove scenario always passes `--yes`, but `remove.ts` still calls
// `p.intro`/`p.log.*`/`p.outro` (and so does `runRender`, which it calls
// internally) purely for terminal output. Mocked so those calls are no-ops
// instead of writing to the test runner's stdout — same shape as
// `commands/__tests__/backup-restore.test.ts`, which exercises another
// clack-based command directly via `runCommand`.
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: {
    message: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

/**
 * search-v2.md §7 P2 — routing, agents and render.
 *
 * R04 correction (verified against `packages/plugins/codegraph/plugin.json`,
 * which ships exactly 5 `skills[]` entries, not 7 as an earlier draft of the
 * plan said): only `leader`, `implementer`, `reviewer`, `auditor` and
 * `ticket-audit` receive the generated `mcp__codegraph__*` family grant via
 * `injectInto`/`withAgentMcpTools`. `explorer` and `researcher` already carry
 * `mcp__codegraph__codegraph_explore` BY NAME in their own source (see
 * `core-assets/agents/explorer.md`/`researcher.md`) — giving them the
 * generated family grant instead would widen their allowlist and break the
 * by-name invariant `mcp-capability-wiring.test.ts` (#575/#761) pins.
 */

const ROLE_AGENTS = ["leader", "implementer", "reviewer", "auditor", "ticket-audit"] as const;

function baseConfig(plugins: Record<string, { enabled: boolean }> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "search-v2-demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
    plugins,
  });
}

function pluginsFor(opts: {
  codegraph?: boolean;
  tgrep?: boolean;
  gh?: boolean;
}): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const [id, enabled] of Object.entries(opts)) {
    if (enabled !== undefined) out[id] = { enabled };
  }
  return out;
}

/** Number of `<!-- navori:managed id="X" ...` OPEN markers — the closing tag
 *  also carries `id="X"`, so a plain substring count would double-count.
 *  Counted via `split` on the literal open-marker prefix rather than
 *  `new RegExp(<interpolated id>)`: this repo's own semgrep gate flags that
 *  shape (`detect-non-literal-regexp`), and `id` never needs regex semantics
 *  here — it is compared as a literal string, same as build-settings.test.ts's
 *  `permissionMatches`. */
function openBlockCount(text: string, id: string): number {
  const openMarker = `<!-- navori:managed id="${id}"`;
  return text.split(openMarker).length - 1;
}

/** The `tools:` allowlist of a rendered agent file, split into entries. */
function agentTools(content: string): string[] {
  const { frontmatter } = splitFrontmatter(content);
  const raw = getFrontmatterField(frontmatter, "tools");
  return raw
    ? raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    : [];
}

const agentPath = (cwd: string, role: (typeof ROLE_AGENTS)[number]) =>
  join(cwd, `.claude/agents/${role}.md`);

interface SettingsJson {
  permissions: { allow: string[]; deny?: string[]; ask?: string[] };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  [key: string]: unknown;
}

function readSettings(cwd: string): SettingsJson {
  return JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8")) as SettingsJson;
}

interface McpJson {
  mcpServers: Record<string, Record<string, unknown>>;
  $navori?: { managed?: boolean; version?: string };
  [key: string]: unknown;
}

function readMcp(cwd: string): McpJson | null {
  const path = join(cwd, ".mcp.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as McpJson) : null;
}

const COMBOS = [
  { label: "00", codegraph: false, tgrep: false },
  { label: "10", codegraph: true, tgrep: false },
  { label: "01", codegraph: false, tgrep: true },
  { label: "11", codegraph: true, tgrep: true },
] as const;

describe.each(COMBOS)("search v2 render matrix — combo $label", ({ codegraph, tgrep }) => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-render-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const cfg = () => baseConfig(pluginsFor({ codegraph, tgrep }));

  it("R01 — core routing block exactly once; provider block iff its plugin is enabled", () => {
    renderClaudeEngine(cwd, cfg());
    const md = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");

    expect(openBlockCount(md, "code-discovery-routing")).toBe(1);
    expect(openBlockCount(md, "codegraph-search-v2")).toBe(codegraph ? 1 : 0);
    expect(openBlockCount(md, "tgrep-search-v2")).toBe(tgrep ? 1 : 0);
  });

  it("R02 — .mcp.json only ever receives CodeGraph; tgrep never appears; foreign server/keys survive", () => {
    // Seed a foreign server + an unrelated top-level key before rendering.
    writeFileSync(
      join(cwd, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: { "fixture-server": { command: "fixture-bin", args: [] } },
          inputs: [],
        },
        null,
        2,
      )}\n`,
    );

    renderClaudeEngine(cwd, cfg());
    const mcp = readMcp(cwd);
    expect(mcp).not.toBeNull();
    expect(mcp!.mcpServers["fixture-server"]).toEqual({ command: "fixture-bin", args: [] });
    expect(mcp!.inputs).toEqual([]);

    // tgrep never registers an MCP server — it has none in its manifest.
    expect(mcp!.mcpServers.tgrep).toBeUndefined();

    if (codegraph) {
      expect(mcp!.mcpServers.codegraph).toEqual({
        command: "codegraph",
        args: ["serve", "--mcp"],
        env: { CODEGRAPH_MCP_TOOLS: "explore", CODEGRAPH_EXPLORE_DEDUP: "0" },
        alwaysLoad: true,
      });
    } else {
      expect(mcp!.mcpServers.codegraph).toBeUndefined();
    }
  });

  it("R03 — a navori-owned settings.json grants exact, deduped permissions", () => {
    renderClaudeEngine(cwd, cfg());
    // Second render exercises dedup, not just first-write correctness.
    renderClaudeEngine(cwd, cfg());
    const settings = readSettings(cwd);

    const countOf = (needle: string) =>
      settings.permissions.allow.filter((a) => a === needle).length;

    if (codegraph) {
      expect(countOf("mcp__codegraph__codegraph_explore")).toBe(1);
    } else {
      expect(countOf("mcp__codegraph__codegraph_explore")).toBe(0);
    }

    if (tgrep) {
      expect(countOf("Bash(tgrep search *)")).toBe(1);
      expect(countOf("Bash(tgrep status *)")).toBe(1);
      expect(countOf("Bash(tgrep --version)")).toBe(1);
    } else {
      expect(countOf("Bash(tgrep search *)")).toBe(0);
      expect(countOf("Bash(tgrep status *)")).toBe(0);
      expect(countOf("Bash(tgrep --version)")).toBe(0);
    }
  });

  // `mergeCoexistSettings` deliberately injects only hooks + deny/ask (the
  // defensive layers) into a hand-written settings.json, NEVER the `allow`
  // "convenience list" a plugin grants (coexist-settings.ts docstring) — so a
  // pre-existing file's OWN deny/ask survive here, but this is not where a
  // plugin's `mcp__codegraph__codegraph_explore`/`Bash(tgrep …)` would appear;
  // that is R03 above, against a navori-owned file.
  it("R03b — a pre-existing (coexist) settings.json keeps its own deny/ask rules", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      `${JSON.stringify(
        {
          permissions: {
            allow: ["Bash(ls)"],
            deny: ["Bash(custom-dangerous-thing)"],
            ask: ["Bash(custom-risky-thing)"],
          },
        },
        null,
        2,
      )}\n`,
    );

    renderClaudeEngine(cwd, cfg());
    const settings = readSettings(cwd);
    expect(settings.permissions.allow).toContain("Bash(ls)");
    expect(settings.permissions.deny).toContain("Bash(custom-dangerous-thing)");
    expect(settings.permissions.ask).toContain("Bash(custom-risky-thing)");
  });

  it("R04 — the five enabled roles get the CodeGraph grant iff enabled; explorer/researcher keep the by-name tool untouched", () => {
    renderClaudeEngine(cwd, cfg());

    for (const role of ROLE_AGENTS) {
      const content = readFileSync(agentPath(cwd, role), "utf-8");
      const tools = agentTools(content);
      if (codegraph) {
        expect(tools, `${role} should carry the generated family grant`).toContain(
          "mcp__codegraph__*",
        );
        expect(openBlockCount(content, `codegraph-access-v2-${role}`)).toBe(1);
        expect(content).toContain("Structural discovery access");
      } else {
        expect(tools).not.toContain("mcp__codegraph__*");
        expect(content).not.toContain(`codegraph-access-v2-${role}`);
      }
    }

    // explorer/researcher are never injectInto targets: their exact-name tool
    // lives in source, unconditionally, and never widens to the family.
    for (const role of ["explorer", "researcher"] as const) {
      const content = readFileSync(join(cwd, `.claude/agents/${role}.md`), "utf-8");
      const tools = agentTools(content);
      expect(tools).toContain("mcp__codegraph__codegraph_explore");
      expect(tools).not.toContain("mcp__codegraph__*");
      expect(content).not.toContain("codegraph-access-v2");
    }
  });

  it("R05 — second render is a no-op: zero writes and byte-identical files", () => {
    renderClaudeEngine(cwd, cfg());
    const snapshot = (): Record<string, string | null> => {
      const paths = [
        "CLAUDE.md",
        ".claude/settings.json",
        ".mcp.json",
        ...ROLE_AGENTS.map((r) => `.claude/agents/${r}.md`),
      ];
      const out: Record<string, string | null> = {};
      for (const p of paths) {
        const abs = join(cwd, p);
        out[p] = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
      }
      return out;
    };
    const before = snapshot();

    const second = renderClaudeEngine(cwd, cfg());
    expect(second.written).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it("R07 — user-section text and another plugin's block survive this render", () => {
    const withGh = baseConfig(pluginsFor({ codegraph, tgrep, gh: true }));
    renderClaudeEngine(cwd, withGh);

    const path = join(cwd, "CLAUDE.md");
    const md = readFileSync(path, "utf-8");
    writeFileSync(
      path,
      md.replace(
        /<!-- navori:user-start -->[\s\S]*?<!-- navori:user-end -->/,
        `<!-- navori:user-start -->\n\n## Reglas del repo\n\nNunca usar \`context.db\` directo.\n\n<!-- navori:user-end -->`,
      ),
    );

    renderClaudeEngine(cwd, withGh);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("## Reglas del repo");
    expect(after).toContain("Nunca usar `context.db` directo.");
    expect(openBlockCount(after, "gh-protocol")).toBe(1);
    const settings = readSettings(cwd);
    expect(settings.permissions.allow).toContain("Bash(gh pr create*)");
  });
});

describe("R06 — dry-run touches no file and executes no external binary", () => {
  let cwd: string;
  let binDir: string;
  const savedPath = process.env.PATH;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-dryrun-"));
    binDir = mkdtempSync(join(tmpdir(), "navori-search-v2-sentinel-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it("a dry-run reports the plan but never invokes codegraph/tgrep, index or process", () => {
    const marker = join(binDir, "invoked.log");
    for (const name of ["codegraph", "tgrep"]) {
      const script = join(binDir, name);
      writeFileSync(script, `#!/usr/bin/env bash\necho "$0 $*" >> "${marker}"\nexit 1\n`, "utf-8");
      chmodSync(script, 0o755);
    }
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;

    const r = renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true, tgrep: true })), {
      dryRun: true,
    });

    expect(r.written.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("R08 — enable/disable/enable and `navori remove` leave no orphans", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-toggle-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("codegraph: true -> false -> true leaves no MCP entry, allow rule or grant orphaned; reactivation does not duplicate", () => {
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const on1 = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(agentTools(on1)).toContain("mcp__codegraph__*");
    expect(openBlockCount(on1, "codegraph-access-v2-leader")).toBe(1);
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeDefined();
    expect(readSettings(cwd).permissions.allow).toContain("mcp__codegraph__codegraph_explore");

    // A config carrying `{ enabled: false }` — the shape `navori remove`
    // writes TEMPORARILY as its Phase 1 (before Phase 2 deletes the key
    // outright, see the `navori remove` test below) — must clean up on its
    // own too, e.g. for a teammate who hand-edits the config to disable a
    // plugin without running `remove`.
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: false })));
    const off = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(agentTools(off)).not.toContain("mcp__codegraph__*");
    expect(off).not.toContain("codegraph-access-v2-leader");
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeUndefined();
    expect(readSettings(cwd).permissions.allow).not.toContain("mcp__codegraph__codegraph_explore");

    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const on2 = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(openBlockCount(on2, "codegraph-access-v2-leader")).toBe(1);
    expect(agentTools(on2).filter((t) => t === "mcp__codegraph__*")).toHaveLength(1);
    expect(
      readSettings(cwd).permissions.allow.filter((a) => a === "mcp__codegraph__codegraph_explore"),
    ).toHaveLength(1);
  });

  it("tgrep: true -> false -> true leaves no allow rule orphaned; reactivation does not duplicate", () => {
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ tgrep: true })));
    expect(readSettings(cwd).permissions.allow).toContain("Bash(tgrep search *)");

    renderClaudeEngine(cwd, baseConfig(pluginsFor({ tgrep: false })));
    expect(readSettings(cwd).permissions.allow).not.toContain("Bash(tgrep search *)");

    renderClaudeEngine(cwd, baseConfig(pluginsFor({ tgrep: true })));
    const allow = readSettings(cwd).permissions.allow;
    expect(allow.filter((a) => a === "Bash(tgrep search *)")).toHaveLength(1);
  });

  // `navori remove` (commands/remove.ts) is a DIFFERENT scenario from the two
  // toggle tests above: Phase 1 renders with `{ enabled: false }` (the same
  // cleanup the toggle tests already pin), but Phase 2 then DELETES the
  // `codegraph` key from navori.config.json outright — a key that is wholly
  // ABSENT is a config shape neither toggle test exercises, and
  // `loadDisabledPlugins`/`loadPluginsWhere` (lib/plugins.ts) only iterate
  // keys PRESENT in `config.plugins`, so an absent key is invisible to that
  // cleanup path. Phase 2 is safe only because Phase 1's render already ran
  // first (search-v2.md §7 R08, §3.5).
  it("navori remove codegraph: deletes the config key (not just enabled:false) and a later render stays orphan-free", async () => {
    const configPath = join(cwd, "navori.config.json");
    writeConfig(configPath, baseConfig(pluginsFor({ codegraph: true })));
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));

    const on = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(agentTools(on)).toContain("mcp__codegraph__*");
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeDefined();
    expect(readSettings(cwd).permissions.allow).toContain("mcp__codegraph__codegraph_explore");

    await runCommand(removeCommand, { rawArgs: ["codegraph", "--cwd", cwd, "--yes"] });

    // Phase 2's actual effect: the key is gone, not merely `enabled: false`.
    const rawPlugins = (
      JSON.parse(readFileSync(configPath, "utf-8")) as { plugins?: Record<string, unknown> }
    ).plugins;
    expect(rawPlugins?.codegraph).toBeUndefined();

    // Phase 1's render already ran before the key was deleted, so the
    // cleanup is visible immediately after `remove` returns.
    const offAfterRemove = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(agentTools(offAfterRemove)).not.toContain("mcp__codegraph__*");
    expect(offAfterRemove).not.toContain("codegraph-access-v2-leader");
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeUndefined();
    expect(readSettings(cwd).permissions.allow).not.toContain("mcp__codegraph__codegraph_explore");

    // A later render against the now-key-absent config — e.g. a teammate
    // pulling the repo after `remove` and running `navori render` again —
    // must stay a no-op: an absent key renders exactly as clean as
    // `{ enabled: false }` does, with no artifact left to resurface it.
    renderClaudeEngine(cwd, baseConfig(pluginsFor({})));
    const finalLeader = readFileSync(agentPath(cwd, "leader"), "utf-8");
    expect(agentTools(finalLeader)).not.toContain("mcp__codegraph__*");
    expect(finalLeader).not.toContain("codegraph-access-v2-leader");
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeUndefined();
    expect(readSettings(cwd).permissions.allow).not.toContain("mcp__codegraph__codegraph_explore");
  });
});

describe("R09 — a hand-edited or newer-version sub-block is preserved and reported as skipped, never as a fresh install", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-conflict-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("user-modified-skipped: hand edit survives and shows up in r.skipped, not r.written", () => {
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const path = agentPath(cwd, "leader");
    const original = readFileSync(path, "utf-8");
    const edited = original.replace(
      "Apply Code discovery routing from the project instructions.",
      "USER-EDIT: apply routing however you like.",
    );
    expect(edited).not.toBe(original);
    writeFileSync(path, edited);

    const r = renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("USER-EDIT: apply routing however you like.");

    const skip = r.skipped.find((s) => s.path === ".claude/agents/leader.md");
    expect(skip?.status).toBe("user-modified-skipped");
    expect(r.written.some((w) => w.path === ".claude/agents/leader.md")).toBe(false);
  });

  it("downgrade-skipped: a sub-block stamped by a newer navori is preserved and reported, not overwritten", () => {
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const path = agentPath(cwd, "leader");
    const original = readFileSync(path, "utf-8");

    // Bump the stamped version past this CLI's own and edit the body, so the
    // block both looks newer AND differs from what this render would produce.
    const currentVersion = readCliVersion();
    expect(currentVersion).not.toBe("999.0.0");
    const bumped = original
      .replace(/(id="codegraph-access-v2-leader"[^>]*version=")[^"]+(")/, "$1999.0.0$2")
      .replace(
        "Apply Code discovery routing from the project instructions.",
        "Apply Code discovery routing from the project instructions (edited by a future navori).",
      );
    expect(bumped).not.toBe(original);
    writeFileSync(path, bumped);

    const r = renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true })));
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(bumped);

    const skip = r.skipped.find((s) => s.path === ".claude/agents/leader.md");
    expect(skip?.status).toBe("downgrade-skipped");
    expect(r.written.some((w) => w.path === ".claude/agents/leader.md")).toBe(false);
  });
});

describe("R10 — no lifecycle/session/index artifacts ship for either plugin", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-lifecycle-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("no codegraph/tgrep script, hook, or bare Bash(tgrep *) rule reaches the rendered output", () => {
    renderClaudeEngine(cwd, baseConfig(pluginsFor({ codegraph: true, tgrep: true })));

    const listNames = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
    const scripts = listNames(join(cwd, ".claude/scripts"));
    const hooks = listNames(join(cwd, ".claude/hooks"));
    expect(scripts.some((f) => /codegraph|tgrep/i.test(f))).toBe(false);
    expect(hooks.some((f) => /codegraph|tgrep/i.test(f))).toBe(false);

    const settings = readSettings(cwd);
    const hookCommands = Object.values(settings.hooks ?? {}).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(hookCommands.some((c) => /codegraph|tgrep/i.test(c))).toBe(false);

    // Only the three exact tgrep permissions — never a bare wildcard (D08).
    expect(settings.permissions.allow).not.toContain("Bash(tgrep *)");
    expect(settings.permissions.allow).not.toContain("Bash(tgrep -*)");
    expect(settings.permissions.allow.some((a) => /^Bash\(codegraph /.test(a))).toBe(false);

    const mcp = readMcp(cwd)!;
    expect(mcp.mcpServers.codegraph!.args).toEqual(["serve", "--mcp"]);
    expect(JSON.stringify(mcp.mcpServers.codegraph)).not.toContain("sync");
    expect(mcp.mcpServers.tgrep).toBeUndefined();
  });
});

describe("R11 — the three managed bodies fit the 350-word budget; no pending templates", () => {
  it("core + codegraph + tgrep bodies sum to <=350 words and carry no unresolved {{placeholder}}", () => {
    const coreBody = readFileSync(
      join(getCoreRoot(), "core-assets/managed/code-discovery-routing.md"),
      "utf-8",
    );
    const codegraphBody = readFileSync(
      join(getPluginPath("codegraph"), "managed/codegraph-search-v2.md"),
      "utf-8",
    );
    const tgrepBody = readFileSync(
      join(getPluginPath("tgrep"), "managed/tgrep-search-v2.md"),
      "utf-8",
    );

    const total = countWords(coreBody) + countWords(codegraphBody) + countWords(tgrepBody);
    expect(total, `three managed bodies sum ${total} words, budget is 350`).toBeLessThanOrEqual(
      350,
    );

    for (const body of [coreBody, codegraphBody, tgrepBody]) {
      expect(body).not.toContain("{{");
    }
  });
});

describe("R12 — a minimal workspace render doesn't duplicate root-only blocks or recreate local agents", () => {
  let root: string;
  let ws: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "navori-search-v2-ws-root-"));
    ws = join(root, "apps", "svc");
    mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("workspace CLAUDE.md omits the root-only routing block; no local .claude/agents/ is created", () => {
    const cfg = baseConfig(pluginsFor({ codegraph: true }));
    renderClaudeEngine(root, cfg);
    const rootMd = readFileSync(join(root, "CLAUDE.md"), "utf-8");
    expect(openBlockCount(rootMd, "code-discovery-routing")).toBe(1);

    const r = renderClaudeEngine(ws, cfg, { repoRoot: root, harnessScope: "minimal" });
    expect(existsSync(join(ws, ".claude/agents"))).toBe(false);

    if (existsSync(join(ws, "CLAUDE.md"))) {
      const wsMd = readFileSync(join(ws, "CLAUDE.md"), "utf-8");
      expect(openBlockCount(wsMd, "code-discovery-routing")).toBe(0);
    }

    // The absent-target warning fires only when an agent is disabled in
    // config.harness (#676) — a trimmed workspace is silent, never a finding.
    const injectWarnings = r.warnings.filter(
      (w) =>
        w.includes("codegraph-access-v2") ||
        w.includes("no inyectado") ||
        w.includes("not injected"),
    );
    expect(injectWarnings).toEqual([]);
  });
});

describe("R13 — retired registries never purge the active v2 ids", () => {
  it("neither codegraph nor tgrep is registered as a retired plugin or a retired block", () => {
    expect("codegraph" in RETIRED_PLUGINS).toBe(false);
    expect("tgrep" in RETIRED_PLUGINS).toBe(false);
    expect("codegraph" in RETIRED_PLUGIN_BLOCKS).toBe(false);
    expect("tgrep" in RETIRED_PLUGIN_BLOCKS).toBe(false);
    expect(KNOWN_PLUGINS.codegraph).toBe("@navori/plugin-codegraph");
    expect(KNOWN_PLUGINS.tgrep).toBe("@navori/plugin-tgrep");
  });

  it("a genuinely retired plugin sharing a render with codegraph doesn't purge codegraph's block", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-search-v2-retired-"));
    try {
      // `cognitive` is a real retired id (RETIRED_PLUGINS) — proves the purge
      // path runs in this render without reaching the still-active v2 id.
      renderClaudeEngine(
        cwd,
        baseConfig({ ...pluginsFor({ codegraph: true }), cognitive: { enabled: true } }),
      );
      const md = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
      expect(openBlockCount(md, "codegraph-search-v2")).toBe(1);
      expect(md).not.toContain('id="cognitive-protocol"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
