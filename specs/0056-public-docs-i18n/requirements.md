# Multilingual public documentation — Requirements

## Context

Publish the existing public website and fourteen primary guides in English (primary), Spanish and Simplified Chinese. The user approved English at the website root, Spanish at /es/, Chinese at /zh-cn/, static compatibility for old URLs, and a single PR to main. This scope localizes public content, not the CLI or AI doctrine.

## Requirements (EARS)

- **R1** — The primary documentation SHALL provide complete English, Spanish and Simplified Chinese editions of all fourteen in-scope guides, preserving technical meaning, commands and identifiers.
- **R2** — The website SHALL serve canonical English pages at the root, Spanish pages under /es/ and Simplified Chinese pages under /zh-cn/, respecting the configured site base.
- **R3** — The website SHALL provide complete localized UI, narrative, command and release content for all three locales without accepting missing translations through fallback.
- **R4** — WHEN a reader changes language, the website SHALL link to the equivalent current page with a meaningful supported fragment and native language labels.
- **R5** — Each canonical HTML page SHALL publish its own canonical, all three reciprocal hreflang alternatives, English x-default, correct HTML language and localized metadata; the sitemap SHALL contain canonical HTML routes only.
- **R6** — WHEN a reader opens an old /en/ route or /versiones, the website SHALL provide a static compatibility document with the correct canonical destination and visible link, preserving supported fragments without claiming HTTP redirects.
- **R7** — The website SHALL generate a concise llms.txt index for each locale using authoritative command, version, inventory and runtime data and actual resource URLs.
- **R8** — The website SHALL generate a Markdown alternative for every canonical page from the same content owners, including every walkthrough stop and deep-dive role detail, and advertise the page alternate and applicable index separately.
- **R9** — Social share cards SHALL provide intentional localized assets for all three languages with product facts derived from authoritative inventory and package data.
- **R10** — Each guide SHALL link reciprocally to its three language editions and resolve translated guide/code/spec links; the published CLI README SHALL link to translations using stable absolute URLs.
- **R11** — The change SHALL preserve documented direction/admission/delivery invariants and registered command inventory while leaving CLI runtime, generated doctrine and historical internal documents outside scope.
- **R12** — Language navigation SHALL remain usable as static anchor links with accessible names and readable CJK/long text at narrow and desktop widths.

- **R13** — The native producer/reviewer provenance reader SHALL admit verified header versions 0.162.1 and 0.163.0 while rejecting unknown versions, malformed identities, conflicting roles/parents, unrelated repositories and non-independent review.

## Primary-guide inventory

README.md; CONTRIBUTING.md; packages/cli/README.md; packages/cli/src/engines/README.md; apps/website/README.md; docs/DIRECTION.md; docs/EXTENDING.md; docs/architecture.md; docs/pi.md; docs/recipes/model-tiering.md; docs/recipes/setup-proveedores-externos.md; docs/recipes/skill-authoring.md; docs/references/skills-security-quality.md; docs/runbook-curacion-engram.md.

## Exclusions

Historical specs/research/audits/inspiration, generated native-overlap matrix and AI doctrine; CLI localization; new dependencies/CMS/MCP server; deployment, npm publication, registrations and search-ranking guarantees. Chinese is Simplified Chinese, zh-CN.
