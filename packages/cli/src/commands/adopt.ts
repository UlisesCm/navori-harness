import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBackup } from "../lib/backup.ts";
import { readCliVersion } from "../lib/bundled-assets.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { injectManagedSection } from "../lib/marker.ts";
import { listMarkers } from "../lib/health.ts";
import { resolveLang, tc, DEFAULT_LANG } from "../lib/i18n.ts";
import { accent, brand, dim } from "../lib/style.ts";

/**
 * Take a hand-made harness file under navori's management (spec 0014, #555).
 *
 * The one command in this feature that WRITES, and it writes over a file the
 * user typed — so every safeguard here is load-bearing, not ceremony: preview
 * by default (R12), a backup before the first byte (R13), and a refusal with a
 * named cause for anything that is not ours to touch (R14).
 *
 * ADOPTING IS WRAPPING, NOT REWRITING. The existing bytes go inside a managed
 * block unchanged (R11); what navori takes over is the file's lifecycle — from
 * here on `sync` keeps it in view and `render --prune` can recognise it — never
 * its content. A command that "adopted" a file by replacing what it said would
 * be a delete with extra steps.
 */

/** Managed-block id for an adopted file: stable, so re-running is a no-op. */
export function adoptedMarkerId(relPath: string): string {
  const slug = relPath
    .replace(/\.md$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `adopted-${slug}`;
}

/** Why a path cannot be adopted. Each is a different answer, so each has a name. */
export type AdoptRefusal =
  | "outside-repo"
  | "missing"
  | "not-a-file"
  | "not-adoptable-path"
  | "already-managed";

export type AdoptPlan =
  | { kind: "refuse"; reason: AdoptRefusal; path: string }
  /** Already adopted, byte for byte: nothing to do, and that is not an error (R15). */
  | { kind: "noop"; path: string }
  | { kind: "adopt"; path: string; relPath: string; markerId: string; content: string };

/**
 * Only markdown under the repo's `.claude/` is adoptable.
 *
 * Narrower than R14 demands, deliberately: the alternative is a command that
 * will write a navori marker into any file it is pointed at, and the first
 * mistake there is a mangled source file. Harness assets are what this feature
 * is about, and they all live in one place.
 */
function isAdoptablePath(relPath: string): boolean {
  return (
    (relPath.startsWith(`.claude${"/"}`) || relPath.startsWith(`.claude${"\\"}`)) &&
    relPath.endsWith(".md")
  );
}

/**
 * What adoption would do to `target`, decided without touching the disk.
 *
 * Split from the write so the preview and the apply answer the SAME question:
 * a preview computed by a different code path is a preview of something else.
 */
export function planAdoption(cwd: string, target: string): AdoptPlan {
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const relPath = relative(cwd, abs);
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    return { kind: "refuse", reason: "outside-repo", path: abs };
  }
  if (!existsSync(abs)) return { kind: "refuse", reason: "missing", path: relPath };
  if (!statSync(abs).isFile()) return { kind: "refuse", reason: "not-a-file", path: relPath };
  if (!isAdoptablePath(relPath)) {
    return { kind: "refuse", reason: "not-adoptable-path", path: relPath };
  }

  const existing = readFileSync(abs, "utf-8");
  const markerId = adoptedMarkerId(relPath);
  const markerIds = listMarkers(abs).map((marker) => marker.id);
  if (markerIds.length > 0) {
    // Ours, from an earlier run → idempotent no-op. Anybody else's → refuse: a
    // file that already carries a managed block is not a hand-made file, and
    // re-wrapping it would nest one block inside another.
    if (markerIds.includes(markerId)) return { kind: "noop", path: relPath };
    return { kind: "refuse", reason: "already-managed", path: relPath };
  }

  const content = injectManagedSection(
    "",
    markerId,
    existing.endsWith("\n") ? existing : `${existing}\n`,
    {
      version: readCliVersion(),
      source: "adopted",
    },
  ).output;
  return { kind: "adopt", path: abs, relPath, markerId, content };
}

export const adoptCommand = defineCommand({
  meta: {
    name: "adopt",
    description: "Take a hand-made .claude/ file under navori's management (preview by default)",
  },
  args: {
    path: {
      type: "positional",
      description: "File to adopt, relative to the repo (e.g. .claude/skills/mia.md)",
      required: true,
    },
    apply: { type: "boolean", description: "Write to disk. Without it, adopt only previews." },
    cwd: { type: "string", description: "Directory (default: cwd)" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = join(cwd, "navori.config.json");
    const lang = existsSync(configPath)
      ? resolveLang(readConfigOrExit(configPath).language)
      : DEFAULT_LANG;
    const t = tc(lang).adopt;

    p.intro(brand(`adopt ${accent(String(args.path))}`));

    const plan = planAdoption(cwd, String(args.path));
    if (plan.kind === "refuse") {
      p.cancel(t.refused[plan.reason](plan.path));
      process.exitCode = 1;
      return;
    }
    if (plan.kind === "noop") {
      p.outro(dim(t.alreadyAdopted(plan.path)));
      return;
    }

    if (!args.apply) {
      p.log.info(t.preview(plan.relPath, plan.markerId));
      p.outro(dim(t.previewHint));
      return;
    }

    // Backup BEFORE the first write, and its path in the output: a safety net
    // nobody can find is not one (R13).
    const handle = createBackup(cwd, [plan.relPath]);
    writeFileSync(plan.path, plan.content, "utf-8");
    p.log.success(t.adopted(plan.relPath, plan.markerId));
    p.outro(dim(t.backupAt(handle.path)));
  },
});
