import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { backupRoot } from "../lib/backup.ts";

interface BackupEntry {
  timestamp: string;
  path: string;
  files: string[];
  mtimeMs: number;
}

function listBackups(): BackupEntry[] {
  const root = backupRoot();
  if (!existsSync(root)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      const files = collectFiles(full, full);
      entries.push({ timestamp: name, path: full, files, mtimeMs: stat.mtimeMs });
    } catch {
      // skip unreadable entries
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
    description: "List available backups in ~/.navori/backups/",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
    limit: { type: "string", description: "Show only the N most recent (default: 20)" },
  },
  run({ args }) {
    const backups = listBackups();
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : 20;
    const truncated = backups.slice(0, limit);

    if (args.json) {
      console.log(JSON.stringify({ backups: truncated, totalAvailable: backups.length }, null, 2));
      return;
    }

    if (backups.length === 0) {
      console.log("No backups found. They are created automatically before each 'sync' or 'render' that modifies files.");
      return;
    }

    console.log(`${backups.length} backup(s) total. Showing ${truncated.length}:`);
    for (const b of truncated) {
      const date = new Date(b.mtimeMs);
      const ago = humanAge(b.mtimeMs);
      console.log(`  ${b.timestamp}  ${date.toISOString()}  ${ago}`);
      for (const f of b.files) {
        console.log(`    · ${f}`);
      }
    }
    if (backups.length > truncated.length) {
      console.log(`  ... ${backups.length - truncated.length} more (use --limit to show)`);
    }
  },
});

const restoreSubCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore files from a backup snapshot to the current directory",
  },
  args: {
    timestamp: { type: "positional", description: "Backup timestamp (from 'backup list')", required: true },
    cwd: { type: "string", description: "Target directory (default: current)" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const ts = args.timestamp as string;
    const cwd = resolve(args.cwd ?? process.cwd());
    const backupDir = join(backupRoot(), ts);

    p.intro(`navori-ai backup restore ${ts}`);

    if (!existsSync(backupDir)) {
      p.cancel(`Backup not found: ${backupDir}`);
      process.exit(1);
    }

    const files = collectFiles(backupDir, backupDir);
    if (files.length === 0) {
      p.cancel(`Backup is empty: ${backupDir}`);
      process.exit(1);
    }

    p.log.message(`Will restore ${files.length} file(s) from ${backupDir} into ${cwd}:`);
    for (const f of files) p.log.message(`  · ${f}`);

    if (!args.yes) {
      const ok = await p.confirm({
        message: "Existing files will be overwritten. Proceed?",
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    for (const rel of files) {
      const src = join(backupDir, rel);
      const dest = join(cwd, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    p.outro(`Restored ${files.length} file(s)`);
  },
});

function humanAge(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "(just now)";
  if (minutes < 60) return `(${minutes} min ago)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `(${hours} h ago)`;
  const days = Math.floor(hours / 24);
  return `(${days} d ago)`;
}

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "List and restore navori-ai backups",
  },
  subCommands: {
    list: listSubCommand,
    restore: restoreSubCommand,
  },
});
