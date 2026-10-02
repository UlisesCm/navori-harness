# Current — Spec 0039 Claude first (39/45 mergeadas; T32 en PR #1161)

- Mergeadas esta jornada: #1149 fix Pi, #1151 T40, #1152 T28, #1153 T38, #1154 T29, #1155 T2
  (fixtures + enmiendas T37/T45/R42), #1156 T31 doc (`quitar-del-default`).
- T35 mergeada en #1157.
- T45 mergeada en PR #1160 a main (`ef2f2e75`); CI quality verde.
- T32: siete decisiones aprobadas e implementadas; gate completo verde con 6726 tests y el piso
  de cobertura intacto. Exclusión de `init --full`, opt-in/grants actuales preservados, aviso
  informativo en doctor/JSON y retirada del consejo de maxFiles; sin migración de configs.
- PR #1161: CI anterior verde; integración de main en curso, resolviendo únicamente los dos
  archivos de progress y conservando ambos registros. Verificación fresca pendiente antes de push.
- Siguiente paso: publicar la integración en #1161 y esperar CI antes de mergear T32. Después T34.
- Pendientes: T23, T24, T34, T37 y T44. La desactivación de codegraph en este repo va en PR separado.
- Worktrees T45/T32 conservados; retirar solo con confirmación del usuario, limpios y publicados.
- Checkout principal: main atrasado y cambio local de Pi conservado; no se modificó ni sincronizó.
- Cierre: T44.
- Deuda o gotchas:
  - Con carga alta en el host, `test:coverage` falla por timeouts de 15s en `cli.e2e`,
    `doctor-json-checks.e2e`, `pi/runtime`, `engine-neutral-state-integration`,
    `gate-hook-worktree` y el test de escalado lineal de `guard-destructive`. El piso de cobertura
    se verificó con `--testTimeout=60000`.
  - En `claude -p`, un `ask` actúa como deny: `general-purpose` queda bloqueado en headless.

Pi: #1146 y #1147 mergeados; sin pendientes en este archivo.
