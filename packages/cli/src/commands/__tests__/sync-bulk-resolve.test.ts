import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #523 — a formatter freezes the harness and only a human can unfreeze it.
 *
 * `prettier --write .` rewrites CLAUDE.md's Markdown without changing its
 * meaning, which invalidates the `hash` of EVERY managed block. navori then
 * marks them `user-modified-skipped` and stops updating them. The only
 * documented way out was `sync --interactive`, one prompt per block — which an
 * agent cannot answer, so a rollout stalls at 17 manual decisions.
 *
 * The property pinned here: `sync --accept-new --apply` brings every mangled
 * block back to the rendered version WITHOUT a single prompt and WITHOUT
 * touching the user zone. The second half is the one that matters — an
 * `--accept-new` that ate the user's own prose would be worse than the freeze.
 *
 * Prompting is not asserted by inspection: `@clack/prompts` is mocked so that
 * `select`/`confirm` THROW. If any code path prompts, these tests fail loudly.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const prompted = vi.hoisted(() => ({ count: 0 }));
vi.mock("@clack/prompts", () => {
  const boom = (): never => {
    prompted.count += 1;
    throw new Error("sync prompted the user — the bulk flags must never do that");
  };
  return {
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
    select: boom,
    confirm: boom,
    multiselect: boom,
    text: boom,
    isCancel: () => false,
  };
});

const { writeConfig } = await import("../../lib/config.ts");
const { runRender } = await import("../render.ts");
const {
  syncCommand,
  resolveBulkMode,
  buildBulkResolutions,
  summarizeConflictDiff,
  CONFLICT_DIFF_MAX_LINES,
} = await import("../sync.ts");
const { USER_SECTION_START, USER_SECTION_END } = await import("../../lib/marker.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-sync-bulk-"));
  prompted.count = 0;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Prose only the user owns. If any run loses this line, `--accept-new` is
 *  destroying more than the managed blocks it was pointed at. */
const USER_SENTINEL = "## Mi dominio\n\nEsta linea es MIA y jamas debe desaparecer.";

interface SyncJson {
  command: string;
  ok: boolean;
  reason?: string;
  mode: string;
  resolution: string | null;
  targets: Array<{
    label: string;
    claudeMd: Array<{ id: string; status: string }>;
  }>;
  conflicts: Array<{ path: string; reason: string; kind?: string }>;
  pending: number;
  written: number;
  backups: Array<{ label: string; path: string }>;
}

type SyncRunner = NonNullable<typeof syncCommand.run>;
type SyncArgs = Parameters<SyncRunner>[0]["args"];

/** Invoke the real `sync` command in-process and return whatever it printed to
 *  stdout parsed as JSON (`--json` is always on: it is the only mode that is
 *  guaranteed prompt-free by construction, so an accidental prompt in the human
 *  path shows up through the clack mock instead of hanging the suite). */
async function runSyncJson(flags: Record<string, unknown>): Promise<SyncJson> {
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    out.push(String(line));
  });
  try {
    await syncCommand.run?.({
      rawArgs: [],
      cmd: syncCommand,
      args: { _: [], cwd, json: true, ...flags } as unknown as SyncArgs,
    });
  } finally {
    spy.mockRestore();
  }
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!) as SyncJson;
}

/** Invoke `sync` in human (non-`--json`) mode. Any prompt throws via the mock. */
async function runSyncHuman(flags: Record<string, unknown>): Promise<void> {
  await syncCommand.run?.({
    rawArgs: [],
    cmd: syncCommand,
    args: { _: [], cwd, ...flags } as unknown as SyncArgs,
  });
}

/**
 * One `prettier --write .` pass over CLAUDE.md, faithful to #523: rewrite the
 * Markdown INSIDE every managed block (emphasis `*x*` → `_x_`, plus a blank line
 * after the block's first line — prettier normalizes both) and leave the markers
 * themselves untouched. Semantics unchanged, every `hash=` invalidated.
 */
function simulateFormatter(content: string): string {
  return content.replace(
    /(<!-- navori:managed id="[^"]+"[^>]*-->\n)([\s\S]*?)(<!-- \/navori:managed)/g,
    (_full: string, open: string, body: string, close: string) => {
      const rewritten = body.replace(/\*([^*\n]+)\*/g, "_$1_");
      const [first, ...rest] = rewritten.split("\n");
      return `${open}${[first, "", ...rest].join("\n")}${close}`;
    },
  );
}

/** Rendered repo whose CLAUDE.md carries a user zone with `USER_SENTINEL` and
 *  whose managed blocks have all been through the formatter. */
function seedFrozenRepo(): { claudeMdPath: string; mangled: string } {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    preset: "custom",
    engines: ["claude"],
  });
  const rendered = runRender(cwd, { dryRun: false });
  expect(rendered.ok).toBe(true);

  const claudeMdPath = join(cwd, "CLAUDE.md");
  const original = readFileSync(claudeMdPath, "utf-8");

  // Put the user's own prose inside the user zone the render seeded.
  const start = original.indexOf(USER_SECTION_START);
  const end = original.indexOf(USER_SECTION_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const withUserProse =
    original.slice(0, start + USER_SECTION_START.length) +
    `\n\n${USER_SENTINEL}\n\n` +
    original.slice(end);

  const mangled = simulateFormatter(withUserProse);
  // Anti-false-green: the fixture must actually be broken before anything below
  // is allowed to claim it got fixed.
  expect(mangled).not.toBe(withUserProse);
  expect(mangled).toContain(USER_SENTINEL);

  writeFileSync(claudeMdPath, mangled, "utf-8");
  return { claudeMdPath, mangled };
}

describe("sync --accept-new / --keep-mine (#523)", () => {
  it("the seeded formatter pass really does freeze the harness (anti-false-green)", async () => {
    seedFrozenRepo();
    const plan = await runSyncJson({});
    const frozen = plan.targets[0]!.claudeMd.filter((e) => e.status === "user-modified-skipped");
    expect(frozen.length).toBeGreaterThan(0);
    expect(plan.conflicts.length).toBeGreaterThanOrEqual(frozen.length);
    // Every one of them is a CLAUDE.md block conflict, i.e. reachable by the
    // bulk flags. If this ever flips to "file", the flags stop covering #523.
    for (const conflict of plan.conflicts) {
      if (conflict.path.includes("CLAUDE.md (")) expect(conflict.kind).toBe("block");
    }
  });

  it("--accept-new --apply restores every frozen block without a prompt", async () => {
    const { claudeMdPath } = seedFrozenRepo();
    const before = await runSyncJson({});
    const frozenIds = before.targets[0]!.claudeMd.filter(
      (e) => e.status === "user-modified-skipped",
    ).map((e) => e.id);
    expect(frozenIds.length).toBeGreaterThan(0);

    const applied = await runSyncJson({ "accept-new": true, apply: true });
    expect(applied.ok).toBe(true);
    expect(applied.resolution).toBe("accept-new");
    expect(applied.written).toBeGreaterThan(0);

    // The freeze is gone: a fresh plan sees no user-modified block left.
    const after = await runSyncJson({});
    expect(after.targets[0]!.claudeMd.filter((e) => e.status === "user-modified-skipped")).toEqual(
      [],
    );
    // …and the previously frozen ids are back in the plan as up-to-date blocks.
    const afterIds = new Set(after.targets[0]!.claudeMd.map((e) => e.id));
    for (const id of frozenIds) expect(afterIds.has(id)).toBe(true);

    expect(prompted.count).toBe(0);
    expect(readFileSync(claudeMdPath, "utf-8")).toContain(USER_SENTINEL);
  });

  it("--accept-new --apply preserves the user zone byte for byte", async () => {
    const { claudeMdPath } = seedFrozenRepo();
    await runSyncJson({ "accept-new": true, apply: true });

    const after = readFileSync(claudeMdPath, "utf-8");
    const start = after.indexOf(USER_SECTION_START);
    const end = after.indexOf(USER_SECTION_END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const userZone = after.slice(start + USER_SECTION_START.length, end);
    expect(userZone.trim()).toBe(USER_SENTINEL);
  });

  it("--accept-new --apply backs CLAUDE.md up before overwriting it", async () => {
    const { mangled } = seedFrozenRepo();
    const applied = await runSyncJson({ "accept-new": true, apply: true });
    // A destructive resolution has to be recoverable: the snapshot is what makes
    // `--accept-new` a decision instead of a gamble.
    expect(applied.backups.length).toBeGreaterThan(0);
    // …and "recoverable" means the snapshot holds THE BYTES THAT WERE DESTROYED,
    // not merely that a path exists. Asserting the path alone stays green if the
    // snapshot captured the wrong file, an empty directory, or — worst — the
    // content written AFTER the overwrite. `render-gitignore-backup.test.ts:107`
    // already sets this bar one directory over; match it.
    const snapshot = join(applied.backups[0]!.path, "CLAUDE.md");
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot, "utf-8")).toBe(mangled);
  });

  it("--accept-new without --apply writes nothing", async () => {
    const { claudeMdPath, mangled } = seedFrozenRepo();
    const plan = await runSyncJson({ "accept-new": true });
    expect(plan.mode).toBe("plan");
    expect(plan.written).toBe(0);
    expect(readFileSync(claudeMdPath, "utf-8")).toBe(mangled);
    expect(prompted.count).toBe(0);
  });

  /**
   * The same guarantee through the HUMAN path, and it is not redundant: the two
   * branches compute `autoApply` independently (`sync.ts:184` for `--json`,
   * `:250` for human), so covering one leaves the other bare. Deleting the guard
   * at `sync.ts:270-273` left the whole suite green while a bare
   * `navori sync --accept-new` overwrote 11 hand-edited blocks for real.
   */
  it("--accept-new without --apply writes nothing on the human path either", async () => {
    const { claudeMdPath, mangled } = seedFrozenRepo();
    await runSyncHuman({ "accept-new": true });
    expect(readFileSync(claudeMdPath, "utf-8")).toBe(mangled);
    expect(prompted.count).toBe(0);
  });

  it("--keep-mine --apply leaves every hand-edited block exactly as it was", async () => {
    const { claudeMdPath } = seedFrozenRepo();
    const applied = await runSyncJson({ "keep-mine": true, apply: true });
    expect(applied.ok).toBe(true);
    expect(applied.resolution).toBe("keep-mine");

    // The conflicting blocks are still reported as skipped, and their mangled
    // bodies are still on disk — "keep mine" must not quietly become "accept".
    const after = await runSyncJson({});
    expect(
      after.targets[0]!.claudeMd.filter((e) => e.status === "user-modified-skipped").length,
    ).toBeGreaterThan(0);
    expect(readFileSync(claudeMdPath, "utf-8")).toContain(USER_SENTINEL);
    expect(prompted.count).toBe(0);
  });

  it("--yes --accept-new does not trip the conflicts CI gate", async () => {
    seedFrozenRepo();
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("sync exited");
    }) as never);
    const applied = await runSyncJson({ "accept-new": true, yes: true });
    expect(exit).not.toHaveBeenCalled();
    expect(applied.ok).toBe(true);
    expect(applied.reason).toBeUndefined();
    expect(applied.written).toBeGreaterThan(0);
  });

  it("--yes alone still fails on conflicts (the gate is unchanged without a bulk flag)", async () => {
    seedFrozenRepo();
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("sync exited");
    }) as never);
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    await expect(
      syncCommand.run?.({
        rawArgs: [],
        cmd: syncCommand,
        args: { _: [], cwd, json: true, yes: true } as unknown as SyncArgs,
      }),
    ).rejects.toThrow("sync exited");
    log.mockRestore();
    expect(exit).toHaveBeenCalledWith(1);
    const payload = JSON.parse(out[0]!) as SyncJson;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("conflicts-detected");
  });

  it("the human (non-json) path applies in bulk without prompting", async () => {
    const { claudeMdPath } = seedFrozenRepo();
    await runSyncHuman({ "accept-new": true, apply: true });
    expect(prompted.count).toBe(0);
    const after = await runSyncJson({});
    expect(after.targets[0]!.claudeMd.filter((e) => e.status === "user-modified-skipped")).toEqual(
      [],
    );
    expect(readFileSync(claudeMdPath, "utf-8")).toContain(USER_SENTINEL);
  });
});

describe("resolveBulkMode — contradictory invocations fail fast", () => {
  it("rejects --accept-new together with --keep-mine", () => {
    const r = resolveBulkMode({ acceptNew: true, keepMine: true, interactive: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected an error");
    expect(r.reasonCode).toBe("bulk-flags-conflict");
    expect(r.reason).toContain("--accept-new");
  });

  it("rejects a bulk flag together with --interactive", () => {
    for (const flags of [
      { acceptNew: true, keepMine: false, interactive: true },
      { acceptNew: false, keepMine: true, interactive: true },
    ]) {
      const r = resolveBulkMode(flags);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected an error");
      expect(r.reasonCode).toBe("bulk-flags-interactive");
    }
  });

  it("returns the mode, or null when no bulk flag is passed", () => {
    expect(resolveBulkMode({ acceptNew: true, keepMine: false, interactive: false })).toEqual({
      ok: true,
      mode: "accept-new",
    });
    expect(resolveBulkMode({ acceptNew: false, keepMine: true, interactive: false })).toEqual({
      ok: true,
      mode: "keep-mine",
    });
    expect(resolveBulkMode({ acceptNew: false, keepMine: false, interactive: true })).toEqual({
      ok: true,
      mode: null,
    });
  });

  it("localizes the error prose (both locales carry the keys)", () => {
    expect(
      resolveBulkMode({ acceptNew: true, keepMine: true, interactive: false }, "en"),
    ).not.toEqual(resolveBulkMode({ acceptNew: true, keepMine: true, interactive: false }, "es"));
  });
});

describe("buildBulkResolutions", () => {
  it("keep-mine resolves to an EMPTY map — the engine's own refusal is the mechanism", () => {
    // Passing skipIds instead would drop the blocks from the plan and the report
    // would stop naming the conflicts that are still on disk.
    expect(buildBulkResolutions([], "keep-mine").size).toBe(0);
    expect(buildBulkResolutions([], null).size).toBe(0);
  });
});

describe("summarizeConflictDiff — what the preview shows and what it does not", () => {
  it("counts every differing line and caps what it prints", () => {
    const actual = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const proposed = ["A", "B", "C", "D", "E", "F", "G", "H"].join("\n");
    const preview = summarizeConflictDiff(actual, proposed);
    // 8 lines differ, each producing a `-` and a `+` line.
    expect(preview.changed).toBe(16);
    expect(preview.lines).toHaveLength(CONFLICT_DIFF_MAX_LINES);
    expect(preview.hidden).toBe(16 - CONFLICT_DIFF_MAX_LINES);
    expect(preview.lines[0]).toBe("- a");
    expect(preview.lines[1]).toBe("+ A");
  });

  it("returns nothing when the bodies match", () => {
    expect(summarizeConflictDiff("same\ntext", "same\ntext")).toEqual({
      changed: 0,
      lines: [],
      hidden: 0,
    });
  });

  it("shows the emphasis rewrite that froze #523 in the first line of the preview", () => {
    const preview = summarizeConflictDiff(
      "The graph _forms_ the hypothesis",
      "The graph *forms* the hypothesis",
    );
    expect(preview.changed).toBe(2);
    expect(preview.hidden).toBe(0);
    expect(preview.lines).toEqual([
      "- The graph _forms_ the hypothesis",
      "+ The graph *forms* the hypothesis",
    ]);
  });

  it("reports a pure deletion and a pure insertion without inventing a counterpart", () => {
    expect(summarizeConflictDiff("a\nb", "a").lines).toEqual(["- b"]);
    expect(summarizeConflictDiff("a", "a\nb").lines).toEqual(["+ b"]);
  });
});
