# Skills de seguridad y calidad — Requirements

## Context

El harness necesita corregir drift entre sus skills y las versiones instaladas, y
agregar guidance de seguridad y calidad sin convertir estándares externos en
checklists propietarios ni aumentar el contexto residente innecesariamente.

## Requirements (EARS)

- **R1** — The system SHALL document, for this closed inventory — core (`verify-before-done`, `debug-failure`, `review-diff`, `security-invariants`, `locate-code`), workflow (`resolve-ticket`, `solution-design`, `spec-bootstrap`, `dominio`, `follow-up-prs`), and configured library (`zod-validation`, `vitest`, `citty`, `clack`) skills — the supported dependency/version, official source URL, trigger, and validation evidence.
- **R2** — WHEN a skill documents a third-party API or gate command, the guidance SHALL match the locked dependency and the repository's canonical quality-gate command, with a regression test for the mismatch that motivated the change.
- **R3** — WHEN a task changes authentication, authorization, trust boundaries, sensitive data, web/API inputs, secrets, cryptography, uploads, external integrations, or dependencies, `secure-by-design` SHALL route the work through applicable invariants, threat modeling, versioned controls, and evidence-producing tests.
- **R4** — WHEN a task has architecture or non-functional requirements, `quality-attributes` SHALL produce a matrix mapping each selected quality attribute to a measurable criterion, evidence source, test, and owner without reproducing copyrighted standard text.
- **R5** — The security and quality skills SHALL remain composable with `security-invariants`, `review-diff`, and `verify-before-done`, and SHALL NOT duplicate their responsibilities or override their gates.
- **R6** — The skills SHALL use progressive disclosure: concise trigger metadata and instructions, with detailed references loaded only when the triggered workflow needs them; bundled content SHALL remain within the repository's documented budgets.
- **R7** — WHEN an official vendor skill or external standard is evaluated for adoption, the repository SHALL record its canonical URL, immutable version/revision, license/terms, permitted use, permissions/tool access, privacy implications, owner, and a reversible pilot result before enabling it by default.
- **R8** — WHEN this scope is released as version 0.9.0, the process SHALL bump `packages/cli/package.json`, build the CLI, run `node packages/cli/dist/index.js render --apply`, verify the non-normalized managed markers and indexes, and pass the full quality gate before the release commit.
