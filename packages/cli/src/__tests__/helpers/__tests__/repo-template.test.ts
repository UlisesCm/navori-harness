import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  committedRepo,
  createRepoTemplate,
  emptyRepo,
  type RepoTemplate,
} from "../repo-template.ts";

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

describe("emptyRepo y committedRepo", () => {
  const out = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  // Covers: R19
  it("emptyRepo da un repo sin commits con la rama pedida, por copia", () => {
    const tpl = emptyRepo({ branch: "trunk" });
    try {
      const a = tpl.copy();
      expect(out(a, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
      expect(() => out(a, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
      expect(readFileSync(join(a, ".git", "config"), "utf8")).not.toContain(tpl.dir);
    } finally {
      tpl.dispose();
    }
  });

  // Covers: R19
  it("committedRepo versiona los archivos en un solo commit limpio", () => {
    const tpl = committedRepo({ "a.txt": "A", "dir/b.txt": "B" });
    try {
      const a = tpl.copy();
      expect(out(a, "ls-files").split("\n")).toEqual(["a.txt", "dir/b.txt"]);
      expect(out(a, "status", "--porcelain")).toBe("");
      expect(out(a, "rev-list", "--count", "HEAD")).toBe("1");
      writeFileSync(join(a, "a.txt"), "changed");
      expect(readFileSync(join(tpl.copy(), "a.txt"), "utf8")).toBe("A");
    } finally {
      tpl.dispose();
    }
  });

  // Covers: R19
  it("copyInto vuelca la plantilla en un directorio existente sin tocar la plantilla", () => {
    const tpl = committedRepo({ "a.txt": "A" });
    try {
      const target = emptyRepo().copy();
      tpl.copyInto(target);
      expect(out(target, "ls-files")).toBe("a.txt");
      writeFileSync(join(target, "a.txt"), "changed");
      expect(readFileSync(join(tpl.dir, "a.txt"), "utf8")).toBe("A");
    } finally {
      tpl.dispose();
    }
  });
});
