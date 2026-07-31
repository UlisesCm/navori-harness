import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { readFileSync } from "node:fs";
import { brand, check, color, dim as grey, sym } from "../lib/style.ts";
import { tc, resolveLang, type Lang } from "../lib/i18n.ts";
import { loadWorkspace } from "../lib/workspace.ts";
import {
  ensureDominio,
  reindex,
  listEntries,
  findEntry,
  validateDominio,
  resolveWorkspacesForCwd,
  type DominioEntry,
} from "../lib/dominio.ts";

/**
 * Resolve which workspace a subcommand targets: the explicit --workspace flag,
 * or the single workspace whose repos contain the cwd. Zero matches or an
 * ambiguous set (repo in >1 workspace) is a clean error asking for --workspace.
 */
function resolveTarget(explicit: string | undefined, d: ReturnType<typeof tc>["dominio"]): string {
  if (explicit) return explicit;
  const matches = resolveWorkspacesForCwd(process.cwd());
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    p.cancel(d.noWorkspace);
    process.exit(1);
  }
  p.cancel(d.ambiguous(matches.join(", ")));
  process.exit(1);
}

/** Language for a workspace's user-facing/injected strings (defaults → es). */
function workspaceLang(name: string): Lang {
  try {
    return resolveLang(loadWorkspace(name)?.defaults.language);
  } catch {
    return resolveLang(undefined);
  }
}

const initSubCommand = defineCommand({
  meta: { name: "init", description: "Create the Dominio store for a workspace" },
  args: { workspace: { type: "string", description: "Workspace name (default: from cwd)" } },
  async run({ args }) {
    p.intro(brand("dominio init"));
    const d = tc(resolveLang(undefined)).dominio;
    const ws = resolveTarget(args.workspace, d);
    const lang = workspaceLang(ws);
    const dl = tc(lang).dominio;
    const res = ensureDominio(ws, lang);
    p.outro(color.green(res.created ? dl.initDone(res.dir) : dl.initExists(res.dir)));
  },
});

const listSubCommand = defineCommand({
  meta: { name: "list", description: "List the Dominio entries of a workspace" },
  args: { workspace: { type: "string", description: "Workspace name (default: from cwd)" } },
  async run({ args }) {
    p.intro(brand("dominio list"));
    const d = tc(resolveLang(undefined)).dominio;
    const ws = resolveTarget(args.workspace, d);
    const dl = tc(workspaceLang(ws)).dominio;
    const entries = listEntries(ws);
    if (entries.length === 0) {
      p.outro(grey(dl.listEmpty(ws)));
      return;
    }
    p.note(entries.map(entryRow).join("\n"), dl.listTitle(ws, entries.length));
    p.outro(grey(dl.readHint));
  },
});

function entryRow(e: DominioEntry): string {
  const scope = e.appliesTo === "all" ? "all" : e.appliesTo.join(", ") || "—";
  const tag = e.status === "canonical" ? "" : ` ${color.yellow(`(${e.status})`)}`;
  const summary = e.summary ? ` ${grey("— " + e.summary)}` : "";
  return `  ${color.cyan(sym.bullet)} ${e.title}${tag} ${grey(`[${e.id} · ${scope}]`)}${summary}`;
}

const showSubCommand = defineCommand({
  meta: { name: "show", description: "Print a Dominio entry" },
  args: {
    id: { type: "positional", description: "Entry id" },
    workspace: { type: "string", description: "Workspace name (default: from cwd)" },
  },
  async run({ args }) {
    const d = tc(resolveLang(undefined)).dominio;
    const ws = resolveTarget(args.workspace, d);
    const dl = tc(workspaceLang(ws)).dominio;
    const entry = findEntry(ws, String(args.id));
    if (!entry) {
      p.cancel(dl.showNotFound(String(args.id)));
      process.exit(1);
    }
    // Raw file to stdout — `show` is for reading, not a decorated summary.
    try {
      process.stdout.write(readFileSync(entry.path, "utf-8"));
    } catch {
      p.cancel(dl.showNotFound(String(args.id)));
      process.exit(1);
    }
  },
});

const reindexSubCommand = defineCommand({
  meta: { name: "reindex", description: "Rebuild DOMINIO.md from the entry files" },
  args: { workspace: { type: "string", description: "Workspace name (default: from cwd)" } },
  async run({ args }) {
    p.intro(brand("dominio reindex"));
    const d = tc(resolveLang(undefined)).dominio;
    const ws = resolveTarget(args.workspace, d);
    const lang = workspaceLang(ws);
    const dl = tc(lang).dominio;
    const res = reindex(ws, lang);
    p.outro(color.green(dl.reindexDone(res.count, res.indexPath)));
  },
});

const doctorSubCommand = defineCommand({
  meta: { name: "doctor", description: "Validate a workspace's Dominio (warnings only)" },
  args: { workspace: { type: "string", description: "Workspace name (default: from cwd)" } },
  async run({ args }) {
    p.intro(brand("dominio doctor"));
    const d = tc(resolveLang(undefined)).dominio;
    const ws = resolveTarget(args.workspace, d);
    const lang = workspaceLang(ws);
    const dl = tc(lang).dominio;
    const findings = validateDominio(ws, lang);
    if (findings.length === 0) {
      p.note(`  ${check(true)} ${dl.doctorClean}`, dl.doctorTitle(ws));
      p.outro(color.green(dl.outroOk));
      return;
    }
    const lines = findings.map(
      (f) => `  ${color.yellow(sym.update)} ${grey(`[${f.id}]`)} ${f.message}`,
    );
    p.note(lines.join("\n"), dl.doctorTitle(ws));
    p.outro(color.yellow(dl.outroIssues(findings.length)));
  },
});

/**
 * `inject` is a MACHINE command called by the SessionStart hook, not an
 * interactive one: it writes the Dominio index (markdown) for the workspace(s)
 * the cwd belongs to straight to stdout, or nothing. It must never throw — the
 * hook absorbs failures, but staying silent keeps the session pristine. This is
 * how a cross-repo fact (e.g. "coachee = user-profile.kind") reaches every
 * member repo's session (spec 0011 §6).
 */
const injectSubCommand = defineCommand({
  meta: {
    name: "inject",
    description: "Emit the workspace Dominio index for the SessionStart hook",
  },
  async run() {
    try {
      const names = resolveWorkspacesForCwd(process.cwd());
      const blocks: string[] = [];
      for (const ws of names) {
        const entries = listEntries(ws).filter((e) => e.status !== "superseded");
        if (entries.length === 0) continue;
        blocks.push(renderInjectBlock(ws, entries, workspaceLang(ws)));
      }
      if (blocks.length > 0) process.stdout.write(blocks.join("\n\n") + "\n");
    } catch {
      // Fail silent: a broken store must not disturb session startup.
    }
  },
});

function renderInjectBlock(ws: string, entries: DominioEntry[], lang: Lang): string {
  const dl = tc(lang).dominio;
  const lines = [dl.injectHeader(ws), "", dl.injectHint, ""];
  for (const e of entries) {
    const scope = e.appliesTo === "all" ? "all" : e.appliesTo.join(", ");
    const scopeTag = scope ? ` (${scope})` : "";
    const dep = e.status === "deprecated" ? " [deprecated]" : "";
    const summary = e.summary ? ` — ${e.summary}` : "";
    lines.push(
      `- **${e.title}**${dep}${summary}  ·  \`workspace://${ws}/dominio/${e.id}.md\`${scopeTag}`,
    );
  }
  return lines.join("\n");
}

export const dominioCommand = defineCommand({
  meta: {
    name: "dominio",
    description: "Manage the workspace knowledge base (canonical cross-repo facts)",
  },
  subCommands: {
    init: initSubCommand,
    list: listSubCommand,
    show: showSubCommand,
    reindex: reindexSubCommand,
    inject: injectSubCommand,
    doctor: doctorSubCommand,
  },
});
