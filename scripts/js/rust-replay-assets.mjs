import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../../packages/cli/src/lib/render/hook-includes.ts";
import { signNativeScript } from "../../packages/cli/src/lib/render/native-hook.ts";
import { assetSources } from "./rust-manifest-check.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE_DIRS = { claude: ".claude", codex: ".codex", pi: ".pi/navori" };

/**
 * Spec 0057 T28 (R11): the bytes the corpus recorded, signed for the binary. Each registered
 * hook's source asset with its includes expanded (what the shell replay runs), under every
 * engine directory, beside the source of each manifest dependency. The signature covers those
 * dependency bytes in manifest key order, as the renderer signs a real copy.
 *
 * Templates stay unrendered, exactly as the corpus captured them; a rendered checkout is
 * replayed instead through NAVORI_RUST_HOOKS_DIR.
 *
 * @param {string} dir scratch root that receives `<engine>/hooks/<id>.sh` and `<engine>/scripts/*`
 * @param {string} [manifestPath]
 * @returns {string} dir
 */
export function writeSignedAssets(dir, manifestPath = join(REPO_ROOT, "crates", "ported.json")) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { deps: sources } = assetSources(REPO_ROOT);
  const core = join(REPO_ROOT, "packages/core/core-assets/hooks");
  for (const [id, hook] of Object.entries(manifest.hooks ?? {})) {
    const deps = Object.keys(hook.deps ?? {})
      .sort()
      .map((name) => {
        const source = sources.get(name);
        if (source === undefined) throw new Error(`${id}: unknown dependency ${name}`);
        return { name, bytes: readFileSync(source) };
      });
    const script = expandHookIncludes(readFileSync(join(core, `${id}.sh`), "utf8"));
    const signed = signNativeScript(
      script,
      hook.impl,
      deps.map((dep) => dep.bytes),
    );
    for (const engine of Object.values(ENGINE_DIRS)) {
      for (const dep of deps) {
        const target = join(dir, engine, dep.name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, dep.bytes);
      }
      const target = join(dir, engine, "hooks", `${id}.sh`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, signed);
      chmodSync(target, 0o755);
    }
  }
  return dir;
}
