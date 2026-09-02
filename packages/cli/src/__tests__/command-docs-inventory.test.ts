import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #548 — the website documented 8 of the 20 subcommands `index.ts` registers,
 * and `navori global` was one of the twelve missing. On an OPT-IN feature that
 * is fatal: it has to be asked for by name, and nothing announced it.
 *
 * Adding the entry does not close the class — the next command drifts the same
 * way. `index.ts` is the registry, so every name in it either has a docs page
 * or a declared exemption. Same move as `subcommand-inventory.test.ts` makes
 * for CLAUDE.md's prose (#507).
 *
 * Parsed rather than imported on purpose: importing `index.ts` calls `runMain`,
 * which would execute the CLI inside the suite.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const INDEX_TS = resolve(REPO_ROOT, "packages", "cli", "src", "index.ts");
const COMMANDS_TS = resolve(REPO_ROOT, "apps", "website", "src", "content", "commands.ts");

/**
 * Subcommands the website does not document yet. An entry is a DECISION with an
 * expiry, not a hiding place: the audit below fails when one goes stale, so the
 * list can only ever shrink.
 *
 * EMPTY since #556, and that is the state to defend. #548 shipped `global`
 * alone on purpose — the remaining eleven were ~1,300 lines of public copy in
 * two languages, and holding an opt-in feature's docs hostage to a copywriting
 * batch would have been the worse trade. They landed together in #556, so every
 * registered subcommand now has a page. A new command that arrives without one
 * fails this suite: add the `CommandDoc` (es AND en), or record the exemption
 * here with the reason it earns and the issue that will retire it.
 */
const UNDOCUMENTED_ON_PURPOSE = new Map<string, string>([]);

/** Why an exemption no longer earns its place. */
type StaleReason = "already documented" | "no longer registered";

interface StaleExemption {
  command: string;
  why: StaleReason;
}

interface CommandDocsAudit {
  /** Registered subcommands with neither a docs page nor a declared exemption. */
  undocumented: string[];
  /** Exemptions that outlived their reason. */
  stale: StaleExemption[];
}

/**
 * Compare the three sets: what the CLI registers, what the website documents,
 * and what is exempt. Pure on purpose — the real repo can only ever exercise
 * the green path, so the failure modes are driven with synthetic input below.
 */
function auditCommandDocs(
  registered: readonly string[],
  documented: readonly string[],
  exempt: ReadonlyMap<string, string>,
): CommandDocsAudit {
  const docs = new Set(documented);
  const undocumented = registered.filter((name) => !docs.has(name) && !exempt.has(name)).sort();
  const stale: StaleExemption[] = [];
  for (const command of [...exempt.keys()].sort()) {
    if (docs.has(command)) stale.push({ command, why: "already documented" });
    else if (!registered.includes(command)) stale.push({ command, why: "no longer registered" });
  }
  return { undocumented, stale };
}

/** The failure text for undocumented commands — it has to NAME them. */
function undocumentedMessage(names: readonly string[]): string {
  return (
    `${names.length} subcommand(s) registered in index.ts with no docs page: ${names.join(", ")}. ` +
    "The website is where an opt-in feature gets announced, so an undocumented command is a " +
    "command nobody can ask for. Add a CommandDoc to BOTH `es` and `en` plus its entry in " +
    "`commandOrder` (apps/website/src/content/commands.ts), or record it in " +
    "UNDOCUMENTED_ON_PURPOSE with the reason it earns."
  );
}

/** The failure text for exemptions that outlived their reason. */
function staleMessage(entries: readonly StaleExemption[]): string {
  return (
    `${entries.length} stale UNDOCUMENTED_ON_PURPOSE entry(ies): ` +
    `${entries.map((e) => `${e.command} (${e.why})`).join(", ")}. ` +
    "Good news, and the list has to record it: delete those entries so it keeps shrinking."
  );
}

/** The names registered in the CLI's `subCommands: { ... }` block. */
function registeredSubCommands(): string[] {
  const source = readFileSync(INDEX_TS, "utf-8");
  const [, block] = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/) ?? [];
  // A check that cannot run must be loud, never a silent pass.
  if (block === undefined) throw new Error(`could not parse subCommands from ${INDEX_TS}`);
  return [...block.matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map(([, name]) => name ?? "");
}

/** The commands the website publishes a page for, in `commandOrder`. */
function documentedCommands(): string[] {
  const source = readFileSync(COMMANDS_TS, "utf-8");
  const [, block] = source.match(/export const commandOrder = \[([\s\S]*?)\]\s*as const;/) ?? [];
  if (block === undefined) {
    throw new Error(
      `could not parse commandOrder from ${COMMANDS_TS} ` +
        '(anchor: "export const commandOrder = [ … ] as const;"). ' +
        "If the shape changed, update this parser — do not delete the guard.",
    );
  }
  return [...block.matchAll(/"([a-z][\w-]*)"/g)].map(([, name]) => name ?? "");
}

describe("the website documents every registered subcommand (#548)", () => {
  const registered = registeredSubCommands();
  const documented = documentedCommands();
  const audit = auditCommandDocs(registered, documented, UNDOCUMENTED_ON_PURPOSE);

  it("parses a real registry on both sides (anti-false-green)", () => {
    // Either regex going quiet would compare two empty lists and read as green.
    expect(registered).toEqual(expect.arrayContaining(["init", "render", "doctor", "global"]));
    expect(documented).toEqual(expect.arrayContaining(["init", "render", "global"]));
  });

  it("has a docs page or a declared exemption for each one", () => {
    expect(audit.undocumented, undocumentedMessage(audit.undocumented)).toEqual([]);
  });

  it("carries no stale exemption (the list can only shrink)", () => {
    expect(audit.stale, staleMessage(audit.stale)).toEqual([]);
  });
});

describe("auditCommandDocs (synthetic — the failure modes the repo cannot show)", () => {
  const reason = "pending";

  it("flags a registered command that is neither documented nor exempt", () => {
    const audit = auditCommandDocs(
      ["init", "global", "ticket"],
      ["init"],
      new Map([["ticket", reason]]),
    );
    expect(audit.undocumented).toEqual(["global"]);
    expect(audit.stale).toEqual([]);
    // The message is the whole point: a diff of counts would not say which one.
    expect(undocumentedMessage(audit.undocumented)).toContain("global");
  });

  it("flags an exemption whose command is already documented", () => {
    const audit = auditCommandDocs(
      ["init", "audit"],
      ["init", "audit"],
      new Map([["audit", reason]]),
    );
    expect(audit.stale).toEqual([{ command: "audit", why: "already documented" }]);
    expect(audit.undocumented).toEqual([]);
    expect(staleMessage(audit.stale)).toContain("audit (already documented)");
  });

  it("flags an exemption whose command is no longer registered", () => {
    const audit = auditCommandDocs(["init"], ["init"], new Map([["retired", reason]]));
    expect(audit.stale).toEqual([{ command: "retired", why: "no longer registered" }]);
    expect(staleMessage(audit.stale)).toContain("retired (no longer registered)");
  });

  it("reports nothing when every command is documented or exempt", () => {
    const audit = auditCommandDocs(["init", "ticket"], ["init"], new Map([["ticket", reason]]));
    expect(audit).toEqual({ undocumented: [], stale: [] });
  });
});
