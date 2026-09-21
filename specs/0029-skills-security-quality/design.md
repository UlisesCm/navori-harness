# Skills de seguridad y calidad — Design

## Approach

Remediar primero las skills existentes in place, después añadir dos skills
delgadas y manuales: `secure-by-design` como router de seguridad y
`quality-attributes` como matriz de evidencia. Evaluar las skills oficiales de
OpenAI en un piloto reversible; no copiar checklists de OWASP/ISO ni instalar
plugins con hooks sin medir sus permisos y costo.

## Components

- `.agents/skills/*` — correcciones de API, gates, seguridad y provenance — R1, R2, R5, R6.
- `packages/core/core-assets/managed/skills/secure-by-design.md` — nueva core skill, añadida a `ROSTER_CORE_SKILLS` — R3, R5, R6.
- `packages/core/core-assets/managed/skills/quality-attributes.md` — nueva workflow skill, añadida a `ROSTER_WORKFLOW_SKILLS` — R4, R5, R6.
- `docs/references/skills-security-quality.md` — registro de URLs, revisiones, licencias/términos, uso permitido, propietario y fecha de revisión — R1, R7.
- `navori.config.json` — sólo registro de libraries/configuración; no es el registro de contenido normativo — R1, R7.
- `packages/cli/src/**/__tests__/` — pruebas de roster, render Claude/Codex, budgets, triggers, provenance y release markers — R1, R2, R6, R8.
- `README.md` release flow — contrato de bump, build, `render --apply`, gate y publicación — R8.
- `packages/cli/package.json` y assets generados — versión 0.9.0 — R8.

## Decisions

- **OWASP ASVS 5.0.0 + NIST SSDF 1.1 + SLSA** son referencias operativas; el registro de referencias conserva la URL, revisión y términos antes de distribuir cualquier paráfrasis. `security-invariants` mantiene las reglas de negocio.
- **ISO/IEC 25010:2023** sólo se referencia como modelo de atributos; la skill usa resúmenes propios y no reproduce texto o tablas licenciadas.
- La skill de seguridad no será un checklist global: se activa sólo ante señales de riesgo y exige evidencia concreta.
- Los comandos canónicos serán los scripts del quality gate (`bun run jscpd:check`, `bun run semgrep:check`) en lugar de variantes divergentes.
- El cambio Citty se alinea con la versión bloqueada; actualizar la dependencia queda fuera salvo que una tarea de implementación lo justifique con migración y pruebas.
- `secure-by-design` es core y se activa sólo ante señales de seguridad; `quality-attributes` es workflow y complementa `solution-design` sólo cuando éste identifica NFR/arquitectura. Ninguna skill crea un dispatcher ni reemplaza al dueño existente.
- El piloto de vendor skills queda documentacional/fixture-only por defecto: no modifica roster, config, hooks ni permisos; cualquier instalación requiere aprobación explícita, criterios de salida y rollback.

## Testing strategy

Cada requisito tendrá al menos una prueba `// Covers: R<n>` en los tests de assets/render, skill metadata, budgets, provenance o CLI. Los snippets de librería se validarán contra las versiones bloqueadas.

## NOT in scope

- Cambios funcionales de la CLI fuera de skills, gates o versionado requerido para 0.9.0.
- Instalación automática del plugin Anthropic `security-guidance`.
- Copia de contenido normativo protegido por copyright.
