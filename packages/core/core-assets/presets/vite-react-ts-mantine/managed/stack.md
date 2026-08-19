## Stack — Vite + React + TS + Mantine

SPA with Vite. The UI is built with Mantine components and the theme tokens (spacing, colors, radius) — no hardcoded styles or ad-hoc CSS when the design system already solves it.

Golden rule: use Mantine's components and props before writing custom CSS; respect the theme. Apply the `mantine-ui-patterns` skill for UI and `new-feature` for the layer order of a new feature.

ES-module hygiene: one `import` statement per module specifier. Two imports of the same module (`no-duplicate-imports`) are a review finding, not a style preference — the lint rule belongs in the repo's own eslint config so the gate catches it before the review does.
