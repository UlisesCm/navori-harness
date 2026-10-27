import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { completeFromInput, decodePayload, parseEngines } from "../command.ts";
import { begin } from "../journal.ts";
import { recordSchema } from "../journal.schema.ts";

const IMPL = `sha256:${"a".repeat(64)}`;
const MATCH = {
  nativeFailed: false,
  shellFailed: false,
  codeDiffers: false,
  stdoutDiffers: false,
  stderrDiffers: false,
};
const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "navori-shadow-cli-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rows(): unknown[] {
  return readFileSync(join(root, ".navori/state/rust-shadow/guard.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line: string): unknown => recordSchema.parse(JSON.parse(line)));
}

describe("rust-shadow machine bridge", () => {
  // Covers: R11
  it("decodes only canonical base64 and an absent payload as empty bytes", () => {
    expect(decodePayload(undefined)).toEqual(new Uint8Array());
    expect(decodePayload(Buffer.from([0, 255, 10]).toString("base64"))).toEqual(
      new Uint8Array([0, 255, 10]),
    );
    expect(decodePayload("AA=")).toBeNull();
    expect(decodePayload("not base64!")).toBeNull();
  });

  // Covers: R11
  it("accepts only known engines for the report", () => {
    expect(parseEngines("claude,pi")).toEqual(["claude", "pi"]);
    expect(parseEngines("claude,cursor")).toBeNull();
    expect(parseEngines("")).toBeNull();
  });

  // Covers: R11, R12
  it("completes a begun observation and refuses malformed or extra input", () => {
    const ack = begin(root, { hook: "guard", engine: "pi", implementation: IMPL });
    if (!ack.ok) throw new Error(`begin refused: ${ack.reason}`);
    for (const input of [
      "not json",
      JSON.stringify({ receipt: ack.receipt, comparison: MATCH, extra: true }),
      JSON.stringify({ receipt: ack.receipt, comparison: MATCH, payloadBase64: "AA=" }),
    ]) {
      expect(completeFromInput(root, input)).toEqual({ ok: false, reason: "invalid" });
    }
    const diverged = { ...MATCH, stderrDiffers: true };
    expect(
      completeFromInput(
        root,
        JSON.stringify({
          receipt: ack.receipt,
          comparison: diverged,
          payloadBase64: Buffer.from("{}").toString("base64"),
        }),
      ),
    ).toEqual({ ok: true });
    expect(rows()).toMatchObject([
      { kind: "begin" },
      { kind: "complete", comparison: diverged, payloadBase64: "e30=" },
    ]);
  });

  // Covers: R11, R13
  it("runs begin, complete and report through the CLI as one JSON line each", () => {
    const cli = (args: string[], input = ""): { status: number | null; json: unknown } => {
      const run = spawnSync(process.execPath, [DIST, "tools", "rust-shadow", ...args], {
        input,
        encoding: "utf8",
      });
      expect(run.stdout.endsWith("\n")).toBe(true);
      return { status: run.status, json: JSON.parse(run.stdout) as unknown };
    };
    const started = cli([
      "begin",
      "--root",
      root,
      "--hook",
      "guard",
      "--engine",
      "pi",
      "--impl",
      IMPL,
    ]);
    expect(started.status).toBe(0);
    expect(started.json).toMatchObject({ kind: "begin", hook: "guard", engine: "pi" });
    const done = cli(
      ["complete", "--root", root],
      JSON.stringify({ receipt: started.json, comparison: MATCH }),
    );
    expect(done).toEqual({ status: 0, json: { ok: true } });
    const summary = cli([
      "report",
      "--root",
      root,
      "--hook",
      "guard",
      "--impl",
      IMPL,
      "--engines",
      "pi",
    ]);
    expect(summary.status).toBe(1);
    expect(summary.json).toMatchObject({
      available: true,
      ready: false,
      engines: [{ engine: "pi", complete: 1, matched: 1, divergences: 0, pending: 0 }],
    });
    const refused = cli([
      "begin",
      "--root",
      "relative",
      "--hook",
      "guard",
      "--engine",
      "pi",
      "--impl",
      IMPL,
    ]);
    expect(refused).toEqual({ status: 1, json: { ok: false, reason: "invalid" } });
  });
});
