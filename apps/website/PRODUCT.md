# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The home must work for visitors with little or no technical knowledge who want to understand what the harness does. Deep dive serves developers evaluating its mechanisms and differences, and documentation serves users looking up configuration and commands.

## Product Purpose

Show what the navori harness contributes through a plain-language demonstration: a generic prompt in a narrow terminal column and an explanatory animated scene beside it. Highlight workspace context and plugins such as tgrep and CodeGraph. Installation and documentation remain available as next steps.

## Operating Context

The product is a CLI that renders harness assets into a repository. The website is an Astro static site, served under a configurable base path, with English, Spanish and Simplified Chinese editions.

## Capabilities and Constraints

Preserve the current routes, semantic section fragments, locale navigation, dark mode, install commands, and documentation. Capabilities and inventory come from the repository; do not invent customers, benchmarks, runtime guarantees or integrations. Engine support has documented differences; showing an adapter does not promise identical enforcement.

## Brand Commitments

Keep the navori name and recognizable sky/violet palette. The user likes the original grid texture and hero terminal, and requested their restoration, with a more visible texture throughout the site. Preserve the identity and improve spacing. The new symbol belongs only in browser and touch icons; navigation and footer use the plain name. The explanatory robot stays, with different objects and meaningful animation introduced in each step rather than a static overview.

## Evidence on Hand

`src/consts.ts` provides the checked product inventory. `src/content/commands.ts` documents CLI commands. `src/components/sections/Flow.astro` and `HarnessGraph.astro` demonstrate composition and workflow. `src/content/releases.ts` contains release history.

## Product Principles

- Demonstrate capabilities before asking visitors to install.
- Show configuration and generated files as concrete product evidence.
- Preserve readable content and working actions without motion.
- Keep the three locale editions equivalent.
