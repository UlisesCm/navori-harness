# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-08-18 13:30 — claude — 6 issues cerrados + capa de solutioning (spec 0012)

- Cambios:
  - `packages/core/core-assets/` — skill `solution-design` (nueva), bloque
    `intake-tickets` (nuevo), `orquestacion` (señales R2-architectural, +117
    palabras), `ticket-intake` (fase 4 real + gate de veredicto), `spec-bootstrap`
    (dimensiones condicionales, anti-placeholder), `ticket-audit` (veredicto,
    problema vs solución propuesta, tamaño verificado), `implementer`/`reviewer`/
    `researcher` (eslabones de consumo), `cierre-sesion` (dominio).
  - `packages/core/core-assets/lib-skills/` — 27 skills con user-section, `cypress`,
    `drizzle-orm`, `react-navigation`, `i18next` nuevas, `socketio` partido en
    server/client, `jest` reescrita sin el leak de Medusa.
  - `packages/cli/` — `scanGitHygiene` + `scanWorkspaceDrift` (doctor), description
    de skills project-local en el índice, registros y conteos, 3 tests nuevos.
  - `packages/plugins/codegraph/` — inyección en `researcher` y `explorer`.
  - `specs/0012-solutioning/` — requirements (21 EARS), design, plan, tasks, evals.
- Quality gate: ✅ 1501 tests · lint · format · CI verde en los 4 PRs.
- Notas:
  - Los 4 evals corrieron sobre casos reales. E y F dieron resultados INVERTIDOS
    respecto a lo esperado y se registraron tal cual — en ambos el escenario estaba
    mal diseñado, no la capa. Los tres veredictos quedaron ejercitados igual.
  - Método adoptado (superpowers): el baseline RED se corre ANTES de escribir una
    skill. La skill ataca fallos observados, no imaginados.
  - Auditoría de cableado: 3 skills del core tenían CERO citas (`security-guidance`,
    `debug-error`, `dominio`) y el `reviewer` no leía el diseño acordado. Cerrado y
    protegido por `solutioning-wiring.test.ts`.
  - Deuda detectada al cerrar: `.claude/progress/` no estaba en `.gitignore` pese a
    estar en el CUBO_A de navori — 8 artefactos efímeros se habían colado al índice.
    Corregido a mano; queda pendiente evaluar activar `gitignoreHarness: "local"`
    en este repo para que la regla la gestione el render.
- Commit / PR: #328, #329, #330, #332, #339 (mergeados) · issues #331, #340 abiertos.
