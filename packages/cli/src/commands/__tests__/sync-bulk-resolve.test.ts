import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

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

const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender } = await import("../render.ts");
const {
  syncCommand,
  resolveBulkMode,
  conflictsBlockYes,
  buildBulkResolutions,
  summarizeConflictDiff,
  CONFLICT_DIFF_MAX_LINES,
} = await import("../sync.ts");
const { USER_SECTION_START, USER_SECTION_END } = await import("../../lib/render/marker.ts");

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
  acceptNewFiles: boolean;
  detail?: string;
  targets: Array<{
    label: string;
    claudeMd: Array<{ id: string; status: string }>;
  }>;
  conflicts: Array<{ path: string; reason: string; kind?: string; resolvable?: string }>;
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
      acceptFiles: false,
    });
    expect(resolveBulkMode({ acceptNew: false, keepMine: true, interactive: false })).toEqual({
      ok: true,
      mode: "keep-mine",
      acceptFiles: false,
    });
    expect(resolveBulkMode({ acceptNew: false, keepMine: false, interactive: true })).toEqual({
      ok: true,
      mode: null,
      acceptFiles: false,
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

describe("sync --accept-new-files (#1240)", () => {
  const SENTINEL = "FILE USER ZONE — never touched";

  /** Rendered repo (+ optional plugins) with ONE agent file hand-edited inside its block. */
  function seedEditedAgent(plugins?: Record<string, unknown>): {
    agent: string;
    pristine: string;
    edited: string;
  } {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      preset: "custom",
      engines: ["claude"],
      ...(plugins ? { plugins } : {}),
    } as Parameters<typeof writeConfig>[1]);
    expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
    const dir = join(cwd, ".claude", "agents");
    const name = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()[0]!;
    const agent = join(dir, name);
    const pristine = `${readFileSync(agent, "utf-8").trimEnd()}\n\n${SENTINEL}\n`;
    writeFileSync(agent, pristine, "utf-8");
    const edited = pristine.replace(/(<!-- navori:managed [^>]*-->\n)/, "$1HAND EDIT\n");
    expect(edited).not.toBe(pristine);
    writeFileSync(agent, edited, "utf-8");
    return { agent, pristine, edited };
  }

  /** Run `sync --json` expecting `process.exit(1)`; returns the JSON it printed first. */
  async function runSyncJsonFailing(flags: Record<string, unknown>): Promise<SyncJson> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    try {
      await expect(
        syncCommand.run?.({
          rawArgs: [],
          cmd: syncCommand,
          args: { _: [], cwd, json: true, ...flags },
        } as never),
      ).rejects.toThrow("exit");
    } finally {
      spy.mockRestore();
    }
    return JSON.parse(lines[0] ?? "{}") as SyncJson;
  }

  /** Make `process.exit` throw so a failing run can be asserted, not exited. */
  function trapExit(): void {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
  }

  // Covers: A3 — resolvable is reported, bodies never leak.
  it("--json reports resolvable:'bulk' for a marker-carrying file and never file contents", async () => {
    seedEditedAgent();
    const plan = await runSyncJson({});
    expect(plan.acceptNewFiles).toBe(false);
    const file = plan.conflicts.find((c) => c.kind === "file");
    expect(file?.resolvable).toBe("bulk");
    expect(Object.keys(file ?? {}).sort()).toEqual(["kind", "path", "reason", "resolvable"]);
    expect(JSON.stringify(plan)).not.toContain("HAND EDIT");
    expect(JSON.stringify(plan)).not.toMatch(/"(basis|content)"/);
  });

  // Covers: A3 — writes with --apply, post-resolution state, user zone + backup.
  it("--accept-new-files --apply restores the file, keeps the user zone, backs up, reports post-resolution state", async () => {
    const { agent, pristine, edited } = seedEditedAgent();

    const out = await runSyncJson({ "accept-new-files": true, apply: true });

    expect(out.ok).toBe(true);
    expect(out.acceptNewFiles).toBe(true);
    expect(readFileSync(agent, "utf-8")).toBe(pristine);
    expect(out.written).toBeGreaterThanOrEqual(1);
    expect(out.conflicts).toEqual([]); // post-resolution, not the stale plan
    const backup = out.backups.find((b) => b.label === "root:sync");
    expect(backup).toBeDefined();
    expect(
      readFileSync(join(backup!.path, ".claude/agents", agent.split("/").pop()!), "utf-8"),
    ).toBe(edited);
    expect(prompted.count).toBe(0);
    // Convergence: nothing left to resolve.
    expect((await runSyncJson({})).conflicts).toEqual([]);
  });

  it("--accept-new alone still leaves whole files untouched (CI semantics unchanged)", async () => {
    const { agent, edited } = seedEditedAgent();
    const out = await runSyncJson({ "accept-new": true, apply: true, yes: true });
    expect(out.ok).toBe(true);
    expect(readFileSync(agent, "utf-8")).toBe(edited);
    expect(out.conflicts.some((c) => c.kind === "file")).toBe(true);
  });

  // Covers: A3 — never writes without --apply/--yes.
  it("--accept-new-files without --apply/--yes is a preview and writes nothing", async () => {
    const { agent, edited } = seedEditedAgent();
    await runSyncHuman({ "accept-new-files": true });
    expect(readFileSync(agent, "utf-8")).toBe(edited);
    const json = await runSyncJson({ "accept-new-files": true });
    expect(json.mode).toBe("plan");
    expect(readFileSync(agent, "utf-8")).toBe(edited);
  });

  it("--dry-run never writes, even with --accept-new-files --apply", async () => {
    const { agent, edited } = seedEditedAgent();
    await runSyncJson({ "accept-new-files": true, apply: true, "dry-run": true });
    expect(readFileSync(agent, "utf-8")).toBe(edited);
  });

  it("--yes --accept-new-files resolves file-only conflicts (human mode, no prompt)", async () => {
    const { agent, pristine } = seedEditedAgent();
    await runSyncHuman({ "accept-new-files": true, yes: true });
    expect(readFileSync(agent, "utf-8")).toBe(pristine);
  });

  // Covers: A3 — unanswered block conflicts still fail --yes (both paths).
  it("--yes --accept-new-files with an unanswered CLAUDE.md block conflict exits 1 and writes nothing", async () => {
    const { agent, edited } = seedEditedAgent();
    const claudeMd = join(cwd, "CLAUDE.md");
    const mangled = simulateFormatter(readFileSync(claudeMd, "utf-8"));
    writeFileSync(claudeMd, mangled, "utf-8");
    trapExit();

    await expect(runSyncHuman({ "accept-new-files": true, yes: true })).rejects.toThrow("exit");
    const failed = await runSyncJsonFailing({ "accept-new-files": true, yes: true });
    expect(failed).toMatchObject({ ok: false, reason: "conflicts-detected" });
    expect(readFileSync(agent, "utf-8")).toBe(edited);
    expect(readFileSync(claudeMd, "utf-8")).toBe(mangled);
  });

  it("conflictsBlockYes: block needs a bulk mode, files are answered by the flag", () => {
    const file = { kind: "file" } as Parameters<typeof conflictsBlockYes>[0][number];
    const block = { kind: "block" } as Parameters<typeof conflictsBlockYes>[0][number];
    expect(conflictsBlockYes([file], null, false)).toBe(true); // today's CI gate
    expect(conflictsBlockYes([file], null, true)).toBe(false);
    expect(conflictsBlockYes([block, file], null, true)).toBe(true);
    expect(conflictsBlockYes([block, file], "accept-new", true)).toBe(false);
    expect(conflictsBlockYes([], null, false)).toBe(false);
  });

  // Covers: A3 — contradictory combinations exit 1 (human + json).
  it.each([
    [{ "keep-mine": true }, "bulk-flags-conflict"],
    [{ interactive: true }, "bulk-flags-interactive"],
  ])("--accept-new-files with %j exits 1 with a stable reason", async (flags, reason) => {
    seedEditedAgent();
    trapExit();
    await expect(runSyncHuman({ "accept-new-files": true, ...flags })).rejects.toThrow("exit");
    const failed = await runSyncJsonFailing({ "accept-new-files": true, ...flags });
    expect(failed).toMatchObject({ ok: false, reason });
  });

  it("resolveBulkMode: --accept-new-files combines with --accept-new, rejects --keep-mine/--interactive", () => {
    const base = { acceptNew: false, keepMine: false, interactive: false };
    expect(resolveBulkMode({ ...base, acceptNew: true, acceptNewFiles: true })).toEqual({
      ok: true,
      mode: "accept-new",
      acceptFiles: true,
    });
    for (const [flag, code] of [
      ["keepMine", "bulk-flags-conflict"],
      ["interactive", "bulk-flags-interactive"],
    ] as const) {
      const r = resolveBulkMode({ ...base, [flag]: true, acceptNewFiles: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonCode).toBe(code);
    }
  });

  // Covers: scope — markerless files are never swept by the flag.
  it("a markerless user-edited plugin script is reported resolvable:'none' and left untouched", async () => {
    seedEditedAgent({ jscpd: { enabled: true } });
    const script = join(cwd, ".claude/scripts/check-jscpd.sh");
    const markerless = `${readFileSync(script, "utf-8")
      .split("\n")
      .filter((l) => !l.includes("navori:managed"))
      .join("\n")}\n# user line\n`;
    writeFileSync(script, markerless, "utf-8");

    const out = await runSyncJson({ "accept-new-files": true, apply: true });

    expect(readFileSync(script, "utf-8")).toBe(markerless);
    const left = out.conflicts.filter((c) => c.resolvable === "none");
    expect(left.some((c) => c.path.includes("check-jscpd.sh"))).toBe(true);
  });

  // Covers: I1 — anti-rollback holds through the flag.
  it("a block from a NEWER navori edited by hand is never overwritten by the flag", async () => {
    const { agent } = seedEditedAgent();
    const newer = readFileSync(agent, "utf-8").replace(/version="[^"]*"/, 'version="999.0.0"');
    writeFileSync(agent, newer, "utf-8");

    const out = await runSyncJson({ "accept-new-files": true, apply: true });

    expect(readFileSync(agent, "utf-8")).toBe(newer);
    expect(out.conflicts.some((c) => c.path.includes(agent.split("/").pop()!))).toBe(false);
  });
});
