# Current — Spec 0039 Claude first (39/45 con T35)

- Mergeadas esta jornada: #1149 fix Pi, #1151 T40, #1152 T28, #1153 T38, #1154 T29, #1155 T2
  (fixtures + enmiendas T37/T45/R42), #1156 T31 doc (`quitar-del-default`).
- Abierto: el PR de T35 (`general-purpose-confirm`, sin `if` por nombre).
- Siguiente paso: T32 (codegraph fuera del default). Diseño y challenge en
  `.navori/state/handoffs/{solution,challenge}_spec0039_t32.md`, con 7 preguntas al usuario.
  Propuesta: opción A + enmendar R34, no tocar el scout, mantener los `enabled:true` existentes con
  aviso en doctor, lista fija en `recommended.ts`, quitar "pass maxFiles", apagar codegraph en este
  repo en un PR aparte. Después T34.
- Desbloqueadas por T2: T23, T24, T37 y T45. T45 corrige `parse.ts:287` `hitTurnLimit`, que busca
  formas inexistentes.
- Cierre: T44.
- Deuda o gotchas:
  - Con carga alta en el host, `test:coverage` falla por timeouts de 15s en `cli.e2e`,
    `doctor-json-checks.e2e`, `pi/runtime`, `engine-neutral-state-integration`,
    `gate-hook-worktree` y el test de escalado lineal de `guard-destructive`. El piso de cobertura
    se verificó con `--testTimeout=60000`.
  - En `claude -p`, un `ask` actúa como deny: `general-purpose` queda bloqueado en headless.

Pi: #1146 y #1147 mergeados; sin pendientes en este archivo.
