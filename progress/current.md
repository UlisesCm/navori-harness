# Sesión actual

**Estado:** idle. 6 issues abiertos, todos diferidos a propósito. Cero PRs abiertos.
`main` al día con los 8 PRs de la sesión.

## Qué se cerró (2026-08-20)

**11 issues, 8 PRs.** Todo lo que bloqueaba el release 0.6.0.

- **#363** (security, high) — el guard hacía match sobre el comando COMPLETO en dos de
  sus tres reglas: `cd /tmp && rm -rf ~/` pasaba, y `git commit -m x && git log -n 3`
  se bloqueaba como `--no-verify`. Ahora el split en segmentos es uno solo y lo
  comparten las tres reglas.
- **#364** (high) — bajo Codex las skills se emitían verbatim: los agents leían
  `.codex/progress/` y las skills escribían en `.claude/progress/`. `transform` en
  `PlacementRequest` + cinco reescrituras nuevas en el compat.
- **#365 + #367** — el backstop del receipt se RETIRA (opción c). Ver la nota abajo.
- **#366** — 8 de las 28 lib-skills afirmaban cosas de un workspace concreto.
- **#368 + #369** — dos chequeos nuevos de `doctor`: el gate declarado es ejecutable,
  y qué skills instaladas tienen su user-section sin llenar (aquí detecta 6).
- **#371** — 10 bullets de drift de documentación + 3 hallazgos extra; ninguno falso.
- **#372, #373, #374** — los tres defectos menores del CLI.

## Siguiente paso natural

**Release 0.6.0 + rollout** per-repo (NUNCA `--all`). Sigue vigente lo anotado la
sesión pasada sobre los dos bloques managed que cambiaron de hash y la migración
`socketio` → `socketio-client`, **más** lo de esta sesión:

1. **Falta el render de auto-hospedaje completo a 0.6.0.** Los PRs solo regeneraron
   los archivos cuyo contenido cambió, para no arrastrar el bump de marcador de otros
   ~29 (mismo criterio que #362). Un `render --apply` limpio en `main` es parte del
   release, no de un fix.
2. **Los assets managed cambiaron bastante** (guard, hook del gate, reviewer, pilot,
   8 lib-skills): los repos onboardeados verán drift gestionado en su próximo render.
3. **El guard es más estricto con el TEXTO del comando**: un mensaje de commit por
   heredoc que mencione un borrado recursivo de HOME se bloquea. La salida es
   `git commit -F <archivo>`. Vale la pena avisarlo en el rollout.

## Diferido por decisión (no son deuda olvidada)

`#370` y `#375`-`#379` — la tanda de optimización del harness (adelgazar el always-on,
prosa→mecanismo, fan-out en la fase 2 del intake, ceremonia proporcional al riesgo).
Van **después** del release: son un rediseño del contexto always-on que se propaga a
~15 repos, y mezclarlo con un release que ya arrastra un fix de seguridad hace el
drift imposible de auditar del lado del consumidor.

## Notas

- **#365 se resolvió por remoción, no por parche.** El backstop del receipt tenía 5
  caminos fail-open, generó 5 de los últimos ~25 issues, no hay una sola captura
  documentada de algo que atrapara, y su modo de fallo de #344 bloqueó el cierre de
  todos los PRs. El receipt sigue vivo como handoff reviewer→pilot; lo que se fue es
  la segunda copia de la verificación, en shell, en un hook que nunca se retargetea.
- **`.claude/worktrees/` acumula 4.2 GB** en ~14 worktrees de sesiones viejas, todos
  de branches ya mergeadas. `git worktree remove` es destructivo, así que queda para
  que Ulises lo confirme.
- Heredado: la ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue
  desactualizada, `~/.navori/registry.json` conserva una entrada de prueba, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559).
