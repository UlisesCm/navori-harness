import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginReview,
  checkSealedEvidence,
  runReviewGate,
  sealReview,
  type EvidenceOptions,
} from "../review-evidence.ts";
import { resolveStateRoot, stateArtifactPath } from "../../primitives/state-root.ts";
import { ReviewSidecarSchema } from "../review-schema.ts";
import { runCommand } from "citty";
import { gateCommand } from "../../../commands/gate.ts";

let cwd: string;
let options: EvidenceOptions;
let nonce: string;
const gate = "npm run verify";

function stateFile(name: string): string {
  return stateArtifactPath(resolveStateRoot(options), name);
}

function approve(): ReturnType<typeof sealReview> {
  writeFileSync(
    stateFile("review_demo.json"),
    JSON.stringify({ feature: "demo", verdict: "APPROVED", findings: [] }),
  );
  return sealReview({ ...options, nonce });
}

beforeEach(() => {
  vi.stubEnv("CODEX_THREAD_ID", "");
  vi.stubEnv("REVIEW_GATE_TEST", "");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-review-gate-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  writeFileSync(join(cwd, "a.txt"), "original\n");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { verify: "node gate.cjs" } }),
  );
  writeFileSync(
    join(cwd, "gate.cjs"),
    `
const fs = require("node:fs");
const mode = process.env.REVIEW_GATE_TEST;
if (mode === "failure") process.exit(7);
if (mode === "signal") process.kill(process.pid, "SIGTERM");
if (mode === "binary") process.stdout.write(Buffer.from([0xff]));
if (mode === "drift") fs.writeFileSync("a.txt", "changed\\n");
setTimeout(() => console.log("gate completed"), 50);
`,
  );
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "g",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: gate, full: gate },
    }),
  );
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"],
    { cwd },
  );
  options = { cwd, feature: "demo", target: "main", gate };
  const begun = beginReview(options);
  if (begun.status !== "begun") throw new Error(begun.message);
  nonce = begun.nonce;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe("review-correlated foreground gate (#1338)", () => {
  it("runs the correlated full gate through the CLI", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCommand(gateCommand, {
      rawArgs: [
        "full",
        "--cwd",
        cwd,
        "--review-feature",
        "demo",
        "--review-nonce",
        nonce,
        "--target",
        "main",
      ],
    });
    expect(process.exitCode).toBe(0);
    expect(approve().status).toBe("validated");
  });

  it.each([
    ["full", "--review-feature", "demo"],
    ["fast", "--review-feature", "demo", "--review-nonce", "nonce", "--target", "main"],
    ["probe", "--review-feature", "demo"],
  ])("refuses incomplete or incompatible review flags: %j", async (...flags: string[]) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCommand(gateCommand, { rawArgs: [...flags, "--cwd", cwd] });
    expect(process.exitCode).toBe(2);
  });

  it("seals a completed run from a different caller context and retains its executor and log", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "principal-session");
    const result = await runReviewGate({ ...options, nonce });
    expect(result.exitCode).toBe(0);
    const record: Record<string, unknown> = JSON.parse(
      readFileSync(stateFile(`review_demo.${nonce}.gate.json`), "utf8"),
    );
    expect(record).toMatchObject({
      executorPid: process.pid,
      executorSession: "principal-session",
      exitCode: 0,
      target: "main",
    });
    expect(readFileSync(join(cwd, String(record.log)), "utf8")).toContain("gate completed");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "reviewer-session");
    expect(approve().status).toBe("validated");
    const sidecar = ReviewSidecarSchema.parse(
      JSON.parse(readFileSync(stateFile("review_demo.json"), "utf8")),
    );
    expect(checkSealedEvidence(resolveStateRoot(options), sidecar).status).toBe("sealed");
    expect(sidecar.evidence).toHaveProperty("gateRun");
  });

  it.each(["failure", "signal"])("never seals a %s as a successful run", async (mode: string) => {
    vi.stubEnv("REVIEW_GATE_TEST", mode);
    expect((await runReviewGate({ ...options, nonce })).exitCode).not.toBe(0);
    expect(approve().status).toBe("error");
  });

  it("refuses source changes during the gate", async () => {
    vi.stubEnv("REVIEW_GATE_TEST", "drift");
    expect((await runReviewGate({ ...options, nonce })).stderr).toContain(
      "changed during the gate",
    );
    expect(approve().status).toBe("error");
  });

  it("rejects a stale begin, a foreign nonce and a different target before execution", async () => {
    expect(
      (await runReviewGate({ ...options, nonce: "00000000-0000-0000-0000-000000000001" })).exitCode,
    ).toBe(2);
    expect((await runReviewGate({ ...options, nonce, target: "dev" })).exitCode).toBe(2);
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    expect((await runReviewGate({ ...options, nonce })).stderr).toContain("changed since begin");
  });

  it("starts a fresh execution even when a matching cached green exists, and refuses replay", async () => {
    expect((await runReviewGate({ ...options, nonce })).exitCode).toBe(0);
    expect((await runReviewGate({ ...options, nonce })).exitCode).toBe(2);
    const begun = beginReview(options);
    if (begun.status !== "begun") throw new Error(begun.message);
    vi.stubEnv("REVIEW_GATE_TEST", "failure");
    expect((await runReviewGate({ ...options, nonce: begun.nonce })).exitCode).toBe(7);
  });

  it("refuses an unfinished reservation instead of replacing it", async () => {
    writeFileSync(stateFile(`review_demo.${nonce}.gate.json`), "");
    expect((await runReviewGate({ ...options, nonce })).exitCode).toBe(2);
    expect(approve().status).toBe("error");
  });

  it("invalidates sealed evidence when the original log changes", async () => {
    expect((await runReviewGate({ ...options, nonce })).exitCode).toBe(0);
    expect(approve().status).toBe("validated");
    const record: Record<string, unknown> = JSON.parse(
      readFileSync(stateFile(`review_demo.${nonce}.gate.json`), "utf8"),
    );
    writeFileSync(join(cwd, String(record.log)), "altered\n");
    const sidecar = ReviewSidecarSchema.parse(
      JSON.parse(readFileSync(stateFile("review_demo.json"), "utf8")),
    );
    expect(checkSealedEvidence(resolveStateRoot(options), sidecar).status).toBe("invalid");
  });

  it("hashes raw log bytes so different invalid UTF-8 bytes cannot share evidence", async () => {
    vi.stubEnv("REVIEW_GATE_TEST", "binary");
    expect((await runReviewGate({ ...options, nonce })).exitCode).toBe(0);
    expect(approve().status).toBe("validated");
    const record: Record<string, unknown> = JSON.parse(
      readFileSync(stateFile(`review_demo.${nonce}.gate.json`), "utf8"),
    );
    const path = join(cwd, String(record.log));
    const bytes = readFileSync(path);
    const index = bytes.indexOf(0xff);
    expect(index).toBeGreaterThanOrEqual(0);
    bytes[index] = 0xfe;
    writeFileSync(path, bytes);
    const sidecar = ReviewSidecarSchema.parse(
      JSON.parse(readFileSync(stateFile("review_demo.json"), "utf8")),
    );
    expect(checkSealedEvidence(resolveStateRoot(options), sidecar).status).toBe("invalid");
  });
});
