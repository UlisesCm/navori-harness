import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { migrationsRoot } from "../lib/migrate.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";

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
          entries.push({ timestamp: ts, repoName, path: repoDir, files, mtimeMs: repoStat.mtimeMs });
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
    description: "List 'init --replace' migrations stored in ~/.navori/migrations/",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
    limit: { type: "string", description: "Show only the N most recent (default: 20)" },
  },
  run({ args }) {
    const migrations = listMigrations();
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : 20;
    const truncated = migrations.slice(0, limit);

    if (args.json) {
      console.log(JSON.stringify({ migrations: truncated, totalAvailable: migrations.length }, null, 2));
      return;
    }

    p.intro(brand("migrations list"));
    if (migrations.length === 0) {
      p.log.info("No migrations found. They are created when 'init --replace' is used to start fresh on a repo with existing Claude infrastructure.");
      p.outro(dim("Done"));
      return;
    }

    const lines: string[] = [];
    lines.push(dim(`${migrations.length} migration(s) total. Showing ${truncated.length}:`));
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
      lines.push(dim(`  ... ${migrations.length - truncated.length} more (use --limit to show)`));
    }
    p.log.message(lines.join("\n"));
    p.outro(dim("Done"));
  },
});

const restoreSubCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore an 'init --replace' migration back to the original repo",
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

    p.intro(`navori migrations restore ${ts}/${repoName}`);

    if (!existsSync(migrationDir)) {
      p.cancel(`Migration not found: ${migrationDir}`);
      process.exit(1);
    }

    const files = collectFiles(migrationDir, migrationDir);
    if (files.length === 0) {
      p.cancel(`Migration is empty: ${migrationDir}`);
      process.exit(1);
    }

    p.log.message(`Will restore ${files.length} file(s) from ${migrationDir} into ${cwd}:`);
    for (const f of files.slice(0, 10)) p.log.message(`  · ${f}`);
    if (files.length > 10) p.log.message(`  ... ${files.length - 10} more`);

    if (!args.yes) {
      const ok = await p.confirm({
        message: "Existing files will be OVERWRITTEN by the migration's snapshot. Proceed?",
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    for (const rel of files) {
      const src = join(migrationDir, rel);
      const dest = join(cwd, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    p.outro(`Restored ${files.length} file(s)`);
  },
});

export const migrationsCommand = defineCommand({
  meta: {
    name: "migrations",
    description: "List and restore 'init --replace' migrations",
  },
  subCommands: {
    list: listSubCommand,
    restore: restoreSubCommand,
  },
});
