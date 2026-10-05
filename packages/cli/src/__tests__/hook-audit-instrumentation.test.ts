import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { buildClaudeSettings } from "../engines/claude/build-settings.ts";
import { getCoreRoot, listBundledPluginIds } from "../lib/render/bundled-assets.ts";
import { loadPlugin } from "../lib/config/plugins.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../lib/config/schema.ts";

/**
 * #778 — every hook the harness REGISTERS must be able to say that it ran.
 *
 * The audit log is the only witness a hook has: a hook that runs and lets the
 * action through is invisible to the transcript by construction, which is the
 * whole reason `_partials/audit-log.sh` exists. A registered hook WITHOUT that
 * include is therefore indistinguishable from one that never executes — it
 * cannot lose its `+x` bit, get its path renamed, or be shadowed by another
 * harness in a way anybody would notice.
 *
 * That was not hypothetical. `tgrep-session.sh` shipped without the include and
 * had ZERO recorded executions in every session log of every repo in the park,
 * across weeks. It was found by hand, by crossing the 15 registered hooks
 * against the log — the same accident that found `routing-watch` inert in #767.
 * This test is that cross-check, run on every commit, so the NEXT plugin hook
 * cannot be born invisible.
 *
 * It reads the REGISTRY, not a directory listing: what matters is what
 * `settings.json` wires up, whether it comes from core, from a plugin's
 * `hooks[]`, or from a `settingsFragment` that merges hooks in directly.
 */

/** Hooks exempt from the include, each because it IS the recorder. */
const RECORDER_HOOKS = new Map<string, string>([
  [
    "audit-mode-trigger.sh",
    "writes the `start`/`prompt` records itself — it is the command that CREATES the session log, so a generic recorder inlined into it would record the act of starting to record",
  ],
  ["audit-mode-close.sh", "writes the `session-end` record itself, which is the log's own seal"],
]);

/** A config that turns on every optional hook, so nothing escapes by being off. */
function fullConfig(pluginIds: string[]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "fx",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    // `verifyOnStop` gates `stop-verify-reminder.sh`, which is opt-in and would
    // otherwise never appear in a settings object built from a default config.
    hooks: { verifyOnStop: true },
    // `plan-gate.sh` is only registered under `harness.planTiers` (spec 0032).
    harness: { planTiers: true },
    plugins: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
  });
}

/** Every `command` string under `settings.hooks`, whatever its event shape. */
function registeredCommands(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === "string") out.push(record.command);
    for (const value of Object.values(record)) walk(value);
  };
  walk(settings.hooks);
  return out;
}

describe("every registered hook carries the audit-log include (#778)", () => {
  // Covers: R8, R9
  it("exits capture-start before the historical handoff recorder and stamp", () => {
    const hook = expandHookIncludes(
      readFileSync(join(getCoreRoot(), "core-assets/hooks/subagent-stop-handoff.sh"), "utf-8"),
    );
    const exit = hook.indexOf('[ "${2:-}" != capture-start ] || exit 0');
    expect(exit).toBeGreaterThan(hook.indexOf("nv_engine=codex"));
    expect(exit).toBeLessThan(hook.indexOf("navori_handoff_key="));
    expect(exit).toBeLessThan(hook.indexOf("trap navori_audit_on_exit EXIT"));
    expect(hook).toContain('[ -f "$audit_root/$repo/session-$root_id.log" ] || return 0');
  });
  const pluginIds = listBundledPluginIds();
  const plugins = pluginIds.map((id) => loadPlugin(id));
  const settings = buildClaudeSettings(fullConfig(pluginIds), plugins);
  const commands = registeredCommands(settings);

  /** `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` → `x.sh`. */
  const scriptNames = [
    ...new Set(
      commands
        .map((c) => /\.claude\/(?:hooks|scripts)\/([A-Za-z0-9._-]+\.sh)/.exec(c)?.[1])
        .filter((n): n is string => Boolean(n)),
    ),
  ].sort();

  /** Where each registered script's SOURCE asset lives. `scriptAssets[].src` is
   *  already absolute (see `LoadedPlugin`), so it is used verbatim. */
  function sourcePath(name: string): string | null {
    const core = join(getCoreRoot(), "core-assets/hooks", name);
    if (existsSync(core)) return core;
    for (const plugin of plugins) {
      const script = plugin.scriptAssets.find((s) => basename(s.dest) === name);
      if (script && existsSync(script.src)) return script.src;
    }
    return null;
  }

  it("registers the hooks this harness is known to wire", () => {
    // A guard on the guard: if the extraction regex ever stops matching, every
    // assertion below would pass over an EMPTY list and the test would go green
    // while checking nothing.
    expect(scriptNames.length).toBeGreaterThanOrEqual(12);
    // One from each source, because the include rule applies to both: a core
    // hook and a plugin-contributed one.
    expect(scriptNames).toContain("guard-destructive.sh");
    // Covers: R25 — the gate that can deny a dispatch must be able to say it ran.
    expect(scriptNames).toContain("plan-gate.sh");
    expect(scriptNames).toContain("check-jscpd.sh");
  });

  it("resolves every registered hook to a source asset", () => {
    const unresolved = scriptNames.filter((name) => sourcePath(name) === null);
    expect(unresolved, "registered hooks with no source asset on disk").toEqual([]);
  });

  it("has the include in every registered hook that is not the recorder itself", () => {
    const missing: string[] = [];
    for (const name of scriptNames) {
      if (RECORDER_HOOKS.has(name)) continue;
      const path = sourcePath(name);
      if (!path) continue; // reported by the test above
      const body = readFileSync(path, "utf-8");
      if (!/^[^\S\n]*#\s*navori:include\s+audit-log[^\S\n]*$/m.test(body)) missing.push(name);
    }
    expect(
      missing,
      `these hooks are registered in settings.json but have no '# navori:include audit-log', ` +
        `so they can run for months with zero recorded executions and nothing would notice ` +
        `(that is exactly how a plugin's SessionStart hook once shipped invisible): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest — a recorder that is no longer registered", () => {
    // An exemption that names a hook nobody registers any more is a hole the
    // next reader would inherit without a reason attached to it.
    const stale = [...RECORDER_HOOKS.keys()].filter((name) => !scriptNames.includes(name));
    expect(stale, "exempt hooks that are no longer registered").toEqual([]);
  });
});

/** Runs an expanded core hook under bash with an isolated audit root and TMPDIR. */
describe("spec 0039 hook behavior (R25, R26)", () => {
  const HOOKS = join(getCoreRoot(), "core-assets/hooks");
  let root: string;

  function install(name: string): string {
    const path = join(root, `installed-${name}`);
    writeFileSync(path, expandHookIncludes(readFileSync(join(HOOKS, name), "utf-8")));
    chmodSync(path, 0o755);
    return path;
  }

  function run(script: string, input: string, extraPath = ""): { out: string; code: number } {
    try {
      const out = execFileSync("bash", [script], {
        input,
        encoding: "utf-8",
        cwd: root,
        env: {
          ...process.env,
          NAVORI_AUDITS_ROOT: join(root, "audits"),
          CLAUDE_PROJECT_DIR: root,
          TMPDIR: root,
          PATH: `${extraPath}${extraPath ? ":" : ""}${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { out: e.stdout ?? "", code: e.status ?? -1 };
    }
  }

  function records(): Array<Record<string, unknown>> {
    const log = join(root, "audits", "fx", "session-sess1.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function activate(): void {
    mkdirSync(join(root, "audits", "fx"), { recursive: true });
    writeFileSync(
      join(root, "audits", "fx", "session-sess1.log"),
      `${JSON.stringify({ event: "start", cwd: root, repo: "fx" })}\n`,
    );
  }

  /** A fake `navori` whose `plan gate` exits with `code` after draining stdin. */
  function fakeNavori(code: number): string {
    const bin = join(root, `bin${code}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "navori"),
      `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--record-metadata")) {
  const field = name => args[args.indexOf(name) + 1];
  const record = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.appendFileSync(path.join(field("--root"), field("--repo"), "session-" + field("--root-session") + ".log"), JSON.stringify(record) + "\\n");
  process.exit(0);
}
fs.readFileSync(0);
process.exit(${code});
`,
    );
    chmodSync(join(bin, "navori"), 0o755);
    return bin;
  }

  const gatePayload = (): string =>
    JSON.stringify({
      session_id: "sess1",
      cwd: root,
      tool_input: { subagent_type: "implementer" },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "navori-0039-"));
    // The audit recorder derives the repo name from `cwd`; name the dir to match.
    const named = join(root, "fx");
    mkdirSync(named);
    root = named;
  });
  afterEach(() => {
    rmSync(dirname(root), { recursive: true, force: true });
  });

  // Covers: R25
  it("plan-gate records a block verdict and keeps exit 2", () => {
    activate();
    const r = run(install("plan-gate.sh"), gatePayload(), fakeNavori(2));
    expect(r.code).toBe(2);
    const rec = records().find((e) => e.name === "plan-gate");
    expect(rec).toMatchObject({ event: "hook", phase: "PreToolUse", verdict: "block" });
    expect(rec).toHaveProperty("ms");
  });

  // Covers: R25
  it("plan-gate records an allow verdict and keeps exit 0", () => {
    activate();
    const r = run(install("plan-gate.sh"), gatePayload(), fakeNavori(0));
    expect(r.code).toBe(0);
    expect(records().find((e) => e.name === "plan-gate")).toMatchObject({ verdict: "allow" });
  });

  const stopPayload = (): string => JSON.stringify({ session_id: "sess1", cwd: root });
  function handoff(body: string): void {
    mkdirSync(join(root, ".claude", "progress"), { recursive: true });
    writeFileSync(join(root, ".claude", "progress", "impl_f.md"), body);
  }

  // Covers: R26
  it("subagent-stop-handoff warns once per (path, content) and again when content changes", () => {
    activate();
    const hook = install("subagent-stop-handoff.sh");
    handoff("# report\n\nwork done\n");
    expect(run(hook, stopPayload()).out).toContain("systemMessage");
    expect(run(hook, stopPayload()).out).toBe("");
    // Same problem, different bytes: a rewrite is news.
    handoff("# report\n\nwork done, rewritten\n");
    expect(run(hook, stopPayload()).out).toContain("systemMessage");
    expect(run(hook, stopPayload()).out).toBe("");
  });
});
