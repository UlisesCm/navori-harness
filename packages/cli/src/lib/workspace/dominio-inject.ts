import { resolveLang, tc, type Lang } from "../i18n.ts";
import { listEntries, resolveWorkspacesForCwd, type DominioEntry } from "./dominio.ts";
import { loadWorkspace } from "./workspace.ts";

// Split out of `commands/dominio.ts` (spec 0055 R14) so `tools session-context` does not load the
// whole `dominio` command, and no subcommand chunk statically loads another.

/** Language for a workspace's user-facing/injected strings (defaults → es). */
export function workspaceLang(name: string): Lang {
  try {
    return resolveLang(loadWorkspace(name)?.defaults.language);
  } catch {
    return resolveLang(undefined);
  }
}

/**
 * What `dominio inject` prints: the Dominio index of the workspace(s) the cwd belongs
 * to, newline-terminated, or `""` when there is nothing to say. Throws on a broken
 * store: `inject` swallows it, `tools session-context` treats it as "no output at all".
 */
export function dominioInjectText(): string {
  const blocks: string[] = [];
  for (const ws of resolveWorkspacesForCwd(process.cwd())) {
    const entries = listEntries(ws).filter((e) => e.status !== "superseded");
    if (entries.length === 0) continue;
    blocks.push(renderInjectBlock(ws, entries, workspaceLang(ws)));
  }
  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}

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
