# Sesión actual

**Estado:** rama `feat/audience-channel` con trabajo **a medias y sin PR** (commit `fa1f328`).
El resto de la jornada está mergeado en `main`. Release 0.7.0 pendiente.

## SIGUIENTE PASO

**Terminar `feat/audience-channel`**: migrar 5 tests que afirman sobre el `CLAUDE.md` un
contenido que ahora vive en `.claude/context/orquestacion.md`.

| Archivo | Fallos | Qué afirma hoy |
|---|---|---|
| `src/__tests__/cli.e2e.test.ts` | 2 | la lista de bloques de `doctor --json` (11 → 10) y "el primer bloque es `orquestacion`" |
| `src/engines/__tests__/empty-placeholder-render.test.ts` | 2 | que `{{project.criticalAreas}}` interpolado aparece en el `CLAUDE.md` |
| `src/commands/__tests__/render-monorepo.test.ts` | 1 | que el `CLAUDE.md` raíz contiene el bloque `orquestacion` |

Los tres apuntan al archivo nuevo en vez del `CLAUDE.md`. **El gate está rojo por esos 5** —
no es deuda oculta, es el estado declarado del commit.

Después: `pnpm test:golden`, gate completo, PR contra `main` (`Closes #573` solo cuando
también aterricen T5/T6/T8 de la spec; si no, `Refs #573`).

## Lo que YA funciona en esa rama (verificado en este repo)

- `audience: orchestrator` en `render-plan.ts` saca un bloque del `CLAUDE.md` y lo renderiza
  a `.claude/context/<id>.md` con marcador, hash, versión e interpolación.
- **`CLAUDE.md`: 381 → 309 líneas.** El objetivo documentado por Claude Code son 200.
- El hook de `SessionStart` lo emite: 19,070 bytes de `additionalContext`, igual en bash y
  zsh, con `NULL_GLOB`/`nullglob` (un dir vacío bajo zsh aborta el hook, #391).
- La migración de un repo ya renderizado sale gratis: el bloque se retira del `CLAUDE.md`
  por su marcador sin tocar la prosa del usuario.
- `blocks.exclude` alcanza el canal nuevo (dos specs lo cazaron: salía del `CLAUDE.md` pero
  se seguía escribiendo en `.claude/context/`).
- `.claude/context` cubierto por `ENGINE_OUTPUTS` (drift/doctor/prune) y por el scan de
  `asset-command-permissions`.

## Cerrado hoy

- **#563** keyword de cierre en inglés (#564) · **#561** specs de `readHarnessCatalog` + 2
  defectos silenciosos (#565) · **#559** ventana del recorder en la ficha del orquestador
  (#566) · **#560** el aviso de handoff se dice una vez (#567) · **#557** `.mcp.json` en el
  prune (#568) · **#556** los 11 comandos documentados, `UNDOCUMENTED_ON_PURPOSE` vacío
  (#569) · **#555** detección de harness ajeno, spec 0014 + implementación (#570, #571) ·
  **#574** la escalera de búsqueda vs auto mode (#576) · **#575** los roles alcanzan MCP
  (#577) · **#579** los seis modos de permiso (#580).
- **Spec 0015** (#578) mergeada: la orquestación fuera de la capa always-on.

## Abiertos

- **#573** — lotes de la spec 0015. Lo de arriba es su Lote 1+2 a medias.
- **#572** — el `CLAUDE.md` sobre el límite de 200 líneas. Con #573 baja a 309.
- **Release 0.7.0** — npm sigue en 0.6.5 con 22+ commits sin publicar. El usuario lo quiere
  DESPUÉS de cerrar todos los issues.

## Deuda / gotchas vigentes

- **El guard `~/.navori` (#404/#424) dio falso positivo toda la jornada**: otra sesión de
  Claude Code viva en `alertaciudadana_app` escribía su log de audit durante cada corrida
  del gate (creció de 19,815 a 78,953 bytes). El propio mensaje del guard nombra el caso.
  En CI siempre pasa.
- **Cuidado con la rama base.** Dos veces cometí encima de una rama de PR en vez de `main`
  (una llegó a pushear a la rama de #571, ya mergeada). Antes de commitear:
  `git branch --show-current`.
- `git commit --no-verify` lo bloquea el guard, y hace bien: si el gate rápido falla, se
  arregla la causa (fue un import sin usar), no se salta el hook.
- **Los inventarios escritos a mano no crecen solos.** Esta jornada rompieron tres veces:
  el conteo de assets de `render-engine`, la lista de archivos del test e2e de engram, y el
  `EXPECTED_PROMPTS` de permisos. Cuando un test liste archivos a mano, evalúa derivarlo.
