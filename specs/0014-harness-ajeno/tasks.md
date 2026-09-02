# Harness ajeno que choca con navori — Tasks

Tres lotes. El primero deja el diagnóstico completo y no escribe nada; el segundo da la
salida para silenciar; el tercero es el único que toca archivos del usuario y por eso va
al final, cuando lo que reporta ya está probado.

## Lote 1 — detección y aviso (read-only)

- [ ] **T1** (R1, R2, R5, R10, R17) — `lib/foreign-harness.ts`: `scanForeignHarness(cwd,
  config, opts)` que compara el inventario managed de navori contra el repo sin marcador,
  `~/.claude` y los plugins que no son el de navori; resuelve la precedencia por tipo de
  asset según la tabla del design; y devuelve un conflicto por colisión con su id estable
  `<tipo>:<scope>:<nombre>`. `opts.homeDir` para inyectar el scope personal en tests.
  · test: `src/lib/__tests__/foreign-harness.test.ts` con `// Covers: R1, R2, R5, R10, R17`
  — una fila por tipo de asset (agente repo vs personal, skill personal vs repo, skill de
  plugin que NO colisiona), el fixture del caso real (`~/.claude/skills/x.md` plano contra
  `.claude/skills/x/SKILL.md`), y la aserción anti-ruido: repo navori sano → cero
  conflictos.

- [ ] **T2** (R3, R6) — Al mismo scan: contradicción de permisos (una regla que
  `.claude/settings.json` declara `deny` y `settings.local.json` o `~/.claude/settings.json`
  declara `allow`), y la marca `gitignored` sobre el asset ajeno del repo que gana.
  · test: mismo archivo, `// Covers: R3, R6` — regla contradicha nombrando el archivo
  ajeno; asset ajeno ignorado por git marcado como tal; y un `deny` que nadie contradice
  que no produce hallazgo.

- [ ] **T3** (R4, R7, R16) — `commands/doctor.ts`: sección advisory que por cada conflicto
  nombra ganador y perdedor con sus rutas, y la acción que lo cierra (adoptar si el archivo
  vive en el repo, asumir si vive fuera). Cadenas en `lib/i18n.ts`, es y en.
  · test: `src/commands/__tests__/doctor-foreign-harness.test.ts` con `// Covers: R4, R7,
  R16` — el aviso nombra al ganador correcto en las dos direcciones de precedencia, ofrece
  adoptar solo para el archivo del repo, y un repo sin conflictos no imprime la sección.

## Lote 2 — silenciar sin borrar

- [ ] **T4** (R8) — `lib/schema.ts`: `project.foreignHarness.acknowledged: string[]` con
  default `[]`; el scan filtra los conflictos cuyo id esté en la lista.
  · test: `src/lib/__tests__/foreign-harness.test.ts` con `// Covers: R8` — el conflicto
  del fixture desaparece al declararlo, y un id que no corresponde a nada no filtra a otro.

- [ ] **T5** (R9) — Entradas obsoletas: el scan devuelve las que ya no corresponden a
  ningún conflicto, y `doctor` las nombra para que la lista solo pueda encoger.
  · test: mismo archivo, `// Covers: R9` — un `acknowledged` cuyo conflicto se resolvió
  sale reportado como obsoleto, con su id.

## Lote 3 — adopción (área crítica: escribe sobre archivos hechos a mano)

- [ ] **T6** (R11, R12, R14) — El comando de adopción: preview por default, `--apply` para
  escribir, y el contenido existente envuelto en un bloque managed **byte a byte**. Rechaza
  —sin escribir nada y nombrando la causa— un archivo que ya carga marcador, uno escrito
  por una navori más nueva, y cualquier ruta fuera del repo.
  · test: `src/commands/__tests__/adopt.test.ts` con `// Covers: R11, R12, R14` — bytes
  originales intactos dentro del bloque; preview no toca el disco; los tres rechazos, cada
  uno con su causa y con el archivo sin modificar.

- [ ] **T7** (R13, R15) — Backup antes de la primera escritura, con su ruta en la salida; y
  idempotencia: la segunda adopción del mismo archivo no reporta cambios.
  · test: mismo archivo, `// Covers: R13, R15` — el backup existe y contiene el contenido
  previo (aserción sobre los bytes, no sobre que la función fue llamada), y la segunda
  corrida deja el archivo idéntico.

## Trazabilidad

| R | Tareas |
|---|--------|
| R1, R2, R5, R10, R17 | T1 |
| R3, R6 | T2 |
| R4, R7, R16 | T3 |
| R8 | T4 |
| R9 | T5 |
| R11, R12, R14 | T6 |
| R13, R15 | T7 |
