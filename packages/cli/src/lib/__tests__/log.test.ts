import { describe, it, expect, vi, afterEach } from "vitest";
import { log } from "../log.ts";

/**
 * Spec 0003 §3.4.4 — level-gated logger. Default warn; debug/info silent
 * unless NAVORI_LOG raises the level. Always writes to stderr.
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

describe("log (spec 0003 §3.4.4)", () => {
  afterEach(() => {
    delete process.env.NAVORI_LOG;
  });

  it("default level is warn: debug/info silent, warn/error shown", () => {
    delete process.env.NAVORI_LOG;
    const out = capture(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(out).not.toContain("[navori:debug]");
    expect(out).not.toContain("[navori:info]");
    expect(out).toContain("[navori:warn] w");
    expect(out).toContain("[navori:error] e");
  });

  it("NAVORI_LOG=debug shows everything, with serialized meta", () => {
    process.env.NAVORI_LOG = "debug";
    const out = capture(() => log.debug("wrote", { path: "CLAUDE.md" }));
    expect(out).toBe('[navori:debug] wrote {"path":"CLAUDE.md"}\n');
  });

  it("an unknown NAVORI_LOG value falls back to warn", () => {
    process.env.NAVORI_LOG = "loud";
    const out = capture(() => {
      log.info("i");
      log.warn("w");
    });
    expect(out).not.toContain("[navori:info]");
    expect(out).toContain("[navori:warn] w");
  });
});
