import { afterEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRepo, type RepoTemplate } from "../../__tests__/helpers/repo-template.ts";

/** Repos built once per file and copied per case (spec 0055 D7). */
let repoTpl: RepoTemplate;
beforeAll(() => {
  repoTpl = emptyRepo({ branch: "main" });
});
afterAll(() => {
  repoTpl.dispose();
});

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.ts");
const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

describe("parallel handoff CLI boundary", () => {
  it.each(["prepare-parallel", "begin-parallel", "complete-parallel", "finalize-parallel"])(
    "documents %s without shadowing built-in help",
    (command) => {
      // Consola suppresses help under TEST/NODE_ENV=test; isolate the CLI from runner flags.
      const childEnv = { ...process.env };
      delete childEnv.TEST;
      delete childEnv.VITEST;
      childEnv.NODE_ENV = "production";
      const result = spawnSync("bun", [cli, "handoff", command, "--help"], {
        encoding: "utf8",
        env: childEnv,
      });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain(command);
    },
  );

  it("fails closed on malformed request JSON through the real command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-parallel-cli-"));
    temps.push(cwd);
    repoTpl.copyInto(cwd);
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ name: "cli-test", engines: ["codex"], preset: "custom" }),
    );
    mkdirSync(join(cwd, ".navori"));
    writeFileSync(join(cwd, ".navori/request.json"), "invalid JSON");
    const result = spawnSync(
      "bun",
      [
        cli,
        "handoff",
        "prepare-parallel",
        "demo-e1",
        "--request",
        ".navori/request.json",
        "--target",
        "main",
        "--json",
      ],
      { cwd, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error" });
  });

  it("requires an explicit run binding before starting or completing a worker", () => {
    for (const command of ["begin-parallel", "complete-parallel"]) {
      const result = spawnSync(
        "bun",
        [cli, "handoff", command, "demo-e1", "--status", "DONE", "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("run");
    }
  });
});
