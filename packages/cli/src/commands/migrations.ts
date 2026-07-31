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
    const migrations = listMigrations();
    const limit = intFlagOrExit(args.limit, "limit", 20);
    const truncated = migrations.slice(0, limit);

    if (args.json) {
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
  // Default to `list` so `navori migrations` just works.
  run({ args }) {
    return listSubCommand.run?.({ args, cmd: listSubCommand, rawArgs: [] });
  },
});
