/**
 * Resolves `<specsDir>/<spec>/` with containment (spec 0044 R9): a spec name
 * is one path segment, so `..`, separators and absolute paths never escape
 * `specsDir` (same guard `checkPart` applies to a part's linked spec).
 */
import { relative, resolve, sep } from "node:path";

const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SpecLocation = { ok: true; dir: string } | { ok: false; why: string };

/** Absolute directory of `spec` under `specsDir`, or the reason it is rejected. */
export function locateSpecDir(cwd: string, specsDir: string, spec: string): SpecLocation {
  if (!SPEC_NAME.test(spec) || spec.includes("..")) {
    return {
      ok: false,
      why: `"${spec}" is not a spec directory name (one path segment of letters, digits, ".", "_" or "-")`,
    };
  }
  const root = resolve(cwd, specsDir);
  const dir = resolve(root, spec);
  const rel = relative(root, dir);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).length !== 1) {
    return { ok: false, why: `"${spec}" resolves outside ${specsDir}` };
  }
  return { ok: true, dir };
}
