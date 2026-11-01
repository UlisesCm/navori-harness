# Migración a Rust, fase 4: cola larga — Design

**Estado:** aceptada; reestructurada el 2026-10-31 (Q26–Q29). Q22 y Q24 se mudaron a 0062 y Q23 sigue
abierta (§ "Preguntas") ·
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

La activación, la distribución y el corte (antes E4–E6) son `specs/0062-rust-activacion-corte/`
desde el 2026-10-31 (Q26).

**Orden y paralelismo (revisado el 2026-10-31, D47).**
- Los hooks entran en `shadow` en la entrega de su área, así su ventana corre mientras se portan las
  otras áreas.
- E1 abrió con los dos slices de referencia porque no dependían de 0059. Su PR final de comandos
  (1c) trae la infraestructura que comparten E2 y E3: las herramientas de T17 y el
  `ProcessRunner` de D42 (T18), que antes llegaba con E2 y obligaba a E3 a esperarla.
- Con esa infraestructura, E2 y M8 de E3 avanzan en paralelo: ninguna depende en nativo de la otra
  (R78) y cada una tiene su archivo de casos del oráculo.
- Solo M9 de E3 espera a 0059 E2, porque `init`, `add`, `configure`, `update` y `refresh` escriben
  por el render multi-engine. Por eso 0059 E2 es la ruta crítica de esta spec.
- 0062 corre en paralelo con esta spec; solo su corte espera a que la cola larga termine.

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

### D41 — Una sola fuente de inventario (R77; R20 de 0062)

- `scripts/js/rust-areas.mjs` exporta `inventory()` y `areaOf()`:
  - `inventory()` recorre el árbol de subcomandos y flags de `cli.ts` desde `dist/` (los `meta` y
    `args` de citty) y la lista de hooks de `core-assets/hooks` y de los plugins;
  - `areaOf()` aplica la tabla de D40 y falla con un subcomando o hook sin área.
- El test de inventario por área (R77) y `cutover:check` (R20 de 0062) usan esas dos funciones; no hay una
  segunda lista. El test de un área falla si falta en `crates/ported.json` un subcomando, una flag o
  un hook de esa área; `cutover:check` exige todas las áreas.

### D42 — Transporte inyectable para red y procesos externos (R76; R85 de 0062)

- **Procesos externos.** Rust los lanza por un `ProcessRunner` (trait de `navori-core`) con la
  implementación real y una grabada; llega con la infraestructura compartida de E1 (T18), antes del primer comando que
  ejecuta procesos (`gate` en E2, `doctor` en E3). En el oráculo no hace falta la grabada: los dos lados corren
  con stubs en `PATH` (`git`, `gh`, `acli`, `codex`, `npm`, `tgrep`, `codegraph`, `pi`) que responden
  según su argv desde `scripts/js/rust-oracle/recordings/` y registran la llamada. Así TS y Rust ven
  exactamente las mismas respuestas.
- **HTTP.** El TS fija sus URLs (`update-notice.ts`, `tool-version-notice.ts`), así que el oráculo no
  puede redirigirlo. Durante la convivencia los avisos de red siguen omitidos en Rust (Q6 de 0058) y
  el oráculo los apaga en los dos lados. R85 (0062) se prueba con tests Rust propios sobre un `HttpClient`
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

### D45 y D46 — se movieron a 0062

La activación (D45) y la distribución y el corte (D46) pasaron a
`specs/0062-rust-activacion-corte/design.md` el 2026-10-31. D45 quedó reemplazada allí por D49
(activación por evidencia mínima) y D46 enmendada por D50 (corte con delegación permanente).

### D47 — Política de velocidad (R70, R71, R73, R77; Q29)

El tiempo de esta fase se iba más en verificar y en coordinar PRs que en escribir código (issue
#1467). Desde el 2026-10-31 rige, para 0059, 0060 y 0062:

- **Un PR por entrega y por flujo.** Commits atómicos dentro del PR y una revisión cruzada por PR;
  dos flujos nunca comparten rama. Los PRs ya abiertos al 2026-10-31 se terminan como están. Cuando
  un test de inventario (R77) necesita el trabajo de otro flujo, el PR que lo necesita entra después
  (los hooks de un área antes que el PR de comandos que corre su inventario).
- **Una evidencia principal por comportamiento.**
  - Hooks: el replay nativo del corpus. Se siembra corpus solo si falta una clase (R71). No se
    escribe un test Rust que repita el corpus; los tests Rust cubren lo que el corpus no alcanza
    (ramas de sistema de archivos, el carril en proceso).
  - Comandos: el oráculo con diferencial cero (R73).
- **Fuzz proporcional al riesgo.** Al portar: 10 000 casos, solo para hooks con compuerta que
  analizan texto (por ejemplo `guard-destructive`, `implementer-no-markdown`, `role-guard`,
  `master-accept-confirm`). Los advisory no llevan fuzz al portar. El fuzz de 100 000 casos corre
  una sola vez, en lote, antes de activar (D49 de 0062).
- **Gate.** En cada commit, `bun run check:fast` y los tests del área. El gate completo (`bun run
  check` y `cargo test --workspace`) lo corre la CI del PR y no se repite en local.
- **Herramientas antes que pasos manuales (T17).**
  - `bun run rust:hooks-sync` recalcula `impl` y `blocks` de `crates/ported.json` sin
    reformatear, re-renderiza y recompila `navori-rust`.
  - `bun run rust:verify` corre el replay y el fuzz con ese binario y reintenta una vez una llamada
    diferida por "probe deadline expired".
  - Los tests de `hook_facts` y `facts_cache` usan el plazo máximo de `Limits` (500 ms). El
    plazo de producción no cambia.
- **Flujos con zona exclusiva.** El trabajo se reparte en tres flujos y cada uno es el único que
  toca su zona, para que el paralelismo no se pague en conflictos:
  - *Hooks:* `crates/navori-hooks/**`, la sección `hooks` de `crates/ported.json`, los scripts
    renderizados, el corpus de hooks y `hook-fuzz.mjs`; también la activación de 0062. Un cambio
    en `navori-hooks/src/shell/` renueva el hash de todos los hooks, así que solo este flujo lo hace.
  - *Comandos:* el código de cada comando en `navori-cli` y `navori-core`, la sección `commands`
    de `ported.json`, su archivo `scripts/js/rust-oracle/cases/<área>.json` y las herramientas de
    T17, que el flujo de hooks usa.
  - *Render y distribución:* `render/**` (0059 E2) y el release y el empaquetado (E2 de 0062).
- **Casos del oráculo por área.** `scripts/js/rust-oracle/cases.json` se parte en un archivo por
  área (T17): dos flujos que agregan casos ya no editan el mismo arreglo, que fue la causa de los
  conflictos de #1464 y #1466.
- **Integración diaria.** Cada flujo integra `origin/migration/rust` a diario y resuelve en su rama.

### D48 — Delegación permanente de caminos raros (R73, R77; Q28)

- Un comando portado es nativo en su camino feliz y en sus errores comunes. Un camino raro, cuya
  salida depende de una implementación ajena (mensajes de zod o de V8), de un estado corrupto o de
  una carrera, delega al TS antes de la primera salida o escritura, como ya hacen los comandos de E1.
- Un subcomando o flag que no vale la pena portar entra en la **lista de delegación permanente** de
  `scripts/js/rust-areas.mjs`, con un motivo de una línea. El test de inventario por área (R77) y
  `cutover:check` (R20 de 0062) aceptan esa lista igual que el manifiesto.
- Después del corte, la delegación va al TS congelado del paquete (D50 de 0062), así que la lista
  no deja nada sin atender.

## Failure modes

- **F39 — Una slice depende de otra sin declararlo.** Un hook de un área que en nativo llama a un
  comando de otra área todavía en TS falla al integrarse antes que ella. Mitigación: R78 y D40; el test de inventario
  de cada área corre también con las otras dos áreas fuera del manifiesto.
- **F41 — Las grabaciones de procesos externos se desfasan del comportamiento real.** Un `git` nuevo
  cambia su salida y el oráculo sigue verde contra la grabación vieja. Mitigación: cada grabación
  guarda la versión de la herramienta que la produjo, y un test semanal (el mismo job de frescura de
  D10 de 0057) las regenera y compara.
- **F46 — La lista de delegación permanente crece sin control.** Mitigación: cada entrada lleva su
  motivo y entra por PR; la revisión cruzada la valida.
- F40, F42 y F43 se movieron a 0062 con la activación y la distribución.

## Testing strategy

Con la política de D47:

- **Hooks:** replay nativo del corpus (`hook-verdict-replay.mjs --impl rust`), corpus sembrado solo
  donde falte una clase (R71) y fuzz de 10 000 casos para los hooks con compuerta que analizan texto.
- **Comandos:** `bun run oracle:rust --only <comando>` con diferencial cero en el camino feliz y
  los errores comunes (R73), oráculo de escrituras (R74), guiones de prompts bajo pseudo-TTY solo
  para los comandos con prompts (R75) y stubs de procesos externos grabados (R76).
- **Slices:** test de inventario por área, con la lista de delegación permanente (R77), y la misma
  corrida con las otras áreas fuera del manifiesto (R78).
- **Gate:** `check:fast` y los tests del área en cada commit; el gate completo en la CI del PR.

## NOT in scope

- Workspaces de monorepo en `render`/`sync` nativos, salvo que el inventario de D41 los marque
  pendientes: en ese caso entran en E3 como flags de esos comandos.
- La activación, la distribución y el corte: son 0062.
- Reescribir la extensión Pi en Rust: sigue siendo el asset derivado de D29 de 0059.

## Decisiones del usuario

| Q | Resolución |
|---|---|
| Q20 | (2026-10-28) La fase 4 queda en una sola spec con seis entregas (E1–E6), por encima del máximo de cuatro del programa |
| Q21 | (2026-10-28) La cola larga se entrega en vertical slices por área funcional (D40), no por capas |
| Q25 | (2026-10-28) Cada milestone es un slice con entregable observable; los dos primeros son de referencia (hooks de publicación y `spec`) y el desarrollo empieza por ellos, sin esperar más certidumbre en las estimaciones |
| Q26 | (2026-10-31) La fase 4 se parte: esta spec se queda con la cola larga (E1–E3) y `specs/0062-rust-activacion-corte/` con la activación, la distribución y el corte |
| Q27 | (2026-10-31) Activación por evidencia mínima (D49 de 0062): replay, fuzz de 100 000 y 7 días de sombra sin divergencias para hooks con compuerta; solo replay para advisory |
| Q28 | (2026-10-31) Delegación permanente de caminos raros (D48) y corte con esa lista delegada al TS congelado (D50 de 0062) |
| Q29 | (2026-10-31) Política de velocidad de D47 en 0059, 0060 y 0062 |

## Preguntas (abiertas)

- **Q23 [human] — Challenge del `auditor`.** La spec toca áreas críticas (hooks, escrituras,
  distribución) y la skill `spec-bootstrap` pide un challenge con contexto fresco, que sin subagentes
  no puede correr. Recomendación: igual que Q18 de 0059, omitirlo y dejar revisión independiente
  pendiente en cada PR; o hacer una excepción a la regla de subagentes solo para ese paso.
- Q22 quedó resuelta por Q27 y Q24 se mudó a 0062.
