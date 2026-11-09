import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { injectManagedSection } from "../../lib/render/marker.ts";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";

/**
 * Fixtures shared by the `render --prune` suites. A file exactly as an engine
 * would have rendered it: managed marker, current version, navori as the source —
 * the only shape a prune may delete. `style` is the marker syntax of the file kind
 * (`shell` for `.toml`, `.sh`, `.gitignore`; `html` for Markdown).
 */
export const navoriAuthored = (
  id: string,
  body: string,
  style: "html" | "shell" = "html",
): string =>
  injectManagedSection(
    "",
    id,
    `${body}\n`,
    { version: readCliVersion(), source: "@navori/core" },
    style,
  ).output;

/** Throwaway home (for the backup store) and repo directories of one prune test. */
export function makeSandboxDirs(label: string): { home: string; cwd: string } {
  return {
    home: mkdtempSync(join(tmpdir(), "navori-home-")),
    cwd: mkdtempSync(join(tmpdir(), `navori-${label}-`)),
  };
}

/** Every file under `dir`, as `dir`-relative paths, sorted: fails on a missing
 *  file AND on an extra one, which `existsSync` per path never does. */
export function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}
