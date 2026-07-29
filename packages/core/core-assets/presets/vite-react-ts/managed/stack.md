## Stack — Vite + React + TypeScript

SPA on Vite + React + TypeScript, UI-lib-agnostic (CSS Modules, Tailwind, styled-components, or a component lib). Feature-based organization: each feature lives in its own folder with its components, hooks and local state; shared things (UI primitives, utils, generic hooks) go in common folders. Components are functional with hooks; no new class components.

Golden rule: strict typing (no unjustified `any` — see the typing block); side-effects in `useEffect` with complete deps; data-fetching through whatever layer the repo uses (fetch/axios, TanStack Query if present — injected as a library-skill based on deps). Server state is NOT duplicated in global state; global state (Redux/Zustand/Context) is only for what's genuinely shared and client-side. Apply the `new-feature` skill to add a new feature with the repo's structure. The UI-lib, forms and state skills are injected based on the dependencies navori detects.

A ticket's work follows the navori infrastructure pipeline: `ticket-audit` → `explorer` (in parallel) → `implementer` (applies the stack skills) → `verify-before-done` → `reviewer` + `review-diff` → `commit-pr-pilot`. navori bootstraps `current.md` and `history.md`; the rest of the artifacts are created by the flow at runtime under `.claude/progress/`.
