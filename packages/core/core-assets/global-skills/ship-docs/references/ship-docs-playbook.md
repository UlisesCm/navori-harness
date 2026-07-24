# Ship Docs Playbook

Section checklists for README.md + DEPLOYMENT.md. Every item is repo-derived — read the files, don't assume.

## README.md skeleton

1. **Title + one-liner** — what the app is and who it's for, one sentence.
2. **Architecture** — the shared "brain" (domain/data/token packages), what's platform-specific, why it's structured this way. One paragraph + a layout tree.
3. **Repo layout** — `apps/*`, `packages/*`, backend dir, with a one-line purpose each.
4. **Prerequisites** — exact versions/tools the repo needs (Node, package manager, Xcode/Android SDK if mobile, backend CLI, Docker if used). Read `engines`, lockfile, config.
5. **Local setup — ordered steps**: (a) start the backend/local stack, (b) copy `.env.example` → `.env` per app and where to get values, (c) install, (d) run each app (the real scripts), (e) first-run notes (seed, migrations, test login).
6. **Scripts** — a table of the actual root/workspace scripts and what each does.
7. **Testing** — how to run the real test targets; what they cover.
8. **Troubleshooting** — the repo's KNOWN gotchas (monorepo symlink/postinstall quirks, native-module version pins, cache-clear flags). Pull from the project's own notes.

## DEPLOYMENT.md skeleton (runbook)

1. **Overview** — the deploy targets (backend, web, mobile) and their order of dependency.
2. **Environment variables** — a table: `NAME | consumed by (app) | where the real value lives`. Split public (client) vs secret (server/build). Never inline values.
3. **Backend** (if present) — create the cloud project; link CLI; push migrations (real command); seed if applicable; auth/email templates & redirect URLs to replicate from local config; obtain prod URL + anon key; note service-role stays server-only.
4. **Web** (if present) — host, framework preset, build command + output dir (from the real build script), env vars to set in the host, SPA rewrite/routing config, custom domain, the public URLs the app must expose (e.g. privacy/support).
5. **Mobile** (if present) — bundle IDs; EAS setup (`eas build:configure`); EAS secrets for env; `eas build` per platform; `eas submit`; App Store Connect / Play listing needs (privacy URL, support URL — point at the web deploy); TestFlight/internal track for the pilot.
6. **Post-deploy checklist** — smoke each surface against prod; verify auth end-to-end; confirm the recovery/email flows work with prod templates; check the public URLs resolve.
7. **Rollback** — how to revert each surface (redeploy previous, migration-down caveats, store rollback limits).

## Rules of thumb

- If the repo has a local backend config (e.g. `config.toml`, email templates), the deploy doc must say "replicate this in the cloud project" and point at the exact file — otherwise prod silently diverges (e.g. OTP email showing a link instead of a code).
- Prefer linking a real `.env.example` over listing keys twice.
- Flag every place a human decision is required (choose host, buy domain, Apple account) as a **[you decide]** callout — don't pretend it's automatic.
- Keep commands copy-pasteable: one command per line, real flags, expected output noted.
