# Eventos OTel como tercera fuente de `navori audit` — Requirements

## Context

`navori audit` se alimenta de dos fuentes: el log append-only que escriben los hooks (lo que
hizo el harness) y el transcript JSONL de Claude Code (lo único que lleva tokens). Dos
comentarios del propio parser declaran que ciertos datos **no son observables por ninguna de
las dos**:

- `parse.ts` — *"Successful manual approvals are NOT detectable — a granted prompt is
  indistinguishable from a pre-approved tool"*. El reporte no puede separar "el usuario
  aprobó" de "estaba pre-aprobado", y lo dice en vez de fingir cobertura.
- `parse.ts` — *"Touched, not used… no criterion over content can separate them"*. La
  activación de skills se infiere de si alguien abrió un `SKILL.md`, porque la tool `Skill`
  casi no se usa: la sesión de referencia dio 0 llamadas contra 34 archivos abiertos. Toda la
  medición de activación (2% → 57%, remedida a 24% en #674) se para sobre esa heurística.

Existe una tercera fuente que sí los expone: los **eventos** de OpenTelemetry de Claude Code
(`OTEL_LOGS_EXPORTER`, distinto de las métricas). `claude_code.tool_decision` trae `decision` y
`source`; `claude_code.api_request` trae el atributo `skill.name`, declarado por el host. Y
`session.id` viaja en todo evento, así que hay clave de unión real con el store de audit — no
correlación por timestamp.

**Restricción 1, que define quién captura.** `OTEL_LOGS_EXPORTER` solo acepta
`otlp | console | none`. No hay exportador a archivo, y el endpoint tiene que ser una URL
HTTP(S) — ni socket unix ni path. Capturar eventos exige un proceso escuchando en loopback. El
invariante 9 de `docs/DIRECTION.md` ("navori genera, no ejecuta") impide que navori lo levante
por su cuenta, así que navori **provee** el receptor como subcomando y **el operador lo
ejecuta**.

**Restricción 2, que define cuándo se decide.** El entorno OTel se lee cuando arranca el proceso
de Claude Code. `navori audit --arm` marca la sesión *después* de que arrancó — y su caso central
(#599) es armar la sesión **en curso** sin reiniciarla. Por lo tanto `--arm` **no puede** encender
la exportación de eventos de una sesión viva, y la configuración tiene que estar puesta antes. De
ahí que se ate a `audit.mode`, que es una declaración del repo, y no a las banderas por sesión.

**Dónde aterrizan los eventos.** En el log de sesión que ya existe, no en un archivo aparte. El
receptor hace `O_APPEND` sobre `session-<id>.log` igual que los hooks, así que no hay sidecar, no
hay paso de volcado y no hay pregunta sobre qué pasa si la sesión muere antes del `--stop`. Es
viable ahora y no antes: #689 agregó `tsMs` y el reordenamiento cronológico, sin los cuales
eventos que llegan batcheados cada segundo quedarían al final del archivo sin forma de ordenarlos.

Público: el operador del harness auditando sus propias sesiones. Issue: #687.

## Requirements (EARS)

### El receptor que el operador ejecuta

- **R1** — WHEN el operador invoca `navori audit --collect`, el sistema SHALL aceptar registros
  OTLP por HTTP y SHALL confirmar en su salida la dirección en la que escucha y el store donde
  escribirá.

- **R2** — WHEN el receptor recibe un `POST /v1/logs` con cuerpo `http/json`, SHALL escribir cada
  evento como una línea JSON en el log de la sesión que el propio evento nombra en `session.id`,
  usando `O_APPEND` y sin reescribir el archivo.

- **R3** — IF la sesión que el evento nombra no tiene log, THEN el receptor SHALL descartar ese
  evento y SHALL NOT crear el log. Es el mismo criterio que aplica el hook: auditar es opt-in por
  sesión, y el log existente es el índice de las que optaron.

- **R4** — WHEN el receptor escribe por primera vez en el log de una sesión, SHALL registrar antes
  un evento que marque el instante desde el cual la tercera fuente estuvo presente para esa
  sesión.

- **R5** — IF el cuerpo de una petición no se puede interpretar como OTLP, THEN el receptor SHALL
  responder 200, SHALL NOT escribir ningún registro de esa petición, y SHALL contabilizar el
  descarte en su salida. Un receptor que responde error hace que el emisor reintente, y
  observabilidad que le cuesta latencia al operador es peor que no tenerla.

- **R6** — El receptor SHALL escuchar únicamente en la interfaz de loopback.

- **R7** — IF la dirección solicitada ya está ocupada, THEN `--collect` SHALL terminar con código
  distinto de 0 nombrando esa dirección, y SHALL NOT crear ni truncar ningún archivo.

- **R8** — El receptor SHALL persistir de cada evento únicamente los campos que esta spec declara,
  y SHALL descartar todo el resto — incluidos el texto del prompt y el de la respuesta si el
  emisor los envía.

- **R9** — Ningún comando ni hook de navori distinto de `audit --collect` SHALL abrir un puerto de
  escucha. Es el invariante 9 en su forma ejecutable: navori provee el receptor, el operador
  decide cuándo corre.

### La configuración que navori sí genera

- **R10** — WHEN el repo declara `audit.mode: always`, `render` SHALL emitir en el fragmento de
  `settings.json` las variables de entorno que exportan eventos al receptor local, y SHALL NOT
  habilitar la exportación de métricas ni de cuerpos crudos de API.

- **R11** — IF `audit.mode` no es `always`, THEN `render` SHALL NOT emitir esas variables. Un repo
  que audita por sesión no debe pagar exportación en las sesiones que no audita.

### Los dos puntos ciegos

- **R12** — WHEN el log de una sesión tiene eventos `tool_decision`, el reporte SHALL contar las
  decisiones de permiso agrupadas por su `source`, separando las que un humano tomó
  (`user_permanent`, `user_temporary`, `user_reject`, `user_abort`) de las que resolvió la
  configuración o un hook (`config`, `hook`).

- **R13** — WHEN el log de una sesión tiene eventos `api_request` con el atributo `skill.name`, el
  reporte SHALL registrar esas skills con una procedencia que las distinga de las que hoy se
  infieren del transcript.

- **R14** — IF el log de una sesión no lleva la marca de R4, THEN el reporte SHALL declarar que la
  tercera fuente no estuvo presente, y la detección heurística existente SHALL seguir operando sin
  cambios. "No hubo datos" y "no hubo aprobaciones manuales" no pueden renderizarse igual.
