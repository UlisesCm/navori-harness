import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { begin, complete, report } from "../journal.ts";
import {
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  recordSchema,
  type Receipt,
  type ShadowRecord,
} from "../journal.schema.ts";
import { analyze, MIN_SPAN_MS } from "../report.ts";
import { completeFromInput } from "../command.ts";
import { leakCount, leakPayload, payloadEncodings } from "./leak-variants.ts";

const IMPL = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;
const MATCH = {
  nativeFailed: false,
  shellFailed: false,
  codeDiffers: false,
  stdoutDiffers: false,
  stderrDiffers: false,
};
const IDENTITY = { hook: "guard", engine: "pi", implementation: IMPL } as const;
const EXPECTED = { hook: "guard", currentImpl: IMPL, engines: ["pi"] };
const NOW = 1_800_000_000_000;
let root: string;
const file = (): string => join(root, ".navori/state/rust-shadow/guard.jsonl");
const bytes = (rows: unknown[]): Buffer =>
  Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join(""));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "navori-shadow-journal-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Synthetic time windows test the report threshold, never claim live shadow observations. */
function observations(
  count = 500,
  span = MIN_SPAN_MS,
  engine = "pi",
  implementation = IMPL,
): ShadowRecord[] {
  const rows: ShadowRecord[] = [];
  for (let index = 0; index < count; index++) {
    const timeMs = NOW - span + Math.floor((index * span) / Math.max(1, count - 1));
    const start = recordSchema.parse({
      schema: 1,
      kind: "begin",
      id: randomUUID(),
      hook: "guard",
      engine,
      implementation,
      timeMs,
    });
    rows.push(start, recordSchema.parse({ ...start, kind: "complete", comparison: MATCH }));
  }
  return rows;
}

/** Fixtures write only their private local journal, with no production API clock override. */
function history(rows: unknown[]): void {
  mkdirSync(dirname(file()), { recursive: true, mode: 0o700 });
  writeFileSync(file(), bytes(rows), { mode: 0o600 });
}

/** Compile the real library for child Node24/26 processes, without experimental TS loaders. */
async function childModule(): Promise<string> {
  const { build } = await import("tsdown");
  const directory = join(root, "fixture-bundle");
  await build({
    config: false,
    tsconfig: false,
    entry: { journal: fileURLToPath(new URL("../journal.ts", import.meta.url)) },
    outDir: directory,
    platform: "node",
    format: "esm",
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^zod(?:\/|$)/] },
    logLevel: "silent",
  });
  return pathToFileURL(join(directory, "journal.mjs")).href;
}

/** Run an actual child writer against the real library and capture only fixture diagnostics. */
function childExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

describe("private shadow journal", () => {
  // Covers: R11, R12
  it("refuses NUL/unpaired UTF16 roots without aliasing a real replacement-character directory", () => {
    const replacement = join(root, "\ufffd");
    mkdirSync(replacement, { mode: 0o700 });
    const aliased = join(root, "\ud800");
    expect(begin(aliased, IDENTITY).ok).toBe(false);
    expect(existsSync(join(replacement, ".navori"))).toBe(false);
    expect(begin(join(root, "nul\0root"), IDENTITY).ok).toBe(false);
    const missing = join(root, "missing-project");
    expect(begin(missing, IDENTITY).ok).toBe(false);
    expect(existsSync(missing)).toBe(false);
    const alias = join(root, "project-alias");
    symlinkSync(root, alias);
    expect(begin(alias, IDENTITY).ok).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  // Covers: R11, R12, R19
  it("revalidates each local directory when concurrent creators win all three mkdir races", async () => {
    const module = await childModule();
    const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.mkdirSync; let races=0;
fs.mkdirSync=(...args)=>{const result=original(...args);if(String(args[0]).startsWith(process.argv[2]+'/')){races++;const error=new Error('concurrent creator');error.code='EEXIST';throw error}return result};syncBuiltinESMExports();
const {begin}=await import(process.argv[1]);const started=begin(process.argv[2],${JSON.stringify(IDENTITY)});
if(!started.ok)throw new Error('begin refused after '+races+' directory races');
if(races!==3)throw new Error('expected three directory races, got '+races);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, module, root], {
      stdio: "pipe",
    });
    try {
      await childExit(child);
      expect(report(root, EXPECTED)).toMatchObject({
        available: true,
        engines: [{ pending: 1 }],
      });
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  // Covers: R11, R12, R19
  it("acknowledges all forty completions from each of two genuinely simultaneous process writers", async () => {
    const module = await childModule();
    const source = `const {begin,complete} = await import(process.argv[1]); let finished=0;
for(let i=0;i<40;i++){const started=begin(process.argv[2],${JSON.stringify(IDENTITY)});if(!started.ok)throw new Error('begin unavailable');if(complete(process.argv[2],started.receipt,${JSON.stringify(MATCH)}).ok)finished++;}
if(finished!==40)throw new Error('finished '+finished);`;
    const children = [0, 1].map(() =>
      spawn(process.execPath, ["--input-type=module", "-e", source, module, root], {
        stdio: "pipe",
      }),
    );
    try {
      await Promise.all(children.map(childExit));
      expect(report(root, EXPECTED)).toMatchObject({
        available: true,
        ready: false,
        engines: [{ complete: 80, matched: 80, pending: 0 }],
      });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  });
  // Covers: R11, R19
  it("acknowledges appended begin before completion and writes no payload in any row", () => {
    const started = begin(root, IDENTITY);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.reason);
    expect(recordSchema.parse(JSON.parse(readFileSync(file(), "utf8")))).toEqual(started.receipt);
    expect(report(root, EXPECTED)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ pending: 1, complete: 0 }],
    });
    expect(complete(root, started.receipt, MATCH)).toEqual({ ok: true });
    const stored = readFileSync(file(), "utf8");
    expect(stored).not.toContain("payload");
    expect(stored.trimEnd().split("\n")).toHaveLength(2);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file())).mode & 0o777).toBe(0o700);
    expect(report(root, EXPECTED)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ pending: 0, complete: 1, matched: 1 }],
    });
  });

  // Covers: R50
  it("counts an unobserved native lane as neither a match nor a divergence", () => {
    const unobserved = { ...MATCH, nativeUnobserved: true as const };
    const started = begin(root, IDENTITY);
    if (!started.ok) throw new Error(started.reason);
    expect(complete(root, started.receipt, unobserved)).toEqual({ ok: true });
    expect(readFileSync(file(), "utf8")).not.toContain("payloadBase64");
    expect(report(root, EXPECTED)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ complete: 1, matched: 0, divergences: 0, unobserved: 1, spanMs: 0 }],
    });
    const failed = begin(root, IDENTITY);
    if (!failed.ok) throw new Error(failed.reason);
    const shell = { ...unobserved, shellFailed: true };
    expect(complete(root, failed.receipt, shell)).toEqual({ ok: true });
    expect(report(root, EXPECTED)).toMatchObject({ engines: [{ divergences: 1, unobserved: 1 }] });
  });

  // Covers: R11, R12
  it("stores only flags and protocol codes on a divergence, including either runtime failure", () => {
    for (const key of Object.keys(MATCH) as (keyof typeof MATCH)[]) {
      const started = begin(root, IDENTITY);
      if (!started.ok) throw new Error(started.reason);
      const comparison = { ...MATCH, [key]: true, shellCode: 2 as const, nativeCode: 0 as const };
      expect(complete(root, started.receipt, comparison)).toEqual({ ok: true });
    }
    const rows = readFileSync(file(), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => recordSchema.parse(JSON.parse(line)));
    for (const row of rows) expect(row).not.toHaveProperty("payloadBase64");
    expect(rows[1]).toMatchObject({ comparison: { shellCode: 2, nativeCode: 0 } });
    const summary = report(root, EXPECTED);
    expect(summary).toMatchObject({
      available: true,
      ready: false,
      legacyPayloadRows: 0,
      engines: [{ divergences: 5 }],
    });
    expect(JSON.stringify(summary)).not.toContain("payload");
  });

  // Covers: R11, R12
  it("refuses a payload or an out-of-protocol code in a written completion", () => {
    const started = begin(root, IDENTITY);
    if (!started.ok) throw new Error(started.reason);
    const original = readFileSync(file());
    for (const comparison of [
      { ...MATCH, payloadBase64: "e30=" },
      { ...MATCH, codeDiffers: true, shellCode: 255 },
      { ...MATCH, codeDiffers: true, nativeCode: -1 },
      { ...MATCH, codeDiffers: true, shellCode: "2" },
    ])
      expect(complete(root, started.receipt, comparison)).toEqual({ ok: false, reason: "invalid" });
    expect(readFileSync(file()).equals(original)).toBe(true);
  });

  // Covers: R11, R19
  it("reads legacy rows with payloadBase64, counts them and never returns the payload", () => {
    const rows = observations(1, 0);
    const [start, end] = rows;
    const legacy = {
      ...end,
      comparison: { ...MATCH, codeDiffers: true },
      payloadBase64: Buffer.from("legacy synthetic payload").toString("base64"),
    };
    const summary = analyze(bytes([start, legacy]), EXPECTED, NOW);
    expect(summary).toMatchObject({
      available: true,
      legacyPayloadRows: 1,
      engines: [{ complete: 1, divergences: 1 }],
    });
    expect(JSON.stringify(summary)).not.toContain(legacy.payloadBase64);
    // A legacy match row (payload without divergence) is no longer a contradiction either.
    expect(analyze(bytes([start, { ...end, payloadBase64: "AA==" }]), EXPECTED, NOW)).toMatchObject(
      { available: true, legacyPayloadRows: 1, engines: [{ matched: 1 }] },
    );
    expect(analyze(bytes(rows), EXPECTED, NOW)).toMatchObject({ legacyPayloadRows: 0 });
  });

  // Covers: R11, R12
  it("writes no identifier variant to the journal bytes", () => {
    const comparison = {
      ...MATCH,
      codeDiffers: true,
      shellCode: 2 as const,
      nativeCode: 0 as const,
    };
    const started = begin(root, IDENTITY);
    if (!started.ok) throw new Error(started.reason);
    // The legacy stdin document is the one path that can carry a payload to the writer.
    const input = JSON.stringify({
      receipt: started.receipt,
      comparison,
      payloadBase64: Buffer.from(leakPayload()).toString("base64"),
    });
    expect(completeFromInput(root, input)).toEqual({ ok: true });
    expect(leakCount(readFileSync(file()))).toBe(0);
    // Positive control: the real payload in every encoding would have been seen.
    for (const encoded of payloadEncodings()) expect(leakCount(encoded)).toBeGreaterThan(0);
  });

  // Covers: R11, R12
  it("accepts protocol codes on write only for a divergence", () => {
    const codes = { shellCode: 2 as const, nativeCode: 0 as const };
    const row = (comparison: object): unknown => ({
      schema: 1,
      id: randomUUID(),
      hook: "guard",
      engine: "pi",
      implementation: IMPL,
      timeMs: 1,
      kind: "complete",
      comparison,
    });
    expect(recordSchema.safeParse(row({ ...MATCH, ...codes })).success).toBe(false);
    expect(recordSchema.safeParse(row({ ...MATCH, shellCode: 0 })).success).toBe(false);
    expect(recordSchema.safeParse(row({ ...MATCH, codeDiffers: true, ...codes })).success).toBe(
      true,
    );
    expect(recordSchema.safeParse(row(MATCH)).success).toBe(true);
  });

  // Covers: R11, R12
  it("refuses malformed DTOs and missing files while report rejects unbound or duplicate completions", () => {
    for (const identity of [
      { ...IDENTITY, id: randomUUID() },
      { ...IDENTITY, payload: "secret" },
      { ...IDENTITY, hook: "../escape" },
      { ...IDENTITY, engine: "unknown" },
      { ...IDENTITY, implementation: "bad" },
    ]) {
      expect(begin(root, identity).ok).toBe(false);
      expect(existsSync(file())).toBe(false);
    }
    const started = begin(root, IDENTITY);
    if (!started.ok) throw new Error(started.reason);
    expect(complete(root, { ...started.receipt, id: randomUUID() }, MATCH).ok).toBe(true);
    expect(report(root, EXPECTED)).toMatchObject({ available: false, ready: false });
    history([started.receipt]);
    expect(complete(root, started.receipt, { ...MATCH, stdout: "secret" }).ok).toBe(false);
    expect(complete(root, started.receipt, { ...MATCH, shellCode: 4 }).ok).toBe(false);
    expect(complete(root, started.receipt, MATCH).ok).toBe(true);
    expect(report(root, EXPECTED)).toMatchObject({ available: true, engines: [{ complete: 1 }] });
    expect(complete(root, started.receipt, MATCH).ok).toBe(true);
    expect(report(root, EXPECTED)).toMatchObject({ available: false, ready: false });
    unlinkSync(file());
    expect(complete(root, started.receipt, MATCH).ok).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  // Covers: R11, R12
  it("preserves insecure files, symlinks, partial tails and nonprivate directories unchanged", () => {
    history([]);
    chmodSync(file(), 0o644);
    expect(begin(root, IDENTITY).ok).toBe(false);
    expect(readFileSync(file())).toEqual(Buffer.alloc(0));
    expect(statSync(file()).mode & 0o777).toBe(0o644);
    unlinkSync(file());
    const outside = join(root, "outside");
    writeFileSync(outside, "untouched", { mode: 0o600 });
    symlinkSync(outside, file());
    expect(begin(root, IDENTITY).ok).toBe(false);
    expect(report(root, EXPECTED).available).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    unlinkSync(file());
    writeFileSync(file(), "partial", { mode: 0o600 });
    expect(begin(root, IDENTITY).ok).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("partial");
    unlinkSync(file());
    chmodSync(dirname(file()), 0o755);
    expect(begin(root, IDENTITY).ok).toBe(false);
    expect(statSync(dirname(file())).mode & 0o777).toBe(0o755);
  });

  // Covers: R11, R12
  it("never repairs a rejected completion and leaves its acknowledged begin pending", () => {
    const started = begin(root, IDENTITY);
    if (!started.ok) throw new Error(started.reason);
    const original = readFileSync(file());
    expect(complete(root, started.receipt, { ...MATCH, nativeFailed: true, shellCode: 9 }).ok).toBe(
      false,
    );
    expect(readFileSync(file())).toEqual(original);
    expect(report(root, EXPECTED)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ pending: 1 }],
    });
  });

  // Covers: R19
  it("requires 500 matches and fourteen elapsed days for every authoritative engine", () => {
    expect(analyze(bytes(observations()), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: true,
    });
    expect(analyze(bytes(observations(499)), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: false,
    });
    expect(analyze(bytes(observations(500, MIN_SPAN_MS - 1)), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: false,
    });
    const expected = { ...EXPECTED, engines: ["claude", "pi"] };
    expect(analyze(bytes(observations()), expected, NOW)).toMatchObject({
      available: true,
      ready: false,
    });
    expect(
      analyze(
        bytes([...observations(), ...observations(500, MIN_SPAN_MS, "claude")]),
        expected,
        NOW,
      ),
    ).toMatchObject({ available: true, ready: true });
    for (const engines of [[], ["claude", "claude"], ["unknown"]])
      expect(analyze(bytes(observations()), { ...EXPECTED, engines }, NOW)).toMatchObject({
        available: false,
        ready: false,
      });
  });

  // Covers: R19
  it("requires a non-Claude host while preserving valid single-engine Pi and Codex evidence", () => {
    for (const engine of ["claude", "pi", "codex"] as const) {
      const expected = { ...EXPECTED, engines: [engine] };
      expect(analyze(bytes(observations(500, MIN_SPAN_MS, engine)), expected, NOW)).toMatchObject({
        available: true,
        ready: engine !== "claude",
        engines: [{ engine, matched: 500, spanMs: MIN_SPAN_MS }],
      });
      expect(analyze(bytes(observations(499, MIN_SPAN_MS, engine)), expected, NOW)).toMatchObject({
        available: true,
        ready: false,
      });
      expect(
        analyze(bytes(observations(500, MIN_SPAN_MS - 1, engine)), expected, NOW),
      ).toMatchObject({ available: true, ready: false });
    }
  });

  // Covers: R19
  it("counts the span between completed begins, not delayed finishes or old implementations", () => {
    const old = observations(500, MIN_SPAN_MS, "pi", OLD);
    expect(analyze(bytes(old), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ complete: 0 }],
    });
    const recent = observations(500, 0);
    for (const row of recent) if (row.kind === "begin") row.timeMs = NOW - MIN_SPAN_MS;
    expect(analyze(bytes([...old, ...recent]), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ spanMs: 0 }],
    });
    const rows = observations();
    const first = rows[0];
    if (!first || first.kind !== "begin") throw new Error("invalid fixture begin");
    const pending: Receipt = { ...first, id: randomUUID(), timeMs: NOW };
    expect(analyze(bytes([...rows, pending]), EXPECTED, NOW)).toMatchObject({
      available: true,
      ready: false,
      engines: [{ pending: 1 }],
    });
    expect(
      analyze(bytes([...rows, { ...pending, implementation: OLD }]), EXPECTED, NOW),
    ).toMatchObject({ available: true, ready: true });
  });

  // Covers: R11, R12, R19
  it("refuses orphan, duplicate, mismatched, future, malformed and privacy-invalid rows", () => {
    const rows = observations(1, 0);
    const start = rows[0];
    const end = rows[1];
    for (const bad of [
      [end],
      [start, start],
      [start, end, end],
      [start, { ...end, implementation: OLD }],
      [start, { ...end, timeMs: NOW - 1 }],
      [{ ...start, timeMs: NOW + 1 }],
      [{ ...start, extra: true }],
      [start, { ...end, payloadBase64: 7 }],
      [start, { ...end, comparison: { ...MATCH, shellCode: 4 } }],
    ]) {
      expect(analyze(bytes(bad), EXPECTED, NOW)).toMatchObject({ available: false, ready: false });
    }
    expect(analyze(Buffer.from([255, 10]), EXPECTED, NOW).available).toBe(false);
    const partial = bytes(rows).subarray(0, bytes(rows).length - 1);
    expect(analyze(partial, EXPECTED, NOW).available).toBe(false);
    expect(analyze(Buffer.from("\n"), EXPECTED, NOW).available).toBe(false);
  });

  // Covers: R11, R19
  it("returns unavailable for row/read limits and reports only from the explicit local root", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    history(observations());
    expect(report(root, EXPECTED)).toMatchObject({ available: true, ready: true });
    expect(report("relative", EXPECTED).available).toBe(false);
    expect(
      analyze(Buffer.alloc(MAX_LINE_BYTES + 1, 32).fill(10, MAX_LINE_BYTES), EXPECTED, NOW)
        .available,
    ).toBe(false);
    writeFileSync(file(), Buffer.alloc(MAX_LOG_BYTES + 1));
    expect(report(root, EXPECTED).available).toBe(false);
    expect(statSync(file()).size).toBe(MAX_LOG_BYTES + 1);
  });

  // Covers: R11, R12, R19
  it("preserves both process writers when the empty exclusive creator pauses before writing", async () => {
    const module = await childModule();
    const source = `
import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const {begin,complete} = await import(process.argv[1]);
if (process.argv[3] === 'pause') {
 const original = fs.writeSync;
 fs.writeSync = function(fd,data,...rest) { if(data.byteLength === 0) { original(1,'created\\n'); const b=Buffer.alloc(1); fs.readSync(0,b,0,1,null); } return original(fd,data,...rest); };
 syncBuiltinESMExports();
}
const started = begin(process.argv[2], ${JSON.stringify(IDENTITY)});
if(!started.ok) throw new Error('begin unavailable');
const done=complete(process.argv[2],started.receipt,${JSON.stringify(MATCH)});
if(!done.ok) throw new Error('complete unavailable');
process.stdout.write('done\\n');`;
    const children: ChildProcessWithoutNullStreams[] = [];
    const writer = (pause: boolean): ChildProcessWithoutNullStreams => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, module, root, pause ? "pause" : "run"],
        { stdio: "pipe" },
      );
      children.push(child);
      return child;
    };
    try {
      const first = writer(true);
      const created = new Promise<void>((resolve, reject) => {
        let stderr = "";
        first.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        first.stdout.on("data", (data: Buffer) => {
          if (data.toString().includes("created")) resolve();
        });
        first.once("error", reject);
        first.once("exit", () =>
          reject(new Error(`creator exited before empty create barrier: ${stderr}`)),
        );
      });
      await created;
      const second = writer(false);
      const finished = (child: ChildProcessWithoutNullStreams): Promise<void> =>
        new Promise((resolve, reject) => {
          let stderr = "";
          child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          child.once("error", reject);
          child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        });
      await finished(second);
      const firstDone = finished(first);
      first.stdin.end(Buffer.from([1]));
      await firstDone;
      expect(readFileSync(file(), "utf8").trimEnd().split("\n")).toHaveLength(4);
      expect(report(root, EXPECTED)).toMatchObject({
        available: true,
        ready: false,
        engines: [{ complete: 2, pending: 0 }],
      });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  });
});
