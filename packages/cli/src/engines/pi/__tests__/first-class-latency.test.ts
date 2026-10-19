import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";
import { load } from "./fixtures/load-extension.ts";
import { emptyRepo, type RepoTemplate } from "../../../__tests__/helpers/repo-template.ts";

/** Repos built once per file and copied per case (spec 0055 D7). */
let repoTplMaster: RepoTemplate;
beforeAll(() => {
  repoTplMaster = emptyRepo({ branch: "master" });
});
afterAll(() => {
  repoTplMaster.dispose();
});

// Every call runs the real rendered scripts under bash; a saturated machine needs room.
vi.setConfig({ testTimeout: 120_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fixed benign corpus: ordinary read/build/git commands every guard must let through. */
const BENIGN_CORPUS: readonly string[] = [
  "ls -la",
  "git status --short",
  "git diff --stat",
  "git log --oneline -5",
  "cat package.json",
  "echo hello",
  "pwd",
  "bun run typecheck",
  "npm test -- --silent",
  "mkdir -p build/out",
  "head -n 20 README",
  "wc -l src/index.ts",
];
const WARMUP = 5;
const ROUNDS = 5;

/** Nearest-rank percentile of an ascending-sorted sample. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe("Pi bridge latency", () => {
  // Covers: R17
  it("measures per-bash-call overhead over a benign corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-latency-"));
    dirs.push(dir);
    repoTplMaster.copyInto(dir);
    renderPiEngine(
      dir,
      NavoriConfigSchema.parse({
        name: "pi-latency",
        preset: "custom",
        engines: ["pi"],
        branchBase: "main",
        qualityGate: { fast: "bun test", full: "bun test" },
      }),
    );
    const handler = load({ env: {} }).get("tool_call")!;
    const ctx = {
      cwd: dir,
      hasUI: false,
      sessionManager: { getSessionId: () => "sess-latency" },
    };
    const run = async (command: string): Promise<unknown> =>
      handler({ toolName: "bash", toolCallId: "call-latency", input: { command } }, ctx);

    for (let i = 0; i < WARMUP; i++) await run("echo warmup");
    const samples: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const command of BENIGN_CORPUS) {
        const start = performance.now();
        const verdict = await run(command);
        samples.push(performance.now() - start);
        // A benign command is allowed: the bridge returns no block.
        expect(verdict, command).toBeUndefined();
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const line = `bridge latency per bash call: n=${sorted.length} p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms max=${(sorted.at(-1) ?? 0).toFixed(1)}ms`;
    // The design names no ceiling (F17 reference: ~25-28 ms per script in series), so the numbers are
    // recorded, never asserted: timing assertions flake on a loaded machine.
    // NAVORI_LATENCY_OUT=<file> appends the line for the report; vitest hides passing console output.
    if (process.env.NAVORI_LATENCY_OUT) appendFileSync(process.env.NAVORI_LATENCY_OUT, `${line}\n`);
    expect(sorted).toHaveLength(BENIGN_CORPUS.length * ROUNDS);
  });
});
