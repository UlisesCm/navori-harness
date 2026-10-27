/**
 * Output-parity comparator for two built website trees (spec 0061, challenge C4).
 *
 * Usage: bun apps/website/scripts/compare-dist.ts <before> <after>
 *
 * Gated (exit 1 on any difference): normalized file list, byte parity of
 * md/txt/xml, per-page visible text, reference attribute multiset, head tags.
 * Reported only: inline script bodies and `_astro` CSS/JS sizes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const HASH = /(_astro\/[^"'\s]*?)\.[A-Za-z0-9_-]{8}\.(\w+)/g;
const REF_ATTRS = /^(href|src|srcset|id|for|lang|hreflang|rel|name|content|property|type|data-.+|aria-.+)$/;

/** Replaces the 8-char content hash of `_astro` assets with the `HASH` placeholder. */
export function normalize(text: string): string {
  // Scoped-style ids (`data-astro-cid-<hash>`) are content hashes of the same kind.
  return (
    text
      // Astro 7 names shared CSS chunks after their entry (BaseLayout, LandingPage) instead of
      // `_localized_`, so the chunk name is not comparable; page references are still counted and
      // the CSS content is gated by `compareCss` below. JS chunks keep their names.
      .replace(/_astro\/[^/"'\s]*?\.[A-Za-z0-9_-]{8}\.css/g, "_astro/CSS.HASH.css")
      .replace(HASH, "$1.HASH.$2")
      .replace(/data-astro-cid-[a-z0-9]+/g, "data-astro-cid-HASH")
  );
}

/** Lists files under `dir` as `/`-separated relative paths. */
function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, root) : [relative(root, full).split("\\").join("/")];
  });
}

/** Text a reader sees: comments, script and style removed, tags stripped, whitespace collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decodes the character references an attribute value can carry, so `&#34;` equals `&quot;`. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (named[name.toLowerCase()] ?? m),
  );
}

/** Parses the attributes of one opening tag into name/value pairs. */
function attrsOf(tag: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<[^\s>/]+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) out.push([m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")]);
  return out;
}

/** Sorted `name=value` list of every reference attribute in the page. */
export function referenceAttrs(html: string): string[] {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.slice(0, m.indexOf(">") + 1));
  const out: string[] = [];
  for (const tag of stripped.match(/<[a-zA-Z][^>]*>/g) ?? [])
  {
    const attrs = attrsOf(tag);
    if (/^<meta\b/i.test(tag) && attrs.some(([k, v]) => k === "name" && v === "generator")) continue;
    for (const [name, value] of attrs) if (REF_ATTRS.test(name)) out.push(`${name}=${value}`);
  }
  return out.sort();
}

/** Sorted set of `<link>`/`<meta>` elements (attributes sorted), generator meta excluded. */
export function headTags(html: string): string[] {
  const tags = (html.match(/<(?:link|meta)\b[^>]*>/gi) ?? [])
    .map((tag) => ({ name: tag.slice(1).split(/[\s>/]/)[0]!.toLowerCase(), attrs: attrsOf(tag) }))
    .filter((t) => !(t.name === "meta" && t.attrs.some(([k, v]) => k === "name" && v === "generator")))
    .map((t) => `${t.name} ${t.attrs.map(([k, v]) => `${k}=${v}`).sort().join(" ")}`);
  return [...new Set(tags)].sort();
}

/** Bodies of inline (src-less) scripts, hash-normalized. */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]!))
    .map((m) => normalize(m[2]!.trim()))
    .sort();
}

function diff(label: string, a: string[], b: string[], out: string[]): void {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(a);
  const cb = count(b);
  const lines: string[] = [];
  for (const [k, n] of ca) if ((cb.get(k) ?? 0) < n) lines.push(`  - ${k.slice(0, 200)}`);
  for (const [k, n] of cb) if ((ca.get(k) ?? 0) < n) lines.push(`  + ${k.slice(0, 200)}`);
  if (lines.length) out.push(`${label}\n${lines.slice(0, 20).join("\n")}`);
}

const CSS_SIZE_TOLERANCE = 0.01; // observed Astro 5 -> 7 minifier drift is ~0.2%

/** Selector list of a stylesheet (text before each `{`), scoped ids normalized. */
function selectors(css: string): string[] {
  return normalize(css)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("{")
    .slice(0, -1)
    .map((chunk) => chunk.split(/[};]/).pop()!.replace(/\s+/g, " ").trim())
    .filter((sel) => sel && !sel.startsWith("@")) // at-rule conditions are rewritten by the minifier
    .sort();
}

/** Declared property names; vendor prefixes are skipped: the minifier targets decide them (accepted v7 change: 2 `-webkit-backdrop-filter` dropped). */
function properties(css: string): string[] {
  return [...css.matchAll(/[{;]\s*(--[\w-]+|[a-z-]+)\s*:/g)]
    .map((m) => m[1]!)
    .filter((name) => !/^-(webkit|moz)-/.test(name))
    .sort();
}

/**
 * Chunk names differ between Astro 5 and 7, so stylesheets are paired by size order and compared by
 * selector multiset of style rules (strict) and total size (within tolerance, covers minifier output drift).
 */
function compareCss(before: string, after: string, failures: string[]): void {
  const load = (root: string) =>
    walk(root)
      .filter((f) => /^_astro\/.*\.css$/.test(f))
      .map((f) => readFileSync(join(root, f), "utf8"))
      .sort((x, y) => x.length - y.length);
  const a = load(before);
  const b = load(after);
  if (a.length !== b.length) return void failures.push(`stylesheet count differs: ${a.length} -> ${b.length}`);
  a.forEach((css, i) => {
    const other = b[i]!;
    if (Math.abs(css.length - other.length) / css.length > CSS_SIZE_TOLERANCE)
      failures.push(`stylesheet #${i} size differs beyond tolerance: ${css.length} -> ${other.length}`);
    diff(`stylesheet #${i} selectors differ`, selectors(css), selectors(other), failures);
    diff(`stylesheet #${i} properties differ`, properties(css), properties(other), failures);
  });
}

/** Compares two trees; returns gated failures and informational report lines. */
export function compareDist(before: string, after: string): { failures: string[]; report: string[] } {
  const failures: string[] = [];
  const report: string[] = [];
  const index = (root: string) => new Map(walk(root).map((f) => [normalize(f), f]));
  const a = index(before);
  const b = index(after);
  // Multiset of normalized paths: two chunks that normalize to one name must still be counted twice.
  diff("file list", walk(before).map(normalize), walk(after).map(normalize), failures);

  compareCss(before, after, failures);
  let scriptDiffs = 0;
  const assetSize = (root: string): Map<string, number> =>
    new Map(walk(root).filter((f) => /^_astro\/.*\.(css|js)$/.test(f)).map((f) => [f, statSync(join(root, f)).size]));
  const sizes = { before: 0, after: 0 };
  for (const [side, root] of [["before", before], ["after", after]] as const)
    for (const [f, n] of assetSize(root)) {
      sizes[side] += n;
      report.push(`_astro ${side} ${f}: ${n} bytes`);
    }
  for (const [norm, fromA] of a) {
    const fromB = b.get(norm);
    if (!fromB) continue;
    const pa = join(before, fromA);
    const pb = join(after, fromB);
    if (/\.(md|txt|xml)$/.test(norm)) {
      if (normalize(readFileSync(pa, "utf8")) !== normalize(readFileSync(pb, "utf8"))) failures.push(`bytes differ: ${norm}`);
    } else if (norm.endsWith(".html")) {
      const ha = normalize(readFileSync(pa, "utf8"));
      const hb = normalize(readFileSync(pb, "utf8"));
      if (visibleText(ha) !== visibleText(hb)) failures.push(`visible text differs: ${norm}`);
      diff(`reference attributes differ: ${norm}`, referenceAttrs(ha), referenceAttrs(hb), failures);
      diff(`head tags differ: ${norm}`, headTags(ha), headTags(hb), failures);
      if (inlineScripts(ha).join("\u0000") !== inlineScripts(hb).join("\u0000")) {
        scriptDiffs++;
        report.push(`inline scripts differ (not gated): ${norm}`);
      }
    }
  }
  report.push(`_astro CSS/JS total: ${sizes.before} -> ${sizes.after} bytes; pages with inline-script changes: ${scriptDiffs}`);
  return { failures, report };
}

if (import.meta.main) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) {
    console.error("usage: compare-dist.ts <before> <after>");
    process.exit(2);
  }
  const { failures, report } = compareDist(resolve(before), resolve(after));
  console.log(report.join("\n"));
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} gated difference(s)\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("\nOK: output parity holds");
}
