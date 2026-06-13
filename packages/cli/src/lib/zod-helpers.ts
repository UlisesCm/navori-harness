import { z } from "zod";

/**
 * Zod refinement that accepts only "safe" relative paths:
 *   - non-empty
 *   - does not start with `/` (no absolute paths)
 *   - has no `..` segment (no parent-directory traversal)
 *
 * Used by NavoriConfig (`progress.dir`, `progress.currentFile`, etc.) and
 * by PluginManifest (`scripts.src/dest`, `skills.file`, `skills.injectInto`)
 * to keep navori from writing outside the repo or reading outside the
 * plugin package root.
 */
export const safeRelPath = z
  .string()
  .min(1)
  .refine(
    (v) => !v.startsWith("/") && !v.split(/[\\/]/).includes(".."),
    "path must be relative and must not contain '..'",
  );
