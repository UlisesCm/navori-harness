import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fastCoveredByFull,
  gateCacheKey,
  lookupGreen,
  passSentinel,
  probeGreen,
  recordGreen,
  type GateCacheEntry,
  type GateCacheKey,
} from "../cache.ts";
import { runGate } from "../run.ts";
import { resolveStateRoot, type StateRoot } from "../../primitives/state-root.ts";

let cwd: string;
let root: StateRoot;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-gate-cache-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "T"], { cwd });
  root = resolveStateRoot({ cwd, feature: "gate", dir: ".navori/state/gate" });
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const FIELDS: GateCacheKey = {
  fingerprint: "f".repeat(64),
  kind: "fast",
  commandHash: "c".repeat(64),
  lockHash: "l".repeat(64),
  navoriVersion: "1.0.0",
  bunVersion: "1.3.0",
  nodeVersion: "v24.0.0",
};

/** Writes a green log (sentinel last) and records it; returns the log path. */
function recordWithLog(key: GateCacheKey, sentinel = passSentinel(key.kind, key.fingerprint)) {
  const dir = join(cwd, ".navori/state/gate");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${key.kind}-${key.fingerprint.slice(0, 6)}.log`);
  writeFileSync(log, `all good\n${sentinel}\n`);
  recordGreen(root, key, log);
  return log;
}

function entries(): GateCacheEntry[] {
  return (
    JSON.parse(readFileSync(join(cwd, ".navori/state/gate/results.json"), "utf8")) as {
      entries: GateCacheEntry[];
    }
  ).entries;
}

describe("gate cache record", () => {
  // Covers: R12, R14
  it("hits on the full key and misses when any one field differs", () => {
    recordWithLog(FIELDS);
    expect(lookupGreen(root, FIELDS)?.logSha256).toMatch(/^[a-f0-9]{64}$/);
    const changed: Record<keyof GateCacheKey, string> = {
      fingerprint: "0".repeat(64),
      kind: "full",
      commandHash: "0".repeat(64),
      lockHash: "0".repeat(64),
      navoriVersion: "1.0.1",
      bunVersion: "1.3.1",
      nodeVersion: "v24.0.1",
    };
    for (const field of Object.keys(changed) as Array<keyof GateCacheKey>) {
      expect(lookupGreen(root, { ...FIELDS, [field]: changed[field] } as GateCacheKey), field).toBe(
        undefined,
      );
    }
  });

  // Covers: R12
  it("keys on the lockfiles and the command text", () => {
    writeFileSync(join(cwd, "bun.lock"), "one");
    const base = { repo: cwd, kind: "fast" as const, command: "npm run a", fingerprint: "x" };
    const first = gateCacheKey(base);
    expect(gateCacheKey(base)).toEqual(first);
    writeFileSync(join(cwd, "bun.lock"), "two");
    expect(gateCacheKey(base).lockHash).not.toBe(first.lockHash);
    expect(gateCacheKey({ ...base, command: "npm run b" }).commandHash).not.toBe(first.commandHash);
  });

  // Covers: R14
  it("treats invalid JSON, an unknown version or malformed entries as a miss, and recovers on record", () => {
    recordWithLog(FIELDS);
    const path = join(cwd, ".navori/state/gate/results.json");
    writeFileSync(path, "{not json");
    expect(lookupGreen(root, FIELDS)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ v: 2, entries: [{ ...FIELDS }] }));
    expect(lookupGreen(root, FIELDS)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ v: 1, entries: [{ ...FIELDS, logSha256: 7 }] }));
    expect(lookupGreen(root, FIELDS)).toBeUndefined();
    writeFileSync(path, "{not json");
    recordWithLog(FIELDS);
    expect(lookupGreen(root, FIELDS)).toBeDefined();
  });

  // Covers: R14
  it("misses when the log is missing, altered, or lacks the success sentinel", () => {
    const log = recordWithLog(FIELDS);
    appendFileSync(log, "tampered\n");
    expect(lookupGreen(root, FIELDS)).toBeUndefined();

    const other = { ...FIELDS, fingerprint: "e".repeat(64) };
    recordWithLog(other, "[navori gate] PASS fast something-else");
    expect(lookupGreen(root, other)).toBeUndefined();

    const gone = { ...FIELDS, fingerprint: "d".repeat(64) };
    rmSync(recordWithLog(gone));
    expect(lookupGreen(root, gone)).toBeUndefined();
  });

  // Covers: R12
  it("keeps the last 16 entries and replaces an entry with the same key", () => {
    for (let i = 0; i < 18; i++) {
      recordWithLog({ ...FIELDS, fingerprint: i.toString(16).padStart(64, "0") });
    }
    expect(entries()).toHaveLength(16);
    expect(entries()[0]?.fingerprint).toBe((2).toString(16).padStart(64, "0"));
    recordWithLog({ ...FIELDS, fingerprint: (17).toString(16).padStart(64, "0") });
    expect(entries()).toHaveLength(16);
  });
});

describe("fastCoveredByFull", () => {
  // Covers: R13
  it("covers fast only when every && step with its cwd is literal in full", () => {
    const full = "bun run a && bun run b && cd packages/cli && bun run c && bun run d";
    expect(fastCoveredByFull("bun run b && bun run a", full)).toBe(true);
    expect(fastCoveredByFull("cd packages/cli && bun run c", full)).toBe(true);
    // Same step, different cwd.
    expect(fastCoveredByFull("bun run c", full)).toBe(false);
    expect(fastCoveredByFull("cd packages/cli && bun run a", full)).toBe(false);
    // A step full does not have, shell sequencers, and an empty chain.
    expect(fastCoveredByFull("bun run a && bun run z", full)).toBe(false);
    expect(fastCoveredByFull("bun run a || bun run b", full)).toBe(false);
    expect(fastCoveredByFull("bun run a; bun run b", full)).toBe(false);
    expect(fastCoveredByFull("", full)).toBe(false);
    // `cd` alone is not a step: fast = `cd x && bun run c` needs full to run c in x.
    expect(fastCoveredByFull("cd packages/cli && bun run c", "bun run c")).toBe(false);
  });
});

describe("fastCoveredByFull script expansion", () => {
  const scripts = {
    "check:fast": "bun run a && cd packages/cli && bun run c",
    nested: "bun run check:fast",
    shell: "bun run a || bun run b",
  };
  const full = "bun run a && cd packages/cli && bun run c && bun run z";

  // Covers: R13
  it("expands one level of root scripts; unknown, nested and non-chain scripts are not covered", () => {
    expect(fastCoveredByFull("bun run check:fast", full, scripts)).toBe(true);
    expect(fastCoveredByFull("npm run check:fast", full, scripts)).toBe(true);
    expect(fastCoveredByFull("bun run check:fast", full)).toBe(false);
    expect(fastCoveredByFull("bun run nope", full, scripts)).toBe(false);
    // `nested` expands to `bun run check:fast`, which is not literal in full (not expanded twice).
    expect(fastCoveredByFull("bun run nested", full, scripts)).toBe(false);
    expect(fastCoveredByFull("bun run shell", full, scripts)).toBe(false);
    // Expansion only applies at the repo root.
    expect(fastCoveredByFull("cd packages/cli && bun run check:fast", full, scripts)).toBe(false);
    // A literal match still wins, and a missing step in full is not covered.
    expect(fastCoveredByFull("bun run a", full, scripts)).toBe(true);
    expect(fastCoveredByFull("bun run check:fast", "bun run a", scripts)).toBe(false);
  });
});

describe("runGate with the cache", () => {
  function setup(extra: Record<string, string> = {}, gates?: { fast: string; full: string }): void {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "g",
        version: "1.0.0",
        scripts: {
          ok: "echo all-good",
          ok2: "echo also-good",
          mark: "node -e \"require('fs').writeFileSync('marker-'+Date.now(),'x')\"",
          ...extra,
        },
      }),
    );
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "g",
        engines: ["claude"],
        preset: "custom",
        qualityGate: gates ?? { fast: "npm run ok", full: "npm run ok" },
      }),
    );
    // contentIdentity needs a HEAD; an unborn branch disables the cache.
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd });
  }

  const first = (stdout: string): string => stdout.split("\n")[0] ?? "";

  // Covers: R12
  it("answers a second run on the same tree from the cache, and --force runs again", async () => {
    setup();
    const ran = await runGate({ cwd, kind: "fast" });
    expect(first(ran.stdout)).toMatch(/^navori gate fast: exit 0 — log /);
    const cached = await runGate({ cwd, kind: "fast" });
    expect(cached.exitCode).toBe(0);
    expect(first(cached.stdout)).toMatch(
      /^navori gate fast: PASS \(cached \d{4}-\d\d-\d\dT[\d:.]+Z · from fast · log \.navori\/state\/gate\/fast-\S+\.log · sha256 [a-f0-9]{64}\)$/,
    );
    const forced = await runGate({ cwd, kind: "fast", force: true });
    expect(first(forced.stdout)).toMatch(/^navori gate fast: exit 0 — log /);
    // Editing a tracked-or-untracked file changes the key.
    writeFileSync(join(cwd, "edit.txt"), "x");
    expect(first((await runGate({ cwd, kind: "fast" })).stdout)).toMatch(/: exit 0 — log /);
  });

  // Covers: R12
  it("does not record a red run", async () => {
    setup({ bad: "exit 3" }, { fast: "npm run bad", full: "npm run bad" });
    expect((await runGate({ cwd, kind: "fast" })).exitCode).toBe(3);
    expect((await runGate({ cwd, kind: "fast" })).exitCode).toBe(3);
    expect(() => readFileSync(join(cwd, ".navori/state/gate/results.json"))).toThrow();
  });

  // Covers: R12
  it("does not record when the tree changes during the run", async () => {
    setup({}, { fast: "npm run mark", full: "npm run mark" });
    expect((await runGate({ cwd, kind: "fast" })).exitCode).toBe(0);
    const again = await runGate({ cwd, kind: "fast" });
    expect(first(again.stdout)).toMatch(/: exit 0 — log /);
  });

  // Covers: R14
  it("treats an altered log as a miss", async () => {
    setup();
    const ran = await runGate({ cwd, kind: "fast" });
    const logPath = /log (\S+)/.exec(first(ran.stdout))?.[1] ?? "";
    appendFileSync(join(cwd, logPath), "tampered\n");
    expect(first((await runGate({ cwd, kind: "fast" })).stdout)).toMatch(/: exit 0 — log /);
  });

  // Covers: R13
  it("lets a green full satisfy fast only when fast's steps are literal in full", async () => {
    setup({}, { fast: "npm run ok", full: "npm run ok && npm run ok2" });
    await runGate({ cwd, kind: "full" });
    const covered = await runGate({ cwd, kind: "fast" });
    expect(first(covered.stdout)).toMatch(/^navori gate fast: PASS \(cached .* · from full · /);

    setup({}, { fast: "npm run ok2 && npm run missing", full: "npm run ok && npm run ok2" });
    await runGate({ cwd, kind: "full" });
    expect(first((await runGate({ cwd, kind: "fast" })).stdout)).toMatch(/: exit 1 — log /);
  });
});

describe("probeGreen", () => {
  // Covers: R17
  it("hits per mode only when index, tree and record agree", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "g", version: "1.0.0", scripts: { ok: "echo hi" } }),
    );
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "g",
        engines: ["claude"],
        preset: "custom",
        qualityGate: { fast: "npm run ok", full: "npm run ok" },
      }),
    );
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-qm", "base"], { cwd });
    const commands = { fast: "npm run ok", full: "npm run ok" };
    expect(probeGreen(root, "index", commands)).toBeUndefined();
    await runGate({ cwd, kind: "fast" });
    expect(probeGreen(root, "index", commands)).toBeDefined();
    expect(probeGreen(root, "clean", commands)).toBeDefined();
    expect(probeGreen(root, "working", commands)).toBeDefined();

    // Working-tree edit that is not staged: the index is no longer the recorded bytes.
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "g", scripts: { ok: "x" } }));
    expect(probeGreen(root, "index", commands)).toBeDefined();
    expect(probeGreen(root, "clean", commands)).toBeUndefined();
    expect(probeGreen(root, "working", commands)).toBeUndefined();
  });
});
