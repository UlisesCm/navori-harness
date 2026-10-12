import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PROGRESS_CURRENT_PATH, scanProgressSize } from "../progress-size.ts";

function repoWith(content?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-progress-size-"));
  if (content !== undefined) {
    mkdirSync(join(cwd, "progress"));
    writeFileSync(join(cwd, PROGRESS_CURRENT_PATH), content);
  }
  return cwd;
}

describe("scanProgressSize (#1263)", () => {
  it("reports nothing when the file is missing", () => {
    expect(scanProgressSize(repoWith())).toBeNull();
  });

  it("reports nothing under the default cap", () => {
    expect(scanProgressSize(repoWith("a".repeat(3999)))).toBeNull();
  });

  it("reports nothing exactly at the cap", () => {
    expect(scanProgressSize(repoWith("a".repeat(4000)))).toBeNull();
  });

  it("reports the file one character over the cap", () => {
    expect(scanProgressSize(repoWith("a".repeat(4001)))).toEqual({
      path: PROGRESS_CURRENT_PATH,
      bytes: 4001,
      thresholdBytes: 4000,
    });
  });

  it("measures bytes, not characters (the hooks use wc -c)", () => {
    // 2500 chars of 2-byte "é" = 5000 bytes: over the 4000 cap by bytes only.
    expect(scanProgressSize(repoWith("é".repeat(2500)))?.bytes).toBe(5000);
  });

  it("honors a custom threshold", () => {
    const cwd = repoWith("a".repeat(50));
    expect(scanProgressSize(cwd, 100)).toBeNull();
    expect(scanProgressSize(cwd, 10)?.thresholdBytes).toBe(10);
  });

  it("reports nothing for multibyte content that stays under the cap in bytes", () => {
    expect(scanProgressSize(repoWith("é".repeat(1999)))).toBeNull();
  });
});
