/**
 * Generates the Open Graph share images into `public/`.
 *
 * The site shipped `twitter:card = summary_large_image` with no image behind
 * it, so every share on Slack, LinkedIn or X rendered a large empty card —
 * worse than declaring no card at all.
 *
 * Run by hand, not at build time, and the PNGs are committed:
 *
 *   node apps/website/scripts/gen-og.mjs
 *
 * That keeps `sharp` out of the website's dependency graph for an asset that
 * changes maybe twice a year. sharp is already present in the pnpm store (Astro
 * pulls it for its image pipeline, and `pnpm-workspace.yaml` allows its build),
 * so this resolves it from there instead of declaring a dependency of its own.
 * If that resolution ever fails, the script says so and exits non-zero rather
 * than silently leaving the old PNGs in place.
 *
 * Type is drawn with generic families on purpose: the renderer uses system
 * fontconfig and will not see the @fontsource files, so asking for "Instrument
 * Serif" yields an unpredictable fallback. The brand carries in the palette and
 * the composition; the wordmark uses a serif italic, which is what the site's
 * display face is.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE = resolve(__dirname, "..");
const REPO_ROOT = resolve(WEBSITE, "..", "..");
const OUT_DIR = resolve(WEBSITE, "public");

const WIDTH = 1200;
const HEIGHT = 630;

/** Brand tokens, mirrored from `src/styles/global.css`. */
const C = {
  ivory: "#fafaf7",
  ivory2: "#f4f3ec",
  ink: "#0f172a",
  night: "#0a0f1f",
  sky: "#0ea5e9",
  skyDeep: "#0369a1",
  violet: "#7c3aed",
  violetLight: "#a78bfa",
  border: "#e6e4d8",
  slate: "#64748b",
};

/** Resolve sharp out of the pnpm store without declaring a dependency. */
function loadSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require("sharp");
  } catch {
    // Not hoisted — reach into the store directly.
    const matches = globSync("node_modules/.pnpm/sharp@*/node_modules/sharp/package.json", {
      cwd: REPO_ROOT,
    });
    if (matches.length === 0) {
      throw new Error(
        "sharp not found. Run `pnpm install` at the repo root, or install it temporarily:\n" +
          "  pnpm add -w -D sharp && node apps/website/scripts/gen-og.mjs && pnpm remove -w sharp",
      );
    }
    const pkgPath = resolve(REPO_ROOT, matches.sort().at(-1));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const entry = resolve(dirname(pkgPath), pkg.main ?? "lib/index.js");
    return require(entry);
  }
}

/** Escape the few characters that would break out of an SVG text node. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param {{ taglineA: string, taglineB: string, stats: string[] }} copy
 * @returns {string} the SVG source for one share image
 */
function buildSvg({ taglineA, taglineB, stats }) {
  const terminalLines = [
    { text: "$ navori init --recommended", fill: "#e2e8f0" },
    { text: "✓ engines: claude · codex", fill: "#7dd3fc" },
    { text: "✓ plugins: engram · codegraph", fill: "#7dd3fc" },
    { text: "→ rendering managed assets", fill: C.violetLight },
    { text: "✓ Done — 34 created", fill: "#6ee7b7" },
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="word" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0%" stop-color="${C.skyDeep}"/>
      <stop offset="60%" stop-color="${C.violet}"/>
      <stop offset="100%" stop-color="${C.violetLight}"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.12" cy="0.1" r="0.6">
      <stop offset="0%" stop-color="${C.sky}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${C.sky}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.88" cy="0.3" r="0.55">
      <stop offset="0%" stop-color="${C.violet}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${C.violet}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse">
      <path d="M 56 0 L 0 0 0 56" fill="none" stroke="${C.ink}" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="${C.ivory}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowA)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowB)"/>

  <!-- left column: wordmark + tagline + stats -->
  <g transform="translate(76, 0)">
    <g transform="translate(0, 132)">
      <circle cx="9" cy="-9" r="5" fill="${C.sky}"/>
      <text x="26" y="-3" font-family="ui-monospace, monospace" font-size="18"
            letter-spacing="3.4" fill="${C.slate}">OPEN SOURCE · 5 ENGINES</text>
    </g>

    <text x="0" y="268" font-family="Georgia, 'Times New Roman', serif" font-style="italic"
          font-size="132" fill="url(#word)">navori</text>

    <g font-family="Helvetica, Arial, sans-serif" font-size="31" font-weight="500" fill="${C.ink}">
      <text x="4" y="332">${esc(taglineA)}</text>
      <text x="4" y="374">${esc(taglineB)}</text>
    </g>

    <rect x="4" y="416" width="118" height="3" rx="1.5" fill="url(#word)"/>
  </g>

  <!-- right column: a terminal, the site's recurring motif -->
  <g transform="translate(716, 148)">
    <rect x="0" y="0" width="430" height="258" rx="16" fill="${C.night}"/>
    <rect x="0" y="0" width="430" height="42" rx="16" fill="#ffffff" fill-opacity="0.03"/>
    <rect x="0" y="26" width="430" height="16" fill="${C.night}"/>
    <line x1="0" y1="42" x2="430" y2="42" stroke="#ffffff" stroke-opacity="0.07"/>
    <circle cx="26" cy="21" r="6" fill="#ef4444" fill-opacity="0.7"/>
    <circle cx="48" cy="21" r="6" fill="#f59e0b" fill-opacity="0.7"/>
    <circle cx="70" cy="21" r="6" fill="#10b981" fill-opacity="0.7"/>
    <g font-family="ui-monospace, monospace" font-size="17">
      ${terminalLines
        .map((l, i) => `<text x="26" y="${86 + i * 34}" fill="${l.fill}">${esc(l.text)}</text>`)
        .join("\n      ")}
    </g>
  </g>

  <!-- stats: full width, below the terminal so nothing overlaps -->
  <g transform="translate(80, 502)" font-family="ui-monospace, monospace" font-size="21"
     fill="${C.slate}">
    ${stats
      .map((s, i) => {
        const x = i * 186;
        const sep =
          i < stats.length - 1
            ? `<circle cx="${x + 154}" cy="-6" r="2.5" fill="${C.violetLight}"/>`
            : "";
        return `<text x="${x}" y="0">${esc(s)}</text>${sep}`;
      })
      .join("\n    ")}
  </g>

  <!-- footer rule + domain -->
  <line x1="76" y1="566" x2="${WIDTH - 76}" y2="566" stroke="${C.border}"/>
  <text x="76" y="600" font-family="ui-monospace, monospace" font-size="18" fill="${C.slate}">
    github.com/UlisesCm/navori-harness
  </text>
  <text x="${WIDTH - 76}" y="600" text-anchor="end" font-family="ui-monospace, monospace"
        font-size="18" fill="${C.slate}">MIT · Node ≥ 20</text>
</svg>`;
}

const VARIANTS = [
  {
    file: "og.png",
    svgFile: "og.svg",
    taglineA: "El harness multi-agente",
    taglineB: "para cualquier repo.",
    stats: ["21 comandos", "12 presets", "7 plugins", "5 engines"],
  },
  {
    file: "og-en.png",
    svgFile: "og-en.svg",
    taglineA: "The multi-agent harness",
    taglineB: "for any repo.",
    stats: ["21 commands", "12 presets", "7 plugins", "5 engines"],
  },
];

const sharp = loadSharp();
await mkdir(OUT_DIR, { recursive: true });

for (const v of VARIANTS) {
  const svg = buildSvg(v);
  // The SVG source ships next to the PNG so the image can be re-rendered, or
  // inspected, without re-running this script.
  await writeFile(resolve(OUT_DIR, v.svgFile), svg, "utf8");
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(resolve(OUT_DIR, v.file), png);
  console.log(`✓ public/${v.file}  ${(png.length / 1024).toFixed(1)} KB`);
}
