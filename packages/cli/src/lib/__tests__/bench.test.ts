import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * bench reads NAVORI_BENCH once at module load (`const enabled = ...`), so each
 * test stubs the env and re-imports a fresh module instance.
 */
function capture(fn: () => void): string {
  const out: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out.join("");
}

describe("bench (spec 0003 §3.3.4)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is a no-op when NAVORI_BENCH is unset", async () => {
    vi.stubEnv("NAVORI_BENCH", "");
    vi.resetModules();
    const { benchStart, benchMark, benchReport, benchEnabled } = await import("../bench.ts");
    expect(benchEnabled()).toBe(false);
    const out = capture(() => {
      benchStart();
      benchMark("x");
      benchReport();
    });
    expect(out).toBe("");
  });

  it("emits a per-step table when NAVORI_BENCH=1", async () => {
    vi.stubEnv("NAVORI_BENCH", "1");
    vi.resetModules();
    const { benchStart, benchMark, benchReport, benchEnabled } = await import("../bench.ts");
    expect(benchEnabled()).toBe(true);
    const out = capture(() => {
      benchStart();
      benchMark("loadConfig");
      benchMark("render");
      benchReport();
    });
    expect(out).toContain("[navori bench]");
    expect(out).toContain("loadConfig");
    expect(out).toContain("render");
    expect(out).toContain("total");
  });
});
