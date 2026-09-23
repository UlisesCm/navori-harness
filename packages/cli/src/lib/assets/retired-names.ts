import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { getCoreRoot, getPluginAssetsRoot } from "../bundled-assets.ts";
import { RETIRED_AGENTS, RETIRED_HOOKS, RETIRED_SKILLS } from "../../engines/shared/roster.ts";

/**
 * One retired id found where it should not be: a shipped asset's content or
 * its own path (spec 0026 T17, R43/R44).
 */
export interface RetiredNameViolation {
  readonly file: string;
  readonly id: string;
  readonly kind: "content" | "path";
}

/**
 * Every id navori USED to ship, pulled from the three R38 registries
 * (`RETIRED_AGENTS`/`RETIRED_SKILLS`/`RETIRED_HOOKS`) instead of a second
 * hand-copied list — those registries are the EXCLUDED source of truth this
 * sweep checks everything else against, never a second list to keep in sync.
 */
export function retiredIds(): string[] {
  return [...RETIRED_AGENTS, ...RETIRED_SKILLS, ...RETIRED_HOOKS].map((r) => r.id);
}

/**
 * The areas a distributed repo actually ships from: core agents, core skills,
 * core managed blocks, core hooks (including their `_partials/` includes —
 * `walk()` recurses, and each partial is scanned as its own file, so the
 * `# navori:include` expansion in `hook-includes.ts` needs no special-casing
 * here: expanded or not, every retired id still sits in some file this sweep
 * visits), library skills (`core-assets/lib-skills`, materialized 1:1 into a
 * target repo's skills by id), the base `.claude/settings.json` fragment
 * (`core-assets/settings`), the one-shot `progress/` bootstrap templates
 * (`core-assets/progress`), the stack presets (their own managed/skills
 * subtrees included), and every plugin bundle. Excludes the R38 registries
 * themselves (`engines/shared/roster.ts`), which are meant to name every
 * retired id forever — sweeping them would just fail on their own append-only
 * history.
 *
 * `core-assets/prompts.json` is deliberately NOT swept: it is a single FILE
 * (`walk()`'s `readdirSync` would throw on it, and `sweepRetiredNames`'s
 * empty-area guard exists precisely to fail loudly on a misresolved root, not
 * to be special-cased around it), and unlike every area above it is never
 * copied into a target repo — `prompts-loader.ts` reads it in-process to
 * build the `init` wizard's question list, so a retired id here would show up
 * as wizard copy, not as a file this sweep is built to catch. If it ever
 * grows enough to warrant its own check, that is a dedicated unit test
 * against the parsed JSON, not a `walk()`-shaped root.
 */
export interface SweepRoot {
  readonly label: string;
  readonly path: string;
}

/** Exported so tests can seed a violation directly under a real swept area's own path, instead of re-deriving it. */
export function sweepRoots(): ReadonlyArray<SweepRoot> {
  const core = getCoreRoot();
  return [
    { label: "core-assets/agents", path: join(core, "core-assets", "agents") },
    { label: "core-assets/skills", path: join(core, "core-assets", "skills") },
    { label: "core-assets/managed", path: join(core, "core-assets", "managed") },
    { label: "core-assets/hooks", path: join(core, "core-assets", "hooks") },
    { label: "core-assets/lib-skills", path: join(core, "core-assets", "lib-skills") },
    { label: "core-assets/settings", path: join(core, "core-assets", "settings") },
    { label: "core-assets/progress", path: join(core, "core-assets", "progress") },
    { label: "core-assets/presets", path: join(core, "core-assets", "presets") },
    { label: "packages/plugins", path: getPluginAssetsRoot() },
  ];
}

/** A character that keeps a match glued to a longer, unrelated word. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Whether `id` appears in `haystack` as a whole token: hyphenated ids
 * (`ticket-audit`) already have a non-word char on each side, and bare-word
 * ids (`leader`, `explorer`) must not match inside an unrelated longer word
 * (`leadership`). Case-insensitive: NFKC does not fold case, and a
 * differently-cased leftover is just as dead.
 *
 * Deliberately NOT a caller-built `RegExp` (`id` is a fixed string here, but
 * `detect-non-literal-regexp` cannot see that, and this repo's own
 * `frontmatter.ts` already sets the precedent of a hand-rolled scan over a
 * dynamic pattern for exactly this shape) — a manual index scan with a
 * literal, static boundary check on each side.
 */
function containsRetiredId(haystack: string, id: string): boolean {
  const hay = haystack.toLowerCase();
  const needle = id.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? hay[idx - 1] : undefined;
    const after = hay[idx + needle.length];
    const boundedBefore = before === undefined || !WORD_CHAR.test(before);
    const boundedAfter = after === undefined || !WORD_CHAR.test(after);
    if (boundedBefore && boundedAfter) return true;
    from = idx + 1;
  }
}

function walk(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Sweep every distributed asset for a retired id, in its content AND its own
 * path, NFKC-normalized so a look-alike Unicode variant cannot hide from the
 * plain-ASCII pattern. Throws if any swept area is empty — a root that
 * resolves to nothing would silently pass every id, which is worse than
 * failing loudly (spec 0026 T17, R43/R44: "falla si no recorrió esas áreas").
 */
export function sweepRetiredNames(
  options: { readonly roots?: ReadonlyArray<SweepRoot>; readonly ids?: readonly string[] } = {},
): RetiredNameViolation[] {
  const ids = options.ids ?? retiredIds();
  const violations: RetiredNameViolation[] = [];

  for (const { label, path: root } of options.roots ?? sweepRoots()) {
    const files = walk(root);
    if (files.length === 0) {
      throw new Error(`retired-names sweep did not traverse "${label}" (${root}) — no files found`);
    }
    for (const file of files) {
      const relPath = relative(root, file).normalize("NFKC");
      for (const id of ids) {
        if (containsRetiredId(relPath, id)) violations.push({ file, id, kind: "path" });
      }
      const content = readFileSync(file, "utf-8").normalize("NFKC");
      for (const id of ids) {
        if (containsRetiredId(content, id)) violations.push({ file, id, kind: "content" });
      }
    }
  }
  return violations;
}
