# Suite rápida: tests herméticos, hooks y CLI más baratos, menos tokens — Requirements

> **Enmienda de alcance (2026-10-19):** esta continuación es documental y conserva la
> implementación existente; no declara la spec completa. El inventario R3, la aceptación final
> R29/T39 y M5/R12 diferido continúan en [#1354](https://github.com/UlisesCm/navori-harness/issues/1354);
> la CI preliminar fallida, en [#1353](https://github.com/UlisesCm/navori-harness/issues/1353), y el
> diagnóstico Pi inconcluso, en [#1355](https://github.com/UlisesCm/navori-harness/issues/1355).
> La aceptación funcional de CI, el full actual, la revisión independiente y un receipt válido siguen
> siendo requisitos de publicación. Los requisitos y resultados fechados abajo son historia, no
> evidencia de cierre actual.
> El full del 2026-10-19 falló (164 fallidas, 9 567 aprobadas, 2 omitidas; 465 archivos; 32 707.7 s).
> Hubo un salto temporal entre inicio y resultado; la causa de los fallos no está determinada
> (`.navori/state/gate/full-20261019T044833225Z.log`).

**Estado:** borrador · **Fecha:** 2026-10-16 · **Base:** `dev` (incluye 0054). El PR de esta spec
apunta a `dev`.

## Contexto

0054 abarató el ciclo (caché del gate, evidencia, hooks), pero la suite no bajó: 380 s de pared en
reposo en la base y en la rama, y R4 (≤ 50 %) se enmendó a "no regresa". Esta spec ataca las causas
que 0054 dejó fuera, medidas el 2026-10-16 con reconocimientos de solo lectura y mediciones locales
(macOS arm64, bash 3.2.57, zsh 5.9, Node 24, git 2.54):

- **La suite está dominada por procesos, no por CPU.** 447 archivos, 9 268 casos y ~6 000 procesos
  por corrida. Hooks bash/zsh ~22 % de la suma por archivo, fixtures git ~19 %, CLI `dist/index.js`
  ~11 %. Subir `maxWorkers` de 4 a 8 regresó bajo carga.
- **La auditoría encarece cada hook.** Con una raíz de auditoría presente, `guard-destructive` cuesta
  36 ms; sin ella, 10 ms (medido con `bench:hooks`). La suite ya aísla `HOME` por archivo (#954, guard
  en `vitest.setup.ts`), así que en la suite el aislamiento aporta robustez, no tiempo; el ahorro de
  tiempo viene de R8.
- **El costo de un hook está dentro del hook, no en el arranque del shell.** `bash -c :` cuesta
  ~2 ms y `zsh -c :` ~8 ms. `navori_audit_now` lanza `perl -MTime::HiRes` dos veces por hook (~24 ms)
  aunque no haya log activo, porque el bash 3.2 de macOS no tiene `EPOCHREALTIME`. Los hooks forkean
  `jq` 2–5 veces por payload (~5 ms cada uno). Por eso `hook-batch` de 0054 no ahorró: quita el
  arranque del shell, no los forks del cuerpo.
- **El CLI arranca caro.** `node -e 0` cuesta 28 ms; `navori` en frío 114–128 ms (bundle de 1.57 MB).
  `session-start-context` llama al CLI 3 veces (~470 ms por sesión); `plan-gate` una (~160 ms).
- **Mucho costo por caso, poco test sin valor.** La auditoría de los 10 archivos más lentos (1 106 s)
  estima ~780 s tras bajar e2e a in-process, agrupar spawns y fusionar tablas equivalentes. La
  matriz bash×zsh pesa hasta 21 % (cota); las aserciones de redacción 5 %; las esperas fijas ~24 s.
- **Mediciones ruidosas.** Bajo carga, el mismo archivo varía 20–30 % y los presupuestos de 0054
  quedaron fijados con esa carga (41 excepciones; `slice` 360 s, ×2 en CI).

Descartado con evidencia: reescribir en Rust/napi, migrar a `bun test`, shells alternativos (dash,
Bun Shell, mvdan/sh, just-bash), bats, `es-git` y runners más grandes.

Decisiones del usuario (2026-10-16):
- **bash×zsh:** zsh solo en los casos donde el shell cambia el resultado; el resto corre en bash.
- **Timestamp de auditoría:** se calcula solo cuando hay un log de auditoría activo; el formato y la
  precisión de milisegundos no cambian.
- **CI:** la suite completa con cobertura corre en los pushes a `dev` y `main`; los PRs hacia ellas
  corren los tests afectados respecto a su rama base.
- **Tokens:** la spec incluye ahorro de tokens en lo que los agentes leen de tests, gates y hooks.
- Una sola entrega: un PR contra `dev` con commits atómicos por milestone.

## Requirements (EARS)

### A — Medición

- **R1** — The system SHALL registrar, por archivo de test, el número de procesos hijo lanzados, y
  `bench:tests` SHALL incluirlo junto a la duración en `.navori/state/bench/`.
- **R2** — The system SHALL registrar con cada corrida de `bench:tests` la carga del sistema al inicio
  y al final, y SHALL marcar la corrida como no comparable cuando la carga media de 1 minuto al
  inicio supere el número de workers (la carga final la infla la propia suite).
- **R3** — The system SHALL ofrecer `bun run bench:hooks` que reporte, por hook gestionado, la mediana
  de duración y el número de procesos hijo por invocación con un payload representativo.
- **R4** — The system SHALL ofrecer una medición del tamaño en bytes de lo que un agente recibe en
  el arranque de sesión, en cada inyección de contexto de hooks y en la salida de `navori gate` y
  `test:affected`.

### B — Tests herméticos

- **R5** — WHEN un test lanza un proceso hijo mediante los helpers compartidos, the system SHALL
  pasarle un `HOME` temporal propio del archivo y `NAVORI_AUDITS_ROOT` apuntando a una ruta que no
  existe, salvo que el test declare explícitamente otra.
- **R6** — WHEN un test ejecuta git, the system SHALL aislarlo de la configuración del usuario y del
  sistema (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`) y de la plantilla de `git init` del usuario.
- **R7** — IF un archivo de test referencia el `HOME` real del usuario (`userInfo().homedir`, rutas
  literales bajo `/Users/` o `/home/`) fuera de una allowlist con motivo, THEN una verificación
  estática SHALL fallar nombrando el archivo. (El guard de `HOME` de #954 se conserva; un chequeo en
  runtime no es práctico porque el repo, `PATH` y las herramientas viven bajo el `HOME` real.)

### C — Hooks más baratos (también en sesiones reales)

- **R8** — WHILE no hay un log de auditoría activo para la sesión, the system SHALL NOT invocar el
  cálculo de timestamp de auditoría ni lanzar procesos para él dentro de un hook.
- **R9** — WHILE hay un log de auditoría activo, the system SHALL escribir los eventos con el mismo
  formato y la misma precisión de milisegundos que antes de esta spec. Única excepción: un evento de
  un hook que corre mientras nace el log se escribe con `ms: 0` (no hubo inicio medido).
- **R10** — The system SHALL extraer todos los campos que un hook necesita del payload con a lo más
  una invocación de `jq` por hook (la escritura de auditoría activa no cuenta).
- **R11** — WHEN el CLI instalado soporta el contexto de sesión y no hay arm de auditoría ni resume
  de Codex pendientes, the system SHALL resolver el contexto de arranque con a lo más una invocación
  del CLI `navori` por evento `SessionStart`.
> **R12 (diferido fuera de E1 por decisión explícita del usuario):** WHEN `bash-outcome-watch` procesa
> un fallo, the system SHALL NOT lanzar Node para parsear el payload. Condicionado: el reemplazo entra
> solo si iguala al 100 % la tabla oráculo de la implementación actual; si no, R12 sale de esta entrega
> a una spec aparte. El oráculo no se ejecutó: no hay resultado de aprobado ni de fallido. E1 conserva
> el carril Node actual; cualquier reevaluación pertenece a una entrega futura.
- **R13** — The system SHALL mantener los veredictos (allow/ask/deny y sus mensajes) de cada hook
  idénticos a los de `dev` para el corpus de casos existente.

### D — Arranque del CLI

- **R14** — WHEN se invoca un subcomando del CLI, the system SHALL cargar solo el código de ese
  subcomando y sus dependencias, no el de los demás subcomandos, de modo que el arranque en frío de
  `navori tools session-context` y `navori plan gate` (mediana de 10, en reposo) baje al menos 20 % y
  20 ms frente a la base sin empeorar `--version`. Condicionado: si el probe de M0 mide menos de 20 ms
  de ahorro, R14 sale de esta entrega.
- **R15** — The system SHALL mantener la salida, los códigos de salida y los flags de cada
  subcomando idénticos a los de `dev`.

### E — Suite más barata y con más valor

- **R16** — The system SHALL reproducir bajo zsh el corpus completo de veredictos de hooks (R13) y
  los casos de la suite marcados como dependientes del shell, con motivo; el resto de los casos SHALL
  ejecutarse solo bajo bash.
- **R17** — WHEN un caso e2e verifica lógica que no depende del binario empaquetado (parseo de flags,
  despacho, `--json`, errores de config), the system SHALL ejecutarlo en proceso y no lanzando
  `dist/index.js`.
- **R18** — WHEN varios casos de hook dependen solo del payload, the system SHALL ejecutarlos en un
  solo proceso de shell por archivo.
- **R19** — WHEN un archivo de test necesita un repo git de fixture, the system SHALL construirlo una
  vez por archivo y copiarlo por caso, en lugar de `git init` y commit por caso.
- **R20** — The system SHALL NOT usar esperas de tiempo fijo en los tests; WHEN un test espera un
  evento, the system SHALL sondear una señal observable con un plazo máximo.
- **R21** — WHEN se elimina o fusiona un caso de test, the system SHALL declararlo en
  `removedCases` con su motivo y SHALL conservar sus tokens `// Covers:` en el caso que lo absorbe.
- **R22** — The system SHALL NOT afirmar redacción de prosa (docs, skills, bloques gestionados) en
  los tests; SHALL afirmar solo marcadores, tokens contractuales y presupuestos.

### F — CI

- **R23** — WHEN se hace push a `dev` o `main`, CI SHALL correr la suite completa con el piso de
  cobertura y el presupuesto de tiempo por archivo.
- **R24** — WHEN un PR apunta a `dev` o `main`, CI SHALL correr los tests afectados respecto a la rama
  base del PR, no la suite completa. Excepción: WHEN el PR toca un módulo hub medido o apunta a
  `main`, CI SHALL correr la suite completa con la misma matriz de shards que en push.
- **R25** — WHEN CI corre la suite completa, the system SHALL repartirla en shards paralelos y SHALL
  combinar sus reportes antes de evaluar cobertura y presupuesto.

**Checkpoint histórico de implementación M10 (R23–R25), anterior a la adopción nativa Codex:** T35–T37
y pruebas focalizadas estaban implementadas; A10 local había pasado 23 pruebas en 3 archivos. El
registro de ese checkpoint decía que M6 seguía rojo y que el host no ofrecía captura Bash. Esas
limitaciones de captura fueron superadas después; este texto no representa el estado actual ni cierra
la aceptación. Para el estado actual de publicación, véase la enmienda de alcance al inicio.

### G — Tokens

- **R26** — WHEN los tests o el gate terminan en verde, the system SHALL imprimir a lo más una línea
  de totales por paso.
- **R27** — WHEN un test falla, the system SHALL imprimir el nombre del caso, la aserción y el error,
  con la salida acotada por caso.
- **R28** — WHEN un hook no tiene nada que señalar, the system SHALL NOT inyectar contexto adicional
  al agente.

### H — Resultado

- **R29** — The system SHALL registrar en `design.md` la línea base y el resultado final medidos en
  reposo: pared local y suma por archivo de la suite, pared del paso de tests en CI, costo por hook,
  costo de arranque del CLI y bytes de contexto (R4).
- **R30** — The system SHALL fijar el presupuesto de tiempo por archivo con mediciones en reposo y
  SHALL reducir las excepciones a las que esas mediciones justifiquen.
