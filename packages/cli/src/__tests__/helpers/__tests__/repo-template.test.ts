import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRepoTemplate, type RepoTemplate } from "../repo-template.ts";

let template: RepoTemplate;

beforeAll(() => {
  template = createRepoTemplate("navori-repo-template-test-", (dir) => {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "seed.txt"), "seed");
  });
});
afterAll(() => template.dispose());

describe("createRepoTemplate", () => {
  it("la copia es independiente de la plantilla y de las otras copias", () => {
    const a = template.copy();
    const b = template.copy();
    expect(new Set([template.dir, a, b]).size).toBe(3);
    writeFileSync(join(a, "seed.txt"), "changed");
    writeFileSync(join(a, "only-a.txt"), "x");
    execFileSync("git", ["switch", "-q", "-c", "feat/a"], { cwd: a });
    expect(readFileSync(join(template.dir, "seed.txt"), "utf8")).toBe("seed");
    expect(readFileSync(join(b, "seed.txt"), "utf8")).toBe("seed");
    expect(existsSync(join(b, "only-a.txt"))).toBe(false);
    const head = (cwd: string): string =>
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
    expect(head(template.dir)).toBe("main");
    expect(head(b)).toBe("main");
    expect(head(a)).toBe("feat/a");
  });

  it("la plantilla no graba rutas absolutas en .git/config", () => {
    const config = readFileSync(join(template.dir, ".git", "config"), "utf8");
    expect(config).not.toContain(template.dir);
    expect(config).not.toMatch(/=\s*\//);
    expect(readFileSync(join(template.copy(), ".git", "config"), "utf8")).toBe(config);
  });

  it("dispose borra la plantilla y las copias", () => {
    const own = createRepoTemplate("navori-repo-template-dispose-", () => undefined);
    const copy = own.copy();
    own.dispose();
    expect(existsSync(own.dir)).toBe(false);
    expect(existsSync(copy)).toBe(false);
  });

  it("borra la plantilla si el build falla", () => {
    let seen = "";
    expect(() =>
      createRepoTemplate("navori-repo-template-fail-", (dir) => {
        seen = dir;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });
});
