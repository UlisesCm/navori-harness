/**
 * Centralized terminal styling for the navori CLI.
 *
 * Wraps picocolors so the rest of the codebase imports from a single place.
 * picocolors auto-disables ANSI when stdout is not a TTY or NO_COLOR is set,
 * so callers don't need to guard for those cases.
 *
 * Use the semantic helpers (added/updated/removed/...) rather than raw
 * colors when a status meaning exists — that keeps the palette swappable.
 */
import pc from "picocolors";

export const color = pc;

/**
 * Status-aware symbol set used by render/sync planners and doctor checks.
 * Centralized so the symbol vocabulary stays consistent across commands.
 */
export const sym = {
  created: "+",
  updated: "~",
  unchanged: "·",
  conflict: "!",
  removed: "-",
  update: "⇡",
  bullet: "·",
  ok: "✓",
  fail: "✗",
  empty: "○",
  arrow: "→",
} as const;

export type RenderStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "user-modified-skipped"
  | "removed-condition-false";

/** Symbol + color for a render-plan entry status. */
export function renderStatusSymbol(status: RenderStatus): string {
  switch (status) {
    case "created":
      return color.green(sym.created);
    case "updated":
      return color.yellow(sym.updated);
    case "unchanged":
      return color.dim(sym.unchanged);
    case "user-modified-skipped":
      return color.red(sym.conflict);
    case "removed-condition-false":
      return color.magenta(sym.removed);
  }
}

/** Colored label for a render-plan entry status (matches renderStatusSymbol). */
export function renderStatusLabel(status: RenderStatus): string {
  switch (status) {
    case "created":
      return color.green(status);
    case "updated":
      return color.yellow(status);
    case "unchanged":
      return color.dim(status);
    case "user-modified-skipped":
      return color.red(status);
    case "removed-condition-false":
      return color.magenta(status);
  }
}

export function dim(s: string): string {
  return color.dim(s);
}

export function ok(s: string): string {
  return color.green(s);
}

export function warn(s: string): string {
  return color.yellow(s);
}

export function err(s: string): string {
  return color.red(s);
}

export function accent(s: string): string {
  return color.cyan(s);
}

/** Brand mark used in command intros: cyan-bold "navori" + dim suffix. */
export function brand(suffix?: string): string {
  const head = color.bold(color.cyan("navori"));
  return suffix ? `${head} ${color.dim(suffix)}` : head;
}

/** Boolean check mark used by doctor: green ✓ for true, dim ○ for false. */
export function check(ok: boolean): string {
  return ok ? color.green(sym.ok) : color.dim(sym.empty);
}

/**
 * Render a key/value table with auto-aligned padding.
 *
 * Example:
 *   kv([
 *     ["name", "navori"],
 *     ["engines", "claude, agents-md"],
 *   ])
 *   // →  name    : navori
 *   //    engines : claude, agents-md
 *
 * The left column is dimmed so the eye lands on the values.
 */
export function kv(rows: Array<[string, string]>, opts: { indent?: string } = {}): string {
  const indent = opts.indent ?? "  ";
  const width = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
  return rows
    .map(([k, v]) => `${indent}${color.dim(k.padEnd(width))} ${color.dim(":")} ${v}`)
    .join("\n");
}
