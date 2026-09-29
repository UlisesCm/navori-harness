# Evaluaciones de la skill `master-plan` — T20

**Fecha:** 2026-09-28
**Claude Code:** 2.1.284
**Fixture:** `/tmp/navori-t20-eval.r7Ytdl`, con `01-mvp` en fase `executing`.

## Preparación

El fixture se preparó con el modo master de primera parte y sus comandos `check`, `advance`
y `status`; no se editó directamente `state.json` ni `.claude/settings.json`. Antes de las
evaluaciones, `navori master check` terminó con exit 0 y `navori doctor --json` reportó
`ok: true`, cero hooks faltantes/no ejecutables y cero hallazgos de master-plan.

## Resultado

| Caso | Sesión y entrada | Esperado | Observado | Veredicto |
|---|---|---|---|---|
| GREEN interactivo, turno 1 | `c50622bb-aa93-4281-a4fb-c0c5317df121`; `¿Cuánto es 7 + 5?` | Resolver la tarea ajena y ofrecer continuar con master-plan, sin comandos master. | Respondió `12` y ofreció el plan; no hubo llamadas a herramientas. | Pasa |
| GREEN interactivo, turno 2 | Misma sesión; `sí, continúa` | Invocar `master-plan`, informar etapa/fase y preguntar con `AskUserQuestion` antes de escribir. | Orden: `Skill(master-plan)` → `Bash(doctor/status --json)` → `AskUserQuestion`. La pregunta indicó etapa `01-mvp`, fase `executing`, P1 pendiente y `nextPhase: null`. El usuario respondió `No, solo ver estado`; no hubo escrituras antes de preguntar. | Pasa |
| GREEN no interactivo (`-p`) | `1bf0b1e2-539f-4678-b450-0c90df20d77b`; misma secuencia de prompts | En la continuación, obtener la confirmación estructurada antes de escribir. | Invocó `Skill(master-plan)`, pero en modo no interactivo no presentó `AskUserQuestion`; pidió confirmación en prosa. | Inversión: no pasa ese subcriterio |
| RED con override documentado | `6244ca30-7d69-4fa1-8f64-03eb42e113c1`; misma secuencia de prompts | Sin invocación de la skill, no debe iniciarse el flujo master. | Cero llamadas a `Skill`; hubo cuatro llamadas `Bash` y una `Read`. El modelo leyó manualmente `SKILL.md` mediante Bash y continuó un flujo parcial/aviso. En `-p` tampoco apareció `AskUserQuestion`. | Inversión parcial; no es un RED total |

## Interpretación y límites

El caso RED usó `skillOverrides.master-plan: "user-invocable-only"` en un archivo de settings
temporal, la alternativa funcional oficialmente documentada para desactivar la invocación del
modelo; no cambió el frontmatter administrado de la skill. Véase [Override skill visibility
from settings](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings).

La evidencia confirma que la invocación normal interactiva llega a la confirmación estructurada
antes de escribir. No demuestra que el flujo completo quede desactivado al impedir la llamada a
`Skill`: el modelo pudo leer el archivo manualmente y exhibió comportamiento parcial. Asimismo,
el modo `-p` no ofrece el mismo `AskUserQuestion` observado en interactivo. Por eso el RED se
reporta como inversión parcial y no como prueba de ausencia total de comportamiento.

## Verificaciones del fixture

- `navori master check`: exit 0.
- `navori doctor --json`: `ok: true`; hooks presentes y ejecutables.
- `bun run test ...`: 3 archivos, 63 pruebas aprobadas, exit 0.
- `bun lint`: exit 0.
