import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The landing said 8 commands, 6 presets and 6 plugins while the CLI shipped
 * 21, 12 and 7 — and it said "Multi-engine roadmap" months after all five
 * engines had landed. It drifted for a quarter and nothing failed.
 *
 * `/docs/<command>` did NOT drift over the same period, because
 * `command-docs-inventory.test.ts` fails when a registered subcommand has no
 * page. The difference between the two halves of the site was a test. This is
 * that test for the other half.
 *
 * Two claims are audited:
 *
 * 1. COUNTS. Every number in `consts.ts` `INVENTORY` is compared against the
 *    thing it counts — `index.ts` for subcommands, the asset directories for
 *    presets/agents/skills/hooks, `packages/plugins/` for plugins,
 *    `src/engines/` for engines. Marketing copy that states a number reads it
 *    from there, so a stale number fails here instead of on the live site.
 *
 * 2. COVERAGE. The landing's lifecycle grouping must cover `commandOrder`
 *    exactly, and the toolbox's plugin list must match the shipped plugins.
 *    A new command or plugin that arrives without a home in the copy fails.
 *
 * Parsed, not imported: these are `.ts` modules inside an Astro app with its
 * own resolution rules, and `index.ts` calls `runMain` at module scope.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const P = {
  index: resolve(REPO_ROOT, "packages", "cli", "src", "index.ts"),
  engines: resolve(REPO_ROOT, "packages", "cli", "src", "engines"),
  plugins: resolve(REPO_ROOT, "packages", "plugins"),
  presets: resolve(REPO_ROOT, "packages", "core", "core-assets", "presets"),
  agents: resolve(REPO_ROOT, "packages", "core", "core-assets", "agents"),
  skills: resolve(REPO_ROOT, "packages", "core", "core-assets", "skills"),
  libSkills: resolve(REPO_ROOT, "packages", "core", "core-assets", "lib-skills"),
  hooks: resolve(REPO_ROOT, "packages", "core", "core-assets", "hooks"),
  consts: resolve(REPO_ROOT, "apps", "website", "src", "consts.ts"),
  groups: resolve(REPO_ROOT, "apps", "website", "src", "content", "command-groups.ts"),
  commands: resolve(REPO_ROOT, "apps", "website", "src", "content", "commands.ts"),
};

/** Directory entries that are real assets, not the JSON sidecars beside them. */
function listAssets(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (ext === "" ? e.isDirectory() : e.isFile() && e.name.endsWith(ext)))
    .map((e) => e.name.replace(ext, ""))
    .sort();
}

/**
 * First capture group of every match, with non-participating groups dropped.
 *
 * `noUncheckedIndexedAccess` types `m[1]` as `string | undefined` even when the
 * group is not optional, so narrowing happens here once instead of at six call
 * sites — and never with a non-null assertion, which would just hide the case
 * rather than handle it.
 */
function captures(source: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(re)) {
    const [, first] = match;
    if (first !== undefined) out.push(first);
  }
  return out;
}

/** Subcommand names registered in `index.ts`'s `subCommands` block. */
function registeredCommands(): string[] {
  const src = readFileSync(P.index, "utf8");
  const block = src.slice(src.indexOf("subCommands: {"), src.indexOf("});"));
  return captures(block, /^\s{4}(\w+):/gm).sort();
}

/** `INVENTORY` as declared by the website, parsed from its literal. */
function declaredInventory(): Record<string, number> {
  const src = readFileSync(P.consts, "utf8");
  const block = src.slice(
    src.indexOf("export const INVENTORY"),
    src.indexOf("} as const;", src.indexOf("export const INVENTORY")),
  );
  const out: Record<string, number> = {};
  for (const [, key, value] of block.matchAll(/^\s*(\w+):\s*(\d+),/gm)) {
    if (key !== undefined && value !== undefined) out[key] = Number(value);
  }
  return out;
}

/** A string-array literal named `name`, from any of the website modules. */
function stringList(file: string, name: string): string[] {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  return captures(src.slice(open, close), /"([^"]+)"/g);
}

/** Every command id the landing's lifecycle groups present, flattened. */
function groupedCommands(): string[] {
  const src = readFileSync(P.groups, "utf8");
  const ids: string[] = [];
  for (const list of captures(src, /commands:\s*\[([^\]]+)\]/g)) {
    ids.push(...captures(list, /"([^"]+)"/g));
  }
  return ids;
}

/** Ids in `commandOrder`, the registry the docs pages are built from. */
function documentedCommands(): string[] {
  const src = readFileSync(P.commands, "utf8");
  const start = src.indexOf("export const commandOrder");
  return captures(src.slice(start, src.indexOf("] as const;", start)), /"([^"]+)"/g);
}

describe("landing inventory", () => {
  const inventory = declaredInventory();

  /**
   * The real counts, each paired with what produces it. `hint` is what the
   * failure message tells a reader to go fix.
   */
  const counts: { key: string; actual: number; source: string }[] = [
    { key: "commands", actual: registeredCommands().length, source: "packages/cli/src/index.ts" },
    { key: "presets", actual: listAssets(P.presets, "").length, source: "core-assets/presets/" },
    { key: "plugins", actual: listAssets(P.plugins, "").length, source: "packages/plugins/" },
    {
      key: "engines",
      actual: listAssets(P.engines, "").filter((d) => d !== "shared" && d !== "__tests__").length,
      source: "packages/cli/src/engines/",
    },
    { key: "agents", actual: listAssets(P.agents, ".md").length, source: "core-assets/agents/" },
    {
      key: "skills",
      actual: listAssets(P.skills, ".md").length + listAssets(P.libSkills, ".md").length,
      source: "core-assets/skills/ + lib-skills/",
    },
    { key: "hooks", actual: listAssets(P.hooks, ".sh").length, source: "core-assets/hooks/" },
  ];

  it.each(counts)(
    "INVENTORY.$key matches what the repo actually ships",
    ({ key, actual, source }) => {
      expect(
        inventory[key],
        `apps/website/src/consts.ts says INVENTORY.${key} = ${inventory[key]}, but ${source} ` +
          `has ${actual}. The landing publishes this number — fix the constant, never this test.`,
      ).toBe(actual);
    },
  );

  it("groups every registered subcommand into a lifecycle section", () => {
    const grouped = groupedCommands();
    const documented = documentedCommands();

    const missing = documented.filter((c) => !grouped.includes(c)).sort();
    const invented = grouped.filter((c) => !documented.includes(c)).sort();
    const duplicated = grouped.filter((c, i) => grouped.indexOf(c) !== i).sort();

    expect(
      missing,
      `${missing.length} command(s) have a docs page but no place on the landing: ` +
        `${missing.join(", ")}. A command the landing never names is a command nobody ` +
        "discovers. Add it to a group in apps/website/src/content/command-groups.ts.",
    ).toEqual([]);
    expect(
      invented,
      `command-groups.ts lists ids with no docs page: ${invented.join(", ")}`,
    ).toEqual([]);
    expect(
      duplicated,
      `command-groups.ts lists the same id twice: ${duplicated.join(", ")}`,
    ).toEqual([]);
  });

  it("lists exactly the plugins that ship, in the toolbox", () => {
    const declared = [...stringList(P.consts, "PLUGIN_IDS")].sort();
    const shipped = listAssets(P.plugins, "");

    expect(
      declared,
      "apps/website/src/consts.ts PLUGIN_IDS must match packages/plugins/. The toolbox " +
        "section renders one card per id, so a plugin missing here ships unmentioned.",
    ).toEqual(shipped);
  });

  it("lists exactly the engines that have an adapter", () => {
    const declared = [...stringList(P.consts, "ENGINE_IDS")].sort();
    const shipped = listAssets(P.engines, "").filter((d) => d !== "shared" && d !== "__tests__");

    expect(declared, "consts.ts ENGINE_IDS must match packages/cli/src/engines/").toEqual(shipped);
  });

  it("keeps INVENTORY.commands aligned with the docs registry", () => {
    // The two registries are maintained separately (`index.ts` is the CLI's,
    // `commandOrder` is the website's). `command-docs-inventory.test.ts` proves
    // every registered command has a page; this proves the reverse direction,
    // so the count can't be right against one and wrong against the other.
    expect(documentedCommands().sort()).toEqual(registeredCommands());
  });
});
