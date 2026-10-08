import { describe, it, expect } from "vitest";
import {
  renderVerdict,
  sentinelLine,
  summarizeGreen,
  summarizeRed,
  truncateMiddle,
} from "../summary.ts";

const bytes = (s: string): number => Buffer.byteLength(s);

const VITEST_GREEN = `
 ✓ src/a.test.ts (3 tests) 4ms
   ✓ handles failed login 1ms
   ✓ shows Error banner 1ms
 ✓ src/b.test.ts (2 tests) 2ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Duration  1.23s
`;
const VITEST_RED = `
 ✓ src/a.test.ts (3 tests) 4ms
 ❯ src/b.test.ts (2 tests | 1 failed) 9ms
   × b > breaks 3ms
     → expected 1 to be 2
 FAIL  src/b.test.ts > b > breaks
AssertionError: expected 1 to be 2
 ❯ src/b.test.ts:7:15

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
`;
const JEST_GREEN = `PASS src/a.test.js
  ✓ handles failed login (2 ms)
Test Suites: 1 passed, 1 total
Tests:       0 failed, 4 passed, 4 total
Snapshots:   0 total
`;
const JEST_RED = `FAIL src/a.test.js
  ● a › breaks
    expect(received).toBe(expected)
    Expected: 2
    Received: 1
Test Suites: 1 failed, 1 total
Tests:       1 failed, 3 passed, 4 total
`;
const PYTEST_GREEN = `collected 3 items
tests/test_a.py::test_failed_login PASSED
============ 3 passed, 0 failed in 0.12s ============
`;
const PYTEST_RED = `tests/test_a.py::test_x FAILED
=================== FAILURES ===================
E   AssertionError: assert 1 == 2
=========== 1 failed, 2 passed in 0.12s ===========
`;
const GO_GREEN = `ok  \tpkg/a\t0.010s
ok  \tpkg/b\t0.020s
ok  \tpkg/c\t(cached)
`;
const GO_RED = `--- FAIL: TestX (0.00s)
    x_test.go:9: got 1 want 2
FAIL
FAIL\tpkg/a\t0.010s
ok  \tpkg/b\t0.020s
`;
const CARGO_GREEN = [
  ...Array.from({ length: 30 }, (_, i) => `test result: ok. ${i + 1} passed; 0 failed; 0 ignored`),
].join("\n");
const CARGO_RED = `test tests::it_breaks ... FAILED

failures:
    tests::it_breaks

thread 'tests::it_breaks' panicked at src/lib.rs:5:9:
assertion failed
test result: FAILED. 1 passed; 1 failed; 0 ignored
error: test failed, to rerun pass \`--lib\`
`;

describe("summarizeGreen", () => {
  // Covers: A1
  it("keeps vitest totals and does not treat test names as failures", () => {
    const out = summarizeGreen(VITEST_GREEN);
    expect(out).toContain("Test Files  2 passed (2)");
    expect(out).toContain("Tests  5 passed (5)");
  });

  it("keeps jest and pytest totals", () => {
    expect(summarizeGreen(JEST_GREEN)).toContain("Tests:       0 failed, 4 passed, 4 total");
    expect(summarizeGreen(PYTEST_GREEN)).toContain("3 passed, 0 failed in 0.12s");
  });

  it("collapses go ok lines and cargo result lines", () => {
    expect(summarizeGreen(GO_GREEN)).toContain("go: 3 package(s) ok");
    const cargo = summarizeGreen(CARGO_GREEN);
    expect(cargo).toContain("30 passed");
    expect(cargo).toContain('30 "test result" lines');
    expect(cargo.split("\n").length).toBeLessThan(8);
  });

  it("is capped and keeps the end when the log is huge", () => {
    const noisy = Array.from({ length: 5000 }, (_, i) => `Tests ${i} passed`).join("\n");
    expect(bytes(summarizeGreen(noisy))).toBeLessThanOrEqual(2048);
  });
});

describe("summarizeRed", () => {
  // Covers: A1
  it.each([
    ["vitest", VITEST_RED, "AssertionError: expected 1 to be 2"],
    ["jest", JEST_RED, "Tests:       1 failed, 3 passed, 4 total"],
    ["pytest", PYTEST_RED, "AssertionError: assert 1 == 2"],
    ["go", GO_RED, "--- FAIL: TestX"],
    ["cargo", CARGO_RED, "panicked at src/lib.rs:5:9"],
  ])("surfaces the %s failure", (_name, log, expected) => {
    expect(summarizeRed(log)).toContain(expected);
  });

  it("is capped at 4 KB, truncating from the middle and keeping the tail", () => {
    const log = [
      "FAIL first-failure",
      ...Array.from({ length: 3000 }, (_, i) => `Error: noise ${i}`),
      "LAST LINE",
    ].join("\n");
    const out = summarizeRed(log);
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    expect(out).toContain("LAST LINE");
    expect(out).toContain("FAIL first-failure");
    expect(out).toContain("[truncated]");
  });

  it("strips ANSI and clips very long lines", () => {
    const out = summarizeRed(`\u001b[31mFAIL x\u001b[0m\n${"y".repeat(5000)}`);
    expect(out).not.toContain("\u001b");
    expect(bytes(out)).toBeLessThan(1000);
  });
});

describe("truncateMiddle / renderVerdict", () => {
  it("never exceeds the byte budget, even for multibyte text", () => {
    expect(bytes(truncateMiddle("é".repeat(5000), 500))).toBeLessThanOrEqual(500);
  });

  it("starts with the exact sentinel and respects total caps", () => {
    const green = renderVerdict("full", 0, ".navori/state/gate/full-1.log", VITEST_GREEN);
    expect(green.split("\n")[0]).toBe(sentinelLine("full", 0, ".navori/state/gate/full-1.log"));
    expect(green.split("\n")[0]).toBe(
      "navori gate full: exit 0 — log .navori/state/gate/full-1.log",
    );
    const big = Array.from({ length: 9000 }, (_, i) => `Error ${i}`).join("\n");
    expect(bytes(renderVerdict("full", 1, "l.log", big))).toBeLessThanOrEqual(4096);
    expect(bytes(renderVerdict("full", 0, "l.log", big))).toBeLessThanOrEqual(2048);
  });
});
