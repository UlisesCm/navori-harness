import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1482 — fail fast when node_modules does not match bun.lock.
 *
 * Only workspace DIRECT deps are checked (no transitive walk): for each one the
 * locked version is compared with the installed `package.json`. Never installs
 * anything; the fix is printed for the human to run.
 */

const FIX = "node_modules does not match bun.lock — run: bun install --frozen-lockfile";
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Installed version of `dep` resolved Node-style from `wsDir` up to `root`, or null. */
function installedVersion(root, wsDir, dep) {
  let dir = resolve(root, wsDir);
  const stop = resolve(root);
  for (;;) {
    const pkg = join(dir, "node_modules", dep, "package.json");
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, "utf-8")).version ?? null;
      } catch {
        return null;
      }
    }
    if (dir === stop || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/**
 * Compares installed direct deps against `<root>/bun.lock`.
 * @param {string} root repo root containing bun.lock and node_modules
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkDepsSync(root) {
  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath)) return { ok: false, problems: ["bun.lock not found"] };
  const lock = JSON.parse(readFileSync(lockPath, "utf-8").replace(/,(\s*[}\]])/g, "$1"));
  const problems = [];
  for (const [wsDir, ws] of Object.entries(lock.workspaces ?? {})) {
    const wsName = ws.name ?? wsDir;
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(ws[field] ?? {})) {
        const entry = lock.packages?.[`${wsName}/${dep}`] ?? lock.packages?.[dep];
        const spec = entry?.[0];
        if (typeof spec !== "string") continue;
        const wanted = spec.slice(spec.lastIndexOf("@") + 1);
        if (wanted.startsWith("workspace:") || /[:/]/.test(wanted)) continue;
        const installed = installedVersion(root, wsDir, dep);
        if (installed === wanted) continue;
        if (installed === null && field === "optionalDependencies") continue;
        problems.push(
          `${dep}: ${installed === null ? "not installed" : `installed ${installed}`}, bun.lock wants ${wanted} (${wsDir || "root"})`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Optional argv[2] points at another root (used by tests); defaults to the repo root.
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { ok, problems } = checkDepsSync(root);
  if (ok) {
    console.log("check:deps ok — node_modules matches bun.lock");
  } else {
    for (const p of problems) console.error(p);
    console.error(FIX);
    process.exit(1);
  }
}
