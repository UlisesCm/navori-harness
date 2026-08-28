import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rangeReportDir, sessionReportDir } from "../paths.ts";
import { NavoriError } from "../../errors.ts";

/**
 * The report directories compose a filesystem path out of an OPAQUE HOST TOKEN
 * (Claude Code's session id) and a date. That is the same shape of input that
 * produced #503, where an unvalidated id wrote outside the audit root — so the
 * guard is re-asserted here rather than assumed from the log path's copy.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-audit-paths-"));
  process.env.NAVORI_AUDITS_ROOT = root;
});

afterEach(() => {
  process.env.NAVORI_AUDITS_ROOT = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("sessionReportDir (#0013, R15)", () => {
  // Covers: R15
  it("stays under the audit root for a valid id", () => {
    const dir = sessionReportDir("demo", "2026-08-25", "a6260e0b-e88c-48b2");
    expect(dir.startsWith(join(root, "demo"))).toBe(true);
    // Short id: the directory is for a human to open and the date already
    // disambiguates; the full id lives inside the log's `start` event.
    expect(dir.endsWith("2026-08-25-a6260e0b")).toBe(true);
  });

  // Covers: R15
  it.each([["a/../../escaped"], ["../climb"], ["with space"], [""]])(
    "rejects a path-shaped session id (%s)",
    (id) => {
      expect(() => sessionReportDir("demo", "2026-08-25", id)).toThrow(NavoriError);
    },
  );

  // Covers: R15
  it("rejects a day that is not YYYY-MM-DD", () => {
    // An empty range (a session whose transcript carried no timestamps) would
    // otherwise compose a nameless directory, and `..` would climb out of it.
    for (const day of ["", "..", "2026-8-5", "2026-08-25/x"]) {
      expect(() => sessionReportDir("demo", day, "sess1")).toThrow(NavoriError);
    }
  });
});

describe("rangeReportDir (#0013, R16)", () => {
  // Covers: R16
  it("composes <from>--<to> under the audit root", () => {
    const dir = rangeReportDir("demo", "2026-08-25", "2026-08-28");
    expect(dir).toBe(join(root, "demo", "ranges", "2026-08-25--2026-08-28"));
  });

  // Covers: R16
  it("rejects a malformed day on either end", () => {
    expect(() => rangeReportDir("demo", "..", "2026-08-28")).toThrow(NavoriError);
    expect(() => rangeReportDir("demo", "2026-08-25", "")).toThrow(NavoriError);
  });
});
