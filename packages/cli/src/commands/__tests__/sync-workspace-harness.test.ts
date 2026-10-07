import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Spec 0043 T1 — `sync` honors `monorepo.workspaceHarness`. Before, it called
 * the Claude engine without a scope, so `sync --apply` rewrote agents, hooks and
 * settings into workspaces that `render` had trimmed.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: () => undefined,
  log: {
    message: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    step: () => undefined,
  },
  select: () => Promise.resolve("keep"),
  confirm: () => Promise.resolve(true),
  multiselect: () => Promise.reject(new Error("unexpected multiselect")),
  text: () => Promise.reject(new Error("unexpected text")),
  isCancel: () => false,
}));

const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender, countPendingRenderChanges } = await import("../render.ts");
const { syncCommand } = await import("../sync.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-sync-ws-"));
  mkdirSync(join(cwd, "apps/backend"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type SyncRunner = NonNullable<typeof syncCommand.run>;
type SyncArgs = Parameters<SyncRunner>[0]["args"];

async function runSync(flags: Record<string, unknown>): Promise<void> {
  await syncCommand.run?.({
    rawArgs: [],
    cmd: syncCommand,
    args: { _: [], cwd, ...flags } as unknown as SyncArgs,
  });
}

function writeMonorepoConfig(harness: "minimal" | "full"): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "ws-sync-demo",
    engines: ["claude"],
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [{ name: "backend", path: "apps/backend" }],
      workspaceHarness: harness,
    },
  });
}

/** Every file under `dir`, relative to it, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

describe("sync respeta workspaceHarness (spec 0043 T1)", () => {
  it("bajo `minimal`, sync no recrea lo omitido, no borra nada y el segundo render queda en cero", async () => {
    // Covers: R9
    writeMonorepoConfig("minimal");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    const ws = join(cwd, "apps/backend");
    const before = listFiles(ws);

    await runSync({ apply: true });

    expect(existsSync(join(ws, ".claude/agents"))).toBe(false);
    expect(existsSync(join(ws, ".claude/settings.json"))).toBe(false);
    expect(listFiles(ws)).toEqual(before);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });

  it("bajo `full`, sync sigue escribiendo el árbol completo del workspace", async () => {
    // Covers: R9
    writeMonorepoConfig("full");
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    const ws = join(cwd, "apps/backend");
    rmSync(join(ws, ".claude/settings.json"));

    await runSync({ apply: true });

    expect(existsSync(join(ws, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(ws, ".claude/agents"))).toBe(true);
  });

  it("bajo `minimal`, sync no recrea las omitidas y no borra nada", async () => {
    // Covers: R9
    // Un repo con las copias de un navori anterior: sync no las recrea si faltan
    // y tampoco las borra — el que reconcilia es `render`, con preview.
    writeMonorepoConfig("full");
    expect(runRender(cwd).ok).toBe(true);
    const ws = join(cwd, "apps/backend");
    writeMonorepoConfig("minimal");
    const before = listFiles(ws);
    expect(before.some((f) => f.includes("locate-code"))).toBe(true);

    await runSync({ apply: true });
    expect(listFiles(ws)).toEqual(before);

    // Y lo que `render` ya había quitado, sync no lo trae de vuelta.
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    expect(existsSync(join(ws, ".claude/skills/locate-code"))).toBe(false);
    const afterRender = listFiles(ws);
    await runSync({ apply: true });
    expect(listFiles(ws)).toEqual(afterRender);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });
});
