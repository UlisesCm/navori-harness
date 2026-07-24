## Stack — Vite + React + TypeScript

SPA sobre Vite + React + TypeScript, agnóstica de UI lib (CSS Modules, Tailwind, styled-components, o una lib de componentes). Organización por feature: cada feature vive en su carpeta con sus componentes, hooks y estado local; lo compartido (UI primitives, utils, hooks genéricos) va a carpetas comunes. Los componentes son funcionales con hooks; nada de class components nuevos.

Regla de oro: tipado estricto (sin `any` injustificado — ver el bloque de tipado); side-effects en `useEffect` con deps completas; data-fetching por la capa que use el repo (fetch/axios, TanStack Query si está — se inyecta como library-skill según deps). El estado del servidor NO se duplica en estado global; el estado global (Redux/Zustand/Context) es solo para lo genuinamente compartido y de cliente. Aplica la skill `new-feature` para dar de alta una feature nueva con la estructura del repo. Las skills de UI lib, forms y state se inyectan según las dependencias que detecte navori.

El trabajo de un ticket sigue el pipeline de la infraestructura de navori: `ticket-audit` → `explorer` (en paralelo) → `implementer` (aplica las skills de stack) → `verify-before-done` → `reviewer` + `review-diff` → `commit-pr-pilot`. navori bootstrapea `current.md` e `history.md`; el resto de artefactos los crea el flujo en runtime bajo `.claude/progress/`.
