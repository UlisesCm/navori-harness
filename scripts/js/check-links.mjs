import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #819 — no gate caught dead relative links in the repo's `.md` files.
 *
 * Measured before this script existed: 7 broken relative links out of 89
 * (8%). One was real code rot, not a typo:
 * `docs/architecture.md -> ../packages/cli/src/engines/claude/render-managed-file.ts`
 * — the file exists, but moved to `engines/shared/`; the doc kept pointing at
 * the old path. `bun run format:check` does not cover markdown (only
 * `packages/cli/src` and `apps/website/src`), so nothing else in the gate
 * would have caught this either.
 *
 * Scope is deliberately narrow: only relative links that resolve to a path on
 * disk. `http(s):`/`mailto:` targets need a network call to verify (out of
 * scope for a dependency-free script) and pure `#anchor` links point within
 * the same file, not at another path.
 *
 * Anti-atrophy guard (the pattern in `check-coverage-floor.mjs` and
 * `verify-client-ui-i18n.ts`'s `MINIMUM_CLIENT_UI_SOURCES`): if link discovery
 * finds fewer than `MIN_LINKS_DISCOVERED`, the regex or the file walk broke
 * silently and the check must fail loud instead of passing green over zero.
 *
 * Usage: node scripts/check-links.mjs   (run from anywhere; resolves paths off git)
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Conservatively below the 89 links present when this gate was added. */
const MIN_LINKS_DISCOVERED = 70;

/**
 * Links that are intentionally broken and must stay that way — each entry
 * documents WHY instead of the check silently skipping it. `file` and
 * `target` are exactly what the offender list below would print.
 */
const KNOWN_EXCEPTIONS = new Set([
  // `docs/research/ponytail-lessons.md` quotes ponytail's own README verbatim
  // inside a `>` blockquote (not a code span, so extractLinks still sees it).
  // The link target is a path in THAT repo, not one meant to resolve inside
  // navori.
  "docs/research/ponytail-lessons.md -> benchmarks/", // quoted from ponytail's own README, ponytail's own benchmarks/

  // Core-assets templates render into a DIFFERENT location than their source
  // path in the tree (`navori render` copies packages/core/core-assets/agents/
  // -> .claude/agents/). Their relative links are written for the render
  // target, not the source depth this walk resolves against — and the
  // rendered sibling (`.claude/agents/orchestrator.md`) is itself tracked, so
  // the same link is checked for real there.
  "packages/core/core-assets/agents/orchestrator.md -> ../../CLAUDE.md",
]);

/**
 * Strips fenced code blocks. A fence opens on a line with (optionally
 * indented / blockquote-prefixed) 3+ backticks or tildes, and closes on a
 * line with the same run length of the same character — matched via
 * backreference so a 4-backtick fence isn't mismatched against a
 * hardcoded 3-backtick assumption, which used to leave a stray backtick
 * that then paired with an unrelated one hundreds of lines away.
 */
function stripFences(markdown) {
  return markdown.replace(/^[ \t>]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t>]*\1[`~]*[ \t]*$/gm, "");
}

/**
 * Strips inline code spans (including multi-backtick spans like
 * `` `` `x` `` ``) paragraph by paragraph, so a span can never swallow
 * content across a blank line the way CommonMark itself forbids — this
 * bounds the blast radius of a stray unmatched backtick to a single
 * paragraph instead of the rest of the document.
 */
function stripCodeSpans(markdown) {
  return markdown
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/(`+)[\s\S]*?\1/g, ""))
    .join("\n\n");
}

/** Markdown links `[text](target)`, skipping fenced code blocks and inline code spans. */
function extractLinks(markdown) {
  const withoutFences = stripFences(markdown);
  const withoutCodeSpans = stripCodeSpans(withoutFences);
  const links = [];
  for (const match of withoutCodeSpans.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    links.push(match[1]);
  }
  return links;
}

/** Relative link targets only: drops absolute URLs, mailto:, and pure anchors. */
function isCheckable(target) {
  if (target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // any URL scheme, incl. mailto:
  return true;
}

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO_ROOT, encoding: "utf-8" })
  .split("\n")
  .filter(Boolean);

let discovered = 0;
const offenders = [];

for (const file of files) {
  const abs = resolve(REPO_ROOT, file);
  const markdown = readFileSync(abs, "utf-8");
  for (const rawTarget of extractLinks(markdown)) {
    if (!isCheckable(rawTarget)) continue;
    discovered += 1;
    const withoutFragment = rawTarget.split("#")[0].split("?")[0];
    if (withoutFragment === "") continue; // was e.g. "./#section" — anchor only
    const resolved = resolve(dirname(abs), withoutFragment);
    if (existsSync(resolved)) continue;
    const key = `${file} -> ${rawTarget}`;
    if (KNOWN_EXCEPTIONS.has(key)) continue;
    offenders.push(key);
  }
}

if (discovered < MIN_LINKS_DISCOVERED) {
  console.error(
    `⊘ link check could not run: only ${discovered} relative link(s) discovered across ${files.length} file(s), expected at least ${MIN_LINKS_DISCOVERED}`,
  );
  console.error(`  did the markdown link regex or the git ls-files walk break?`);
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`✗ ${offenders.length} broken relative link(s) in tracked markdown:`);
  for (const offender of offenders) console.error(`    ${offender}`);
  process.exit(1);
}

console.log(`✓ link check: ${discovered} relative link(s) across ${files.length} file(s), all resolve`);
