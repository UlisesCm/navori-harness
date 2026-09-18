# Sesión actual

**Estado: idle.** El lote de 6 issues abiertos por la fase R de la spec 0026 (#867–#872) quedó
cerrado: 6 de 6 mergeados, sin issues ni PRs abiertos en el repo. Detalle completo en
`progress/history.md` (entrada del 2026-09-17).

## Qué entró a main

#867→#874 (flake de `gate-hook-kill`) · #868→#876 (4 áreas al barrido de ids retirados) ·
#869→#877 (alias de `mine-activation.py` derivados del registro) · #872→#878 (fallback del
receipt) · #871→#879 (anclas por símbolo en specs) · #870→#880 (piso medible de R54).

## Deuda conocida, sin issue abierto

Ninguna bloquea nada; se listan para que la próxima sesión decida si merecen ticket propio.

- **Presupuestos de doctrina casi agotados**: `CLAUDE.md` 2493/2500 (margen 7),
  `spec-bootstrap.md` 647/650 (margen 3), `sdd.md` margen 1, `code-discovery-routing.md` margen 9.
  Cualquier doctrina nueva exige podar antes. Los márgenes exactos salen de
  `node packages/cli/scripts/check-doc-budgets.mjs --list`.
- **Fixtures de #868 en el árbol fuente**: los tests de `retired-names` siembran violaciones en
  `packages/core/core-assets/<área>/explorer-retired-names-fixture/`. El `finally` limpia en fallo
  normal, pero un SIGKILL dejaría residuo commiteable que además pondría en rojo la corrida
  siguiente.
- **Carrera latente en el mismo test**: hoy todos los llamadores de `sweepRetiredNames` viven en un
  solo archivo y vitest los corre en serie. Un segundo llamador en otro archivo introduciría flake.
- **La nota de #872 en `CLAUDE.md` es un apaño temporal** atado a ese issue: se retira cuando se
  publique una versión de navori con el subcomando `receipt`. Hoy el global (0.8.7) no lo trae y
  hay que usar `node packages/cli/dist/index.js receipt ...`.
- **Flakes por carga concurrente**: con varios `pnpm check` a la vez aparecen timeouts que pasan
  56/56 en aislamiento (vistos en el ciclo de #871, ajenos a ese diff). Distinto del flake de #867,
  que sí se arregló. Candidato a issue si reaparece.
- **Cicatrices menores en la historia de main**: el commit de #880 quedó con "piso measurable"
  (spanglish) y con `Co-Authored-By: Claude Haiku 4.5`, que no corresponde al modelo de la sesión.
  No se reescribió historia por eso.

## Notas de operación para la próxima sesión

- **El registro de agentes queda fijado al checkout principal al arrancar.** Si el worktree trae un
  roster más nuevo (fase R: `orchestrator`/`scout`/`publisher`), sólo se pueden despachar los
  nombres viejos. `implementer`, `reviewer` y `auditor` existen en ambos rosters.
- **`main` se mueve rápido.** Al reapuntar la base de una rama, revisar si aparecen archivos
  modificados fuera del alcance del ticket: son reversiones del trabajo ajeno, no ruido.
- **Rama sin commits propios no necesita rebase**: `git reset origin/main` mueve el puntero sin
  tocar el árbol de trabajo. Evita el stash, que en worktrees comparte stack con otras sesiones.

## Próximo paso explícito

Ninguno asignado. El repo queda sin issues ni PRs abiertos.
