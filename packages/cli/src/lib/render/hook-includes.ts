import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCoreRoot } from "./bundled-assets.ts";

/**
 * Build-once, ship-standalone shell "includes" for the generated hook scripts.
 *
 * The PreToolUse(Bash) hooks (`guard-destructive`, `quality-gate-pre-commit`)
 * and the plugin gate scripts (`check-semgrep`, `check-jscpd`) share a chunk of
 * hardened boilerplate — the jq/node/sed command extractor and the compound-
 * command gate detector (the FIX B/C wrapper-peeling logic). Keeping four hand-
 * synced copies is how a fix to one drifted from the others (#225 / #261).
 *
 * Instead the shared bodies live ONCE under `core-assets/hooks/_partials/*.sh`,
 * and each script references them with a `# navori:include <name>` directive.
 * The directive is expanded at RENDER time (not committed into the script), so:
 *   - there is a SINGLE source of truth for the shared logic, and
 *   - the file that lands in the target repo is still fully standalone — the
 *     directive is gone, the partial's body is inlined, exactly what a security
 *     hook needs (self-contained, directly auditable, no runtime `source`).
 *
 * Expansion is a pure textual substitution and runs BEFORE `interpolate`, so a
 * partial can carry `{{...}}` placeholders that resolve like any other body.
 * Includes are one level deep; a partial that itself contains a directive is a
 * build error (keeps the model trivially reasoned about).
 */
const INCLUDE_RE = /^[^\S\n]*#\s*navori:include\s+([A-Za-z0-9._-]+)[^\S\n]*$/gm;

/** The `_partials/` directory, resolved against the bundled-or-dev core root. */
export function hookPartialsDir(): string {
  return join(getCoreRoot(), "core-assets/hooks/_partials");
}

/**
 * Replace every `# navori:include <name>` line in `content` with the body of
 * `_partials/<name>.sh`. Returns `content` untouched when it holds no directive
 * (the common case for agents/skills that flow through the same read path).
 */
export function expandHookIncludes(content: string): string {
  if (!content.includes("navori:include")) return content;
  return content.replace(INCLUDE_RE, (_line, name: string) => {
    const partialPath = join(hookPartialsDir(), `${name}.sh`);
    let partial: string;
    try {
      partial = readFileSync(partialPath, "utf-8");
    } catch {
      throw new Error(`hook include: partial '${name}' not found at ${partialPath}`);
    }
    if (new RegExp(INCLUDE_RE.source, "m").test(partial)) {
      throw new Error(`hook include: nested includes are not supported (partial '${name}')`);
    }
    // Drop the partial's trailing newline; the directive line's own newline
    // stays, so surrounding blank lines are preserved verbatim.
    return partial.replace(/\n$/, "");
  });
}
