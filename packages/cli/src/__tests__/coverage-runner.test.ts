import { describe, expect, it, vi } from "vitest";
import { runCoverage } from "../../scripts/run-test-coverage.mjs";

type SpawnCall = [string, string[], { env: NodeJS.ProcessEnv }];

function successfulRunner() {
  const calls: SpawnCall[] = [];
  const removed: string[] = [];
  let count = 0;
  const status = runCoverage({
    env: { NAVORI_COVERAGE_DIR: undefined },
    mkdtempSync: () => "/tmp/navori-coverage-one",
    rmSync: (path) => {
      removed.push(String(path));
    },
    spawnSync: (command, args, options) => {
      calls.push([String(command), args.map(String), options as { env: NodeJS.ProcessEnv }]);
      count += 1;
      return { status: 0, signal: null, pid: count, output: [] };
    },
  });
  return { calls, removed, status };
}

describe("runCoverage", () => {
  it("gives Vitest and the floor one generated directory, then removes it on success", () => {
    const result = successfulRunner();

    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]![2].env.NAVORI_COVERAGE_DIR).toBe("/tmp/navori-coverage-one");
    expect(result.calls[1]![2].env.NAVORI_COVERAGE_DIR).toBe("/tmp/navori-coverage-one");
    expect(result.removed).toEqual(["/tmp/navori-coverage-one"]);
  });

  it("keeps an explicit caller-owned directory", () => {
    const removeDir = vi.fn();
    const status = runCoverage({
      env: { NAVORI_COVERAGE_DIR: "/tmp/caller-coverage" },
      rmSync: removeDir,
      spawnSync: () => ({ status: 0, signal: null, pid: 1, output: [] }),
    });

    expect(status).toBe(0);
    expect(removeDir).not.toHaveBeenCalled();
  });

  it("does not run the floor or remove evidence after Vitest fails or is interrupted", () => {
    const run = vi.fn(() => ({ status: null, signal: "SIGINT", pid: 1, output: [] }));
    const removeDir = vi.fn();
    const status = runCoverage({
      mkdtempSync: () => "/tmp/navori-coverage-interrupted",
      rmSync: removeDir,
      spawnSync: run,
    });

    expect(status).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(removeDir).not.toHaveBeenCalled();
  });

  it("keeps the report when the coverage floor fails", () => {
    const removeDir = vi.fn();
    let invocation = 0;
    const status = runCoverage({
      mkdtempSync: () => "/tmp/navori-coverage-floor-failure",
      rmSync: removeDir,
      spawnSync: () => {
        invocation += 1;
        return { status: invocation === 1 ? 0 : 2, signal: null, pid: invocation, output: [] };
      },
    });

    expect(status).toBe(2);
    expect(removeDir).not.toHaveBeenCalled();
  });
});
