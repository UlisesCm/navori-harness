import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReviewHandoff } from "../review-check.ts";
import { beginReview, sealReview, type EvidenceOptions } from "../review-evidence.ts";

const dirs: string[] = [];
beforeEach(() => vi.stubEnv("CODEX_THREAD_ID", undefined));
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((d) => rmSync(d, { force: true, recursive: true }));
});

const DIR = ".navori/state/handoffs";

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-review-check-")));
  dirs.push(root);
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-m", "base");
  mkdirSync(join(root, DIR), { recursive: true });
  return root;
}

const options = (cwd: string): EvidenceOptions => ({
  cwd,
  feature: "demo",
  target: "main",
  gate: "",
});
const check = (cwd: string, since?: string) =>
  checkReviewHandoff({ cwd, dir: DIR, feature: "demo", ...(since ? { since } : {}) });
const kinds = (cwd: string, since?: string): string[] =>
  check(cwd, since).failures.map((f) => f.check);

/** begin -> write md + sidecar -> seal, as a reviewer does. */
function review(cwd: string, verdict = "APPROVED"): void {
  const begun = beginReview(options(cwd));
  if (begun.status !== "begun") throw new Error(begun.message);
  writeFileSync(join(cwd, DIR, "review_demo.md"), `# Review\n\nVerdict: ${verdict}\n`);
  writeFileSync(
    join(cwd, DIR, "review_demo.json"),
    JSON.stringify({ feature: "demo", verdict, findings: [] }),
  );
  const sealed = sealReview({ ...options(cwd), nonce: begun.nonce });
  if (sealed.status === "error") throw new Error(sealed.message);
}

describe("checkReviewHandoff (spec 0048 R7, D7)", () => {
  // Covers: R7
  it("fails with nothing written, a verdict-less md and an unsealed sidecar", () => {
    const cwd = repo();
    expect(kinds(cwd)).toEqual(["exists", "exists"]);
    writeFileSync(join(cwd, DIR, "review_demo.md"), "looks fine\n");
    writeFileSync(
      join(cwd, DIR, "review_demo.json"),
      JSON.stringify({ feature: "demo", verdict: "APPROVED", findings: [] }),
    );
    expect(kinds(cwd)).toEqual(["verdict", "evidence"]);
    writeFileSync(join(cwd, DIR, "review_demo.json"), "{not json");
    expect(kinds(cwd)).toEqual(["verdict", "parse"]);
  });

  // Covers: R7
  it("accepts a sealed review begun after dispatch and rejects one from an earlier round", () => {
    const cwd = repo();
    const before = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    review(cwd);
    expect(check(cwd, before)).toMatchObject({ status: "ok", failures: [], consumer: "reviewer" });
    const after = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    expect(kinds(cwd, after)).toEqual(["fresh"]);
    expect(kinds(cwd, "not-a-date")).toEqual(["fresh"]);
  });
});
