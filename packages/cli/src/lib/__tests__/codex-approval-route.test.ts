import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  approvalDeny,
  relayApproval,
  requestApproval,
  type ApprovalPending,
} from "../codex/approval-route.ts";

const CLI = resolve("src/index.ts");
const BUN = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real isolated checkout; home/global config and gh never participate. */
function fixture(): { cwd: string; command: string; payload: string; home: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-approval-")));
  dirs.push(cwd);
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q", "-b", "feat/review");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  writeFileSync(join(cwd, "source.txt"), "first\n");
  writeFileSync(join(cwd, "body.txt"), "Proposed body\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const command =
    "gh pr create --repo owner/repository --base main --head feat/review --title 'feat: review this' --body-file body.txt --draft";
  const home = join(cwd, ".home");
  mkdirSync(home);
  writeFileSync(join(home, "trust.toml"), "unchanged");
  return {
    cwd,
    command,
    home,
    payload: JSON.stringify({
      cwd,
      tool_name: "Bash",
      tool_input: { command },
      session_id: "claimed-session",
      tool_use_id: "tool-1",
      agent_id: "child",
    }),
  };
}

function requestFile(cwd: string, id: string): string {
  return join(cwd, ".navori/state/handoffs", `approval_${id}.json`);
}

/** Invoke actual registered source CLI, with isolated home and no external effects. */
function cli(args: string[], cwd: string, input?: string): string {
  const result = spawnSync(BUN, [CLI, "codex", "approval", ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 12_000,
    env: {
      ...process.env,
      HOME: join(cwd, ".home"),
      CODEX_HOME: join(cwd, ".home"),
      NAVORI_AUDIT_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("Codex pending approval route", () => {
  // Covers: R6, R7, R16
  it("actual request/relay CLI retains usable fields and never asserts consent", () => {
    const f = fixture();
    const output = JSON.parse(cli(["request"], f.cwd, f.payload)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    const id = output.hookSpecificOutput.permissionDecisionReason.match(
      /Pending request ([a-f0-9-]+)/,
    )?.[1];
    expect(id).toBeTruthy();
    const result = JSON.parse(cli(["relay", id!, "--cwd", f.cwd], f.cwd)) as ApprovalPending;
    expect(result).toMatchObject({
      status: "pending",
      reason: "source-unavailable",
      mediation: "claimed",
      remoteState: "unverified",
      fields: {
        repo: "owner/repository",
        base: "main",
        head: "feat/review",
        title: "feat: review this",
        bodyFile: "body.txt",
        draft: true,
      },
    });
    expect(result.reviewCommand).toContain("--title 'feat: review this'");
    expect(result.reviewCommand).toContain("--body-file 'body.txt'");
    expect(readFileSync(join(f.home, "trust.toml"), "utf8")).toBe("unchanged");
    expect(existsSync(join(f.cwd, "effect"))).toBe(false);
    const saved = readFileSync(requestFile(f.cwd, id!), "utf8");
    expect(saved).not.toContain("Proposed body");
    expect(saved).not.toContain('"command":');
  });

  // Covers: R6, R7
  it.each([
    "repo",
    "base",
    "head",
    "title",
    "bodyFile",
    "fingerprint",
    "bodyDigest",
    "headSha",
    "source",
    "origin",
  ])("tampered %s remains pending with no usable effect", (field) => {
    const f = fixture();
    const request = requestApproval(f.payload);
    const path = requestFile(f.cwd, request.requestId!);
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      fields: Record<string, unknown>;
    };
    if (["repo", "base", "head", "title", "bodyFile"].includes(field))
      saved.fields[field] = field === "repo" ? "other/repository" : "different";
    else saved[field] = "forged";
    writeFileSync(path, JSON.stringify(saved));
    const result = relayApproval(request.requestId!, f.cwd);
    expect(result.status).toBe("pending");
    expect(result.reviewCommand).toBeUndefined();
    expect(existsSync(join(f.cwd, "effect"))).toBe(false);
  });

  // Covers: R6, R7
  it.each(["body", "content", "checkout", "expiry"])(
    "revalidates %s drift and never consumes authorization",
    (change) => {
      const f = fixture();
      const request = requestApproval(f.payload);
      let cwd = f.cwd;
      if (change === "body") writeFileSync(join(cwd, "body.txt"), "changed");
      if (change === "content") writeFileSync(join(cwd, "source.txt"), "changed");
      if (change === "checkout") cwd = fixture().cwd;
      if (change === "expiry") {
        const path = requestFile(cwd, request.requestId!);
        const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        saved.createdAt = Date.now() - 16 * 60_000;
        writeFileSync(path, JSON.stringify(saved));
      }
      expect(relayApproval(request.requestId!, cwd).reviewCommand).toBeUndefined();
    },
  );

  // Covers: R6, R7
  it.each(["head", "base"])("rejects actual %s SHA drift even with identical content", (change) => {
    const f = fixture();
    const request = requestApproval(f.payload);
    const args =
      change === "head"
        ? ["commit", "--allow-empty", "-qm", "new head"]
        : ["update-ref", "refs/remotes/origin/main", "HEAD"];
    expect(spawnSync("git", args, { cwd: f.cwd }).status).toBe(0);
    expect(relayApproval(request.requestId!, f.cwd).reviewCommand).toBeUndefined();
  });

  // Covers: R6, R7, R16
  it("two actual CLI processes compete only for mediation; loser can read summary and recover", async () => {
    const f = fixture();
    const request = requestApproval(f.payload);
    const run = (): Promise<ApprovalPending> =>
      new Promise((resolveResult, reject) => {
        const child = spawn(
          BUN,
          [CLI, "codex", "approval", "relay", request.requestId!, "--cwd", f.cwd],
          {
            cwd: f.cwd,
            env: { ...process.env, CODEX_THREAD_ID: undefined, NAVORI_AUDIT_SESSION_ID: undefined },
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code: number | null) => {
          if (code !== 0) reject(new Error(`exit ${code}`));
          else resolveResult(JSON.parse(output) as ApprovalPending);
        });
      });
    const results = await Promise.all([run(), run()]);
    expect(results.map((result) => result.mediation).sort()).toEqual([
      "already-claimed",
      "claimed",
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        status: "pending",
        reason: "source-unavailable",
        fields: { title: "feat: review this" },
      });
    const repeat = relayApproval(request.requestId!, f.cwd);
    expect(repeat.mediation).toBe("already-claimed");
    expect(repeat.reviewCommand).toBeTruthy();
    const fresh = requestApproval(f.payload);
    expect(fresh.requestId).not.toBe(request.requestId);
    expect(relayApproval(fresh.requestId!, f.cwd).mediation).toBe("claimed");
    expect(existsSync(join(f.cwd, "effect"))).toBe(false);
  });

  // Covers: R6, R7, R16
  it("direct relay deadline kills a metadata Git grandchild retaining pipes", () => {
    const f = fixture();
    const request = requestApproval(f.payload);
    const bin = join(f.cwd, ".navori/state/bin");
    mkdirSync(bin);
    const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n *--show-toplevel*) echo $$ > '${bin}/stalled-pid'; sleep 20; exit 1 ;;\nesac\nexec '${git}' "$@"\n`,
      { mode: 0o755 },
    );
    const start = Date.now();
    const result = spawnSync(
      BUN,
      [CLI, "codex", "approval", "relay", request.requestId!, "--cwd", f.cwd],
      {
        cwd: f.cwd,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 8_000,
      },
    );
    expect(Date.now() - start).toBeLessThan(7_000);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "pending",
      reason: "handler-unavailable-or-timeout",
    });
    expect(() => process.kill(Number(readFileSync(join(bin, "stalled-pid"), "utf8")), 0)).toThrow();
    expect(existsSync(join(f.cwd, "effect"))).toBe(false);
  }, 12_000);

  // Covers: R6, R7, R16
  it.each(["approved", "human", "consent", "authorization", "source"])(
    "principal %s assertion cannot grant or create a request",
    (key) => {
      const f = fixture();
      const payload = { ...(JSON.parse(f.payload) as Record<string, unknown>), [key]: "approved" };
      expect(requestApproval(JSON.stringify(payload)).requestId).toBeUndefined();
      expect(JSON.stringify(approvalDeny(requestApproval(JSON.stringify(payload))))).toContain(
        '"permissionDecision":"deny"',
      );
    },
  );

  // Covers: R6, R7
  it.each([
    "--head other",
    "--repo implicit",
    "--approved true",
    "--title $(touch effect)",
    "--body-file ../body.txt",
    "--body-file -",
    "; touch effect",
    "--draft --draft",
    "--title 'unclosed",
  ])("unsupported or mismatched shape %s fails closed", (suffix) => {
    const f = fixture();
    const command =
      suffix === "--head other"
        ? f.command.replace("feat/review", "other")
        : `${f.command} ${suffix}`;
    const payload = JSON.stringify({ cwd: f.cwd, tool_name: "Bash", tool_input: { command } });
    expect(requestApproval(payload).requestId).toBeUndefined();
    expect(existsSync(join(f.cwd, "effect"))).toBe(false);
  });

  // Covers: R6, R7, R16
  it("malformed, oversized and symlinked state/body inputs never escape checkout", () => {
    const f = fixture();
    expect(requestApproval("not JSON").requestId).toBeUndefined();
    expect(requestApproval("x".repeat(65_537)).requestId).toBeUndefined();
    expect(relayApproval("../../escape", f.cwd).reason).toBe("invalid-request-id");
    rmSync(join(f.cwd, "body.txt"));
    symlinkSync(join(f.home, "trust.toml"), join(f.cwd, "body.txt"));
    expect(requestApproval(f.payload).requestId).toBeUndefined();
    rmSync(join(f.cwd, "body.txt"));
    writeFileSync(join(f.cwd, "body.txt"), "Proposed body\n");
    mkdirSync(join(f.cwd, ".navori"));
    symlinkSync(f.home, join(f.cwd, ".navori/state"));
    expect(requestApproval(f.payload).requestId).toBeUndefined();
    expect(readdirSync(f.home)).toEqual(["trust.toml"]);
  });
});
