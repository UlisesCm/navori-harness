# Multilingual public documentation — Design

## Decision

Option A is approved: English is canonical at the website root, Spanish uses `/es/`, and Simplified Chinese uses `/zh-cn/`. Existing English `/en/` URLs and the legacy `/versiones` path have static compatibility pages with canonical destinations and visible links. These pages do not promise HTTP 301 responses. The scope is the existing public website and its published guides; CLI behavior, generated doctrine, historical research, and broader product localization remain out of scope.

English is the primary guide edition. Each of the 14 public guide families keeps its existing English path and has co-located `.es.md` and `.zh-CN.md` editions. The three editions link to one another in native names and the order English, Español, 简体中文. Guide links, section fragments, executable examples, flags, identifiers, and technical guarantees must stay valid and equivalent across editions.

## Architecture

Astro's existing static site owns route generation and page layouts. `apps/website/src/i18n/locales.ts` defines locale identity, route prefix, and native label; `apps/website/src/content/pages.ts` owns canonical page identity and locale content. Shared page components under `apps/website/src/components/pages/` render the localized HTML pages. `apps/website/src/content/markdown.ts` derives agent-readable Markdown from those same rendered page and narrative sources, and `apps/website/src/pages/[...page].md.ts` serves the static Markdown siblings. The exporter resolves each rendered link against its canonical page URL and emits absolute canonical URLs that include the configured origin and base path while preserving query strings, fragments, and non-HTTP protocols. It retains executable examples and their technical text. Locale-specific `llms.txt` endpoints link to the generated resources and reciprocally to all three locale indexes; each index includes localized site and command pages, primary repository guides, repository and npm links, the current project schema URL, CLI version and Node requirement, and inventory facts from the current configuration. These files provide optional agent discovery and make no indexing, ranking, or adoption guarantee.

All interactive narrative states that a reader can reach are included in the Markdown exports, rather than exporting only the initial state. Page descriptions and social cards use locale-specific factual content from the shared page data. `apps/website/scripts/gen-og.mjs` generates the card assets using the existing SVG and Sharp toolchain. The generated cards must agree with the visible text and metadata for each locale.

Compatibility routes are static pages, so their behavior is an HTML refresh and visible canonical link rather than a server redirect status. Routes and generated links honor the configured site base. The build-time checker in `apps/website/scripts/check-i18n.ts` verifies generated routes, metadata, aliases, Markdown, indexes, and cards.

## Alternatives and trade-offs

### Option A — English root with language prefixes (chosen)

This directly serves English from the project entry point and extends Astro's default-locale routing. Spanish and Chinese remain one explicit language selection away. The trade-off is that old unprefixed Spanish URLs now resolve to English; Spanish equivalents live under `/es/`. Existing `/en/` URLs need compatibility pages for the corresponding root routes.

### Option B — prefix every locale

Routes under `/en/`, `/es/`, and `/zh-cn/` make locale ownership symmetric and preserve old English deep-link paths. The root then needs a separate English entry policy, while old unprefixed Spanish pages need compatibility destinations. This adds routing and canonical complexity without improving the requested English-first entry point, so it was not selected.

### CMS or translation pipeline

A CMS, hosted translation service, new framework, or MCP server would add dependencies and a second content owner. The existing static catalogs, Astro routes, and Markdown sources cover the required publication surfaces, so this alternative was rejected.

## Compatibility and validation

The old `/en/` route family maps to its English root counterpart, including command documentation. `/versiones` maps to `/es/releases`. These static pages expose a canonical target and visible link; no deployed HTTP status or crawler behavior is asserted. The site does not force locale selection from browser preferences.

Validation is split by what can be proven locally. Focused tests check locale completeness, route and alias contracts, metadata, agent-readable content, absolute base-aware Markdown links (including query, fragment, and protocol handling), preserved technical examples, guide parity, link integrity, and English direction invariants. Website builds and `check-i18n.ts` inspect generated output both at the site root and under a configured project base, including reciprocal locale indexes and current repository/npm/schema references. Browser review covers language selection, keyboard use, supported fragments, and narrow layouts. Build output cannot prove deployed redirects, crawler access, indexing, ranking, or adoption; translation fluency still needs editorial review.

The native provenance correction admits exactly the explicitly verified CLI versions `0.162.1` and `0.163.0`. `NativeActorSchema` and `HeaderSchema.cli_version` share the same two-version allowlist. The embedded review-binding reader in the generated Codex role-guard hook is byte-identical to its source fragment, and both apply the same allowlist and reader predicate. The implementation and tests cover all four reviewer/producer version pairs, including a second scribe owner behind a valid implementer, and reject unknown `0.164.0` in either owner position. Existing malformed-version, identity, parent, role, path, checkout, ownership, and same-thread review-independence denials remain in force. This does not introduce wildcard versions, caller-supplied identity, or environment-based bypasses.
