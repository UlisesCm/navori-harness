---
name: ship-docs
description: "Trigger: README, deployment guide, deploy docs, ship docs, runbook, how to deploy, documentar despliegue, handoff docs. Generate repo-grounded README.md + DEPLOYMENT.md for a built app."
license: Apache-2.0
metadata:
  author: "ricardomarin"
  version: "1.0"
---

## Activation Contract

Activate when a built app needs handoff/ship documentation — a README and a deployment runbook — or the user asks for deploy docs. This is the FINAL documentation layer (app-builder's closing phase). Do NOT activate for inline code comments, API reference generation, or a design doc for unbuilt work.

## Hard Rules

- Ground EVERYTHING in the real repo. Before writing a line, read: root + workspace `package.json` (name, scripts, deps → real stack), the monorepo layout, `app.json`/`app.config`, migrations dir, `.env.example` / env usage, CI config. Never emit generic boilerplate or invented commands.
- Every command in the docs MUST exist (a real npm script, a real CLI the repo uses). Verify; if a step needs a tool the repo lacks, say so explicitly, don't fabricate.
- Two documents, never merged: README (clone → run locally) and DEPLOYMENT.md (ship → production runbook). Mixing buries both.
- Secrets never appear in docs or git. Reference env vars by name; point to `.env.example`; call out where real secrets live (host dashboard, EAS secrets).
- Write for a teammate who just cloned and knows nothing. Apply cognitive-doc-design: scannable headers, one concept per section, copy-pasteable ordered steps, prerequisites before actions.
- DEPLOYMENT.md is a RUNBOOK: ordered, numbered, each step's command + expected result + how to verify. Include rollback and a post-deploy checklist.

## Decision Gates

| Repo shape | Deploy sections to include |
|---|---|
| Backend (Supabase/DB/API) present | Backend deploy: create project, apply migrations, seed, email/template + auth config, env vars |
| Web app present | Web deploy: host (Vercel/Netlify/…), build command, env vars, custom domain |
| Mobile (Expo/RN) present | Mobile: EAS build/submit, store (App Store Connect / Play), TestFlight, required public URLs |
| Only one of the above | Include only that section; do not template absent stacks |

## Execution Steps

1. Read `references/ship-docs-playbook.md` for the section checklists.
2. Harvest repo facts (scripts, layout, stack, migrations, app config, env keys). Derive, don't assume.
3. Write `README.md`: one-line what + why; architecture (shared packages / the "brain"); repo layout; prerequisites (versions); local setup as ordered steps (backend up, env, install, run each app); scripts table; testing; troubleshooting for the repo's known gotchas.
4. Write `DEPLOYMENT.md`: env-var reference table (name · where used · where the real value lives); then a numbered runbook per present stack (gate table above); post-deploy checklist; rollback.
5. Ensure `.env.example` lists every env key the code reads (add missing keys). Never commit real `.env`.
6. Verify: every referenced script/command exists; links resolve; no secret literals.

## Output Contract

Return: files created (README.md, DEPLOYMENT.md, .env.example changes); which stacks were detected and documented; any command/tool the repo lacks that a deploy step needs (flagged, not faked); repo style guide vs inline fallback used.

## References

- `references/ship-docs-playbook.md` — per-stack section checklists (backend / web / mobile), env-table shape, runbook and rollback patterns.
