import { spawnSync } from "node:child_process";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest, type TestProject, type TestSpecification } from "vitest/node";
import config from "../../vitest.config.ts";

const packageRoot = resolve(import.meta.dirname, "../..");
const parityPath = "src/__tests__/hooks-zsh-parity.test.ts";

describe("Vitest scheduling", () => {
  // Covers: R16, R23, R25
  it("discovers the original inventory exactly once without importing the corpus", async () => {
    const ctx = await createVitest({
      root: packageRoot,
      config: join(packageRoot, "vitest.config.ts"),
      watch: false,
    });
    try {
      const specs = await ctx.globTestSpecifications();
      const original = globSync("src/**/*.test.ts", { cwd: packageRoot })
        .map((file: string): string => resolve(packageRoot, file))
        .sort();
      expect(specs.map((spec: TestSpecification): string => spec.moduleId).sort()).toEqual(
        original,
      );
      const parity = specs.filter(
        (spec: TestSpecification): boolean => spec.project.name === "parity",
      );
      expect(parity.map((spec: TestSpecification): string => spec.moduleId)).toEqual([
        resolve(packageRoot, parityPath),
      ]);
      expect(config.test).not.toHaveProperty("include");
      expect(ctx.config.globalSetup).toEqual([join(packageRoot, "vitest.globalSetup.ts")]);
      expect(ctx.config.maxWorkers).toBeGreaterThan(0);
      expect(ctx.projects.map((project: TestProject): string => project.name)).toEqual([
        "parity",
        "suite",
      ]);
      for (const project of ctx.projects) {
        expect(project.config.globalSetup).toEqual([]);
        expect(project.config.setupFiles).toEqual([join(packageRoot, "vitest.setup.ts")]);
        expect(project.config.maxWorkers).toBe(ctx.config.maxWorkers);
        expect(project.config.pool).toBe("forks");
        expect(project.config.clearMocks).toBe(false);
        expect(project.config.sequence.groupOrder).toBe(project.name === "parity" ? 1 : 2);
        expect(project.config.include).toEqual([
          project.name === "parity" ? parityPath : "src/**/*.test.ts",
        ]);
      }
    } finally {
      await ctx.close();
    }
  });

  // Covers: R16, R25, R26
  it.each([1, 2])(
    "finishes parity afterAll before any suite setup with %i workers and one root setup",
    (workers: number): void => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-scheduling-test-")));
      try {
        mkdirSync(join(root, "src/__tests__"), { recursive: true });
        mkdirSync(join(root, "home"));
        symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir");
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        writeFileSync(
          join(root, "global.ts"),
          `import { appendFileSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
export default function(project: TestProject): () => void {
  appendFileSync(process.env.TRACE!, 'global:start\\n');
  project.provide('token', 'root-only');
  return (): void => appendFileSync(process.env.TRACE!, 'global:end\\n');
}`,
        );
        writeFileSync(
          join(root, "setup.ts"),
          `import { appendFileSync } from 'node:fs';
import { expect, inject } from 'vitest';
expect(inject('token')).toBe('root-only');
appendFileSync(process.env.TRACE, 'setup:' + expect.getState().testPath.split('/').pop() + '\\n');`,
        );
        const files = ["hooks-zsh-parity", "normal1", "normal2"];
        for (const name of files) {
          writeFileSync(
            join(root, `src/__tests__/${name}.test.ts`),
            `import { appendFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
appendFileSync(process.env.TRACE, 'file:${name}\\n');
afterAll(async () => {
  await setImmediate();
  appendFileSync(process.env.TRACE, 'end:${name}\\n');
});
it('${name}', () => expect(true).toBe(true));`,
          );
        }
        // Reuse the real project declarations, but never the real build/lock setup.
        writeFileSync(
          join(root, "vitest.config.mjs"),
          `import production from ${JSON.stringify(join(packageRoot, "vitest.config.ts"))};
export default { root: ${JSON.stringify(root)}, test: {
  projects: production.test.projects, pool: 'forks', maxWorkers: ${workers},
  globalSetup: ['./global.ts'], setupFiles: ['./setup.ts'],
  reporters: production.test.reporters,
} };`,
        );
        const result = spawnSync(
          process.execPath,
          [join(packageRoot, "node_modules/vitest/vitest.mjs"), "run"],
          {
            cwd: root,
            env: {
              ...process.env,
              HOME: join(root, "home"),
              TRACE: join(root, "trace"),
              VITEST_MAX_WORKERS: undefined,
              NO_COLOR: "1",
            },
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(/Tests: 3 passed, 0 skipped \(3 files\)/);
        expect(result.stdout.match(/^Tests:/gm)).toHaveLength(1);
        const events = readFileSync(join(root, "trace"), "utf8").trim().split("\n");
        expect(events.filter((event: string): boolean => event === "global:start")).toHaveLength(1);
        expect(events.filter((event: string): boolean => event === "global:end")).toHaveLength(1);
        for (const file of files) {
          for (const event of [`setup:${file}.test.ts`, `file:${file}`, `end:${file}`]) {
            expect(events.filter((value: string): boolean => value === event)).toHaveLength(1);
          }
        }
        for (const normal of files.slice(1)) {
          expect(events.indexOf(`setup:${normal}.test.ts`)).toBeGreaterThan(
            events.indexOf("end:hooks-zsh-parity"),
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
