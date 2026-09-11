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
(`OTEL_LOGS_EXPORTER`, distinto de las métricas). `claude_code.tool_decision` trae
`decision` y `source`; `claude_code.api_request` trae el atributo `skill.name`, declarado por
el host. Y `session.id` viaja en todo evento, así que hay clave de unión real con el store de
audit — no correlación por timestamp.

**La restricción que da forma a todo lo demás**: `OTEL_LOGS_EXPORTER` solo acepta
`otlp | console | none`. No hay exportador a archivo, y el endpoint tiene que ser una URL
HTTP(S) — ni socket unix ni path. Capturar eventos exige un proceso escuchando en loopback.
El invariante 9 de `docs/DIRECTION.md` ("navori genera, no ejecuta") impide que navori lo
levante por su cuenta, así que navori **provee** el receptor como subcomando y **el operador
lo ejecuta**.

Público: el operador del harness auditando sus propias sesiones. Issue: #687.

## Requirements (EARS)

### El receptor que el operador ejecuta

- **R1** — WHEN el operador invoca `navori audit --collect`, el sistema SHALL aceptar
  registros OTLP por HTTP y SHALL confirmar en su salida la dirección en la que escucha y el
  directorio donde escribirá los eventos.

- **R2** — WHEN el receptor recibe un `POST /v1/logs` con cuerpo `http/json`, SHALL escribir
  un registro por cada evento del cuerpo en el archivo de eventos de la sesión que el propio
  evento nombra en `session.id`.

- **R3** — IF el cuerpo de una petición no se puede interpretar como OTLP, THEN el receptor
  SHALL responder 200, SHALL NOT escribir ningún registro de esa petición, y SHALL contabilizar
  el descarte en su salida. Un receptor que responde error hace que el emisor reintente, y
  observabilidad que le cuesta latencia al operador es peor que no tenerla.

- **R4** — El receptor SHALL escuchar únicamente en la interfaz de loopback.

- **R5** — IF la dirección solicitada ya está ocupada, THEN `--collect` SHALL terminar con
  código distinto de 0 nombrando esa dirección, y SHALL NOT crear ni truncar ningún archivo.

- **R6** — El receptor SHALL persistir de cada evento únicamente los campos que esta spec
  declara, y SHALL descartar todo el resto — incluidos el texto del prompt y el de la
  respuesta si el emisor los envía.

- **R7** — Ningún comando ni hook de navori distinto de `audit --collect` SHALL abrir un
  puerto de escucha. Es el invariante 9 en su forma ejecutable: navori provee el receptor, el
  operador decide cuándo corre.

### La ingesta

- **R8** — WHEN se genera el reporte de una sesión y existe su archivo de eventos, el sistema
  SHALL unir esos eventos a la sesión por `session.id`.

- **R9** — IF una sesión no tiene archivo de eventos, THEN el reporte SHALL generarse igual y
  SHALL declarar que la tercera fuente no estuvo presente. "No hubo datos" y "no hubo
  aprobaciones manuales" no pueden renderizarse igual.

### Los dos puntos ciegos

- **R10** — WHEN la sesión tiene eventos `claude_code.tool_decision`, el reporte SHALL contar
  las decisiones de permiso agrupadas por su `source`, separando las que un humano tomó
  (`user_permanent`, `user_temporary`, `user_reject`, `user_abort`) de las que resolvió la
  configuración o un hook (`config`, `hook`).

- **R11** — WHEN la sesión tiene eventos `claude_code.api_request` con el atributo
  `skill.name`, el reporte SHALL registrar esas skills con una procedencia que las distinga de
  las que hoy se infieren del transcript.

- **R12** — IF la tercera fuente falta o no nombra ninguna skill, THEN la detección heurística
  existente SHALL seguir operando sin cambios. La fuente nueva agrega evidencia; no reemplaza
  la que ya había.
