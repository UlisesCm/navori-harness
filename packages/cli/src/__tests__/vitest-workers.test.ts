import { describe, expect, it } from "vitest";
import { FDS_PER_WORKER, WORKER_CAP, resolveMaxWorkers } from "../../vitest.workers.ts";

describe("resolveMaxWorkers", () => {
  // Covers: R10
  it("workers por CPU, tope por ulimit y override por env", () => {
    const free = { env: {}, ulimit: Number.POSITIVE_INFINITY };
    // CPU bound: leaves one core free.
    expect(resolveMaxWorkers({ ...free, cpus: 4 })).toBe(3);
    // CAP bound on a big machine.
    expect(resolveMaxWorkers({ ...free, cpus: 64 })).toBe(WORKER_CAP);
    expect(WORKER_CAP).toBe(4);
    expect(resolveMaxWorkers({ ...free, cpus: 5 })).toBe(4);
    expect(resolveMaxWorkers({ ...free, cpus: 6 })).toBe(4);
    // ulimit bound: a 256-fd shell gets fewer workers than the CPUs allow.
    expect(resolveMaxWorkers({ env: {}, cpus: 64, ulimit: FDS_PER_WORKER * 2 + 1 })).toBe(2);
    // Never below one worker, even with a tiny ulimit or a single CPU.
    expect(resolveMaxWorkers({ env: {}, cpus: 1, ulimit: 8 })).toBe(1);
    // Env override wins over every bound.
    expect(
      resolveMaxWorkers({ env: { NAVORI_TEST_WORKERS: "12" }, cpus: 2, ulimit: FDS_PER_WORKER }),
    ).toBe(12);
    // Garbage or non-positive overrides are ignored.
    for (const bad of ["", "abc", "0", "-3"]) {
      expect(resolveMaxWorkers({ env: { NAVORI_TEST_WORKERS: bad }, cpus: 4, ulimit: 1e9 })).toBe(
        3,
      );
    }
  });
});
