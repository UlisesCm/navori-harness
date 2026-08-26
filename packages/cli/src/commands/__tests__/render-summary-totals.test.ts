import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #519: the render outro — and `--json`'s `summary` — counted ONLY the managed
 * blocks of `CLAUDE.md`. The engine files (`.claude/settings.json`, the agents,
 * the hooks, the skills, `AGENTS.md`, the harness `.gitignore`) print in their
 * own section of the very same report and never reached the count, so a rollout
 * whose listing enumerated 5 created / 53 updated announced "1 created, 18
 * updated": a number that reads as a total while describing under a third of
 * what `--apply` was about to write.
 *
 * The property pinned here is the one that was missing, not a magic number: the
 * outro must add up to what the listing above it enumerates, whatever the
 * fixture renders. Every expected value is DERIVED from the run's own report —
 * a hand-typed 53 next to a hand-counted list is exactly what failed in the
 * first place.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config.ts");
const { renderCommand } = await import("../render.ts");

type Counts = Record<string, number>;

interface ListedEntry {
  /** Managed-block id or engine-file path, as the listing prints it. */
  id: string;
  status: string;
}

/** The status token each listing line ends with: `  + .claude/settings.json  (created)`. */
const STATUS_LINE =
  /^(.*?)\s{2}\((created|updated|unchanged|user-modified-skipped|downgrade-skipped|removed-condition-false)\)\s*$/;
/** Engine files that did not change are printed as ONE aggregated count, in the
 *  two shapes `reportEngineFiles` uses. */
const AGGREGATED_UNCHANGED = [/\(\+(\d+) unchanged\)/, /·\s+(\d+) unchanged\s*$/];
/** The outro's own words, mapped back to the status they summarize. */
const OUTRO_WORDS: Record<string, string> = {
  created: "created",
  updated: "updated",
  conflict: "user-modified-skipped",
  "downgrade-skip": "downgrade-skipped",
  removed: "removed-condition-false",
  unchanged: "unchanged",
};

/** picocolors keeps its ANSI codes when a TTY (or FORCE_COLOR) is in play;
 *  the regex is BUILT so the escape never lands as a control char in a
 *  literal, which the linter rightly rejects. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Every report line EXCEPT the outro (the `└` one), which is what we compare
 *  the listing against. */
function listingLines(output: string): string[] {
  return stripAnsi(output)
    .split("\n")
    .filter((line) => !line.includes("└"))
    .map((line) => line.replace(/^[│▲┌]\s?/, ""));
}

/** What the report ENUMERATES, line by line: the CLAUDE.md managed blocks and
 *  the engine files, each with the status printed next to it. */
function listedEntries(output: string): ListedEntry[] {
  const out: ListedEntry[] = [];
  for (const line of listingLines(output)) {
    const match = STATUS_LINE.exec(line);
    if (match)
      out.push({ id: (match[1] ?? "").trim().replace(/^\S+\s+/, ""), status: match[2] ?? "" });
  }
  return out;
}

/** The listing's counts: one per enumerated line, plus the aggregated
 *  "N unchanged" the engine section prints instead of listing them one by one. */
function countListing(output: string): Counts {
  const counts: Counts = {};
  for (const entry of listedEntries(output)) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  for (const line of listingLines(output)) {
    for (const pattern of AGGREGATED_UNCHANGED) {
      const match = pattern.exec(line);
      if (match) counts.unchanged = (counts.unchanged ?? 0) + Number(match[1]);
    }
  }
  return counts;
}

/** The numbers the outro — the last line, the one everybody reads — claims. */
function countOutro(output: string): Counts {
  const outro = stripAnsi(output)
    .split("\n")
    .filter((line) => line.includes("└"))
    .at(-1);
  expect(outro, `no outro line in:\n${output}`).toBeDefined();
  const counts: Counts = {};
  for (const [word, status] of Object.entries(OUTRO_WORDS)) {
    const match = new RegExp(`(\\d+) ${word}\\b`).exec(outro as string);
    if (match) counts[status] = Number(match[1]);
  }
  return counts;
}

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-summary-"));
  // claude + agents-md: the report gets both sections that used to be ignored —
  // the `.claude/**` tree and a non-Claude engine file.
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude", "agents-md"],
    preset: "custom",
  });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

/** Run `render` capturing the human report clack writes to stdout. */
async function renderOutput(...args: string[]): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await runCommand(renderCommand, { rawArgs: ["--cwd", cwd, ...args] });
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

/** Run `render --json` and parse the payload. */
async function renderJson(...args: string[]): Promise<RenderPayload> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
    lines.push(String(msg));
  });
  try {
    await runCommand(renderCommand, { rawArgs: ["--cwd", cwd, "--json", ...args] });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.at(-1) as string) as RenderPayload;
}

interface Scope {
  entries: Array<{ id: string; status: string }>;
  written: Array<{ path: string; status: string }>;
  skipped: Array<{ path: string; reason: string }>;
  unchangedFiles: number;
  extraEngines?: Array<{ written: Array<{ path: string; status: string }> }>;
}
interface RenderPayload {
  mode: string;
  root: Scope;
  workspaces: Scope[];
  extraEngines: Array<{ written: Array<{ path: string; status: string }> }>;
  gitignore: { status: string } | null;
  summary: Counts;
}

describe("the render summary counts what its listing enumerates (#519)", () => {
  it("a first render: the outro's created matches every line the report listed", async () => {
    const output = await renderOutput();

    const listed = listedEntries(output);
    // Anti-false-green: the parser must have found BOTH sections before the
    // comparison below means anything. An output shape it stopped understanding
    // would otherwise compare two empty objects and pass.
    expect(listed.some((e) => e.id === "orquestacion")).toBe(true);
    expect(listed.some((e) => e.id === ".claude/settings.json")).toBe(true);
    expect(listed.some((e) => e.id === "AGENTS.md")).toBe(true);

    const listing = countListing(output);
    // The exact bug: the CLAUDE.md blocks are a small minority of the report.
    const blocksOnly = listed.filter((e) => !e.id.includes("/") && !e.id.endsWith(".md")).length;
    expect(listing.created).toBeGreaterThan(blocksOnly * 2);

    expect(countOutro(output)).toEqual(listing);
  });

  it("a second render: the outro's unchanged covers the engine files too", async () => {
    await renderOutput("--apply");

    const output = await renderOutput();

    // Anti-false-green: this case only proves anything if the report really did
    // aggregate unchanged ENGINE FILES (the ones the old count dropped).
    const aggregated = listingLines(output).some((line) =>
      AGGREGATED_UNCHANGED.some((pattern) => pattern.test(line)),
    );
    expect(aggregated).toBe(true);

    expect(countOutro(output)).toEqual(countListing(output));
  });

  it("--json: summary is recomputable from the payload's own lists", async () => {
    const payload = await renderJson();

    const derived: Counts = {};
    const bump = (status: string, n = 1): void => {
      if (n > 0) derived[status] = (derived[status] ?? 0) + n;
    };
    const countScope = (scope: Scope): void => {
      for (const entry of scope.entries) bump(entry.status);
      // CLAUDE.md is the file whose blocks `entries` already enumerated.
      for (const file of scope.written) if (file.path !== "CLAUDE.md") bump(file.status);
      bump("unchanged", scope.unchangedFiles);
      for (const engine of scope.extraEngines ?? []) {
        for (const file of engine.written) bump(file.status);
      }
    };
    countScope(payload.root);
    for (const ws of payload.workspaces) countScope(ws);
    for (const engine of payload.extraEngines) {
      for (const file of engine.written) bump(file.status);
    }
    if (payload.gitignore && !payload.gitignore.status.endsWith("-skipped")) {
      bump(payload.gitignore.status);
    }

    // Anti-false-green: a payload with no engine files makes the equality below
    // hold for the wrong reason — it is exactly the state the bug reported.
    expect(payload.root.written.length).toBeGreaterThan(10);
    expect(payload.summary).toEqual(derived);
    // …and the summary is strictly bigger than the blocks-only count it used to
    // publish, which is the regression this test exists to catch.
    const blocksOnly = payload.root.entries.length;
    expect(payload.summary.created).toBeGreaterThan(blocksOnly);
  });
});
