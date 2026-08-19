# Sesión actual

**Estado:** idle. Cero issues abiertos, cero PRs abiertos. `main` al día.

## Qué se cerró

**14 issues** y **12 PRs mergeados** entre el 2026-08-18 y el 19.

- **Los 8 con los que abrió la sesión** (#331, #333-#338, #340). Ninguno procedía tal como
  estaba escrito: uno pasó limpio, cinco se reformularon y de dos hubo que cortar la parte
  principal —#333 (navori no escribe `package.json`; el plugin que lo hacía se removió en
  #130) y #336 (un `.semgrep.yml` habría sido inerte)—, cerrados con la evidencia.
- **Los 6 defectos del harness que aparecieron al usarlo**: #344 (`path` es variable especial
  de zsh → `DRIFT` falso irresoluble), #348 (131 GB de backups), #352 y #354 (el backstop
  ciego bajo Codex y el receipt que eclipsaba a otro), #341 y #342 (la contradicción de la
  Regla A y el receipt no inspeccionable), #345 y #350.
- **Créditos públicos** a los 11 proyectos de referencia: `docs/inspiration.md` restaurado y
  verificado, sección nueva en el README, y bloque en la landing (es/en).

Detalle por sesión en `history.md`.

## Siguiente paso natural

**Release + rollout** a los repos registrados, **per-repo (NUNCA `--all`)**. Arrastra todo lo
anterior desde 0.5.1. Tres cosas que conviene tener presentes al hacerlo:

1. **Dos bloques managed cambiaron de hash** → los repos onboardeados verán drift gestionado
   en su próximo `render`/`sync`. Es esperado, no una regresión:
   - `orquestacion` en `CLAUDE.md`: `64bcd6d1` → `d755829c` (la Regla A reescrita, +28 palabras).
   - `gitignore-harness` en `.gitignore`: `755bdad2` → `f831335d` (una línea añadida,
     `.codex/progress/`; verificado que no es reordenamiento). Solo afecta a repos con
     `gitignoreHarness` ≠ `"off"`.
2. **`doctor` empezará a reportar `.codex/progress/`** (`EPHEMERAL_AGENT_PATHS` es alias de la
   misma constante): warning nuevo en repos con Codex y `gitignoreHarness: "local"` hasta que
   re-rendericen.
3. **Heredado**: los repos con `socket.io-client` necesitan `navori update` además de `render`
   para migrar `socketio` → `socketio-client`.

## Follow-ups anotados (ninguno abierto como issue)

- `apps/website/src/content/commands.ts:62,267` omite `codegraph` de los plugins instalables —
  el mismo error de inventario que se corrigió en el README, en otro archivo.
- `engines/claude/adapter.ts:31` tiene un `backupTargets` muerto con `.claude` y sin
  `backupExclude`: copia viva de la forma que arregló #348, esperando a que alguien la reviva.
- `summarizeTrigger` corta la `description` en el primer `" — "`, por eso `dominio` aparece
  truncada como *"Use when you discover"* en el índice always-on de cada sesión.
- `statusCheckRollup` es una unión de tipos: `StatusContext` (Vercel, CircleCI, Jenkins) trae
  `targetUrl` y no tiene run id, así que el paso 3 de `babysit-prs` asume GitHub Actions.
- `subagent-stop-handoff.sh:35` y cuatro skills del core asumen rutas de Claude bajo Codex
  (misma causa que #352: `placeHook` no retargetea).

## Notas

- **Disco recuperado**: `~/.navori/backups` pasó de 131 GB / 6873 backups a 32 MB / 310, todos
  posteriores al fix de #348 y ninguno con `worktrees/`. El más pesado, de 15 GB a 368 KB.
  `registry.json` y `workspaces/` quedaron intactos.
- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue desactualizada: dice
  `/Users/ulisescm/Documents/dev/bonum/`, la real es `/Users/ulisescm/Documents/Dev - Docs/bonum/`.
- `~/.navori/registry.json` conserva una entrada de prueba apuntando a
  `.../scratchpad/inherit-test`.
- **Heredado de sesiones previas** (repo externo bonum-webapp): publicar el comentario del
  PR #639, cerrar #640 y #559, y el rebind de SonarCloud (requiere admin).
