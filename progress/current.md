# Current — Spec 0039 Claude first (38/45 mergeadas; T45 validada y T32 en revisión)

- Mergeadas esta jornada: #1149 fix Pi, #1151 T40, #1152 T28, #1153 T38, #1154 T29, #1155 T2
  (fixtures + enmiendas T37/T45/R42), #1156 T31 doc (`quitar-del-default`).
- T35 mergeada en #1157; al retomar no había PRs abiertos.
- T45: parser corregido y gate validado con timeout de 60 s autorizado por el usuario, sin
  alterar tests ni umbrales. Siguiente paso: cerrar revisión y publicar a main.
- T32: siete decisiones aprobadas; exclusión de `init --full`, opt-in/grants actuales preservados,
  aviso informativo en doctor, lista explícita y retirada del consejo de maxFiles. Código y docs
  implementados, 107 tests dirigidos verdes; gate completo en curso. Después T34.
- Pendientes: T23, T24, T34, T37 y T44. La desactivación de codegraph en este repo va en PR separado.
- Worktrees en uso: `../navori-harness-t45` y `../navori-harness-t32`; no borrarlos mientras se revisan.
- Checkout principal: main atrasado y cambio local de Pi conservado; no se modificó ni se estacionó.
- Cierre: T44.
- Deuda o gotchas:
  - Con carga alta en el host, `test:coverage` falla por timeouts de 15s en `cli.e2e`,
    `doctor-json-checks.e2e`, `pi/runtime`, `engine-neutral-state-integration`,
    `gate-hook-worktree` y el test de escalado lineal de `guard-destructive`. El piso de cobertura
    se verificó con `--testTimeout=60000`.
  - En `claude -p`, un `ask` actúa como deny: `general-purpose` queda bloqueado en headless.

Pi: #1146 y #1147 mergeados; sin pendientes en este archivo.
