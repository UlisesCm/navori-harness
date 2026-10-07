import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writeConfig } from "../../lib/config/config.ts";
import { runRender } from "../render.ts";
import { computeRenderPending, statusCommand } from "../status.ts";

/**
 * #1143: `status` reported `drift: 0` while `render` would create/remove files,
 * because drift only reads markers already on disk. `renderPending` comes from a
 * dry-run of the same render engine.
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-status-render-pending-"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "pending-a",
    engines: ["claude", "agents-md"],
    preset: "custom",
    qualityGate: { fast: "pnpm lint", full: "pnpm test" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

/** Every file under `dir` mapped to its bytes, to prove nothing was written. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, "latin1"));
    }
  };
  walk(dir);
  return out;
}

async function statusJson(): Promise<Record<string, unknown>> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  // citty's `run` takes a context this command only reads `args` from.
  await (statusCommand.run as (ctx: unknown) => Promise<void>)({
    args: { cwd, json: true },
  });
  return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

describe("status renderPending (#1143)", () => {
  // Covers: A1
  it("counts files render would create while drift stays 0", async () => {
    expect(runRender(cwd).ok).toBe(true);
    unlinkSync(join(cwd, "AGENTS.md"));

    const json = await statusJson();
    expect(json.drift).toBe(0);
    expect(json.renderPending as number).toBeGreaterThan(0);
  });

  // Covers: A1
  it("is 0 for an up-to-date repo and adds no pending step", async () => {
    expect(runRender(cwd).ok).toBe(true);

    const json = await statusJson();
    expect(json.renderPending).toBe(0);
    expect((json.nextSteps as string[]).some((s) => s.includes("would change"))).toBe(false);
  });

  // Covers: A2
  it("suggests previewing before applying when renderPending > 0", async () => {
    expect(runRender(cwd).ok).toBe(true);
    unlinkSync(join(cwd, "AGENTS.md"));

    const json = await statusJson();
    const steps = json.nextSteps as string[];
    expect(steps.some((s) => s.includes("'navori render'") && s.includes("render --apply"))).toBe(
      true,
    );
  });

  // Covers: A2
  it("is null when the repo was never rendered", async () => {
    expect(computeRenderPending(cwd, false)).toBeNull();
    const json = await statusJson();
    expect(json.renderPending).toBeNull();
  });

  // Covers: A2
  it("is null (no crash) when the dry run cannot read the config", () => {
    writeFileSync(join(cwd, "navori.config.json"), "{ not json");
    expect(computeRenderPending(cwd, true)).toBeNull();
  });

  // Covers: A1
  it("leaves every file byte-identical (dry run writes nothing)", () => {
    expect(runRender(cwd).ok).toBe(true);
    unlinkSync(join(cwd, "AGENTS.md"));
    const before = snapshot(cwd);

    expect(computeRenderPending(cwd, true)).toBeGreaterThan(0);

    expect(snapshot(cwd)).toEqual(before);
  });

  // Covers: A1
  it("counts a workspace skill to create AND a retired root library skill, tree untouched", async () => {
    const base = {
      name: "pending-mono",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "turbo" as const,
        // Con gate propio, `verify-before-done` difiere de la raíz y el workspace la
        // conserva (spec 0043): sigue habiendo una skill de workspace que re-crear.
        workspaces: [
          {
            name: "backend",
            path: "apps/backend",
            qualityGate: { fast: "pnpm lint", full: "pnpm test" },
          },
        ],
        workspaceHarness: "minimal" as const,
      },
    };
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    // Render with a declared library, then undeclare it: its root skill keeps a
    // valid navori marker that render would now retire (removed-condition-false).
    writeConfig(join(cwd, "navori.config.json"), { ...base, project: { libraries: ["vitest"] } });
    expect(runRender(cwd).ok).toBe(true);
    writeConfig(join(cwd, "navori.config.json"), base);
    // ...and a workspace skill that render would re-create.
    rmSync(join(cwd, "apps/backend/.claude/skills/verify-before-done"), { recursive: true });
    const before = snapshot(cwd);

    const json = await statusJson();

    expect(json.drift).toBe(0);
    expect(json.renderPending as number).toBeGreaterThanOrEqual(2);
    expect(snapshot(cwd)).toEqual(before);
  });

  // Covers: R3, R9
  it("after updating to this version with duplicated copies, pending is > 0; after applying, 0 and drift 0", async () => {
    const mono = (harness: "full" | "minimal") => ({
      name: "pending-dedup",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "turbo" as const,
        workspaces: [{ name: "backend", path: "apps/backend" }],
        workspaceHarness: harness,
      },
    });
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    // The tree an older navori left: every skill duplicated into the workspace.
    writeConfig(join(cwd, "navori.config.json"), mono("full"));
    expect(runRender(cwd).ok).toBe(true);
    writeConfig(join(cwd, "navori.config.json"), mono("minimal"));

    const before = await statusJson();
    expect(before.renderPending as number).toBeGreaterThan(0);

    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    const after = await statusJson();
    expect(after.renderPending).toBe(0);
    expect(after.drift).toBe(0);
  });
});
