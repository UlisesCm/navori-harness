[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

# @navori/website

Navori's public landing page and documentation site. Built with Astro and Tailwind CSS v4, and published to GitHub Pages.

## Development

```bash
# from the monorepo root (Bun 1.4.4; repository requires Node.js >=24)
bun install
bun run --cwd apps/website dev
# open http://localhost:4321
```

## Build

```bash
bun run --cwd apps/website build
bun run --cwd apps/website preview
```

The build runs Astro and then `scripts/check-i18n.ts`. The checker verifies the generated pages, locale and fragment links, Markdown alternatives, localized indexes, command and narrative coverage, compatibility aliases, and sitemap inventory.

## Routes and localization

English is the canonical default at `/`. Spanish pages use `/es/`; Simplified Chinese pages use `/zh-cn/`. Astro's default locale is `en`, and the default locale prefix is disabled. `SITE_URL` sets the site origin and `SITE_BASE` sets its base path; both default to the root deployment values in `astro.config.mjs`.

For backward compatibility, the site also emits static `/en/…` pages that point to the canonical English routes and `/versiones`, which points to `/es/releases`. These are HTML compatibility pages with `noindex, follow`, a meta refresh, and a small script that preserves the URL fragment. They are not HTTP 301 redirects. The sitemap excludes these aliases as well as `.md` and `.txt` resources.

The current build emits **99 canonical HTML pages**, one sibling Markdown alternative for each page, and **3 localized `llms.txt` indexes**. The HTML route set covers the home page, quickstart, deep dive, releases, and the 29 CLI command pages in each of the three locales. It also emits 34 static compatibility pages: 33 `/en/…` aliases plus `/versiones`.

## Content and source files

The localized pages share Astro page components and content sources rather than maintaining separate page implementations. The landing-page narrative in `src/i18n/ui.ts` includes all eight walkthrough stops—Arrives, Context, Orchestrates, Locates, Works, Guards, Filters, and Closes. `src/content/narratives.ts` supplies the deep-dive copy for Orchestrator, Scout, Auditor, Architect, Implementer, Reviewer, Publisher, and Scribe. These sources are used by the HTML components and by the generated Markdown alternatives; the Markdown export also includes the hidden walkthrough states and the technical examples.

```text
apps/website/
├── astro.config.mjs              # locale routing, base path, and sitemap
├── scripts/
│   ├── check-i18n.ts             # build-time output and link checker
│   └── gen-og.mjs                # manual Open Graph SVG/PNG generation
├── src/
│   ├── components/pages/         # shared landing, quickstart, deep-dive, releases pages
│   ├── components/sections/      # reusable landing sections
│   ├── content/
│   │   ├── commands.ts           # localized command documentation
│   │   ├── guides.ts              # canonical guide inventory and locale URLs
│   │   ├── markdown.ts            # page alternatives and llms.txt indexes
│   │   ├── narratives.ts          # deep-dive narrative shared across outputs
│   │   └── pages.ts               # canonical routes, aliases, and fragments
│   ├── i18n/
│   │   ├── locales.ts             # supported locales and native names
│   │   └── ui.ts                  # localized UI and walkthrough copy
│   └── pages/
│       ├── [...localized].astro   # canonical /es/ and /zh-cn/ pages
│       ├── [...page].md.ts        # Markdown sibling for every canonical page
│       ├── [locale]/llms.txt.ts   # localized agent-discovery indexes
│       ├── index.astro            # canonical English landing page at /
│       ├── llms.txt.ts            # English root index
│       ├── robots.txt.ts          # crawl policy and sitemap reference
│       └── en/                    # static English compatibility aliases
└── public/
    ├── og*.svg and og*.png        # committed share-card sources and renders
    └── schema/                    # published JSON Schemas
```

The shared route inventory in `src/content/pages.ts` defines one canonical location per topic and locale. English is served without a locale prefix; the other two languages use their configured prefixes. When adding a page or command, update the owning content source and keep the localized page, Markdown alternative, language links, fragments, and sitemap valid. The build checker names missing or out-of-sync artifacts.

The monorepo uses Bun `1.4.4` and requires Node.js `>=24` (`package.json`) for site development and builds. The published CLI has its own runtime floor of Node.js `>=22.12` (`packages/cli/package.json`); that lower CLI requirement does not replace the monorepo's development requirement.

## `llms.txt` and crawler policy

The site generates an `llms.txt` index at the English root and under each non-default locale. Each index lists the localized site pages, command documentation, primary repository guides, current CLI version and Node requirement, and links to the HTML and Markdown resources. The Markdown files are alternatives rendered from the same Astro page components; they preserve the visible content and add narrative states that may be hidden in the interactive UI.

`llms.txt` is an optional agent-discovery aid. It does not replace the site, guarantee that an agent will use the content, or promise search indexing or ranking. The site does not provide an MCP server.

`robots.txt` keeps the existing default-allow policy (`User-agent: *` / `Allow: /`) and explicitly lists named AI crawlers with `Allow: /`. It also advertises the English `llms.txt` index and the sitemap. GitHub Pages project sites live below a repository path, while crawlers fetch `robots.txt` from the domain root; therefore this generated policy is authoritative only on a custom domain or a user-root Pages site.

## Open Graph cards

Run `node apps/website/scripts/gen-og.mjs` manually to regenerate the committed share cards. The script reads the published counts from `src/consts.ts` and the current version and Node requirement from `packages/cli/package.json`. For each locale it writes an SVG source next to the PNG render: `og.svg`/`og.png`, `og-en.svg`/`og-en.png`, and `og-zh-CN.svg`/`og-zh-CN.png`.

The generator resolves `sharp` from the repository's existing package-manager installation instead of declaring it as a separate website dependency. It is intentionally not part of the site build because these assets change infrequently. If `sharp` cannot be resolved, the script exits with an error rather than leaving stale PNGs in place.

## Deployment

The GitHub Action `.github/workflows/deploy-website.yml` builds and publishes to GitHub Pages on pushes to `main` that touch `apps/website/**`.

**Before the first deploy:** in the repository's `Settings → Pages`, set **Source: GitHub Actions**.

For a project site at `<user>.github.io/<repo>/`, define these repository variables:

- `SITE_URL` = `https://<user>.github.io`
- `SITE_BASE` = `/<repo>/`

For a `<user>.github.io` root site, leave the defaults.

## Design

- **Typography:** Instrument Serif for display, Geist Sans for body text, and Geist Mono for code.
- **Palette:** sky `#0EA5E9` and violet `#7C3AED` on warm ivory `#FAFAF7`; dark mode uses night blue `#0A0E1A`.
- **Patterns:** an asymmetrical split hero with a CSS-only animated terminal, a subtle background grid, and contained sky-to-violet radial glows.
