# Pi: igualar los resultados de Claude — Requirements

**Estado:** scaffold aceptado por el usuario el 2026-10-14. Abrir la spec no autoriza workplans de entrega,
implementación ni publicación.
**Base:** `origin/dev`. Pi pinneado en `@earendil-works/pi-coding-agent` 1.1.0; última publicada 1.2.0
(2026-10-12).

## Context

Con Claude Code, el harness de navori produce resultados medibles: el ciclo implementer → reviewer →
publisher se cierra, las guardas corrigen al modelo y el contexto sobrevive a la compactación. Con Pi los
mecanismos existen en código, pero nunca se ejecutaron con un modelo real y las sesiones Pi del usuario no
dejan evidencia producida por hijos. Esta spec mide ambos engines con las mismas tareas y cierra las
brechas que la medición y la investigación encontraron.

## Evidencia inicial (investigación en frío, 2026-10-14)

Claude (5 sesiones de `~/.claude/projects/-Users-ulisescm-Documents-dev-docs-navori-harness/`, handoffs y
gate logs de `.navori/state/`):

- Dispatches: implementer 64, reviewer 57, publisher 47 (0.89 reviewer por implementer).
- Handoffs de review: 61 APPROVED y 10 CHANGES_REQUESTED; handoffs de implementer: 88 DONE y 17 BLOCKED.
- Denegaciones observadas (cota superior): `implementer-no-markdown` 75, `guard-search-routing` 74,
  `guard-destructive` 44, `plan-gate` 43, `subagent-no-background` 10.
- 12 gates fallidos en `.navori/state/gate/`; cada uno tiene un PASS posterior.
- 1 a 2 compactaciones por sesión.

Pi (código en `origin/dev`, sesiones en `~/.pi/agent/sessions`, paquete upstream 1.2.0):

- Todos los tests usan `fauxProvider`. Solo el e2e de `packages/cli/src/engines/pi/__tests__` y
  `runtime.test` ejecutan el binario real; ninguno con un modelo real.
- 45 sesiones Pi en disco y ninguna evidencia en `.navori/state` atribuible a un hijo `pi-<role>`;
  `navori-verify-reminder` aparece 0 veces.
- El plan gate de `checkDispatch` (`extension-source.ts`) solo tiene pruebas con spawn simulado, y la
  config del e2e no activa `harness.planTiers`.
- `PI_EXTENSION_SOURCE` no escucha `session_before_compact` ni `session_compact`, aunque Pi 1.2.0 los
  expone. El contexto inyectado por `injectContext` no se repone tras compactar.
- El routing de búsqueda a tgrep ya corre en Pi (lane `tgrep-search-lane` de `guard-destructive.sh`, que
  carga `guard-search-routing.sh`), pero ninguna prueba compara su decisión con Claude. La guarda de
  Markdown del implementer solo cubre `edit`/`write`, no bash.
- La regla 6 de `guard-destructive.sh` solo detecta `>`, `>|`, `sed -i` y `tee` hacia archivos gestionados;
  `cp`, `mv` e `install` pasan. En las copias de Claude y Codex, `.pi/agents/*.md` queda fuera del plano
  de control.
- Con Node < 22.19 la extensión no registra handlers. Cualquier Pi ≥ 1.1.0 se acepta como verificado sin
  sonda. `bridgeVerdict` permite una llamada abortada aunque el control sea `enforced`.
  `runBridgeScript` trunca stdout a 64 KiB.
- `INDEX` antepone `openai-codex/` a los tiers de `codexMap`; otro proveedor rompe los hijos.
- Upstream: Pi no tiene subagentes ni permisos nativos. Un handler de `tool_call` puede bloquear con una
  razón que el modelo recibe como resultado de error. Sin UI, `confirm` devuelve `false`.

## Requirements (EARS)

- **R1** — The system SHALL producir, a partir de `navori audit` sobre sesiones Claude y Pi de un mismo
  conjunto fijo de tareas, una comparación lado a lado con, por engine: dispatches por rol, publicaciones
  precedidas por una revisión aprobada del mismo diff, veredictos de revisión, handoffs `BLOCKED`,
  denegaciones por control, gates fallidos seguidos de un gate verde y compactaciones con contexto repuesto.
- **R2** — Antes de aceptar esta spec, `evals.md` SHALL contener la comparación de R1 de una corrida en
  vivo, con modelo real, del conjunto fijo de tareas en Claude y en Pi, con resultado `pass`, `fail` o
  `inconclusive`. El resultado SHALL ser `inconclusive` si algún engine no publica al menos una vez en las
  tareas 1–2 o no registra al menos una vez cada denegación provocada. Para `pass`, Pi SHALL registrar cero
  publicaciones sin aprobación correlacionada del diff publicado y cero commits sin gate verde; además,
  the system SHALL tomar la misma decisión en Claude y en Pi para cada comando del catálogo de guardas que
  ambos engines evalúan en la capa de scripts compartidos.
- **R3** — WHEN un hijo `implementer` o `reviewer` de Pi termine, the system SHALL persistir evidencia
  atribuible a ese hijo (rol, sesión padre e identidad del árbol de trabajo) en el transcript de la sesión
  padre y en su log de auditoría, que `navori audit` cuente como dispatch de ese rol.
- **R4** — WHEN `harness.planTiers` esté activo y el agente principal de Pi despache un `implementer` sin un
  plan aprobado y verde, the system SHALL denegar el despacho y devolver al modelo la razón de
  `navori plan gate`, y esto SHALL probarse con el padre corriendo como proceso `pi` real.
- **R5** — WHEN Pi haya compactado una sesión, the system SHALL reponer el contexto de navori que
  `injectContext` entregó al inicio, una sola vez por compactación: sin agregarlo si ya hay un marcador
  posterior a la última compactación.
- **R6** — WHEN el plugin `tgrep` esté activo y un agente de Pi ejecute una búsqueda recursiva que la regla de routing compartida desvía a
  tgrep, the system SHALL denegarla con la misma razón y la misma ruta permitida que en Claude.
- **R7** — WHEN un hijo `implementer` de Pi intente escribir un archivo Markdown fuera de los prefijos de
  doctrina mediante bash, the system SHALL bloquearlo como bloquea `edit`/`write`.
- **R8** — WHEN cualquier agente, en Claude o en Pi, copie, mueva, instale o enlace (`cp`, `mv`, `git mv`,
  `install`, `ln`) un archivo sobre una ruta propiedad de navori (escrita por el render), o mueva una de esas
  rutas a otro lugar, the system SHALL bloquearlo y nombrar el comando de render que lo reemplaza.
- **R9** — IF la versión de Node no permite registrar los handlers de la extensión THEN the system SHALL
  bloquear `bash`, `edit`, `write` y `powershell` con un diagnóstico accionable en lugar de no registrar
  ningún handler.
- **R10** — IF la versión de Pi no figura en la lista de versiones verificadas por sonda THEN the system
  SHALL aplicar el modo restringido de escritura y `navori doctor` SHALL reportarla como no verificada; la
  lista SHALL contener solo 1.2.0, tras pasar la sonda.
- **R11** — IF un control `enforced` no produce un veredicto evaluable (llamada abortada, o una línea de
  salida que declara una clave de veredicto y no se puede parsear) THEN the system SHALL denegar la
  operación; la salida sin claves de veredicto SHALL conservar su semántica actual.
- **R12** — WHEN se resuelva el modelo de un rol de Pi, the system SHALL usar el proveedor configurado para
  Pi y SHALL NOT asumir un proveedor fijo.

## Decisiones del usuario (2026-10-14)

- **D-U1** — Investigación en frío: la spec parte de lo que el harness produce hoy, no de specs previas.
- **D-U2** — El benchmark de R1/R2 es el criterio de aceptación de la spec.
- **D-U3** — La evidencia de los hijos vive en el transcript del padre y su log de auditoría, como en Claude;
  sin registro nuevo en `.navori/state`.
- **D-U4** — Se aceptan las reformulaciones de R2, R5 y R6 propuestas en el diseño.
- **D-U5** — El plan gate de R4 se prueba con el padre como proceso `pi` real.
- **D-U6** — Solo Pi 1.2.0 queda verificada; 1.1.0 cae a modo restringido.

## Límites de alcance

- Las métricas de calidad (tasa de `CHANGES_REQUESTED`, `BLOCKED`, retrabajo) se registran, pero no son
  umbral de aceptación: dependen del modelo, no del harness. Solo las métricas de seguridad de R2 son umbral.
- No se replican subagentes ni permisos nativos en Pi; los hijos siguen siendo procesos `pi` y la
  enforcement sigue en `tool_call`.
- MCP en hijos sigue con `--no-mcp`.
- `audit-mode` en Pi queda fuera: `navori audit` ya lee las sesiones Pi. Nota: el disparo de audit-mode en Pi (arm/`--host pi` y `audit.mode=always`) se promovió en la spec pi-audit-mode.
- Que el hook de gate de Claude ejecute una cadena distinta de `qualityGate.fast` es un hallazgo aparte;
  se abre como issue, no entra aquí.
