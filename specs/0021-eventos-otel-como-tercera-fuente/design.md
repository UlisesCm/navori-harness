# Eventos OTel como tercera fuente de `navori audit` — Design

## Approach

Tres fuentes, una clave de unión. El log de hooks dice qué hizo el harness, el transcript dice
qué costó, y los eventos OTel dicen **qué decidió el host** — las dos cosas que ninguna de las
otras dos puede saber. `session.id` viaja en todo evento y es el mismo id con el que el store
de audit ya nombra sus archivos, así que la unión es por igualdad de id, no por ventanas de
tiempo (la lección de #560 y de `ownerOf`: correlacionar por reloj inventa dueños).

**navori provee el receptor; el operador lo ejecuta.** `navori audit --collect` levanta un
servidor HTTP en loopback y se queda escribiendo hasta que el operador lo corta. Eso mantiene
intacto el invariante 9 (`DIRECTION.md`): navori genera el harness y provee herramientas, pero
no arranca procesos por su cuenta. R7 lo vuelve verificable en vez de dejarlo como promesa.

Trade-offs descartados:

- **navori levanta el receptor solo en `--start`.** Cero fricción, pero contradice el
  invariante 9 y exigiría enmendarlo. No se paga esa enmienda antes de tener evidencia de que
  el pipeline sirve; si la fricción resulta fatal en la práctica, esa medición es el argumento
  para reabrirlo.
- **`otelcol` externo con un `collector.yaml` renderizado.** Ortodoxo respecto al invariante 9,
  pero agrega una dependencia binaria y deja el formato en disco definido por un YAML en vez de
  por navori — justo el acoplamiento que hace frágil leer lo que otro escribió.
- **`OTEL_LOGS_EXPORTER=console`.** La documentación no dice si escribe a stdout o a stderr, y
  cualquiera de las dos corrompe la TUI. Descartado por indefinido, no por costoso.
- **Renderizar las variables de entorno en `settings.json`.** Ver *NOT in scope*.

## Components

- `packages/cli/src/lib/audit/collect.ts` — el receptor: servidor HTTP en loopback, ruta
  `POST /v1/logs`, aplana el sobre OTLP y aplica la allowlist. Cubre R1, R2, R3, R4, R6.
- `packages/cli/src/commands/audit.ts` — la bandera `--collect`, su salida de confirmación y
  el fallo por dirección ocupada. Cubre R1, R5.
- `packages/cli/src/lib/audit/paths.ts` — `otelLogPath(repo, sessionId)`, con la misma
  validación de id que `sessionLogPath` (#503). Cubre R2.
- `packages/cli/src/lib/audit/otel.ts` — lee el JSONL de eventos y lo une a la sesión. Cubre
  R8, R9.
- `packages/cli/src/lib/audit/model.ts` — `PermissionDecisions`, `otelEventsFrom`, y la
  variante nueva de `SkillSource`, que convive con las dos heurísticas en vez de sustituirlas.
  Cubre R9, R10, R11, R12.
- `packages/cli/src/lib/audit/report.ts` — rendereo de las decisiones de permiso, de las skills
  declaradas por el host y de la ausencia de la fuente. Cubre R9, R10, R11.

## Decisions

- **`http/json`, no `http/protobuf` ni `grpc`.** Claude Code acepta los tres; JSON es el único
  que se parsea con `JSON.parse` y deja el receptor en un `node:http` sin una sola dependencia
  nueva. El bundle de la CLI tiene un tope de 1000 KB que hoy ocupa 915 KB — meter un runtime
  de protobuf por observabilidad opcional sería gastar el margen en el lugar equivocado.

- **Un receptor sirve a todas las sesiones.** El evento nombra su propia `session.id`, así que
  el ruteo a archivo se decide por evento y no al arrancar. El operador levanta `--collect` una
  vez y trabaja en los repos que quiera; no hay que reiniciarlo por sesión.

- **Se persiste el registro aplanado, no el sobre OTLP.** El sobre anida
  `resourceLogs → scopeLogs → logRecords` con los atributos en arreglos de pares `{key, value}`.
  Aplanar en la escritura deja el archivo con la misma forma que el log de hooks —una línea
  JSON, campos planos— y evita que cada lector futuro reimplemente el desanidado.

- **Allowlist, no denylist (R6).** Se persisten `ts`, `event`, `sessionId`, y por tipo de
  evento: `toolName`, `decision`, `source` para `tool_decision`; `skillName`, `agentName`,
  `model` para `api_request`. Todo lo demás se descarta. Una denylist obliga a acertarle a cada
  campo nuevo que el host agregue; una allowlist falla hacia no guardar, que es el lado correcto
  cuando el emisor puede mandar el texto del prompt.

- **`SkillSource` gana la variante `host`**, y gana a `skill-tool` y a `skill-md` al resolver
  la procedencia de una skill. Es la única de las tres que no es inferencia: el host declara qué
  skill estaba activa en la request. Las otras dos se quedan tal cual para las sesiones sin
  tercera fuente (R12).

- **La ausencia se declara, no se asume (R9).** Mismo criterio que `hookLogFrom`, que existe
  porque "no hubo hooks" y "no hubo registro" renderizaban igual. Aquí el error equivalente
  sería leer "0 aprobaciones manuales" en una sesión donde nadie estaba escuchando.

## Contracts

Una línea por evento en `~/.navori/audits/<repo>/otel-<session-id>.jsonl`:

```json
{"ts":"2026-09-11T18:30:00.123Z","event":"tool_decision","sessionId":"<uuid>","toolName":"Bash","decision":"accept","source":"user_temporary"}
{"ts":"2026-09-11T18:30:04.880Z","event":"api_request","sessionId":"<uuid>","skillName":"structural-search","agentName":"researcher","model":"claude-opus-5"}
```

`event` es el nombre del evento del host sin el prefijo `claude_code.`. Los campos opcionales
se omiten cuando el atributo no vino, nunca se escriben vacíos — misma regla que el registro de
hooks.

El entorno que el operador exporta en la terminal donde lanza `claude`, y que `--collect`
imprime para copiar:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
export OTEL_LOGS_EXPORT_INTERVAL=1000
```

`OTEL_METRICS_EXPORTER=none` es explícito: las métricas no entran a esta spec y no exportarlas
evita que el receptor reciba tráfico que va a descartar. Las variables de protocolo y endpoint
son las **por señal** (`_LOGS_`) para que habilitar esto no arrastre trazas ni métricas si el
operador ya tiene otra configuración de OTel.

## Failure modes

- **El operador no levantó el receptor.** Claude Code intenta exportar cada segundo y falla en
  silencio (los errores del exportador solo salen con `--debug`, prefijados `[3P telemetry]`).
  No hay archivo de eventos, y R9 hace que el reporte lo diga.
- **El receptor corre pero la sesión no está marcada.** El evento nombra una `session.id` sin
  log de hooks. Se escribe igual: el archivo de eventos es independiente del marcado, y un
  reporte posterior sobre esa sesión lo encontrará si llega a marcarse. No se inventa un log.
- **El receptor muere a media sesión.** El archivo queda más corto, como el log de hooks cuando
  una sesión se cae. Se lee lo que haya; el formato es una línea por evento justamente para eso.
- **Cuerpo ininterpretable o evento sin `session.id`.** Se descarta y se cuenta (R3). Un evento
  sin sesión no tiene archivo al que pertenecer, y adivinarlo sería inventar la unión que esta
  spec existe para hacer exacta.
- **Dirección ocupada.** Falla temprano y sin tocar disco (R5): el caso típico es un `--collect`
  anterior que sigue vivo, y truncar su archivo de salida sería destruir la sesión en curso.

## Testing strategy

- El receptor se prueba **por HTTP real** contra un puerto efímero, no llamando a la función
  interna: lo que está en duda es el contrato con un emisor externo (ruta, content-type,
  código de respuesta), y una llamada directa no lo ejerce.
- El descarte de basura (R3) se prueba con un cuerpo que no es JSON **y** con uno que es JSON
  válido sin forma OTLP. El segundo es el que un parser ingenuo deja pasar.
- La allowlist (R6) se prueba mandando un evento que incluye `prompt` y `response` con texto, y
  afirmando que el archivo no los contiene. Es un test de lo que NO se escribió.
- R7 se prueba de forma estructural, recorriendo los assets enviados y el `src` de la CLI: nada
  fuera de `collect.ts` puede llamar a `listen`. Falla nombrando el archivo, igual que
  `agent-descriptions.test.ts` sostiene su convención.
- La degradación (R9, R12) se prueba con una sesión **sin** archivo de eventos, afirmando que el
  reporte sale y que declara la ausencia. Es el modo en que el 100% de las sesiones existentes
  van a correr.

## Migration

Ninguna. Todo es aditivo: una sesión sin archivo de eventos produce hoy y seguirá produciendo el
mismo reporte más una línea que declara la ausencia. No cambia el formato del log de hooks, ni el
del transcript, ni la forma del JSON ya publicado.

## NOT in scope

- **Renderizar las variables de entorno en `settings.json`.** El `env` de `settings.json` es
  estático y global al repo: quedaría activo en toda sesión, y en las que nadie esté escuchando
  Claude Code intentaría exportar cada segundo contra un puerto muerto. Es exactamente el "costo
  de estar apagado" que ya obligó a rediseñar `audit-log.sh` (~48 ms por comando de shell para
  una feature que nadie había encendido). Mientras el receptor sea manual, el entorno también:
  se exporta en la terminal de la sesión que se quiere auditar y muere con ella.
- **Los demás eventos del catálogo**: `api_error` (`status_code`, `attempt`), `cost_usd`,
  `mcp_server.name`, `tool_result.error_type`, `api_refusal`, y los cuerpos crudos de API. Todos
  tienen valor y ninguno justifica por sí solo el receptor; entran cuando haya evidencia de que
  el pipeline de dos eventos funciona.

  `tool_result.error_type` merece una nota: #686 ya clasifica los errores de tool desde el
  transcript, por prefijo. El atributo del host haría con esa taxonomía lo mismo que `skill.name`
  hace con la heurística de skills — cambiar inferencia por dato declarado. Es el tercer punto
  ciego natural, y la razón de dejarlo fuera es de secuencia, no de valor: primero se demuestra
  que la tercera fuente llega y se une bien.
- **Las métricas de OTel.** Son otra señal, otro exportador y otro consumidor. navori ya deriva
  de tokens lo que las métricas darían agregado.
- **`http/protobuf` y `grpc`.** Se soportan del lado del host; el receptor solo habla `http/json`
  y lo dice en su salida.
- **Reemplazar la heurística de skills.** R12 es explícito: la fuente nueva agrega evidencia. La
  remedición de activación se rehará con ambas y se comparará, que es el único modo de saber
  cuánto se equivocaba la heurística.
