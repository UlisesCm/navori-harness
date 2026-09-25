---
name: tailwind-v4
description: Use when touching Tailwind CSS classes, editing @theme tokens, tailwind.config.js, or a build's CSS entry, or debugging a sizing utility (w-*, max-w-*) that resolves to the wrong value. Applies to repos already on Tailwind. Not for Uniwind (Tailwind bindings for React Native — its own skill) and not for a component library's own props.
metadata:
  type: reference
---

# Tailwind CSS — check the major first

Check the `tailwindcss` major in `package.json` before doing anything else: **v4 is CSS-first** (below). On **v3**, stop here and follow v3 conventions instead — `tailwind.config.js` as the source of truth, `content` globs, `theme.extend`; this skill's specifics don't apply.

Written for Tailwind 4.3 on v4.

## v4 is CSS-first

- The CSS entry imports Tailwind itself: `@import "tailwindcss";` — no `tailwind.config.js` by default.
- `@theme { --color-x: ...; }` defines design tokens as real CSS custom properties, consumed both by Tailwind's generated utilities and directly via `var(--color-x)`.
- `@custom-variant dark (&:is(.dark *));` (or equivalent) defines the `dark:` variant instead of a config's `darkMode` key.
- `@layer` groups rules into Tailwind's cascade layers (`base`, `components`, `utilities`, plus custom ones like `theme`) so specificity stays predictable.
- `@source` explicitly adds a path Tailwind should scan for classes when auto-detection misses it (e.g. a workspace package outside the app's own tree).
- `@utility` defines a custom utility class that participates in variants (`hover:`, `dark:`, ...) the same way built-in utilities do — prefer it over a hand-written `@layer utilities` rule.

## Semantic tokens, light + dark

Define semantic tokens (`background`, `foreground`, `primary`, `border`, ...) as CSS variables with a light default and a dark override, then map them into `@theme` so utilities like `bg-background` exist:

```css
@layer theme {
  :root {
    --background: oklch(0.985 0 0);
    &:where(.dark, .dark *) {
      --background: oklch(0.145 0 0);
    }
  }
}
@theme inline {
  --color-background: var(--background);
}
```

Never a raw palette class (`bg-blue-500`) or a hex/rgb/oklch literal in app code for anything themed — always the semantic token.

## Gotchas that bite

- **Sizing utilities resolve against `--spacing-*` before `--container-*`.** Tailwind 4 looks up `w-*`, `min-w-*`, and `max-w-*` (and friends) in `--spacing-*` first, falling back to the built-in `--container-*` t-shirt scale (`xs`, `sm`, `md`, `lg`, ...) only if no spacing token matches. A custom `--spacing-sm`/`-md`/`-lg` token silently shadows the matching `--container-*` entry — `max-w-sm` or `w-lg` then resolves to the wrong value everywhere, with no error. Keep custom spacing scales under a distinct prefix (e.g. `--spacing-space-*`) instead of reusing container t-shirt names.
- **No `content` config in v4** — Tailwind auto-detects source files via the CSS import graph and common ignores; use `@source` only when a path is genuinely missed (a workspace package, a generated folder).
- **`@theme inline`** re-exposes a `:root`-scoped variable as a Tailwind theme value; use it for the semantic-token pattern above so `bg-background` picks up the light/dark swap without duplicating the palette.

## Before declaring done

Copy and check off:

- [ ] Confirmed the `tailwindcss` major before applying any of the above.
- [ ] Every themed color goes through a semantic token, defined for both light and dark.
- [ ] No custom `--spacing-*` name collides with a built-in `--container-*` t-shirt size.
- [ ] The screen was checked in light and dark.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's tokens (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where the semantic token set is defined and which apps consume it.
     - The custom spacing prefix in use, if any.
     - Any @source paths added and why.
-->
