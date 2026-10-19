import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCoverageArgs,
  runCoverage,
  validateShardFiles,
} from "../../scripts/run-test-coverage.mjs";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "navori-shards-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Complete wrapper filenames; native Vitest still validates the blob version and payload. */
function blobs(count: number): string {
  const root = sandbox();
  for (let i = 1; i <= count; i += 1) writeFileSync(join(root, `shard-${i}-${count}.json`), "[]");
  return root;
}

describe("coverage shards", () => {
  // Covers: R25
  it("merges transported blobs after every original raw coverage directory is gone", () => {
    const fixture = sandbox();
    const output = sandbox();
    const transported = sandbox();
    const merged = sandbox();
    const config = join(fixture, "vitest.config.mjs");
    writeFileSync(
      join(fixture, "branch.ts"),
      "export const branch = (value: boolean): number => value ? 1 : 2;\n",
    );
    for (const [index, value] of [
      [1, true],
      [2, false],
    ] as const) {
      writeFileSync(
        join(fixture, `sample-${index}.test.ts`),
        `import { branch } from './branch.ts'; test('branch-${index}', () => expect(branch(${value})).toBe(${value ? 1 : 2}));\n`,
      );
    }
    writeFileSync(
      config,
      `export default { root: ${JSON.stringify(fixture)}, test: { globals: true, include: ['*.test.ts'], globalSetup: [], setupFiles: [], coverage: { provider: 'v8', include: ['branch.ts'], reportsDirectory: process.env.NAVORI_COVERAGE_DIR, reporter: ['json-summary'] } } };\n`,
    );
    const allocated: string[] = [];
    const gates: string[] = [];
    const spawn = (
      command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ): { status: number | null; error?: Error; signal?: string | null } => {
      if (!args.includes("vitest")) {
        gates.push(args[0]!);
        return { status: 0 }; // Floor/budget command selection is asserted separately.
      }
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../../node_modules/vitest/vitest.mjs"),
          ...args
            .slice(2)
            .map((arg) =>
              arg === "--reporter=./vitest.reporter.ts"
                ? `--reporter=${resolve(import.meta.dirname, "../../vitest.reporter.ts")}`
                : arg,
            ),
          `--config=${config}`,
        ],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          env: options.env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      if (result.status !== 0)
        process.stderr.write(`${command}: ${result.stdout}\n${result.stderr}`);
      return { status: result.status, error: result.error, signal: result.signal };
    };
    const dependencies = {
      env: {
        NAVORI_COVERAGE_DIR: undefined,
        NAVORI_TEST_REPORT: undefined,
        NAVORI_KEEP_TEST_ARTIFACTS: undefined,
        NAVORI_BLOB_DIR: output,
      },
      mkdtempSync: (prefix: string): string => {
        const path = mkdtempSync(prefix);
        allocated.push(path);
        return path;
      },
      spawnSync: spawn,
    };
    for (const shard of ["1/2", "2/2"])
      expect(runCoverage(dependencies, ["--shard", shard])).toBe(0);
    expect(allocated.every((path) => !existsSync(path))).toBe(true);
    expect(gates).toEqual([]);
    for (const file of readdirSync(output)) cpSync(join(output, file), join(transported, file));
    rmSync(output, { recursive: true, force: true });
    expect(
      runCoverage({ ...dependencies, env: { ...dependencies.env, NAVORI_COVERAGE_DIR: merged } }, [
        "--merge",
        transported,
        "--shards",
        "2",
      ]),
    ).toBe(0);
    const summary: unknown = JSON.parse(
      readFileSync(join(merged, "coverage-summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      total: { lines: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 } },
    });
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatch(/check-coverage-floor\.mjs$/);
    expect(gates[1]).toMatch(/check-test-budget\.mjs$/);
    expect(readdirSync(transported)).toEqual(["shard-1-2.json", "shard-2-2.json"]);
  });

  // Covers: R25
  it("merge falla con blobs faltantes y evalúa el piso una sola vez", () => {
    const input = blobs(2);
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(() => runCoverage({ spawnSync: spawn }, ["--merge", input, "--shards", "3"])).toThrow();
    expect(spawn).not.toHaveBeenCalled();
    const report = sandbox();
    expect(
      runCoverage(
        {
          env: {
            NAVORI_COVERAGE_DIR: report,
            NAVORI_COVERAGE_SHARD: "1",
            NAVORI_TEST_REPORT: undefined,
          },
          spawnSync: spawn,
        },
        ["--merge", input, "--shards", "2"],
      ),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(3);
    const [native, floor, budget] = spawn.mock.calls as unknown as Array<
      [string, string[], { env: NodeJS.ProcessEnv }]
    >;
    expect(native![1]).toContain(`--merge-reports=${input}`);
    expect(native![1]).toContain("--coverage");
    expect(native![1]).toContain("--reporter=json");
    expect(native![1]).toContain("--reporter=./vitest.reporter.ts");
    expect(native![2].env.NAVORI_COVERAGE_SHARD).toBeUndefined();
    expect(floor![1][0]).toMatch(/check-coverage-floor\.mjs$/);
    expect(budget![1]).toEqual([
      expect.stringMatching(/check-test-budget\.mjs$/),
      "--report",
      join(report, "vitest-report.json"),
    ]);
  });

  // Covers: R25
  it("merge respects the caller's explicit test report path", () => {
    const input = blobs(2);
    const report = join(sandbox(), "caller-report.json");
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(
      runCoverage(
        { env: { NAVORI_COVERAGE_DIR: sandbox(), NAVORI_TEST_REPORT: report }, spawnSync: spawn },
        ["--merge", input, "--shards", "2"],
      ),
    ).toBe(0);
    const calls = spawn.mock.calls as unknown as Array<
      [string, string[], { env: NodeJS.ProcessEnv }]
    >;
    expect(calls[0]![1]).toContain(`--outputFile.json=${report}`);
    expect(calls[2]![1]).toEqual([
      expect.stringMatching(/check-test-budget\.mjs$/),
      "--report",
      report,
    ]);
  });

  // Covers: R25
  it("native failing shard prints its case and assertion without publishing success", () => {
    const fixture = sandbox();
    const report = sandbox();
    const output = sandbox();
    const config = join(fixture, "vitest.config.mjs");
    writeFileSync(
      join(fixture, "failure.test.ts"),
      "test('visible shard assertion', () => expect(1).toBe(2));\n",
    );
    writeFileSync(
      config,
      `export default { root: ${JSON.stringify(fixture)}, test: { globals: true, include: ['*.test.ts'], globalSetup: [], setupFiles: [], coverage: { provider: 'v8', include: [], reportsDirectory: process.env.NAVORI_COVERAGE_DIR, reporter: ['json-summary'] } } };\n`,
    );
    let diagnostic = "";
    const spawn = vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../../node_modules/vitest/vitest.mjs"),
          ...args
            .slice(2)
            .map((arg: string): string =>
              arg === "--reporter=./vitest.reporter.ts"
                ? `--reporter=${resolve(import.meta.dirname, "../../vitest.reporter.ts")}`
                : arg,
            ),
          `--config=${config}`,
        ],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          env: options.env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      diagnostic = `${result.stdout}\n${result.stderr}`;
      expect(result.error).toBeUndefined();
      return { status: result.status, error: result.error, signal: result.signal };
    });
    expect(
      runCoverage(
        {
          env: {
            NAVORI_COVERAGE_DIR: report,
            NAVORI_TEST_REPORT: undefined,
            NAVORI_BLOB_DIR: output,
          },
          spawnSync: spawn,
        },
        ["--shard", "1/1"],
      ),
    ).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(diagnostic).toContain("visible shard assertion");
    expect(diagnostic).toContain("expected 1 to be 2");
    expect(readdirSync(output)).toEqual([]);
  });

  // Covers: R25
  it.each([0, 1, 2])(
    "propagates child failure at phase %i and stops subsequent gates",
    (failedPhase) => {
      const input = blobs(2);
      let phase = 0;
      const spawn = vi.fn(() => ({ status: phase++ === failedPhase ? 7 : 0 }));
      expect(
        runCoverage({ env: { NAVORI_COVERAGE_DIR: sandbox() }, spawnSync: spawn }, [
          "--merge",
          input,
          "--shards",
          "2",
        ]),
      ).toBe(7);
      expect(spawn).toHaveBeenCalledTimes(failedPhase + 1);
    },
  );

  // Covers: R25
  it("rejects missing, duplicate, foreign and mixed-count shard sets before native merge", () => {
    for (const names of [
      [],
      ["shard-1-2.json"],
      ["shard-1-2.json", "shard-1-2.json"],
      ["shard-1-2.json", "shard-2-3.json"],
      ["shard-1-2.json", "shard-3-2.json"],
      ["shard-1-2.json", "unknown.json"],
    ]) {
      expect(() => validateShardFiles(names, 2)).toThrow();
    }
    expect(() => validateShardFiles(["shard-2-2.json", "shard-1-2.json"], 2)).not.toThrow();
  });

  // Covers: R25
  it("fails closed on mixed-version native rejection and preserves caller directories", () => {
    const input = blobs(2);
    const coverage = sandbox();
    writeFileSync(join(coverage, "owned.txt"), "keep");
    const remove = vi.fn();
    const spawn = vi.fn(() => ({ status: 1 }));
    expect(
      runCoverage({ env: { NAVORI_COVERAGE_DIR: coverage }, spawnSync: spawn, rmSync: remove }, [
        "--merge",
        input,
        "--shards",
        "2",
      ]),
    ).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(readFileSync(join(coverage, "owned.txt"), "utf8")).toBe("keep");
    expect(readdirSync(input)).toHaveLength(2);
  });

  // Covers: R25
  it("native Vitest rejects complete filenames whose blob versions differ", () => {
    const input = sandbox();
    // Vitest's flatted envelope; native version validation precedes payload replay.
    for (const [index, version] of [
      [1, "5.0.1"],
      [2, "0.0.0-invalid"],
    ] as const) {
      writeFileSync(
        join(input, `shard-${index}-2.json`),
        JSON.stringify([["1", "2", "3", "4", 0, "5"], version, [], [], {}, {}]),
      );
    }
    const config = join(sandbox(), "vitest.config.mjs");
    writeFileSync(
      config,
      "export default { test: { include: [], globalSetup: [], setupFiles: [] } };\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../node_modules/vitest/vitest.mjs"),
        "run",
        `--config=${config}`,
        `--merge-reports=${input}`,
      ],
      { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("same Vitest version");
    expect(readdirSync(input)).toHaveLength(2);
  });

  // Covers: R25
  it("validates mutually exclusive modes and bounded integer shard indices", () => {
    expect(parseCoverageArgs(["--shard", "2/4"])).toMatchObject({ shard: "2/4" });
    for (const args of [
      ["--shard", "0/4"],
      ["--shard", "5/4"],
      ["--shard", "1/2x"],
      ["--shard", "1/9007199254740992"],
      ["--shard"],
      ["--shard", "1/2", "--merge", "x"],
      ["--shards", "2"],
      ["--merge", "x", "--shards", "0"],
      ["--merge", "x", "--merge", "y"],
    ]) {
      expect(() => parseCoverageArgs(args)).toThrow();
    }
  });

  // Covers: R25
  it("partial shards disable only their gates and never publish failed children", () => {
    const report = sandbox();
    const spawn = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        expect(options.env.NAVORI_COVERAGE_SHARD).toBe("1");
        return { status: 6 };
      },
    );
    expect(
      runCoverage({ env: { NAVORI_COVERAGE_DIR: report }, spawnSync: spawn }, ["--shard", "1/4"]),
    ).toBe(6);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]![1];
    expect(args).toContain("--shard=1/4");
    expect(args).toContain("--reporter=blob");
    expect(args).toContain(
      `--reporter=${process.stdout.isTTY ? "default" : "./vitest.reporter.ts"}`,
    );
    expect(args).toContain(`--outputFile.blob=${join(report, "shard.blob.json")}`);
    expect(readdirSync(report)).toEqual([]);
  });

  // Covers: R25
  it("publishes successful blobs exclusively, keeps caller evidence and gates a 1/1 shard", () => {
    const report = sandbox();
    const output = sandbox();
    let gates = 0;
    const run = (
      _command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ): { status: number } => {
      if (args.includes("vitest")) {
        expect(options.env.NAVORI_COVERAGE_SHARD).toBeUndefined();
        writeFileSync(join(report, "shard.blob.json"), "native blob");
      } else gates += 1;
      return { status: 0 };
    };
    const deps = { env: { NAVORI_COVERAGE_DIR: report, NAVORI_BLOB_DIR: output }, spawnSync: run };
    expect(runCoverage(deps, ["--shard", "1/1"])).toBe(0);
    expect(gates).toBe(1);
    expect(readFileSync(join(output, "shard-1-1.json"), "utf8")).toBe("native blob");
    expect(() => runCoverage(deps, ["--shard", "1/1"])).toThrow(/EEXIST/);
    expect(readFileSync(join(output, "shard-1-1.json"), "utf8")).toBe("native blob");
    expect(readdirSync(report)).toContain("shard.blob.json");
  });

  // Covers: R25
  it.each([undefined, "1", "0"])(
    "config keeps aggregate thresholds unless the partial flag is %s",
    async (flag) => {
      vi.stubEnv("NAVORI_COVERAGE_SHARD", flag);
      vi.resetModules();
      const config = await import("../../vitest.config.ts");
      expect(config.default).toHaveProperty("test.coverage.reporter", ["json-summary"]);
      expect(config.default).toHaveProperty(
        "test.coverage.thresholds",
        flag === "1"
          ? undefined
          : { "src/lib/**": { lines: 65, statements: 60, functions: 65, branches: 57 } },
      );
    },
  );
});
