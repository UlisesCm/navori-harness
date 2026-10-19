import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Spec 0055 R14 / D8 — lazy subcommands. `src/index.ts` must not import `commands/*`, and in the
 * built `dist/` the entry's static import graph must not reach any subcommand chunk, nor may one
 * subcommand chunk statically reach another.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");
const dist = join(here, "..", "..", "dist");

/** `import ... from "./x.js"` and `import "./x.js"` (minified or not); `import("./x.js")` is dynamic. */
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g;

/**
 * Subcommand chunks that already load another command's module because a helper lives in that
 * command file (`runRender`, `computeHealthVerdict`, ...). Ceiling: they load only when the
 * importing command runs and none is a hot hook path. Upgrade trigger: move the helper to `lib/`
 * when one of these commands needs a faster cold start; never add an entry for a hot command
 * (`tools`, `plan`, `gate`).
 */
const KNOWN_COUPLINGS = new Set([
  "init -> doctor",
  "init -> render",
  "add -> render",
  "remove -> render",
  "adopt -> render",
  "update -> refresh",
  "update -> render",
  "refresh -> render",
  "sync -> render",
  "doctor -> render",
  "status -> doctor",
  "status -> render",
  "bench -> render",
  "workspace -> render",
  "handoff -> receipt",
  "master -> render",
]);

/** Prefer actual command names, then resolve the bundler's numeric collision suffixes. */
function chunkName(file: string, commands: ReadonlySet<string>): string {
  const name = file.replace(/\.js$/, "");
  if (commands.has(name)) return name;
  let base = name;
  while (/\d$/.test(base)) {
    base = base.slice(0, -1);
    if (commands.has(base)) return base;
  }
  return name;
}

function matches(file: string, pattern: RegExp): string[] {
  return [...readFileSync(join(dist, file), "utf8").matchAll(pattern)].map((m) => m[1] as string);
}

/** Files reachable from `entry` through static imports (the entry included). */
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...matches(file, STATIC_IMPORT));
  }
  return seen;
}

describe("cli lazy load", () => {
  // Covers: R14
  it("index no importa chunks de subcomandos y ningún subcomando carga a otro", () => {
    expect(readFileSync(join(src, "index.ts"), "utf8")).not.toMatch(/commands\//);

    const cliSource = readFileSync(join(src, "cli.ts"), "utf8");
    const lazyFiles = [...cliSource.matchAll(/import\("\.\/commands\/([\w-]+\.ts)"\)/g)].map(
      (m) => m[1] as string,
    );
    expect(lazyFiles.length).toBeGreaterThan(0);
    const commandNames = new Set(
      lazyFiles.map((file: string): string => file.replace(/\.ts$/, "")),
    );
    for (const file of lazyFiles) expect(existsSync(join(src, "commands", file))).toBe(true);
    expect(cliSource).not.toMatch(/^import .* from "\.\/commands\//m);

    // Chunks sit at the root of dist/ next to index.js so `bundled-assets.ts` (HERE) still finds
    // dist/assets and ../package.json.
    expect(existsSync(join(dist, "index.js"))).toBe(true);
    const subdirs = readdirSync(dist).filter((name) => statSync(join(dist, name)).isDirectory());
    expect(subdirs).toEqual(["assets"]);

    const entryGraph = staticClosure("index.js");
    const targets = [...new Set([...entryGraph].flatMap((file) => matches(file, DYNAMIC_IMPORT)))];
    expect(targets.length, "one lazy chunk per subcommand").toBeGreaterThanOrEqual(
      lazyFiles.length,
    );

    const eager = targets.filter((target) => entryGraph.has(target));
    expect(eager, "subcommand chunks reachable from index.js without a dynamic import").toEqual([]);

    const coupled: string[] = [];
    for (const target of targets) {
      for (const reached of staticClosure(target)) {
        if (reached === target || !targets.includes(reached)) continue;
        const edge = `${chunkName(target, commandNames)} -> ${chunkName(reached, commandNames)}`;
        if (!KNOWN_COUPLINGS.has(edge)) coupled.push(edge);
      }
    }
    expect(
      coupled,
      "new couplings: a subcommand chunk statically loads another subcommand",
    ).toEqual([]);
  });
});
