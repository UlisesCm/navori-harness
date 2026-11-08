import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, git, mkTemp } from "../../__tests__/helpers/tmp-git.ts";
import { recordVerdicts, type VerdictOptions } from "../accept.ts";
import { readLog, readPlanState } from "../state.ts";

const PLAN = `# Plan: Demo

## Objetivo

Un socio ficticio usa la app.

## Aceptación

- Entorno: qa — https://qa.example.test
- Rama de aceptación: qa
- Rama destino: dev

## Slices

| ID | Actor → resultado | Spec | Commit |
|---|---|---|---|
| S1 | Socio → se registra | | |
| S2 | Socio → ve su historial | | |
| S3 | Socio → canjea un cupón | | |
| S4 | Socio → sin integrar | | |

## Decisiones

| ID | Decisión |
|---|---|
| D1 | Usar cupones de un solo uso |
`;

let repo: string;
let origin: string;

const LOG_REF = "refs/heads/navori/acceptance";
const remoteLog = (): string =>
  git(origin, "show", "navori/acceptance:acceptance.jsonl")
    .trim()
    .split("\n")
    .filter(Boolean)
    .join("\n");
const rev = (cwd: string, ref: string): string => git(cwd, "rev-parse", ref).trim();

/** Merges marked commits for `ids` into qa (the acceptance branch) and returns to `main`. */
function integrate(...ids: string[]): void {
  git(repo, "checkout", "-q", "-B", "qa", "origin/qa");
  for (const id of ids) git(repo, "commit", "-q", "--allow-empty", "-m", `[${id}] work`);
  git(repo, "push", "-q", "origin", "qa");
  git(repo, "checkout", "-q", "main");
}

const accept = (...ids: string[]) => accepting({ ids });
const accepting = (o: Partial<VerdictOptions>) =>
  recordVerdicts(repo, {
    verdict: "accepted",
    ids: [],
    approvedBy: "user",
    ...o,
  });
const reject = (id: string, ...notes: string[]) =>
  recordVerdicts(repo, {
    verdict: "rejected",
    ids: [id],
    notes,
    approvedBy: "user",
  });
const stateOf = (id: string) => readPlanState(repo).slices.find((s) => s.id === id);

beforeEach(() => {
  origin = mkTemp("acc-origin-");
  repo = mkTemp("acc-repo-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  for (const branch of ["main", "qa", "dev"]) git(repo, "push", "-q", "origin", `HEAD:${branch}`);
  git(repo, "fetch", "-q", "origin");
  mkdirSync(join(repo, "specs", "_plan"), { recursive: true });
  writeFileSync(join(repo, "specs", "_plan", "PLAN.md"), PLAN);
  integrate("S1", "S2", "S3");
});
afterEach(cleanupTempDirs);

describe("recordVerdicts", () => {
  it("accepts a batch of integrated slices, writes date/commit/evidence and publishes", () => {
    const before = {
      head: rev(repo, "HEAD"),
      status: git(repo, "status", "--porcelain"),
    };
    const out = accepting({
      ids: ["s1", "S3"],
      evidence: "https://example.test/qa",
    });
    expect(out).toMatchObject({ code: 0, stderr: "" });
    const sha = rev(repo, "origin/qa").slice(0, 7);
    expect(out.stdout).toMatch(
      new RegExp(
        `^S1 aceptado \\d{4}-\\d{2}-\\d{2} ${sha} · evidencia https://example\\.test/qa$`,
        "m",
      ),
    );
    expect(out.stdout).toContain("publicado en origin/navori/acceptance");
    const entries = readLog(repo);
    expect(entries.map((e) => [e.id, e.verdict, e.evidence])).toEqual([
      ["S1", "accepted", "https://example.test/qa"],
      ["S3", "accepted", "https://example.test/qa"],
    ]);
    expect(entries[0]).toMatchObject({
      env: "qa",
      by: "user",
      commit: rev(repo, "origin/qa"),
    });
    expect(Date.parse(entries[0]?.at ?? "")).not.toBeNaN();
    expect(remoteLog().split("\n")).toHaveLength(2);
    expect(rev(repo, LOG_REF)).toBe(rev(origin, LOG_REF));
    expect(stateOf("S1")?.state).toBe("aceptado");
    expect(rev(repo, "HEAD")).toBe(before.head);
    expect(git(repo, "status", "--porcelain")).toBe(before.status);
  });

  it("fails the whole batch on one bad id and writes nothing", () => {
    const out = accept("S1", "S9");
    expect(out).toMatchObject({ code: 1, stdout: "" });
    expect(out.stderr).toContain("S9");
    expect(git(repo, "branch", "--list", "navori/acceptance").trim()).toBe("");
    expect(git(origin, "branch", "--list", "navori/acceptance").trim()).toBe("");
  });

  it("only accepts integrated slices, and never mixes S with D", () => {
    expect(accept("S4").stderr).toContain("S4");
    expect(accept("S1", "D1").stderr).toContain("D<n> se acepta aparte");
    expect(accept("S1", "S1").stderr).toContain("repetidos");
    expect(accepting({ ids: ["S1"], evidence: "ftp://x" }).code).toBe(1);
    expect(accepting({ ids: ["S1"], notes: ["x"] }).code).toBe(1);
    expect(readLog(repo)).toEqual([]);
  });

  it("requires --approved-by user", () => {
    expect(accepting({ ids: ["S1"], approvedBy: "agent" }).code).toBe(1);
    expect(accepting({ ids: ["S1"], approvedBy: undefined }).code).toBe(1);
    expect(readLog(repo)).toEqual([]);
  });

  it("accepts a decision on its own", () => {
    expect(accept("D1").code).toBe(0);
    expect(readPlanState(repo).decisions[0]?.approved).toBe(true);
    expect(accept("D1").stderr).toContain("ya está aceptada");
  });

  it("needs notes to reject, and notes accumulate as open tasks", () => {
    expect(reject("S2").code).toBe(1);
    expect(reject("S4", "x").code).toBe(1);
    expect(reject("S2", "uno", "dos").code).toBe(0);
    expect(reject("S2", "tres").stdout).toMatch(/^S2 rechazado .* · 1 nota\(s\)$/m);
    expect(stateOf("S2")).toMatchObject({
      state: "en curso",
      notes: ["uno", "dos", "tres"],
    });
    expect(accept("S2").stderr).toContain("en curso");
    integrate("S2");
    expect(stateOf("S2")).toMatchObject({ state: "integrado", notes: ["uno", "dos", "tres"] });
    expect(accept("S2").code).toBe(0);
    expect(stateOf("S2")).toMatchObject({ state: "aceptado", notes: [] });
  });

  it("prints the verdict in the requested language", () => {
    const out = accepting({ ids: ["S1"], evidence: "https://example.test/qa", lang: "en" });
    expect(out.stdout).toMatch(/^S1 accepted .* · evidence https:\/\/example\.test\/qa$/m);
    expect(out.stdout).toContain("published to origin/navori/acceptance");
  });

  it("retries once when the remote refuses the push", () => {
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\n[ -e "${hook}.done" ] && exit 0\ntouch "${hook}.done"\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
    const out = accept("S1");
    expect(out.stdout).toContain("publicado");
    expect(existsSync(`${hook}.done`)).toBe(true);
    expect(remoteLog().split("\n")).toHaveLength(1);
    expect(rev(repo, LOG_REF)).toBe(rev(origin, LOG_REF));
  });

  it("keeps what another clone published and validates against it", () => {
    expect(accept("S1").code).toBe(0);
    const foreign = JSON.stringify({
      id: "S2",
      verdict: "accepted",
      at: "2026-01-01T00:00:00.000Z",
      env: "qa",
      commit: rev(repo, "origin/qa"),
      by: "user",
    });
    const run = (args: string[], input?: string): string =>
      execFileSync("git", args, { cwd: repo, input, encoding: "utf-8" }).trim();
    const blob = run(["hash-object", "-w", "--stdin"], `${remoteLog()}\n${foreign}\n`);
    const tree = run(["mktree"], `100644 blob ${blob}\tacceptance.jsonl\n`);
    const commit = run(["-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree]);
    run(["push", "-q", "-f", "origin", `${commit}:refs/heads/navori/acceptance`]);
    expect(accept("S2").stderr).toContain("S2");
    expect(accept("S3").code).toBe(0);
    expect(
      remoteLog()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual(["S1", "S2", "S3"]);
  });

  it("keeps the verdict local without a remote and publishes it with the next one", () => {
    git(repo, "remote", "set-url", "origin", join(origin, "missing"));
    const out = accept("S1");
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("sin publicar");
    expect(readLog(repo).map((e) => e.id)).toEqual(["S1"]);
    git(repo, "remote", "set-url", "origin", origin);
    expect(stateOf("S1")?.state).toBe("aceptado");
    expect(accept("S3").stdout).toContain("publicado");
    expect(
      remoteLog()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual(["S1", "S3"]);
  });
});
