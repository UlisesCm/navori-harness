# Checkpoint — #1046 / Spec0036

- Worktree: `/Users/ulisescm/.codex/worktrees/issue-1019-concurrent-coverage/navori-harness`
- Branch: `codex/1046-engine-neutral-state`
- Estado: T1–T5 y T8 revisados y aprobados. T6–T7 esperan el merge de #1071; después inspeccionar
  el helper/parser real antes de implementar. T9 y el PR propio a `main` siguen pendientes.
- PR draft: [#1074](https://github.com/UlisesCm/navori-harness/pull/1074), abierto contra `main`.
  Commits: `24a96619`, `7f19026b`, `ce5398ce`. No incluye `Closes #1046` mientras T6–T9 sigan
  pendientes; CI está en progreso.
- Documentación T8: commit `adf65d01`.
- Siguiente paso: esperar que #1071 se integre; reanudar T6–T7 en este worktree, completar T9,
  correr revisión y gate final con receipt fresco, actualizar el PR draft y solo entonces marcar
  `Closes #1046`.
- Evidencia previa de T8: reviewer APPROVED (291 archivos, 5340 tests), pero el receipt actual tiene
  drift del checkbox T8; no se considera gate fresco hasta revalidarlo.

## Otros pendientes

- #985: faltan tres ciclos reales por agente; también destraba #993 y #1022.
- #947: bloqueado hasta cerrar su ventana, alrededor de 2026-09-30.
- #1064/#1065: Spec 0034, a cargo de otra sesión.
- Sin issue: worktree eliminado con handoff solo `markdownRequests`; desfase de `bun.lock`
  (0.9.0 → 0.10.1); decidir check mecánico del cuerpo del PR (opción 3 de #1028).

## Gotchas operativos

- Sincronizar `main` antes de firmar receipt/review; ambas etapas rechazan ramas atrasadas.
- En worktree, `receipt check` para #1046 requiere `--dir .codex/progress` desde el propio worktree.
- Prosa managed: buscar literales fijados por tests con `git grep` y mantener ≥5% de holgura.
- Cambios a listas managed deben probar upgrade desde la versión publicada; regenerar espejos con
  `bun run render:apply` ante conflictos en marcadores managed.
- Commits y PRs sin atribución de IA.
