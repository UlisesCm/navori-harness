import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, git, mkTemp } from "../../__tests__/helpers/tmp-git.ts";
import { checkIncoming, readPlanState } from "../state.ts";

const PLAN = (extra = ""): string => `# Plan: Demo

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
${extra}`;

let repo: string;

/** Commits an empty change with `message` on `branch` (created from `from`) and pushes it. */
function commitOn(branch: string, message: string, from = "main"): string {
  git(repo, "checkout", "-q", "-B", branch, branch === from ? branch : `origin/${from}`);
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  git(repo, "push", "-q", "-f", "origin", branch);
  return git(repo, "rev-parse", "HEAD").trim();
}

/** Merges `source` into `into` with a merge commit (GitHub's subject) and pushes. */
function mergeInto(into: string, source: string, subject: string): void {
  git(repo, "checkout", "-q", "-B", into, `origin/${into}`);
  git(repo, "merge", "-q", "--no-ff", "-m", subject, `origin/${source}`);
  git(repo, "push", "-q", "origin", into);
}

/** Writes acceptance.jsonl to the orphan navori/acceptance branch with plumbing. */
function writeLog(lines: object[]): void {
  const run = (args: string[], input?: string): string =>
    execFileSync("git", args, { cwd: repo, input, encoding: "utf-8" }).trim();
  const blob = run(
    ["hash-object", "-w", "--stdin"],
    lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  );
  const tree = run(["mktree"], `100644 blob ${blob}\tacceptance.jsonl\n`);
  const commit = run([
    "-c",
    "user.email=t@navori.test",
    "-c",
    "user.name=navori",
    "commit-tree",
    tree,
    "-m",
    "acceptance",
  ]);
  run(["update-ref", "refs/heads/navori/acceptance", commit]);
}

beforeEach(() => {
  const origin = mkTemp("mp-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  repo = mkTemp("mp-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(repo, "specs", "_plan"), { recursive: true });
  writeFileSync(join(repo, "specs", "_plan", "PLAN.md"), PLAN());
  git(repo, "add", "specs");
  git(repo, "commit", "-q", "-m", "plan");
  git(repo, "push", "-q", "origin", "main");
  for (const b of ["qa", "dev"]) {
    git(repo, "branch", "-f", b, "main");
    git(repo, "push", "-q", "origin", b);
  }
});
afterEach(cleanupTempDirs);

const stateOf = (id: string) => readPlanState(repo).slices.find((s) => s.id === id);

describe("readPlanState", () => {
  it("derives pendiente, en curso and integrado from the marks", () => {
    commitOn("slice/S2-historial", "feat: historial\n\nSlice: S2");
    commitOn("slice/S1-registro", "[S1] registro");
    mergeInto("qa", "slice/S1-registro", "[S1] registro (#1)");
    expect(stateOf("S1")?.state).toBe("integrado");
    expect(stateOf("S2")?.state).toBe("en curso");
    expect(stateOf("S3")?.state).toBe("pendiente");
    expect(readPlanState(repo).counted).toEqual(["S1"]);
  });

  it("reads GitHub's merge subject as a mark and flags a slice that never reaches qa", () => {
    commitOn("slice/S3-cupon", "feat: cupón");
    mergeInto("dev", "slice/S3-cupon", "Merge pull request #3 from someone/slice/S3-cupon");
    expect(stateOf("S3")).toMatchObject({ state: "en curso", noEnv: true });
    expect(readPlanState(repo).counted).toEqual(["S3"]);
  });

  it("uses the Commit column for slices integrated before the v2", () => {
    const sha = commitOn("qa", "feat: registro previo", "qa");
    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN().replace("| S1 | Socio → se registra | | |", `| S1 | Socio → se registra | | ${sha} |`),
    );
    expect(stateOf("S1")?.state).toBe("integrado");
  });

  it("applies the latest verdict of the log, with rejection notes and approved decisions", () => {
    const head = commitOn("qa", "[S1] registro", "qa");
    const s2 = commitOn("qa", "[S2] historial", "qa");
    commitOn("qa", "fix: retrabajo\n\nSlice: S1", "qa");
    writeLog([
      {
        id: "S1",
        verdict: "accepted",
        at: "2026-11-07",
        env: "qa",
        commit: head,
        by: "user",
        evidence: "https://example.test/qa-1",
      },
      {
        id: "S2",
        verdict: "rejected",
        at: "2026-11-07",
        env: "qa",
        commit: s2,
        by: "user",
        notes: ["a"],
      },
      {
        id: "S2",
        verdict: "rejected",
        at: "2026-11-08",
        env: "qa",
        commit: s2,
        by: "user",
        notes: ["b"],
      },
      { id: "D1", verdict: "accepted", at: "2026-11-07", env: "qa", commit: head, by: "user" },
    ]);
    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN(
        "\n## Decisiones\n\n| ID | Decisión |\n|---|---|\n| D1 | Solo correo |\n| D2 | Sin SMS |\n",
      ),
    );
    const state = readPlanState(repo);
    expect(stateOf("S1")).toMatchObject({
      state: "aceptado",
      evidence: "https://example.test/qa-1",
    });
    expect(stateOf("S2")).toMatchObject({ state: "en curso", notes: ["a", "b"] });
    expect(state.counted).toEqual(["S2"]);
    expect(state.decisions).toEqual([
      { id: "D1", text: "Solo correo", approved: true },
      { id: "D2", text: "Sin SMS", approved: false },
    ]);
    expect(state.warnings.join("\n")).toMatch(/S1.*después de aceptar/);
  });

  it("puts a rejected slice back to integrado once its rework reaches qa, keeping the notes", () => {
    const s2 = commitOn("qa", "[S2] historial", "qa");
    const rejection = (commit: string) => ({
      id: "S2",
      verdict: "rejected",
      at: "2026-11-07",
      env: "qa",
      commit,
      by: "user",
      notes: ["a"],
    });
    writeLog([rejection(s2)]);
    commitOn("qa", "fix: otro slice\n\nSlice: S1", "qa");
    expect(stateOf("S2")).toMatchObject({ state: "en curso", notes: ["a"] });

    commitOn("qa", "fix: retrabajo\n\nSlice: S2", "qa");
    expect(stateOf("S2")).toMatchObject({ state: "integrado", notes: ["a"] });

    // A verdict commit unknown to this repo, or off a rewritten qa, keeps the rejection in force.
    writeLog([rejection("0".repeat(40))]);
    expect(stateOf("S2")?.state).toBe("en curso");
    writeLog([rejection(commitOn("old-qa", "qa reescrita"))]);
    const state = readPlanState(repo);
    expect(state.slices.find((s) => s.id === "S2")?.state).toBe("en curso");
    expect(state.warnings.join("\n")).toMatch(/S2: el commit del rechazo no está/);
  });

  it("warns when a slice takes more than 3 days to integrate", () => {
    git(repo, "checkout", "-q", "-B", "slice/S3-cupon", "origin/dev");
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@navori.test",
        "-c",
        "user.name=navori",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "[S3] cupón",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
        },
      },
    );
    expect(readPlanState(repo).warnings.join("\n")).toMatch(/S3: \d+ días sin integrarse/);
  });

  it("fails closed on a shallow clone, an unknown Commit and a failed required fetch", () => {
    commitOn("qa", "[S1] registro", "qa");
    const shallow = mkTemp("mp-shallow-");
    git(
      shallow,
      "clone",
      "-q",
      "--depth",
      "1",
      "--no-single-branch",
      `file://${git(repo, "remote", "get-url", "origin").trim()}`,
      ".",
    );
    mkdirSync(join(shallow, "specs", "_plan"), { recursive: true });
    writeFileSync(join(shallow, "specs", "_plan", "PLAN.md"), PLAN());
    expect(() => readPlanState(shallow)).toThrow(/superficial/);

    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN().replace(
        "| S3 | Socio → canjea un cupón | | |",
        "| S3 | Socio → canjea un cupón | | deadbeef |",
      ),
    );
    expect(() => readPlanState(repo)).toThrow(/S3.*deadbeef/);

    writeFileSync(join(repo, "specs", "_plan", "PLAN.md"), PLAN());
    git(repo, "remote", "set-url", "origin", join(repo, "no-such-remote"));
    expect(readPlanState(repo, { fetch: true }).warnings.join("\n")).toMatch(/sin conexión/);
    expect(() => readPlanState(repo, { fetch: "required" })).toThrow(/fetch/);
  });

  it("fails closed when the acceptance branch cannot be resolved", () => {
    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN().replace("aceptación: qa", "aceptación: staging"),
    );
    expect(() => readPlanState(repo)).toThrow(/origin\/staging/);
  });
});

describe("checkIncoming", () => {
  it("blocks a new slice while another waits for acceptance, by mark and not by branch name", () => {
    commitOn("slice/S1-registro", "[S1] registro");
    mergeInto("qa", "slice/S1-registro", "[S1] registro (#1)");
    commitOn("slice/S2-historial", "feat: historial\n\nSlice: S2", "dev");
    commitOn("feat/s2", "feat: historial\n\nSlice: S2", "dev");
    commitOn("fix/typo", "fix: typo", "dev");
    expect(checkIncoming(repo, "origin/slice/S2-historial", "dev")).toMatchObject({
      ok: false,
      newSlices: ["S2"],
    });
    expect(checkIncoming(repo, "origin/feat/s2", "dev").ok).toBe(false);
    expect(checkIncoming(repo, "origin/fix/typo", "dev")).toMatchObject({ ok: true, incoming: [] });
  });

  it("lets a promotion or a fix of an already counted slice through", () => {
    commitOn("slice/S2-historial", "[S2] historial", "dev");
    mergeInto("dev", "slice/S2-historial", "[S2] historial (#2)");
    expect(checkIncoming(repo, "origin/dev", "qa")).toMatchObject({ ok: true, newSlices: [] });
    commitOn("slice/S2-fix", "fix: historial\n\nSlice: S2", "dev");
    expect(checkIncoming(repo, "origin/slice/S2-fix", "dev").ok).toBe(true);
  });

  it("blocks a PR that brings two new slices at once", () => {
    commitOn("multi", "[S1] registro", "dev");
    git(repo, "commit", "-q", "--allow-empty", "-m", "[S2] historial");
    git(repo, "push", "-q", "-f", "origin", "multi");
    expect(checkIncoming(repo, "origin/multi", "dev")).toMatchObject({
      ok: false,
      newSlices: ["S1", "S2"],
    });
  });
});

describe("checkIncoming reads the plan of the base", () => {
  const withS1Counted = (): void => {
    commitOn("slice/S1-registro", "[S1] registro");
    mergeInto("qa", "slice/S1-registro", "[S1] registro (#1)");
  };

  it("ignores a PR that raises WIP in its own PLAN.md", () => {
    withS1Counted();
    commitOn("slice/S2-historial", "[S2] historial", "dev");
    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN().replace("- Rama destino: dev\n", "- Rama destino: dev\n- WIP: 5\n"),
    );
    git(repo, "commit", "-q", "-am", "plan: WIP 5");
    expect(checkIncoming(repo, "HEAD", "dev")).toMatchObject({
      ok: false,
      newSlices: ["S2"],
      limit: 1,
    });
  });

  it("finds the base plan through the base's config, not the PR's", () => {
    withS1Counted();
    commitOn("slice/S2-historial", "[S2] historial", "dev");
    writeFileSync(
      join(repo, "navori.config.json"),
      JSON.stringify({ sdd: { specsDir: "elsewhere" } }),
    );
    git(repo, "add", "navori.config.json");
    git(repo, "commit", "-q", "-m", "chore: mueve specsDir");
    expect(checkIncoming(repo, "HEAD", "dev")).toMatchObject({ ok: false, newSlices: ["S2"] });
  });

  it("passes with a notice when origin/<base> has no PLAN.md, even without one on disk", () => {
    commitOn("bare", "chore: sin plan", "dev");
    git(repo, "rm", "-q", "-r", "specs");
    git(repo, "commit", "-q", "-m", "chore: quita el plan");
    git(repo, "push", "-q", "-f", "origin", "bare");
    expect(checkIncoming(repo, "HEAD", "bare")).toMatchObject({ ok: true, noPlan: true });
    expect(checkIncoming(repo, "HEAD", "bare", { fetch: "required" }).ok).toBe(true);
  });

  it("counts a slice by branch or title and lets unmarked work through (scenario 8)", () => {
    withS1Counted();
    commitOn("slice/S4-x", "feat: sin marca", "dev");
    expect(checkIncoming(repo, "HEAD", "dev", { branch: "slice/S4-x" })).toMatchObject({
      ok: false,
      incoming: ["S4"],
    });
    commitOn("feat/s4", "feat: x\n\nSlice: S4", "dev");
    expect(checkIncoming(repo, "HEAD", "dev").ok).toBe(false);
    commitOn("fix/typo", "fix: typo", "dev");
    expect(
      checkIncoming(repo, "HEAD", "dev", { branch: "fix/typo", title: "fix: typo" }),
    ).toMatchObject({ ok: true, incoming: [] });
    expect(checkIncoming(repo, "HEAD", "dev", { title: "feat: x [S2]" })).toMatchObject({
      ok: false,
      newSlices: ["S2"],
    });
  });

  it("requires [S<n>] in the title of a slice branch", () => {
    withS1Counted();
    commitOn("slice/S4-x", "feat: sin marca", "dev");
    const branch = "slice/S4-x";
    expect(checkIncoming(repo, "HEAD", "dev", { branch, title: "feat: x" })).toMatchObject({
      ok: false,
      titleMissing: "S4",
    });
    expect(checkIncoming(repo, "HEAD", "dev", { branch, title: "[S4] x" })).toMatchObject({
      ok: false,
      newSlices: ["S4"],
    });
    expect(checkIncoming(repo, "HEAD", "dev", { branch }).titleMissing).toBeUndefined();
  });
});
