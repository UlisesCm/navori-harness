import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
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

/**
 * #1227 stage 1 — whole-file conflicts are outside what `sync` can resolve.
 * `sync` must not offer a block-by-block flow for them, must say so whenever
 * they remain, and its skip copy must point at the real manual exit.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

interface SelectOption {
  value: string;
  label: string;
}
const ui = vi.hoisted(() => ({
  selectCalls: [] as Array<{ options: Array<{ value: string; label: string }> }>,
  /** Answers handed out in order, one per `select`; falls back to "keep". */
  answers: [] as string[],
  warns: [] as string[],
}));
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: () => undefined,
  log: {
    message: () => undefined,
    info: () => undefined,
    warn: (m: string) => {
      ui.warns.push(m);
    },
    error: () => undefined,
    success: () => undefined,
    step: () => undefined,
  },
  select: (opts: { options: SelectOption[] }) => {
    ui.selectCalls.push(opts);
    return Promise.resolve(ui.answers.shift() ?? "keep");
  },
  confirm: () => Promise.resolve(true),
  multiselect: () => Promise.reject(new Error("unexpected multiselect")),
  text: () => Promise.reject(new Error("unexpected text")),
  isCancel: () => false,
}));

const { writeConfig } = await import("../../lib/config/config.ts");
const { runRender } = await import("../render.ts");
const { syncCommand } = await import("../sync.ts");
const { tc } = await import("../../lib/i18n.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-sync-files-"));
  ui.selectCalls = [];
  ui.answers = [];
  ui.warns = [];
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

/** Hand-edit the first managed block of `path`, invalidating its hash. */
function editFirstBlock(path: string): void {
  const original = readFileSync(path, "utf-8");
  const edited = original.replace(/(<!-- navori:managed [^>]*-->\n)/, "$1HAND EDIT\n");
  expect(edited).not.toBe(original);
  writeFileSync(path, edited, "utf-8");
}

/** Hand-edit the managed block of the first rendered agent file (a whole-file conflict). */
function breakFirstAgentFile(): string {
  const dir = join(cwd, ".claude", "agents");
  const name = readdirSync(dir).find((f) => f.endsWith(".md"));
  expect(name).toBeDefined();
  const path = join(dir, name!);
  editFirstBlock(path);
  return path;
}

/**
 * Turn an edited agent file into an UNRESOLVABLE conflict: a symlink (sync must
 * never write through a link, so the engine attaches no resolution to it).
 */
function makeUnresolvable(path: string): void {
  const real = join(cwd, "real-agent-copy.txt");
  renameSync(path, real);
  symlinkSync(real, path);
}

function seed(): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    preset: "custom",
    engines: ["claude"],
  });
  expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
}

describe("sync with whole-file conflicts (#1227)", () => {
  it("does not offer 'interactive' when only UNRESOLVABLE whole files conflict", async () => {
    seed();
    const agent = breakFirstAgentFile();
    makeUnresolvable(agent);
    const before = readFileSync(agent, "utf-8");
    ui.answers = ["skip-conflicts"];

    await runSync({});

    expect(ui.selectCalls).toHaveLength(1);
    expect(ui.selectCalls[0]!.options.map((o) => o.value)).toEqual(["skip-conflicts", "abort"]);
    expect(ui.warns).toContain(tc("es").sync.fileConflictsRemain(1));
    expect(readFileSync(agent, "utf-8")).toBe(before);
  });

  it("with a block+resolvable-file mix, offers 'interactive' and warns about the kept file", async () => {
    seed();
    breakFirstAgentFile();
    editFirstBlock(join(cwd, "CLAUDE.md"));
    ui.answers = ["interactive"]; // per-block prompts then fall back to "keep"

    await runSync({});

    expect(ui.selectCalls[0]!.options.map((o) => o.value)).toContain("interactive");
    // The agent file kept its marker, so it is resolvable: answered "keep" -> kept.
    expect(ui.warns).toContain(tc("es").sync.fileConflictsKept(1));
  });

  it("--interactive with unresolvable file-only conflicts warns and writes nothing", async () => {
    seed();
    const agent = breakFirstAgentFile();
    makeUnresolvable(agent);
    const before = readFileSync(agent, "utf-8");

    await runSync({ interactive: true });

    expect(ui.selectCalls).toHaveLength(0);
    expect(ui.warns).toContain(tc("es").sync.fileConflictsRemain(1));
    expect(readFileSync(agent, "utf-8")).toBe(before);
  });
});

describe("skip copy no longer promises 'navori sync' for whole files (#1227)", () => {
  for (const lang of ["es", "en"] as const) {
    it(`${lang}: names the render --apply exit and not sync`, () => {
      const t = tc(lang);
      // managedBlockEditedByHand is shared with prose/ignore blocks that `sync`
      // does resolve, so it names both exits; sub-blocks advise hand edits only.
      const shared = t.engine.managedBlockEditedByHand;
      expect(shared).toContain("navori sync");
      expect(shared).toContain("navori render --apply");
      const sub = t.engine.subBlockEditedByHand("x", "y");
      expect(sub).not.toContain("navori sync");
      expect(sub).not.toContain("navori render --apply");
      const texts = [
        t.sync.fileConflictsRemain(2),
        t.sync.conflictDiffFileLevel,
        t.render.skippedOutro(2),
      ];
      for (const text of texts) {
        expect(text).not.toMatch(/navori sync/);
        expect(text).toContain("navori render --apply");
      }
      expect(t.sync.fileConflictsRemain(2)).not.toContain(".claude/");
    });
  }
});
