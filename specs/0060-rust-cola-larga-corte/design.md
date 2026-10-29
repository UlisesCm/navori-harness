# Migración a Rust, fase 4: cola larga, activaciones, distribución y corte — Design

**Estado:** borrador; Q20, Q21 y Q25 resueltas por el usuario, Q22–Q24 abiertas (§ "Preguntas") ·
**Fecha:** 2026-10-28 · **Base verificada:** `migration/rust` = `b0b64ddd` (merge de #1442). Toda
afirmación "ya existe" o "falta" se leyó en ese commit; las referencias citan archivo y símbolo.

**Alcance del documento:** fase 4 del programa (`specs/0057-migracion-rust/requirements.md` § "Fases
del programa"). Reutiliza sin cambios D1–D17 de 0057, D18–D27 de 0058 y D28–D39 de 0059; las
decisiones nuevas siguen la numeración (D40 en adelante), igual que los modos de falla (F39 en
adelante) y las preguntas (Q20 en adelante). Corresponde a E8–E10 del plan de entregas de 0057 más
las activaciones que las fases 1–3 movieron aquí.

## Estado de partida

- **Manifiesto:** `crates/ported.json` declara `--version` y `--help` como comandos y dos hooks en
  `shadow` (`guard-destructive`, `subagent-no-background`).
- **Al cerrar 0058 y 0059** quedarán nativos `render`, `sync`, `remove` y `adopt` (todos los engines,
  sin monorepo), `gate probe`, `plan gate`, `tools session-context`, `tools notice` y
  `dominio inject`, y siete hooks en `shadow`: los dos anteriores más `quality-gate-pre-commit`,
  `plan-gate`, `session-start-context`, `subagent-stop-handoff` y `model-advisor`.
- **Cola larga (este documento):** 15 de los 22 hooks de `core-assets/hooks` y el resto de los 29
  subcomandos de `cli.ts`, unas 50–60k LOC de TS de producción. Las áreas más grandes son
  `lib/audit` (~20.8k), `lib/master` (~6.4k), `lib/diagnose` con `commands/doctor.ts` (~10.9k) y
  `lib/codex` (~5.3k).
- **Herramientas que faltan:** `scripts/js/hook-shadow-report.mjs` (0058 T3 la difirió aquí),
  `scripts/js/cutover-check.mjs` y `check:post-cutover`.
- **Red:** `lib/primitives/update-notice.ts` fija la URL del registro de npm (`REGISTRY`) y
  `tool-version-notice.ts` construye la suya; ninguna se puede redirigir desde el entorno. Los
  procesos externos que se invocan son sobre todo `git`, y en menor medida `gh`, `codex`, `tgrep`,
  `codegraph`, `pi`, `npm` y `which`.

## Approach

**Vertical slices (Q21).** La cola larga se reparte por área funcional, no por capa. Cada entrega
porta, para su área: los hooks, los subcomandos de `navori` que esos hooks invocan, los comandos de
usuario del área y su `lib`. Al integrarse, el área funciona en Rust de punta a punta (comandos
nativos y hooks en `shadow`) aunque las otras dos sigan en TS (R77, R78).

La asignación sale de lo que cada hook ejecuta. `audit-mode-trigger` y `audit-mode-close` llaman a
`navori audit` por los parciales `audit-arm` y `audit-log`; `master-plan-context` y
`master-accept-confirm` llaman a `navori master status|part|close`. Los demás hooks solo nombran
`navori render` en sus mensajes y van al área de su propósito:

| Entrega | Área | Hooks | Comandos |
|---|---|---|---|
| E1 | Orquestación y gobierno de agentes | `comment-draft-confirm`, `pr-publisher-confirm`, `master-plan-context`, `master-accept-confirm`, `implementer-no-markdown`, `role-guard`, `general-purpose-confirm`, `engram-write-guard` | `spec`, `master`, `handoff`, `plan` (resto), `dominio` (resto) |
| E2 | Auditoría, gate y telemetría de sesión | `audit-mode-trigger`, `audit-mode-close`, `bash-outcome-watch`, `routing-watch`, `stop-verify-reminder` | `audit` (resto), `receipt`, `gate` (resto: `fast`, `full`, `foreign`), `bench`, `tools` (resto) |
| E3 | Instalación, mantenimiento y salud del repo | `managed-drift-watch`, `worktree-reclaim` | `init`, `add`, `configure`, `update`, `refresh`, `scan`, `doctor`, `status`, `workspace`, `registry`, `ticket`, `backup`, `migrations`, `preset`, `codex` |

**Slices de referencia (Q25).** Cada milestone de E1–E3 es un slice con un entregable observable
(«al cerrar Mx, esto corre en Rust»). Los dos primeros fijan el patrón que repiten los demás:

- **M1, referencia de hooks:** `general-purpose-confirm`. Es un hook con compuerta (`ask` en
  Claude, `deny` en Codex), registrado en dos engines, que no invoca `navori` ni tiene efectos:
  ejercita corpus, wiring en `shadow`, fuzz y evento de auditoría sin depender de 0059. M1 deja
  también el inventario por área de D41. Las confirmaciones de publicación no sirven de referencia:
  la rama Codex de `pr-publisher-confirm` lanza `navori codex approval request`, y
  `comment-draft-confirm` arrastra el render del borrador (`draft-body`); van en M5.
- **M2, referencia de comandos:** `spec`, de solo lectura y determinista: ejercita la entrada al
  manifiesto, el oráculo con diferencial cero y el test de inventario de un comando completo.

E4 activa todos los hooks en un solo PR (los siete de las fases 1–3 y los 15 de esta). E5 ensaya la
distribución sin publicar. E6 es el corte a `dev`.

**Por qué este orden.**
- Los hooks entran en `shadow` en la entrega de su área, así su ventana corre mientras se portan las
  otras áreas.
- Las entregas van en serie: E1 M1 deja el inventario por área de D41 y E2 deja los stubs de
  procesos externos de D42, que reutilizan las siguientes. Cada entrega sigue siendo integrable sin
  las siguientes (R78).
- E1 abre con los dos slices de referencia porque no dependen de 0059; sus milestones siguientes
  (`master`, `handoff`, `plan`, gobierno de agentes) sí usan la base de hooks de 0059 E1.
- E3 va al final porque además depende de la capa `Fs` y del render multi-engine (0058 E3, 0059 E2).
- La activación va después de las slices (decisión del usuario del 2026-10-28) y antes de la
  distribución, porque `cutover:check` exige que ningún hook siga en `shadow` (D17 de 0057).

**Alternativa descartada: capas horizontales** (hooks, comandos de lectura, comandos de escritura).
Deja cada área a medias hasta la última entrega: un hook de auditoría en Rust seguiría llamando al
`audit` de TS, y ninguna entrega sería usable por sí sola. Las slices cuestan algo de duplicación de
infraestructura de prueba por área, que se paga con el test de inventario compartido (D41).

## Decisions

### D40 — Asignación de hooks y comandos por área (R77, R78)

- La tabla del Approach es normativa. Un subcomando nuevo de `cli.ts` que llegue por la
  sincronización con `dev` se asigna al área de su comando raíz; un hook nuevo, al área de su
  propósito, y la asignación se registra en `scripts/js/rust-areas.mjs` en el mismo PR.
- Una dependencia en nativo entre áreas solo se permite hacia algo ya portado por una fase anterior
  (render, `Fs`, config, markers, la base de hooks). Hacia un comando de otra área de esta fase que
  siga en TS, el camino es el ejecutor del `navori` de `PATH` de R52 y R53 de 0059 (R72). Así una
  slice nunca espera a otra.
- `managed-drift-watch` va en E3 aunque observe escrituras de cualquier herramienta, porque su
  veredicto depende de `doctor` (deriva de bloques gestionados) y de `render`/`sync`.

### D41 — Una sola fuente de inventario (R77, R20)

- `scripts/js/rust-areas.mjs` exporta `inventory()` y `areaOf()`:
  - `inventory()` recorre el árbol de subcomandos y flags de `cli.ts` desde `dist/` (los `meta` y
    `args` de citty) y la lista de hooks de `core-assets/hooks` y de los plugins;
  - `areaOf()` aplica la tabla de D40 y falla con un subcomando o hook sin área.
- El test de inventario por área (R77) y `cutover:check` (R20) usan esas dos funciones; no hay una
  segunda lista. El test de un área falla si falta en `crates/ported.json` un subcomando, una flag o
  un hook de esa área; `cutover:check` exige todas las áreas.

### D42 — Transporte inyectable para red y procesos externos (R76, R85)

- **Procesos externos.** Rust los lanza por un `ProcessRunner` (trait de `navori-core`) con la
  implementación real y una grabada; llega con el primer comando que ejecuta procesos (`gate`, en
  E2). En el oráculo no hace falta la grabada: los dos lados corren
  con stubs en `PATH` (`git`, `gh`, `acli`, `codex`, `npm`, `tgrep`, `codegraph`, `pi`) que responden
  según su argv desde `scripts/js/rust-oracle/recordings/` y registran la llamada. Así TS y Rust ven
  exactamente las mismas respuestas.
- **HTTP.** El TS fija sus URLs (`update-notice.ts`, `tool-version-notice.ts`), así que el oráculo no
  puede redirigirlo. Durante la convivencia los avisos de red siguen omitidos en Rust (Q6 de 0058) y
  el oráculo los apaga en los dos lados. R85 se prueba con tests Rust propios sobre un `HttpClient`
  grabado (respuesta nueva, igual, error, tiempo agotado), comparando el texto contra las constantes
  de `lib/i18n.ts`. El aviso se enciende en el PR de corte.
- Ninguna prueba ni job de CI toca la red real (R76).

### D43 — Prompts con la herramienta de D16 de 0057 (R75)

- Se reutiliza tal cual el contrato de D16 de 0057: `dialoguer` en Rust y, en
  `crates/navori-oracle-tests`, `expectrl` conduce el mismo guion contra `node dist/index.js` y
  `navori-rust` bajo pseudo-TTY y compara preguntas, opciones, árbol resultante y código de salida.
- E3 añade los guiones de `init`, `add`, `configure`, `update`, `preset` y `workspace`. La salida
  no-TTY se compara byte a byte en el oráculo.

### D44 — `audit` se porta por capas de su propio dominio (R73, R74)

- `lib/audit` es el área más grande de la cola larga (~20.8k LOC). E2 la porta en tres milestones,
  cada uno con su parte del comando `audit` nativa y probada contra el TS:
  1. sesión de auditoría: `audit --arm`, `--start`, `--close`, el log por sesión y el bridge al
     escritor de eventos de D12 de 0057 (lo que invocan `audit-mode-trigger` y `audit-mode-close`);
  2. recolección y reporte: `collect`, `report` y sus formatos, incluida la consulta local de salud
     del puente (`/healthz` en `127.0.0.1`) por el transporte de D42;
  3. el resto de subcomandos y flags de `audit` que el inventario de D41 marque como faltantes.
- `--capture-child` lo porta 0059; esta fase no lo toca.

### D45 — Activación conjunta con umbral por clase y excepción a 30 días (R79–R83)

- **Evidencia (R81).** `scripts/js/hook-shadow-report.mjs` (la herramienta que 0058 T3 difirió)
  lee el ledger de `navori tools rust-shadow`, cuenta invocaciones y divergencias por hook y engine
  dentro de la ventana y aplica el umbral por clase de D35 de 0059 a los 22 hooks:

  | Clase | Ejemplos | Umbral en 14 días |
  |---|---|---|
  | Por tool call | `guard-destructive`, `quality-gate-pre-commit`, `implementer-no-markdown`, `routing-watch`, `bash-outcome-watch`, `managed-drift-watch` | 500 |
  | Por turno o despacho | `subagent-no-background`, `plan-gate`, `subagent-stop-handoff`, `stop-verify-reminder`, `general-purpose-confirm`, `role-guard`, `engram-write-guard` | 100 |
  | Por sesión o evento raro | `session-start-context`, `model-advisor` (`SessionStart`), `worktree-reclaim`, `audit-mode-trigger`, `audit-mode-close`, `master-plan-context`, `master-accept-confirm`, `comment-draft-confirm`, `pr-publisher-confirm` | 30 |

  La clase de un hook registrado en varios eventos es la de su evento más frecuente en ese engine.
  `hook-shadow-report.mjs` lee la clase de cada hook de una tabla en el propio script, revisada en el
  PR de E1, E2 o E3 que pone el hook en `shadow`.
- **Excepción (R82; Q22).** Un hook que no llega a su umbral en 30 días se activa con el corpus
  completo por clase y modo, el fuzz de R81 y la aprobación explícita del usuario para ese hook. La
  línea `activate` lleva `reason: "below-threshold"` y el conteo real. Sin esto, un hook raro
  (`pr-publisher-confirm`, `comment-draft-confirm`) bloquearía el corte indefinidamente, porque R20
  no admite hooks en `shadow`.
- **Un solo PR.** E4 activa todos los hooks que cumplen, cada uno con su línea `activate`. Uno que
  diverge vuelve a `shadow` con `deactivate` (R80) y se corrige antes de reintentar.
- **Transiciones (R79).** `scripts/js/rust-manifest-check.mjs` ya valida el manifiesto; E4 le
  añade la regla de transiciones de R79 y R80 (antes T2 de 0058).

### D46 — Distribución y corte según D17 de 0057 (R18, R20–R22, R24, R84, R85)

- Se ejecuta D17 de 0057 sin cambios de fondo: patrón esbuild (`navori` con lanzador JS y
  `optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide),
  `legacy/` con el `dist/` exacto del último TS publicado verificado por `integrity`, binarios musl
  estáticos en Linux.
- **Sondas (R84).** `scripts/js/dist-probe.mjs` instala el tarball local (`npm pack`) con npm, pnpm
  y bun, con y sin scripts, en un directorio limpio por plataforma, y verifica `navori --version` y
  un hook registrado (`guard-destructive` con un payload de bloqueo).
- **`check:post-cutover` (R18)** se define en `package.json` como la composición posterior al corte
  y se cronometra en reposo; `cutover:check` (R20) lee su último tiempo registrado.
- **Corte (R24).** El PR de E6 re-apunta `rust.yml` a `dev`, añade el workflow de release, el
  empaquetado y `legacy/`, enciende los avisos de R85, borra `packages/cli/src` con sus tests (salvo
  las suites de artefacto, D11 de 0057) y elimina la delegación al TS y el oráculo TS.

## Failure modes

- **F39 — Una slice depende de otra sin declararlo.** Un hook de un área que en nativo llama a un
  comando de otra área todavía en TS falla al integrarse antes que ella. Mitigación: R78 y D40; el test de inventario
  de cada área corre también con las otras dos áreas fuera del manifiesto.
- **F40 — Un hook raro nunca llega al umbral.** Bloquea el corte (R20). Mitigación: la excepción de
  D45 con aprobación por hook.
- **F41 — Las grabaciones de procesos externos se desfasan del comportamiento real.** Un `git` nuevo
  cambia su salida y el oráculo sigue verde contra la grabación vieja. Mitigación: cada grabación
  guarda la versión de la herramienta que la produjo, y un test semanal (el mismo job de frescura de
  D10 de 0057) las regenera y compara.
- **F42 — Divergencia tras activar.** Mitigación: R80; vuelta a `shadow` con `deactivate` antes de
  tocar la implementación.
- **F43 — El postinstall no corre o el binario no coincide.** Mitigación: el lanzador ejecuta el
  binario a través de Node o, sin binario, el TS congelado (R22); la sonda de R84 cubre los tres
  gestores con y sin scripts.

## Testing strategy

- **Hooks:** corpus por clase y modo (R71) con `hook-verdict-replay.mjs --impl rust`, y
  `fuzz:hooks` (100 000 casos con compuerta, 20 000 advisory; paralelo y con caché del oráculo
  shell, D9 de 0057) antes de la sombra y otra vez en E4.
- **Comandos:** `bun run oracle:rust --only <comando>` con diferencial cero (R73); oráculo de
  escrituras para los efectos en disco (R74); guiones de prompts bajo pseudo-TTY (R75); stubs de
  procesos externos grabados (R76).
- **Slices:** test de inventario por área (R77) y la misma corrida con las otras áreas excluidas del
  manifiesto (R78).
- **Activación:** `hook-shadow-report.mjs` (R81, R82), `rust-manifest-check.mjs` con transiciones
  (R79, R80) y la matriz fail-closed por engine sobre cada hook con compuerta en `active` (R83).
- **Distribución y corte:** sondas de R84, `check:post-cutover` cronometrado (R18) y
  `cutover:check` (R20).

## NOT in scope

- Workspaces de monorepo en `render`/`sync` nativos, salvo que el inventario de D41 los marque
  pendientes: en ese caso entran en E3 como flags de esos comandos.
- Windows y otras plataformas sin binario: reciben el TS congelado (R22).
- Publicar en npm: E5 ensaya sin publicar; la publicación sigue el paso manual del README tras E6.
- Reescribir la extensión Pi en Rust: sigue siendo el asset derivado de D29 de 0059.

## Decisiones del usuario

| Q | Resolución |
|---|---|
| Q20 | (2026-10-28) La fase 4 queda en una sola spec con seis entregas (E1–E6), por encima del máximo de cuatro del programa |
| Q21 | (2026-10-28) La cola larga se entrega en vertical slices por área funcional (D40), no por capas |
| Q25 | (2026-10-28) Cada milestone es un slice con entregable observable; los dos primeros son de referencia (hooks de publicación y `spec`) y el desarrollo empieza por ellos, sin esperar más certidumbre en las estimaciones |

## Preguntas (abiertas)

- **Q22 [human] — Hooks que no llegan al umbral.** La excepción de D45: activar con corpus completo,
  fuzz y aprobación por hook si no llegan en 30 días. Alternativa: dejar el hook en TS (shell)
  después del corte, lo que exige cambiar R20. Recomendación: la excepción. Bloquea solo E4.
- **Q23 [human] — Challenge del `auditor`.** La spec toca áreas críticas (hooks, escrituras,
  distribución) y la skill `spec-bootstrap` pide un challenge con contexto fresco, que sin subagentes
  no puede correr. Recomendación: igual que Q18 de 0059, omitirlo y dejar revisión independiente
  pendiente en cada PR; o hacer una excepción a la regla de subagentes solo para ese paso.
- **Q24 [human] — Scope npm de los paquetes de plataforma.** Pendiente desde la decisión 3 del
  usuario en 0057. Bloquea solo M16 (E5).
