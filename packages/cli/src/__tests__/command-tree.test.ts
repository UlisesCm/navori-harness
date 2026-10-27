import { describe, expect, it } from "vitest";
import type { CommandDef, Resolvable, SubCommandsDef } from "citty";
import { main } from "../cli.ts";

/**
 * Spec 0061 R4 — command-tree invariants for citty 0.2. A command that both `run`s and
 * dispatches subcommands runs its `run` AFTER the subcommand too (the #466 class: `migrations
 * list` printed its list twice), and citty 0.2 throws `E_DEFAULT_CONFLICT` when `default` and
 * `run` coexist. The default-subcommand mechanism is `default: "<sub>"`, never a parent `run`.
 */

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

interface Node {
  path: string;
  command: CommandDef;
  subs: SubCommandsDef;
}

/** Walks `main`, resolving every lazy subcommand, and returns each command with its path. */
async function walk(command: CommandDef, path: string): Promise<Node[]> {
  const subs: SubCommandsDef = command.subCommands ? await resolve(command.subCommands) : {};
  const nodes: Node[] = [{ path, command, subs }];
  for (const [name, sub] of Object.entries(subs)) {
    nodes.push(...(await walk(await resolve(sub), `${path} ${name}`)));
  }
  return nodes;
}

describe("command tree", () => {
  // Covers: R4
  it("no command both runs and dispatches subcommands", async () => {
    const nodes = await walk(main, "navori");
    expect(nodes.length).toBeGreaterThan(30);
    const offenders = nodes
      .filter((n) => Object.keys(n.subs).length > 0 && typeof n.command.run === "function")
      .map((n) => n.path);
    expect(offenders).toEqual([]);
  });

  // Covers: R4
  it("every default names one of the command's own subcommands", async () => {
    const nodes = await walk(main, "navori");
    const defaults = nodes.filter((n) => n.command.default !== undefined);
    expect(defaults.map((n) => n.path)).toContain("navori migrations");
    for (const n of defaults) {
      expect(Object.keys(n.subs), n.path).toContain(n.command.default);
    }
  });
});
