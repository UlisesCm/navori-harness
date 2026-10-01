import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../config/schema.ts";
import {
  CODEGRAPH_TOOL,
  classifyCodegraphStatus,
  codegraphWiringFindings,
  scanCodegraphWiring,
  type CodegraphWiringDeps,
} from "../codegraph-wiring.ts";
import { codegraphProjectPathMismatch, mineCodegraphProjectPaths } from "../../audit/signals.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "navori-codegraph-wiring-"));
  dirs.push(d);
  return d;
}

const config = (enabled = true): NavoriConfig =>
  NavoriConfigSchema.parse({
    name: "cg",
    engines: ["claude"],
    preset: "custom",
    plugins: { codegraph: { enabled } },
  });

function agent(cwd: string, name: string, tools: string | null): void {
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
  const fm = tools === null ? `name: ${name}` : `name: ${name}\ntools: ${tools}`;
  writeFileSync(join(cwd, ".claude", "agents", `${name}.md`), `---\n${fm}\n---\n# ${name}\n`);
}

const fresh = JSON.stringify({ initialized: true, index: { reindexRecommended: false } });
const deps = (over: Partial<CodegraphWiringDeps> = {}): CodegraphWiringDeps => ({
  hasBinary: () => true,
  runStatus: () => fresh,
  ...over,
});

describe("scanCodegraphWiring", () => {
  // Covers: R32
  it("is null when the codegraph plugin is not enabled", () => {
    expect(scanCodegraphWiring(tmp(), config(false), deps())).toBeNull();
  });

  // Covers: R32
  it("separates agents with and without the grant", () => {
    const cwd = tmp();
    agent(cwd, "implementer", `Read, ${CODEGRAPH_TOOL}`);
    agent(cwd, "wild", "Read, mcp__codegraph__*");
    agent(cwd, "reviewer", "Read, Grep");
    const report = scanCodegraphWiring(cwd, config(), deps());
    expect(report?.grantedAgents).toEqual(["implementer", "wild"]);
    expect(report?.ungrantedAgents).toEqual(["reviewer"]);
    expect(codegraphWiringFindings(report!)).toContainEqual({
      kind: "ungranted-agents",
      agents: ["reviewer"],
    });
  });

  // Covers: R32
  it("counts the settings allow list as a grant", () => {
    const cwd = tmp();
    agent(cwd, "reviewer", "Read, Grep");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: [CODEGRAPH_TOOL] } }),
    );
    expect(scanCodegraphWiring(cwd, config(), deps())?.grantedAgents).toEqual(["reviewer"]);
  });

  // Covers: R32
  it("flags that no agent holds the grant", () => {
    const cwd = tmp();
    agent(cwd, "reviewer", "Read");
    const report = scanCodegraphWiring(cwd, config(), deps())!;
    expect(codegraphWiringFindings(report)).toContainEqual({ kind: "no-grant" });
  });

  // Covers: R32
  it("reports a missing binary as informative and never runs status", () => {
    let ran = false;
    const report = scanCodegraphWiring(
      tmp(),
      config(),
      deps({
        hasBinary: () => false,
        runStatus: () => {
          ran = true;
          return fresh;
        },
      }),
    );
    expect(report?.index).toEqual({ kind: "binary-missing" });
    expect(ran).toBe(false);
  });

  // Covers: R32
  it("degrades to unknown when status throws", () => {
    const report = scanCodegraphWiring(
      tmp(),
      config(),
      deps({
        runStatus: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(report?.index).toEqual({ kind: "unknown" });
  });

  // Covers: R32
  it("checks the projectPath rule in the instructions file", () => {
    const withRule = tmp();
    writeFileSync(join(withRule, "CLAUDE.md"), "Pass the absolute `projectPath`.");
    expect(scanCodegraphWiring(withRule, config(), deps())?.projectPathRule).toBe(true);

    const without = tmp();
    writeFileSync(join(without, "CLAUDE.md"), "Use codegraph.");
    const report = scanCodegraphWiring(without, config(), deps())!;
    expect(report.projectPathRule).toBe(false);
    expect(codegraphWiringFindings(report)).toContainEqual({ kind: "projectpath-rule-missing" });

    expect(scanCodegraphWiring(tmp(), config(), deps())?.projectPathRule).toBeNull();
  });
});

describe("classifyCodegraphStatus", () => {
  // Covers: R32
  it("maps missing, stale and fresh indexes", () => {
    expect(classifyCodegraphStatus(JSON.stringify({ initialized: false }))).toEqual({
      kind: "missing",
    });
    expect(
      classifyCodegraphStatus(
        JSON.stringify({ initialized: true, index: { reindexRecommended: true } }),
      ),
    ).toEqual({ kind: "stale", reason: "reindex-recommended" });
    expect(
      classifyCodegraphStatus(
        JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 2 } }),
      ),
    ).toEqual({ kind: "stale", reason: "pending-changes" });
    expect(
      classifyCodegraphStatus(
        JSON.stringify({ initialized: true, worktreeMismatch: { worktreeRoot: "/a" } }),
      ),
    ).toEqual({ kind: "stale", reason: "worktree-mismatch" });
    expect(classifyCodegraphStatus(fresh)).toEqual({ kind: "fresh" });
    expect(classifyCodegraphStatus("not json")).toEqual({ kind: "unknown" });
  });
});

describe("codegraph-projectpath-mismatch", () => {
  function transcript(cwd: string, projectPaths: Array<string | undefined>): string {
    const dir = tmp();
    const path = join(dir, "s1.jsonl");
    const lines = projectPaths.map((projectPath) =>
      JSON.stringify({
        cwd,
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: CODEGRAPH_TOOL,
              input: projectPath === undefined ? { query: "x" } : { query: "x", projectPath },
            },
          ],
        },
      }),
    );
    writeFileSync(path, lines.join("\n"));
    return path;
  }

  // Covers: R32
  it("flags a projectPath that points at another worktree", () => {
    const repo = "/work/repo";
    const wt = "/work/repo/.claude/worktrees/agent-1";
    const path = transcript(repo, [repo, `${repo}/`, wt, undefined]);
    const stats = mineCodegraphProjectPaths([{ sessionId: "s1", transcript: path }]);
    expect(stats).toEqual({ calls: 4, mismatched: 1, paths: [wt] });
    const [signal] = codegraphProjectPathMismatch(stats, "en");
    expect(signal?.kind).toBe("codegraph-projectpath-mismatch");
    expect(signal?.evidence).toContain(wt);
  });

  // Covers: R32
  it("is silent when every call matches the cwd", () => {
    const path = transcript("/work/repo", ["/work/repo", undefined]);
    const stats = mineCodegraphProjectPaths([{ sessionId: "s1", transcript: path }]);
    expect(codegraphProjectPathMismatch(stats, "es")).toEqual([]);
  });
});
