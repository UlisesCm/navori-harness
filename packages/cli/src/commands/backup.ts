import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { backupRoot, backupRepoLabel, backupIdRepoLabel, purgeOldBackups } from "../lib/backup.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";
import { tc, resolveLang, type Lang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/global-config.ts";
import { intFlagOrExit } from "../lib/args.ts";

/** Language for machine-global backup commands: global config, else default. */
function globalLang(): Lang {
  return resolveLang(readGlobalConfig()?.language);
}

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
    const limit = intFlagOrExit(args.limit, "limit", 20);
    const truncated = backups.slice(0, limit);

    if (args.json) {
      console.log(JSON.stringify({ backups: truncated, totalAvailable: backups.length }, null, 2));
      return;
    }

    const tr = tc(globalLang()).backup;
    p.intro(brand("backup list"));
    if (backups.length === 0) {
      p.log.info(tr.listEmpty);
      p.outro(dim(tr.done));
      return;
    }

    const lines: string[] = [];
    lines.push(dim(tr.total(backups.length, truncated.length)));
    for (const b of truncated) {
      const date = new Date(b.mtimeMs);
      const ago = dim(humanAge(b.mtimeMs, tr));
      lines.push(
        `  ${color.cyan(sym.bullet)} ${accent(b.timestamp)}  ${dim(date.toISOString())}  ${ago}`,
      );
      for (const f of b.files) {
        lines.push(`      ${dim(sym.bullet)} ${dim(f)}`);
      }
    }
    if (backups.length > truncated.length) {
      lines.push(dim(tr.more(backups.length - truncated.length)));
    }
    p.log.message(lines.join("\n"));
    p.outro(dim(tr.done));
  },
});

const restoreSubCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore files from a backup snapshot to the current directory",
  },
  args: {
    timestamp: {
      type: "positional",
      description: "Backup timestamp (from 'backup list')",
      required: true,
    },
    cwd: { type: "string", description: "Target directory (default: current)" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const ts = args.timestamp as string;
    const cwd = resolve(args.cwd ?? process.cwd());
    const backupDir = join(backupRoot(), ts);

    const lang = globalLang();
    const tr = tc(lang).backup;
    p.intro(brand(`backup restore ${accent(ts)}`));

    if (!existsSync(backupDir)) {
      p.cancel(tr.notFound(backupDir));
      process.exit(1);
    }

    const files = collectFiles(backupDir, backupDir);
    if (files.length === 0) {
      p.cancel(tr.empty(backupDir));
      process.exit(1);
    }

    // Soft destination check (#82): the backup id encodes the repo it came from.
    // Restoring one repo's snapshot into a different repo is almost always a
    // mistake in a multi-repo rollout, so warn — but don't block (the user may
    // have renamed the dir, or be restoring intentionally elsewhere).
    const backupRepo = backupIdRepoLabel(ts);
    if (backupRepo && backupRepo !== backupRepoLabel(cwd)) {
      p.log.warn(tr.repoMismatch(backupRepo, backupRepoLabel(cwd)));
    }

    p.log.message(tr.willRestore(files.length, backupDir, cwd));
    for (const f of files) p.log.message(`  · ${f}`);

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
      const src = join(backupDir, rel);
      const dest = join(cwd, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    p.outro(tr.restored(files.length));
  },
});

// #393: the explicit pruning path. Renders prune on write, so a repo that
// stops rendering keeps its backups forever; this command applies the same two
// criteria on demand — retention by age first, then oldest-first until the
// total size is under the cap.
const pruneSubCommand = defineCommand({
  meta: {
    name: "prune",
    description: "Delete backups past retention, then oldest-first down to the size cap",
  },
  args: {
    days: { type: "string", description: "Retention in days (default: 30)" },
    "max-mb": { type: "string", description: "Total size cap in MB (default: 2048)" },
  },
  run({ args }) {
    const days = intFlagOrExit(args.days, "days");
    const maxMb = intFlagOrExit(args["max-mb"], "max-mb");
    const tr = tc(globalLang()).backup;
    p.intro(brand("backup prune"));
    const pruned = purgeOldBackups({
      retentionDays: days,
      maxTotalBytes: maxMb === undefined ? undefined : maxMb * 1024 * 1024,
    });
    if (pruned.length === 0) {
      p.outro(dim(tr.pruneNothing));
      return;
    }
    for (const dir of pruned) p.log.message(`  ${color.cyan(sym.bullet)} ${dim(dir)}`);
    p.outro(tr.pruned(pruned.length));
  },
});

function humanAge(mtimeMs: number, tr: ReturnType<typeof tc>["backup"]): string {
  const diffMs = Date.now() - mtimeMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return tr.ageJustNow;
  if (minutes < 60) return tr.ageMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr.ageHours(hours);
  const days = Math.floor(hours / 24);
  return tr.ageDays(days);
}

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "List and restore navori backups",
  },
  subCommands: {
    list: listSubCommand,
    restore: restoreSubCommand,
    prune: pruneSubCommand,
  },
});
