import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * #1240 — `sync` resolves whole-file conflicts of user-edited managed files
 * that still carry a navori marker: diff + keep/accept, written through
 * `commitWrites` with a backup. Markerless files stay out of scope.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

interface SelectOptions {
  message: string;
  options: Array<{ value: string; label: string }>;
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

function seed(plugins?: Record<string, unknown>): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    preset: "custom",
    engines: ["claude"],
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

  // Covers: scope (markerless out) — a markerless user-edited file is never offered.
  it("a markerless user-edited plugin script is never offered and keeps the manual-exit message", async () => {
    seed({ jscpd: { enabled: true } });
    const script = join(cwd, ".claude/scripts/check-jscpd.sh");
    expect(existsSync(script)).toBe(true);
    const legacy = readFileSync(script, "utf-8")
      .split("\n")
      .filter((l) => !l.includes("navori:managed"))
      .join("\n");
    const markerless = `${legacy}\n# user line\n`;
    writeFileSync(script, markerless, "utf-8");

    await runSync({ interactive: true });

    expect(ui.selectCalls).toHaveLength(0);
    expect(ui.warns).toContain(tc("es").sync.fileConflictsRemain(1));
    expect(readFileSync(script, "utf-8")).toBe(markerless);
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
