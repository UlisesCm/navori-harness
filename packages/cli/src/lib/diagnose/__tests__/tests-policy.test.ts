import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTestSuite, suggestTestsForNewCode } from "../detect.ts";

/**
 * #529 — the tests policy is derived from what the repo SHOWS, not asked and
 * then left blank (navori's own config never declared it, which is how the gap
 * surfaced).
 *
 * The distinction these pin is setup vs. suite: a repo where someone added a
 * runner years ago and nobody wrote a test must not be told to ship tests with
 * every change. A rule against reality is a rule nobody follows.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-tests-policy-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(rel: string, content = "x"): void {
  const full = join(cwd, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("hasTestSuite", () => {
  it("finds a colocated *.test.ts", () => {
    write("src/sum.test.ts");
    expect(hasTestSuite(cwd)).toBe(true);
  });

  it("finds a *.spec.tsx anywhere in the tree", () => {
    write("app/features/login/Login.spec.tsx");
    expect(hasTestSuite(cwd)).toBe(true);
  });

  it("finds a populated __tests__ directory", () => {
    write("src/__tests__/whatever.ts");
    expect(hasTestSuite(cwd)).toBe(true);
  });

  it("does NOT count an EMPTY __tests__ directory — that is scaffolding", () => {
    mkdirSync(join(cwd, "src", "__tests__"), { recursive: true });
    expect(hasTestSuite(cwd)).toBe(false);
  });

  it("finds python and go conventions", () => {
    write("app/test_views.py");
    expect(hasTestSuite(cwd)).toBe(true);
    const other = mkdtempSync(join(tmpdir(), "navori-go-"));
    writeFileSync(join(other, "handler_test.go"), "package main", "utf-8");
    expect(hasTestSuite(other)).toBe(true);
    rmSync(other, { recursive: true, force: true });
  });

  it("ignores node_modules — a dependency's tests are not this repo's suite", () => {
    write("node_modules/lodash/sum.test.js");
    expect(hasTestSuite(cwd)).toBe(false);
  });

  it("says false for a repo with source but no tests", () => {
    write("src/index.ts");
    write("package.json", "{}");
    expect(hasTestSuite(cwd)).toBe(false);
  });
});

describe("suggestTestsForNewCode", () => {
  it("says nothing when there is no runner — silence is an answer", () => {
    write("src/index.ts");
    expect(suggestTestsForNewCode(cwd, null)).toBeUndefined();
  });

  it("derives always when the runner has a suite behind it", () => {
    write("src/sum.test.ts");
    expect(suggestTestsForNewCode(cwd, "vitest")).toBe("always");
  });

  it("derives when-applicable for a runner nobody used — the legacy shape", () => {
    // The case that motivated the issue: setup present, suite absent. Ordering
    // `always` writes a rule against reality; ordering `none` throws away a
    // runner that is right there.
    write("package.json", JSON.stringify({ devDependencies: { jest: "^29" } }));
    expect(suggestTestsForNewCode(cwd, "jest")).toBe("when-applicable");
  });

  it("does not count a Maestro-style e2e suite as a unit-test suite", () => {
    // `.maestro/flows/*.yaml` are device flows, written by hand. A repo whose
    // only "tests" are those has a runner nobody used, which is exactly the
    // `when-applicable` case — and the reason `testsExclude` exists.
    write(".maestro/flows/01_login.yaml", "appId: com.example");
    expect(suggestTestsForNewCode(cwd, "jest")).toBe("when-applicable");
  });
});
