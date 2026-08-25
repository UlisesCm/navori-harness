import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { migrationsRoot } from "../lib/migrate.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";
import { tc, resolveLang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/global-config.ts";
import { intFlagOrExit } from "../lib/args.ts";

/**
 * Language for machine-global commands (migrations/backup/registry) that aren't
 * scoped to a single repo: read it off the global harness config, else default.
 */
function globalLang() {
  return resolveLang(readGlobalConfig()?.language);
}

interface MigrationEntry {
  timestamp: string;
  repoName: string;
  path: string;
  files: string[];
  mtimeMs: number;
}

function listMigrations(): MigrationEntry[] {
  const root = migrationsRoot();
  if (!existsSync(root)) return [];
  const entries: MigrationEntry[] = [];
  for (const ts of readdirSync(root)) {
    const tsDir = join(root, ts);
    try {
      const stat = statSync(tsDir);
      if (!stat.isDirectory()) continue;
      for (const repoName of readdirSync(tsDir)) {
        const repoDir = join(tsDir, repoName);
        try {
          const repoStat = statSync(repoDir);
          if (!repoStat.isDirectory()) continue;
          const files = collectFiles(repoDir, repoDir);
          entries.push({
            timestamp: ts,
            repoName,
            path: repoDir,
            files,
            mtimeMs: repoStat.mtimeMs,
          });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function collectFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        out.push(...collectFiles(root, full));
      } else if (stat.isFile()) {
        out.push(relative(root, full));
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Body of `migrations list`, shared with the parent command's default run.
 * Takes plain options instead of citty's `ParsedArgs` because the parent
 * declares only `--json` (see `migrationsCommand`), so its args can never
 * satisfy this subcommand's arg shape. `limit` stays `unknown` because both
 * callers get it straight off the CLI (the parent through citty's catch-all
 * index signature, which types undeclared flags as string|boolean|string[]);
 * `intFlagOrExit` is the validator, and undefined means "use the default".
 */
function runMigrationsList(opts: { json: boolean; limit?: unknown }): void {
  const migrations = listMigrations();
  const limit = intFlagOrExit(opts.limit, "limit", 20);
  const truncated = migrations.slice(0, limit);

  if (opts.json) {
    console.log(
      JSON.stringify({ migrations: truncated, totalAvailable: migrations.length }, null, 2),
    );
    return;
  }

  const tr = tc(globalLang()).migrations;
  p.intro(brand("migrations list"));
  if (migrations.length === 0) {
    p.log.info(tr.listEmpty);
    p.outro(dim(tr.done));
    return;
  }

  const lines: string[] = [];
  lines.push(dim(tr.total(migrations.length, truncated.length)));
  for (const m of truncated) {
    const date = new Date(m.mtimeMs);
    lines.push(
      `  ${color.cyan(sym.bullet)} ${accent(m.timestamp)}  ${dim(`repo='${m.repoName}'`)}  ${dim(date.toISOString())}`,
    );
    for (const f of m.files) {
      lines.push(`      ${dim(sym.bullet)} ${dim(f)}`);
    }
  }
  if (migrations.length > truncated.length) {
    lines.push(dim(tr.more(migrations.length - truncated.length)));
  }
  p.log.message(lines.join("\n"));
  p.outro(dim(tr.done));
}

const listSubCommand = defineCommand({
  meta: {
    name: "list",
    description: "List init replace-mode migrations stored in ~/.navori/migrations/",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
    limit: { type: "string", description: "Show only the N most recent (default: 20)" },
  },
  run({ args }) {
    runMigrationsList({ json: args.json, limit: args.limit });
  },
});

const restoreSubCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore an init replace-mode migration back to the original repo",
  },
  args: {
    timestamp: { type: "positional", description: "Migration timestamp", required: true },
    repo: { type: "positional", description: "Repo name (from 'migrations list')", required: true },
    cwd: { type: "string", description: "Target directory (default: current)" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const ts = args.timestamp as string;
    const repoName = args.repo as string;
    const cwd = resolve(args.cwd ?? process.cwd());
    const migrationDir = join(migrationsRoot(), ts, repoName);

    const lang = globalLang();
    const tr = tc(lang).migrations;
    p.intro(brand(`migrations restore ${accent(`${ts}/${repoName}`)}`));

    if (!existsSync(migrationDir)) {
      p.cancel(tr.notFound(migrationDir));
      process.exit(1);
    }

    const files = collectFiles(migrationDir, migrationDir);
    if (files.length === 0) {
      p.cancel(tr.empty(migrationDir));
      process.exit(1);
    }

    p.log.message(tr.willRestore(files.length, migrationDir, cwd));
    for (const f of files.slice(0, 10)) p.log.message(`  · ${f}`);
    if (files.length > 10) p.log.message(tr.moreFiles(files.length - 10));

    if (!args.yes) {
      const ok = await p.confirm({
        message: tr.overwriteConfirm,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel(tc(lang).common.aborted);
        return;
      }
    }

    for (const rel of files) {
      const src = join(migrationDir, rel);
      const dest = join(cwd, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    p.outro(tr.restored(files.length));
  },
});

/**
 * Whether citty already dispatched a subcommand for this invocation.
 *
 * citty runs the parent's `run` even AFTER dispatching a subcommand: the
 * `if (typeof cmd.run === "function")` sits OUTSIDE the dispatch branch
 * (citty 0.1.6 `dist/index.mjs:315`, unchanged in 0.2.2). With a parent `run`
 * acting as the default (see `migrationsCommand`), that printed the list twice
 * on `migrations list` and dumped it on top of `migrations restore` (#466).
 *
 * Reads `rawArgs` on purpose — not `args._` — because this mirrors citty's own
 * resolution rule (the first token that doesn't start with `-` is the
 * subcommand name). The parent's parsed `args._` can lose that token to an
 * undeclared value flag (`migrations --foo list` parses `list` as `--foo`'s
 * value), which would miss the dispatch and print twice again.
 *
 * This is a deliberate exception to the `citty` skill's "never read `rawArgs`
 * by hand": that rule is about reading INPUTS, and nothing here is read as one
 * — the predicate replicates citty's dispatch decision, which is the only thing
 * that can answer "did a subcommand already run?".
 *
 * BUMPING CITTY INVALIDATES THIS. 0.2.x replaces the naive scan with
 * `findSubCommandIndex` (0.2.2 `dist/index.mjs:268-279`), which returns -1 on
 * `--`: there `migrations -- list` stops dispatching while this predicate still
 * says it did, silencing the parent's run. On 0.1.6 `--` DOES dispatch (checked),
 * so the mirror is faithful today and only today.
 */
function ranSubCommand(rawArgs: string[]): boolean {
  return rawArgs.some((arg) => !arg.startsWith("-"));
}

export const migrationsCommand = defineCommand({
  meta: {
    name: "migrations",
    description: "List and restore init replace-mode migrations",
  },
  // Mirror only the BOOLEAN `--json` so `navori migrations --json` works via the
  // default run below. Value flags (`--limit N`) cannot be mirrored here: citty
  // resolves the subcommand from the first non-dash token BEFORE applying the
  // parent's arg schema, so `migrations --limit 5` reads `5` as a subcommand name
  // ("Unknown command 5"). Truncation lives on the `list` subcommand instead:
  // `navori migrations list --limit N`. See #282.
  args: {
    json: { type: "boolean", description: "Output as JSON" },
  },
  subCommands: {
    list: listSubCommand,
    restore: restoreSubCommand,
  },
  // Without a subcommand citty errors with a bare "No command specified."
  // Default to `list` so `navori migrations` just works. `args.limit` is not in
  // this command's schema, but citty's parser still collects undeclared flags,
  // so forward it (reachable as `navori migrations --limit=N`, the `=` form:
  // the space form makes `N` a positional and citty reads it as a subcommand):
  // dropping it would make the value silently ignored here.
  run({ args, rawArgs }) {
    if (ranSubCommand(rawArgs)) return;
    runMigrationsList({ json: args.json, limit: args.limit });
  },
});
