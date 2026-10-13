import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { planCommand } from "../../../commands/plan.ts";
import { resumePlans } from "../resume.ts";
import { fingerprintTree, readHead } from "../evidence.ts";

let cwd: string;
const state = (name: string): string => join(cwd, ".navori/state/handoffs", name);
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const current = "Task: implement E2\nNext: review M2\nOld claim: passed\n";
function plan(feature = "demo"): void {
  writeFileSync(
    state(`workplan_${feature}.json`),
    JSON.stringify({
      feature,
      level: 1,
      classification: { score: 1, level: 1, signals: [] },
      objective: "continue",
      acceptance: [{ id: "A1", description: "executed", command: "test", expected: "pass" }],
      files: [],
      outOfScope: [],
      progress: { A1: "cumplido" },
    }),
  );
}
beforeEach(() => {
  vi.stubEnv("CODEX_THREAD_ID", undefined);
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-resume-")));
  git("init", "-b", "main");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "T");
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("switch", "-c", "feature");
  mkdirSync(state(""), { recursive: true });
  mkdirSync(join(cwd, "progress"));
  writeFileSync(join(cwd, "progress/current.md"), current);
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({ name: "test", preset: "custom", engines: ["codex"], branchBase: "main" }),
  );
  vi.spyOn(process, "cwd").mockImplementation(() => cwd);
  plan();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe("Codex resume continuity", () => {
  // Covers: R8, R3, R4
  it.each(["--show-object-format", "HEAD"])(
    "cancels delayed Git %s within the shared budget without reviving guarantees or writing Git state",
    (argument) => {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const bin = state("git-shim");
      mkdirSync(bin);
      const marker = state("delayed-git");
      const delayed = `
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(marker)}, "entered");
const end = Date.now() + 1500;
while (Date.now() < end) {}
`;
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
case " $* " in
  *" ${argument} "*) exec '${process.execPath}' -e '${delayed.replaceAll("'", "'\\''")}' ;;
esac
exec '${realGit}' "$@"
`,
        { mode: 0o755 },
      );
      const beforePlan = readFileSync(state("workplan_demo.json"), "utf8");
      const beforeIndex = readFileSync(join(cwd, ".git/index"));
      const beforeGit = readdirSync(join(cwd, ".git"), { recursive: true }).sort();
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      const started = Date.now();
      const result = resumePlans(cwd, 700);
      expect(Date.now() - started).toBeLessThan(1100);
      expect(readFileSync(marker, "utf8")).toBe("entered");
      expect(result.status).toBe("pending");
      expect(result.reason).toBe("resume deadline exceeded");
      expect(result.current).toBe(current);
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0]?.acceptance.A1?.status).toBe("pending");
      expect(result.plans[0]?.review.status).toBe("pending");
      expect(result.plans[0]?.receipt.status).toBe("pending");
      expect(readFileSync(state("workplan_demo.json"), "utf8")).toBe(beforePlan);
      expect(readFileSync(join(cwd, ".git/index"))).toEqual(beforeIndex);
      expect(readdirSync(join(cwd, ".git"), { recursive: true }).sort()).toEqual(beforeGit);
    },
  );
  // Covers: R8, R3, R4
  it("retains task/next step, revalidates actual evidence and invalidates drift without rewriting the plan", () => {
    const fp = fingerprintTree(cwd);
    if (!fp.ok) throw new Error(fp.reason);
    writeFileSync(
      state("workplan_demo.evidence.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        feature: "demo",
        id: "A1",
        command: "test",
        tree: cwd,
        cwd,
        head: readHead(cwd),
        worktreeTree: fp.tree,
        dirty: true,
      }) + "\n",
    );
    const before = readFileSync(state("workplan_demo.json"), "utf8");
    expect(fingerprintTree(cwd, undefined, { readOnly: true }).ok).toBe(true);
    expect(fingerprintTree(cwd, undefined, { readOnly: true })).toEqual(fp);
    const resumed = resumePlans(cwd);
    expect(resumed.status, resumed.reason).toBe("evaluated");
    expect(resumed.current).toBe(current);
    expect(resumed.plans[0]?.acceptance.A1?.status).toBe("passed");
    writeFileSync(join(cwd, "a.txt"), "drift\n");
    expect(resumePlans(cwd).plans[0]?.acceptance.A1?.status).toBe("pending");
    expect(readFileSync(state("workplan_demo.json"), "utf8")).toBe(before);
  });
  // Covers: R8
  it("evaluates multiple features separately and leaves missing review/receipt and timeout pending", () => {
    plan("second");
    const result = resumePlans(cwd);
    expect(result.status, result.reason).toBe("evaluated");
    expect(result.plans.map((p) => p.feature).sort()).toEqual(["demo", "second"]);
    for (const p of result.plans) {
      expect(p.review.status).toBe("pending");
      expect(p.receipt.status).toBe("pending");
    }
    const timeout = resumePlans(cwd, 0);
    expect(timeout.status).toBe("pending");
    expect(timeout.current).toBe(current);
    expect(
      timeout.plans.every((p) => Object.values(p.acceptance).every((a) => a.status === "pending")),
    ).toBe(true);
  });
  // Covers: R8
  it("uses the actual plan resume CLI entrypoint and treats malformed context as pending", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await runCommand(planCommand, { rawArgs: ["resume", "--json"] });
    expect(JSON.parse(output.join("")).current).toBe(current);
    writeFileSync(state("workplan_demo.json"), "broken");
    expect(resumePlans(cwd).status).toBe("pending");
  });
});
