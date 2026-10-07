import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * #1240 — `sync` resolves whole-file conflicts of user-edited managed files
 * that still carry a navori marker: diff + keep/accept, written through
 * `commitWrites` with a backup. #1245 adds the interactive-only replace of a
 * markerless file (see the second describe).
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

interface SelectOptions {
  message: string;
  options: Array<{ value: string; label: string }>;
  initialValue?: string;
}
const ui = vi.hoisted(() => ({
  selectCalls: [] as SelectOptions[],
  /** Answers handed out in order, one per `select`; falls back to "keep". */
  answers: [] as string[],
  /** Runs after each `select` call is recorded (1-based call number). */
  onSelect: undefined as undefined | ((call: number) => void),
  /** 1-based select call that the user cancels (Ctrl-C), or 0 for none. */
  cancelAt: 0,
  warns: [] as string[],
  messages: [] as string[],
  cancels: [] as string[],
}));
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: (m: string) => {
    ui.cancels.push(m);
  },
  log: {
    message: (m: string) => {
      ui.messages.push(m);
    },
    info: () => undefined,
    warn: (m: string) => {
      ui.warns.push(m);
    },
    error: () => undefined,
    success: () => undefined,
    step: () => undefined,
  },
  select: (opts: SelectOptions) => {
    ui.selectCalls.push(opts);
    ui.onSelect?.(ui.selectCalls.length);
    if (ui.cancelAt === ui.selectCalls.length) return Promise.resolve(Symbol.for("cancel"));
    return Promise.resolve(ui.answers.shift() ?? "keep");
  },
  confirm: () => Promise.resolve(true),
  multiselect: () => Promise.reject(new Error("unexpected multiselect")),
  text: () => Promise.reject(new Error("unexpected text")),
  isCancel: (v: unknown) => v === Symbol.for("cancel"),
}));

const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender } = await import("../render.ts");
const { syncCommand, applyFileResolutions } = await import("../sync.ts");
const { tc } = await import("../../lib/i18n.ts");

type ResolvableConflict = Parameters<typeof applyFileResolutions>[0][number];

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-sync-resolve-"));
  ui.selectCalls = [];
  ui.answers = [];
  ui.onSelect = undefined;
  ui.cancelAt = 0;
  ui.warns = [];
  ui.messages = [];
  ui.cancels = [];
});

afterEach(() => {
  for (const dir of [cwd, home.dir]) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Run the real `sync` in-process with the target dir pinned to the test repo. */
const runSync = async (flags: Record<string, unknown>): Promise<void> => {
  const args = { _: [], cwd, ...flags };
  await syncCommand.run?.({ rawArgs: [], cmd: syncCommand, args } as never);
};

interface SyncJson {
  conflicts: Array<{ path: string; kind: string }>;
  pending: number;
}

async function runSyncJson(flags: Record<string, unknown>): Promise<SyncJson> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    out.push(String(line));
  });
  await runSync({ json: true, ...flags });
  return JSON.parse(out[0] ?? "{}") as SyncJson;
}

const SENTINEL = "USER NOTES SENTINEL — never touched by sync";

function seed(plugins?: Record<string, unknown>, engines: string[] = ["claude"]): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    preset: "custom",
    engines,
    ...(plugins ? { plugins } : {}),
  } as Parameters<typeof writeConfig>[1]);
  expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
}

/** Absolute paths of the rendered agent files, sorted. */
function agentFiles(): string[] {
  const dir = join(cwd, ".claude", "agents");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

/** Append a user zone, then hand-edit the managed block. Returns the pristine text. */
function editAgent(path: string): { pristine: string; edited: string } {
  const pristine = readFileSync(path, "utf-8");
  const withUser = `${pristine.trimEnd()}\n\n${SENTINEL}\n`;
  // The user zone is part of the file render keeps; the pristine reference for
  // "what the block should be" is the file before the edit.
  writeFileSync(path, withUser, "utf-8");
  const edited = withUser.replace(/(<!-- navori:managed [^>]*-->\n)/, "$1HAND EDIT\n");
  expect(edited).not.toBe(withUser);
  writeFileSync(path, edited, "utf-8");
  return { pristine: withUser, edited };
}

describe("sync interactive: resolve a user-edited managed file (#1240)", () => {
  // Covers: I2, I6 — accept writes the rendered block, keeps the user zone, backs up.
  it("accept replaces only the managed block, keeps the user zone, backs up the old bytes", async () => {
    seed();
    const [agent] = agentFiles();
    const { pristine, edited } = editAgent(agent!);
    ui.answers = ["accept"];

    await runSync({ interactive: true });

    const after = readFileSync(agent!, "utf-8");
    expect(after).toBe(pristine);
    expect(after).toContain(SENTINEL);
    expect(after).not.toContain("HAND EDIT");
    // The diff was shown before asking.
    expect(ui.messages.some((m) => m.includes("HAND EDIT"))).toBe(true);
    // Backup (label `<target>:sync`) holds the hand-edited bytes.
    const line = ui.messages.find((m) => m.includes("[root:sync]"));
    expect(line).toBeDefined();
    const backupDir = stripVTControlCharacters(line!.split("[root:sync]")[1]!).trim();
    expect(readFileSync(join(backupDir, ".claude/agents", agent!.split("/").pop()!), "utf-8")).toBe(
      edited,
    );
  });

  // Covers: I3 — keep writes nothing.
  it("keep leaves the file byte-identical and says it stays", async () => {
    seed();
    const [agent] = agentFiles();
    const { edited } = editAgent(agent!);
    ui.answers = ["keep"];

    await runSync({ interactive: true });

    expect(readFileSync(agent!, "utf-8")).toBe(edited);
    expect(ui.warns).toContain(tc("es").sync.fileConflictsKept(1));
  });

  // Covers: I3 — cancel mid-prompts writes nothing, not even the accepted ones.
  it("cancel at a later prompt writes nothing (earlier accepts are discarded)", async () => {
    seed();
    const [a, b] = agentFiles();
    const ea = editAgent(a!);
    const eb = editAgent(b!);
    ui.answers = ["accept", "accept"];
    ui.cancelAt = 2;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(runSync({ interactive: true })).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(0);
    expect(readFileSync(a!, "utf-8")).toBe(ea.edited);
    expect(readFileSync(b!, "utf-8")).toBe(eb.edited);
  });

  // Covers: I4 — a file changed after the diff is dropped, the others still proceed.
  it("TOCTOU: a file edited again after the diff is dropped with a warning; the other is written", async () => {
    seed();
    const [a, b] = agentFiles();
    const ea = editAgent(a!);
    const eb = editAgent(b!);
    ui.answers = ["accept", "accept"];
    // After the LAST prompt, the user touches file `a` once more.
    ui.onSelect = (call) => {
      if (call === 2) writeFileSync(a!, `${ea.edited}\nlate edit\n`, "utf-8");
    };

    await runSync({ interactive: true });

    expect(readFileSync(a!, "utf-8")).toBe(`${ea.edited}\nlate edit\n`);
    expect(readFileSync(b!, "utf-8")).toBe(eb.pristine);
    expect(ui.warns.some((w) => w.includes(".claude/agents/") && w.includes("cambió"))).toBe(true);
  });

  // Covers: I4 — lstat at write time: a file swapped for a symlink is never written through.
  it("a file replaced by a symlink after the diff is dropped, the link target untouched", async () => {
    seed();
    const [agent] = agentFiles();
    const { edited } = editAgent(agent!);
    ui.answers = ["accept"];
    const real = join(cwd, "elsewhere.txt");
    ui.onSelect = () => {
      renameSync(agent!, real);
      symlinkSync(real, agent!);
    };

    await runSync({ interactive: true });

    expect(readFileSync(real, "utf-8")).toBe(edited);
    expect(ui.warns.some((w) => w.includes("cambió"))).toBe(true);
  });

  // Covers: I7 — after accept, sync converges to zero conflicts for that file.
  it("converges: a second sync reports no conflict for the accepted file", async () => {
    seed();
    const [agent] = agentFiles();
    editAgent(agent!);
    ui.answers = ["accept"];
    await runSync({ interactive: true });

    const second = await runSyncJson({});
    expect(second.conflicts).toEqual([]);
  });
});

describe("applyFileResolutions partial failure (#1240)", () => {
  function conflictFor(label: string, dir: string, content: string): ResolvableConflict {
    mkdirSync(dir, { recursive: true });
    const absPath = join(dir, "f.txt");
    writeFileSync(absPath, "old", "utf-8");
    return {
      path: `${label}/f.txt`,
      reason: "r",
      kind: "file",
      label,
      cwd: dir,
      resolution: { absPath, basis: "old", content },
    };
  }

  it("earlier targets stay written (with backup); the failing target reports and stops", () => {
    const a = conflictFor("a", join(cwd, "ta"), "new-a");
    const b = conflictFor("b", join(cwd, "tb"), "new-b");
    const c = conflictFor("c", join(cwd, "tc"), "new-c");
    chmodSync(join(cwd, "tb"), 0o555); // writes into target b fail

    try {
      const outcome = applyFileResolutions([a, b, c]);
      expect(outcome.applied).toEqual([a]);
      expect(readFileSync(a.resolution.absPath, "utf-8")).toBe("new-a");
      expect(outcome.backups.map((x) => x.label)).toEqual(["a:sync"]);
      expect(outcome.error).toContain("tb");
      // Target c was never attempted.
      expect(readFileSync(c.resolution.absPath, "utf-8")).toBe("old");
    } finally {
      chmodSync(join(cwd, "tb"), 0o755);
    }
  });
});

// Covers: #1245
describe("sync interactive: replace a markerless file (#1245)", () => {
  const SCRIPT = ".claude/scripts/check-jscpd.sh";
  const FOREIGN = ".codex/scripts/check-jscpd.sh";

  /** The managed script, the way pre-#637 navori wrote it (no marker), plus a user line. */
  function makeMarkerless(rel: string, extra = "# user line\n"): { fresh: string; mine: string } {
    const abs = join(cwd, rel);
    const fresh = readFileSync(abs, "utf-8");
    const stripped = fresh
      .split("\n")
      .filter((l) => !l.includes("navori:managed"))
      .join("\n");
    const mine = `${stripped}\n${extra}`;
    writeFileSync(abs, mine, "utf-8");
    return { fresh, mine };
  }

  const backupDirOf = (): string => {
    const line = ui.messages.find((m) => m.includes("[root:sync]"));
    expect(line).toBeDefined();
    return stripVTControlCharacters(line!.split("[root:sync]")[1]!).trim();
  };

  const ts = tc("es").sync;

  it("keep (the default) changes nothing, makes no backup and the prompt defaults to keep", async () => {
    seed({ jscpd: { enabled: true } });
    const { mine } = makeMarkerless(SCRIPT);

    await runSync({ interactive: true }); // no scripted answer -> the mock answers "keep"

    expect(readFileSync(join(cwd, SCRIPT), "utf-8")).toBe(mine);
    expect(ui.selectCalls).toHaveLength(1);
    expect(ui.selectCalls[0]?.initialValue).toBe("keep");
    expect(ui.selectCalls[0]?.options.map((o) => o.label)).toEqual([
      ts.optKeepMine,
      ts.optReplaceWholeFile,
    ]);
    expect(ui.warns).toContain(ts.markerlessFileWarning(SCRIPT));
    expect(ui.messages.some((m) => m.includes("[root:sync]"))).toBe(false);
    expect(ui.warns).toContain(ts.fileConflictsKept(1));
  });

  it("replace writes the fresh render (one block), keeps the exec bit, backs up the basis, prints the path, and the next full syncs are clean", async () => {
    seed({ jscpd: { enabled: true } });
    const { fresh, mine } = makeMarkerless(SCRIPT);
    chmodSync(join(cwd, SCRIPT), 0o644);
    ui.answers = ["accept"];

    await runSync({ interactive: true });

    const abs = join(cwd, SCRIPT);
    const after = readFileSync(abs, "utf-8");
    expect(after).toBe(fresh);
    expect(after.split("navori:managed start")).toHaveLength(2);
    expect(statSync(abs).mode & 0o100).toBeTruthy();
    // Diff shown, backup holds the user's bytes and its path was printed.
    expect(ui.messages.some((m) => m.includes("# user line"))).toBe(true);
    expect(readFileSync(join(backupDirOf(), SCRIPT), "utf-8")).toBe(mine);
    expect(ui.messages.some((m) => m.includes(ts.markerlessBackupHint))).toBe(true);

    // Idempotence: the FULL sync (apply pass included), twice, rewrites nothing.
    for (let run = 0; run < 2; run++) {
      await runSync({ apply: true });
      expect(readFileSync(abs, "utf-8")).toBe(fresh);
      const json = await runSyncJson({});
      expect(json.conflicts).toEqual([]);
      expect(json.pending).toBe(0);
    }
  });

  it("site 2: a foreign file at a codex plugin script path is replaced with the null-existing render, exec bit kept, idempotent", async () => {
    seed({ jscpd: { enabled: true } }, ["claude", "codex"]);
    const fresh = readFileSync(join(cwd, FOREIGN), "utf-8");
    // Truly foreign: not navori's rendered text at all.
    writeFileSync(join(cwd, FOREIGN), "echo mine\n", "utf-8");
    ui.answers = ["accept"];

    await runSync({ interactive: true });

    const abs = join(cwd, FOREIGN);
    expect(readFileSync(abs, "utf-8")).toBe(fresh);
    expect(fresh.split("navori:managed start")).toHaveLength(2);
    expect(statSync(abs).mode & 0o100).toBeTruthy();
    expect(readFileSync(join(backupDirOf(), FOREIGN), "utf-8")).toBe("echo mine\n");
    for (let run = 0; run < 2; run++) {
      await runSync({ apply: true });
      expect(readFileSync(abs, "utf-8")).toBe(fresh);
      const json = await runSyncJson({});
      expect(json.conflicts).toEqual([]);
      expect(json.pending).toBe(0);
    }
  });

  it("a mixed list resolves each file on its own: accept the marker-kept agent, keep the markerless script", async () => {
    seed({ jscpd: { enabled: true } });
    const [agent] = agentFiles();
    const { pristine } = editAgent(agent!);
    const { mine } = makeMarkerless(SCRIPT);
    // Prompt order follows the conflict list; answer by looking at what is asked.
    ui.onSelect = () => {
      const last = ui.selectCalls[ui.selectCalls.length - 1]!;
      ui.answers = [last.message.includes(".claude/agents/") ? "accept" : "keep"];
    };

    await runSync({ interactive: true });

    expect(readFileSync(agent!, "utf-8")).toBe(pristine);
    expect(readFileSync(join(cwd, SCRIPT), "utf-8")).toBe(mine);
    expect(ui.selectCalls).toHaveLength(2);
    expect(ui.warns).toContain(ts.fileConflictsKept(1));
  });

  it("accepting the markerless file while keeping the marker-kept one also works (and vice versa order-independent)", async () => {
    seed({ jscpd: { enabled: true } });
    const [agent] = agentFiles();
    const { edited } = editAgent(agent!);
    const { fresh } = makeMarkerless(SCRIPT);
    ui.onSelect = () => {
      const last = ui.selectCalls[ui.selectCalls.length - 1]!;
      ui.answers = [last.message.includes(".claude/scripts/") ? "accept" : "keep"];
    };

    await runSync({ interactive: true });

    expect(readFileSync(agent!, "utf-8")).toBe(edited);
    expect(readFileSync(join(cwd, SCRIPT), "utf-8")).toBe(fresh);
  });

  it("a markerless file changed after the diff is dropped, not written", async () => {
    seed({ jscpd: { enabled: true } });
    makeMarkerless(SCRIPT);
    const abs = join(cwd, SCRIPT);
    const late = `${readFileSync(abs, "utf-8")}# late edit\n`;
    ui.answers = ["accept"];
    ui.onSelect = () => writeFileSync(abs, late, "utf-8");

    await runSync({ interactive: true });

    expect(readFileSync(abs, "utf-8")).toBe(late);
    expect(ui.warns.some((w) => w.includes("cambió"))).toBe(true);
    expect(ui.messages.some((m) => m.includes("[root:sync]"))).toBe(false);
  });

  it("cancel writes nothing for a markerless file", async () => {
    seed({ jscpd: { enabled: true } });
    const { mine } = makeMarkerless(SCRIPT);
    ui.answers = ["accept"];
    ui.cancelAt = 1;
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(runSync({ interactive: true })).rejects.toThrow("exit");

    expect(readFileSync(join(cwd, SCRIPT), "utf-8")).toBe(mine);
  });

  it("a file carrying another id's block (or a partial marker) is never offered", async () => {
    seed({ jscpd: { enabled: true } });
    const { mine } = makeMarkerless(
      SCRIPT,
      '# navori:managed start id="other" version="999.0.0"\n',
    );

    await runSync({ interactive: true });

    expect(ui.selectCalls).toHaveLength(0);
    expect(ui.warns).toContain(ts.fileConflictsRemain(1));
    expect(readFileSync(join(cwd, SCRIPT), "utf-8")).toBe(mine);
  });
});
