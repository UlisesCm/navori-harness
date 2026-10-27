import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyRepo, type RepoTemplate } from "../../__tests__/helpers/repo-template.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { resolveStateRoot } from "../primitives/state-root.ts";
import { writeAcceptanceIndex } from "../plan/acceptance-index.ts";
import {
  readEvidenceLog,
  validateEvidence,
  type DeliveryEvidenceBinding,
} from "../plan/evidence.ts";
import { acrossShells, type HookShell } from "./helpers/shells.ts";

let template: RepoTemplate;
beforeAll(() => {
  template = emptyRepo({ branch: "main" });
});
afterAll(() => template.dispose());
const command = "echo acceptance";
const secret = "PRIVATE_TOOL_OUTPUT_7b2140";

function fixture(expected: string): {
  cwd: string;
  run: (
    payload: Record<string, unknown>,
    failure?: boolean,
    shell?: HookShell,
    env?: NodeJS.ProcessEnv,
  ) => void;
  log: () => string;
} {
  const cwd = template.copy();
  const root = resolveStateRoot({ cwd, feature: "demo" });
  mkdirSync(root.path, { recursive: true });
  writeFileSync(
    join(root.path, "workplan_demo.json"),
    JSON.stringify({
      feature: "demo",
      level: 1,
      classification: { score: 1, level: 1, signals: [] },
      objective: "test",
      files: [],
      outOfScope: [],
      progress: {},
      acceptance: [{ id: "A1", description: "test", command, expected }],
    }),
  );
  writeAcceptanceIndex(root);
  for (const name of ["routing-watch", "bash-outcome-watch"]) {
    const source = resolve(getCoreRoot(), `core-assets/hooks/${name}.sh`);
    writeFileSync(join(cwd, `${name}.sh`), expandHookIncludes(readFileSync(source, "utf8")));
  }
  const log = (): string => readFileSync(join(root.path, "workplan_demo.evidence.jsonl"), "utf8");
  return {
    cwd,
    log,
    run: (
      payload: Record<string, unknown>,
      failure = false,
      shell: HookShell = "bash",
      env: NodeJS.ProcessEnv = {},
    ): void => {
      const result = spawnSync(
        shell,
        [
          join(cwd, failure ? "bash-outcome-watch.sh" : "routing-watch.sh"),
          ...(failure ? [] : ["claude-post-tool-use"]),
        ],
        {
          input: JSON.stringify({
            tool_name: "Bash",
            session_id: "fixture-session",
            cwd,
            tool_input: { command },
            ...payload,
          }),
          encoding: "utf8",
          // Match Claude's registered deadlines: routing-watch fingerprints the tree (30 s).
          timeout: failure ? 10_000 : 30_000,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: cwd,
            CLAUDE_CODE_SESSION_ID: "fixture-session",
            ...env,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  };
}

describe("Claude expected capture", () => {
  // Covers: R18, R19 (0045)
  it("retains the exact delivery binding and excludes only its lifecycle files", (): void => {
    const f = fixture("contains: ready");
    const dir = join(f.cwd, ".navori/state/handoffs");
    const binding: DeliveryEvidenceBinding = {
      policy: "deliveries-content-v1",
      authorityGeneration: 1,
      stagePath: "stage",
      sourceIdentity: "a".repeat(64),
      baselineIdentity: "b".repeat(64),
      queueIdentity: "c".repeat(64),
      qualifiedId: "P1.A1",
      criterionIdentity: "d".repeat(64),
    };
    mkdirSync(join(f.cwd, "stage"));
    writeFileSync(join(f.cwd, "stage/state.json"), "initial lifecycle");
    writeFileSync(join(f.cwd, "stage/STATUS.md"), "initial view");
    writeFileSync(join(f.cwd, "stage/parts.json"), "fixed contract");
    writeFileSync(
      join(dir, "acceptance-index"),
      `${command}\tdemo\tA1\t${dir}\t${JSON.stringify(binding)}\tstage\n`,
    );
    const row = JSON.parse(readFileSync(join(dir, "acceptance-expected.jsonl"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(dir, "acceptance-expected.jsonl"),
      JSON.stringify({ ...row, binding, stage: "stage" }) + "\n",
    );
    f.run({ tool_response: { stdout: "ready", stderr: "" } });
    expect(JSON.parse(f.log())).toMatchObject({ deliveryBinding: binding, outcome: "pass" });
    const check = (): boolean =>
      validateEvidence({
        root: resolveStateRoot({ cwd: f.cwd, feature: "demo" }),
        feature: "demo",
        id: "A1",
        command,
        expected: "contains: ready",
        deliveryBinding: binding,
      }).ok;
    expect(check()).toBe(true);
    writeFileSync(join(f.cwd, "stage/state.json"), "new lifecycle");
    writeFileSync(join(f.cwd, "stage/STATUS.md"), "new view");
    expect(check()).toBe(true);
    writeFileSync(join(f.cwd, "stage/parts.json"), "changed contract");
    expect(check()).toBe(false);
  });

  // Covers: R18 (0045)
  it.each(["matches: /[/", "matches: /x/ii"])(
    "records invalid comparison %j as unevaluated",
    (expected: string): void => {
      const f = fixture(expected);
      f.run({ tool_response: { stdout: "x", stderr: "" } });
      expect(JSON.parse(f.log())).toMatchObject({ expected, outcome: "unevaluated" });
    },
  );
  // Covers: R18, R19 (0045)
  it.each(["feature", "id", "command", "dir", "stage", "binding"])(
    "does not borrow a comparison with a different %s",
    (field: string): void => {
      const f = fixture("contains: ready");
      const path = join(f.cwd, ".navori/state/handoffs/acceptance-expected.jsonl");
      const row: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      row[field] = "different";
      writeFileSync(path, JSON.stringify(row) + "\n");
      f.run({ tool_response: { stdout: "ready", stderr: "" } });
      expect(JSON.parse(f.log())).not.toHaveProperty("outcome");
      expect(
        validateEvidence({
          root: resolveStateRoot({ cwd: f.cwd, feature: "demo" }),
          feature: "demo",
          id: "A1",
          command,
          expected: "contains: ready",
        }).ok,
      ).toBe(false);
    },
  );

  // Covers: R18 (0045)
  it.each([
    "exit code 3",
    "noise\nExit code 3",
    "Exit code 300",
    "Exit code 3\nCommand timed out",
    "could not start",
  ])("does not infer an exit from unrecognized failure text %j", (error: string): void => {
    const f = fixture("exit 3");
    f.run({ error }, true);
    expect(
      readEvidenceLog(join(f.cwd, ".navori/state/handoffs/workplan_demo.evidence.jsonl")),
    ).toEqual([]);
  });

  // Covers: R18 (0045)
  it("fails closed for output expectations when Node is unavailable", (): void => {
    const f = fixture("contains: ready");
    const bin = join(f.cwd, ".navori/state/bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    f.run({ tool_response: { stdout: "ready", stderr: "" } }, false, "bash", {
      PATH: bin + ":" + process.env.PATH,
    });
    expect(JSON.parse(f.log())).not.toHaveProperty("outcome");
    expect(
      validateEvidence({
        root: resolveStateRoot({ cwd: f.cwd, feature: "demo" }),
        feature: "demo",
        id: "A1",
        command,
        expected: "contains: ready",
      }).ok,
    ).toBe(false);
  });
  // Covers: R18, R19 (0045)
  it.each<{
    expected: string;
    response: Record<string, unknown>;
    failure?: boolean;
    exit: number;
    outcome: "pass" | "fail";
  }>([
    {
      expected: "contains: ready",
      response: { stdout: `ready ${secret}`, stderr: "" },
      exit: 0,
      outcome: "pass",
    },
    {
      expected: "contains: absent",
      response: { stdout: secret, stderr: "" },
      exit: 0,
      outcome: "fail",
    },
    {
      expected: "matches: /^ready$/im",
      response: { stdout: secret, stderr: "READY" },
      exit: 0,
      outcome: "pass",
    },
    {
      expected: "matches: /absent/",
      response: { stdout: secret, stderr: "" },
      exit: 0,
      outcome: "fail",
    },
    { expected: "exit 0", response: {}, exit: 0, outcome: "pass" },
    { expected: "exit 3", response: {}, exit: 0, outcome: "fail" },
    { expected: "exit 3", response: {}, failure: true, exit: 3, outcome: "pass" },
    { expected: "exit 2", response: {}, failure: true, exit: 3, outcome: "fail" },
    { expected: "contains: ready", response: {}, failure: true, exit: 3, outcome: "fail" },
  ])(
    "records only scalars for $expected ($outcome, exit $exit)",
    ({ expected, response, failure, exit, outcome }): void => {
      acrossShells((shell: HookShell): void => {
        const f = fixture(expected);
        f.run(
          failure ? { error: `Exit code 3\n${secret}` } : { tool_response: response },
          failure,
          shell,
        );
        const raw = f.log();
        expect(raw).not.toContain(secret);
        const rows = readEvidenceLog(
          join(f.cwd, ".navori/state/handoffs/workplan_demo.evidence.jsonl"),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ exit, expected, outcome });
        for (const field of ["stdout", "stderr", "output", "outputHash"])
          expect(JSON.parse(raw)).not.toHaveProperty(field);
        expect(
          validateEvidence({
            root: resolveStateRoot({ cwd: f.cwd, feature: "demo" }),
            feature: "demo",
            id: "A1",
            command,
            expected,
          }).ok,
        ).toBe(outcome === "pass");
      });
    },
  );

  // Covers: R18, R19 (0045)
  it.each([
    { label: "missing output", payload: {} },
    { label: "wrong output type", payload: { tool_response: { stdout: 1, stderr: "" } } },
    {
      label: "interrupted",
      payload: { tool_response: { stdout: "ready", stderr: "", interrupted: true } },
    },
    { label: "image", payload: { tool_response: { stdout: "ready", stderr: "", isImage: true } } },
    {
      label: "truncated",
      payload: { tool_response: { stdout: "ready [99 characters truncated]", stderr: "" } },
    },
    {
      label: "oversized",
      payload: { tool_response: { stdout: "x".repeat(4 * 1024 * 1024), stderr: "ready" } },
    },
  ])("retains an unevaluated result for $label", ({ payload }): void => {
    const f = fixture("contains: ready");
    f.run(payload);
    expect(JSON.parse(f.log())).toMatchObject({
      expected: "contains: ready",
      outcome: "unevaluated",
    });
  });

  // Covers: R18 (0045)
  it("bounds pathological regex evaluation without writing output", (): void => {
    const f = fixture("matches: /^(a+)+$/");
    f.run({ tool_response: { stdout: "a".repeat(10000) + "!", stderr: "" } });
    expect(JSON.parse(f.log())).toMatchObject({ outcome: "unevaluated" });
  });

  // Covers: R19 (0045)
  it("does not revive a previous pass after a completed failing command", (): void => {
    const f = fixture("contains: ready");
    f.run({ tool_response: { stdout: "ready", stderr: "" } });
    f.run({ error: `Exit code 2\n${secret}` }, true);
    expect(f.log().trim().split("\n")).toHaveLength(2);
    expect(
      validateEvidence({
        root: resolveStateRoot({ cwd: f.cwd, feature: "demo" }),
        feature: "demo",
        id: "A1",
        command,
        expected: "contains: ready",
      }).ok,
    ).toBe(false);
  });
});
