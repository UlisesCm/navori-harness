// Covers: R21
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logReview } from "../review-schema.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { force: true, recursive: true })));

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-review-")));
  dirs.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  mkdirSync(join(root, "state"));
  return root;
}

const sidecar = {
  feature: "demo",
  verdict: "CHANGES_REQUESTED",
  findings: [
    { category: "correctness", severity: "high", score: 80, file: "a.ts", line: 3 },
    { category: "style", severity: "low", score: 20, file: "b.ts" },
  ],
};

function write(root: string, body: unknown): void {
  writeFileSync(
    join(root, "state", "review_demo.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

describe("logReview", () => {
  it("appends only findings with score >= 50", () => {
    const root = repo();
    write(root, sidecar);
    const result = logReview({ cwd: root, feature: "demo", dir: "state" });
    expect(result).toMatchObject({ status: "appended", appended: 1 });
    const lines = readFileSync(join(root, "state", "findings.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ file: "a.ts", score: 80, feature: "demo" });
  });

  it("dedupes a sidecar already logged and keeps prior lines", () => {
    const root = repo();
    write(root, sidecar);
    logReview({ cwd: root, feature: "demo", dir: "state" });
    const again = logReview({ cwd: root, feature: "demo", dir: "state" });
    expect(again).toMatchObject({ status: "duplicate", appended: 0 });
    const lines = readFileSync(join(root, "state", "findings.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
  });

  it("rejects invalid input with ERROR / WHY / FIX", () => {
    const root = repo();
    write(root, {
      ...sidecar,
      findings: [{ category: "x", severity: "nope", score: 9, file: "" }],
    });
    const result = logReview({ cwd: root, feature: "demo", dir: "state" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/^ERROR: .*\nWHY: .*\nFIX: /s);
  });

  it("rejects a missing sidecar and malformed JSON", () => {
    const root = repo();
    expect(logReview({ cwd: root, feature: "demo", dir: "state" }).status).toBe("error");
    write(root, "{nope");
    expect(logReview({ cwd: root, feature: "demo", dir: "state" }).status).toBe("error");
  });

  it("has the narrow allow rule in settings-base.json", () => {
    const settings = readFileSync(
      join(import.meta.dirname, "../../../../../core/core-assets/settings/settings-base.json"),
      "utf8",
    );
    expect(settings).toContain('"Bash(navori handoff log-review:*)"');
  });
});
