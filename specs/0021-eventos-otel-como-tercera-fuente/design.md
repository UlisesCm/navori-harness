# Eventos OTel como tercera fuente de `navori audit` — Design

## Approach

Tres fuentes, **un archivo**. El log de sesión ya es el lugar donde el harness registra lo que
hizo; los eventos del host entran ahí por la misma puerta, con `O_APPEND` y una línea JSON por
evento. No hay sidecar, no hay paso de volcado al cerrar, y no hay pregunta sobre qué pasa si la
sesión muere antes del `--stop`: lo que se escribió, se escribió.

Esto es viable ahora y no antes. Los eventos llegan batcheados cada segundo, así que aterrizan
intercalados con los del harness y fuera de orden respecto a ellos. #689 acaba de agregar `tsMs` y
`chronological()`, que es exactamente lo que hace ordenable un archivo con dos escritores. Sin eso
esta forma no funcionaría y habría que pagar el sidecar.

Escribir concurrente desde dos procesos es el modo en que el archivo ya opera: `parse.ts` documenta
que *"two writes racing on the same append leave the file ordered by arrival"*. Los registros van
muy por debajo de `PIPE_BUF`, donde `O_APPEND` es atómico en POSIX, así que un tercer escritor no
cambia el modelo — solo lo usa.

**navori provee el receptor; el operador lo ejecuta.** `navori audit --collect` levanta un servidor
HTTP en loopback y escribe hasta que el operador lo corta. Eso mantiene intacto el invariante 9:
navori genera el harness y provee herramientas, pero no arranca procesos por su cuenta. R9 lo
vuelve verificable en vez de dejarlo como promesa.

Trade-offs descartados:

- **navori levanta el receptor solo en `--start` o `--arm`.** Cero fricción, pero contradice el
  invariante 9 y exigiría enmendarlo. No se paga esa enmienda antes de tener evidencia de que el
  pipeline sirve.
- **`otelcol` externo con un `collector.yaml` renderizado.** Ortodoxo respecto al invariante 9,
  pero agrega una dependencia binaria y deja el formato en disco definido por un YAML en vez de
  por navori.
- **`OTEL_LOGS_EXPORTER=console`.** La documentación no dice si escribe a stdout o a stderr, y
  cualquiera de las dos corrompe la TUI. Descartado por indefinido, no por costoso.
- **Un archivo `otel-<session>.jsonl` aparte, volcado al log en `--stop`.** Fue el primer diseño.
  Lo mata un caso concreto: una sesión que nunca llega a `--stop` deja los eventos huérfanos en un
  archivo que ningún reporte lee, y recuperarlos exige un volcado idempotente que hay que escribir,
  probar y mantener. Escribir directo no tiene ese estado intermedio.

## Por qué esto NO cuelga de `--arm`

Vale dejarlo escrito porque la pregunta se va a repetir. El entorno OTel lo lee Claude Code cuando
**arranca su proceso**. `navori audit --arm` marca la sesión después, y su caso central (#599) es
armar la sesión **ya abierta** sin reiniciarla — "No restart, no lost context", dice el partial.
Una bandera que corre cuando el proceso ya nació no puede cambiar el entorno con el que nació.

De ahí que la configuración se ate a `audit.mode` (R10, R11), que es una declaración del repo
evaluada en `render`, y no a `--arm`/`--start`, que son decisiones por sesión. En un repo con
`audit.mode: always` el operador no tiene que acordarse de nada: el entorno ya está, y lo único
manual es levantar `--collect` cuando quiere la tercera fuente.

## Cuánto hay que acordarse de esto

Ninguna vez por sesión. El receptor **no se corre por sesión ni por repo**: un solo proceso sirve
a todos, porque cada evento nombra su propia `session.id` y el destino se resuelve por evento. La
pregunta operativa real no es "¿lo corro otra vez?" sino "¿está corriendo?".

Lo que sí es cierto y hay que decirlo sin adornos: **los eventos emitidos mientras nadie escucha se
pierden**. No hay captura retroactiva — el exportador descarta el lote y sigue. R4 y R14 existen
justamente para eso: el hueco se registra como hueco en vez de renderizarse como "no hubo
aprobaciones manuales".

Dejarlo siempre arriba es trabajo del supervisor que el operador ya use — `launchd` en macOS,
una unidad de usuario de `systemd`, un panel de `tmux`, lo que sea. navori no lo levanta ni lo
vigila, y eso no es una limitación que haya que rodear: es la misma división que ya rige los
hooks, donde navori **declara** y otro proceso **ejecuta**. Un `LaunchAgent` que apunta a
`navori audit --collect` es una declaración más, del mismo tamaño que el fragmento de
`settings.json` que esta spec ya emite.

Generar ese archivo de supervisor es candidato razonable a una spec futura (un plist, una unidad
`systemd`), y queda fuera de ésta a propósito: es superficie por sistema operativo para un archivo
de una línea, y no hace falta para que el receptor funcione.

## Components

- `packages/cli/src/lib/audit/collect.ts` — el receptor: servidor HTTP en loopback, ruta
  `POST /v1/logs`, aplana el sobre OTLP, aplica la allowlist, resuelve el log de destino y marca
  su horizonte. Cubre R1, R2, R3, R4, R5, R6, R8.
- `packages/cli/src/commands/audit.ts` — la bandera `--collect`, su salida de confirmación y el
  fallo por dirección ocupada. Cubre R1, R7.
- `packages/cli/src/engines/claude/` + el esquema de config — el fragmento de `settings.json` con
  el entorno, condicionado a `audit.mode`. Cubre R10, R11.
- `packages/cli/src/lib/audit/parse.ts` — los discriminadores `otel-start`, `tool_decision` y
  `api_request` en el lector del log de sesión, que ya recorre ese archivo. Cubre R4, R12, R13.
- `packages/cli/src/lib/audit/model.ts` — `PermissionDecisions`, `otelFrom` y la variante nueva de
  `SkillSource`, que convive con las dos heurísticas en vez de sustituirlas. Cubre R12, R13, R14.
- `packages/cli/src/lib/audit/report.ts` — rendereo de las decisiones de permiso, de las skills
  declaradas por el host y de la ausencia de la fuente. Cubre R12, R13, R14.

No hace falta un módulo de ingesta: los eventos entran por `readJsonl` con el resto del log.

## Decisions

- **`http/json`, no `http/protobuf` ni `grpc`.** Claude Code acepta los tres; JSON es el único que
  se parsea con `JSON.parse` y deja el receptor en un `node:http` sin una sola dependencia nueva.
  El bundle de la CLI tiene un tope de 1000 KB que hoy ocupa 915 KB — meter un runtime de protobuf
  por observabilidad opcional sería gastar el margen en el lugar equivocado.

- **Un receptor sirve a todas las sesiones y a todos los repos.** El evento nombra su propia
  `session.id`, así que el destino se resuelve por evento. El receptor localiza el log escaneando
  los directorios del store por `session-<id>.log` — el mismo fallback exacto que usa
  `resolveTranscript`, y que no depende de que el host incluya `workspace.host_paths`. El resultado
  se cachea por id: un `readdir` por sesión nueva, no por evento.

- **`otel-start` como horizonte (R4), no un booleano en el reporte.** Es el mismo patrón que
  `hookLogFrom`, que existe porque "no hubo hooks" y "no hubo registro" renderizaban igual. Aquí el
  error equivalente sería leer "0 aprobaciones manuales" en una sesión donde nadie estaba
  escuchando. Y como es un registro en el log, sobrevive al reporte: la respuesta está en el
  archivo, no en la corrida que lo leyó.

- **La sesión no marcada se descarta (R3).** El receptor NO crea el log. Crearlo convertiría a la
  tercera fuente en un activador de audit-mode por la puerta de atrás, cuando el marcado es opt-in
  por diseño (`discovery.ts`). El evento se pierde, y eso es correcto: nadie pidió auditar esa
  sesión.

- **Allowlist, no denylist (R8).** Se persisten `ts`, `tsMs`, `event`, y por tipo —
  `tool`/`decision`/`source` para `tool_decision`, `skill`/`agent`/`model` para `api_request`. Todo
  lo demás se descarta, incluidos `prompt` y `response`. Una denylist obliga a acertarle a cada
  campo nuevo que el host agregue; una allowlist falla hacia no guardar, que es el lado correcto
  cuando el emisor puede mandar el texto del prompt.

- **`api_request` solo se persiste si trae `skill.name`.** Ese evento dispara en cada request y el
  log de sesión ya corre a miles de líneas. Lo demás que trae (`cost_usd`, `agent.name` suelto)
  está fuera de alcance, así que guardarlo sería volumen sin lector.

- **`SkillSource` gana la variante `host`**, y gana a `skill-tool` y a `skill-md` al resolver la
  procedencia de una skill. Es la única de las tres que no es inferencia. Las otras dos se quedan
  tal cual para las sesiones sin tercera fuente (R14).

- **El entorno se renderiza solo con `audit.mode: always` (R10, R11).** Un repo en ese modo ya
  declaró que audita todo, así que el entorno es coherente con lo que pidió. En `opt-in` no se
  emite: ahí la mayoría de las sesiones no se auditan y exportar en todas sería cobrarle a quien
  no pidió.

## Contracts

Las líneas que el receptor agrega al log de sesión, junto a las que ya escriben los hooks:

```json
{"ts":"2026-09-11T18:30:00Z","tsMs":1789497000123,"event":"otel-start","endpoint":"127.0.0.1:4318"}
{"ts":"2026-09-11T18:30:00Z","tsMs":1789497000456,"event":"tool_decision","tool":"Bash","decision":"accept","source":"user_temporary"}
{"ts":"2026-09-11T18:30:04Z","tsMs":1789497004880,"event":"api_request","skill":"structural-search","agent":"researcher","model":"claude-opus-5"}
```

`event` es el nombre del evento del host sin el prefijo `claude_code.`. Los campos opcionales se
omiten cuando el atributo no vino, nunca se escriben vacíos — misma regla que el registro de hooks.
`session.id` no se persiste: el archivo ya es el de esa sesión.

El entorno que `render` emite en `settings.json` para un repo con `audit.mode: always`, y que
`--collect` imprime para quien quiera exportarlo a mano en una sesión suelta:

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
OTEL_LOGS_EXPORT_INTERVAL=1000
```

Las variables de protocolo y endpoint son las **por señal** (`_LOGS_`) para que esto no arrastre
trazas ni métricas si el operador ya tiene otra configuración de OTel.

## Failure modes

- **El entorno está puesto y nadie levantó el receptor.** Claude Code intenta exportar cada segundo
  contra un puerto cerrado. Es un `ECONNREFUSED` local inmediato —sin timeout, y el exportador
  batch descarta el lote en vez de reintentarlo—, así que el costo es ruido en `--debug`, no
  latencia. El log no lleva la marca de R4 y el reporte declara la ausencia.

- **El receptor arranca a media sesión.** El caso mixto, y el que hace que R4 valga la pena: los
  eventos anteriores no existen y no hay forma de recuperarlos. La marca de horizonte cae en el
  instante en que el receptor empezó a escribir, así que el reporte puede decir *desde cuándo* la
  tercera fuente estuvo presente en vez de presentar una cobertura parcial como total. Es el mismo
  problema que `hookLogFrom` resolvió para un harness renderizado a media sesión.
- **El receptor corre pero la sesión no está marcada.** Se descarta (R3). No se crea el log.
- **El receptor muere a media sesión.** El log queda con la marca de R4 y con los eventos hasta ese
  punto, igual que queda más corto cuando se cae una sesión. Se lee lo que haya.
- **Cuerpo ininterpretable, o evento sin `session.id`.** Se descarta y se cuenta (R5). Un evento sin
  sesión no tiene archivo al que pertenecer, y adivinarlo sería inventar la unión que esta spec
  existe para hacer exacta.
- **Dirección ocupada.** Falla temprano y sin tocar disco (R7): el caso típico es un `--collect`
  anterior que sigue vivo.
- **Dos receptores sobre la misma sesión.** No puede pasar por R7 — el segundo no arranca.

## Testing strategy

- El receptor se prueba **por HTTP real** contra un puerto efímero, no llamando a la función
  interna: lo que está en duda es el contrato con un emisor externo (ruta, content-type, código de
  respuesta), y una llamada directa no lo ejerce.
- El descarte de basura (R5) se prueba con un cuerpo que no es JSON **y** con uno que es JSON válido
  sin forma OTLP. El segundo es el que un parser ingenuo deja pasar.
- La allowlist (R8) se prueba mandando un evento que incluye `prompt` y `response` con texto, y
  afirmando que el log no los contiene. Es un test de lo que NO se escribió.
- R3 se prueba con una sesión sin log, afirmando que después de la petición el archivo **sigue sin
  existir**. Es el test que impide que la tercera fuente active audit-mode por la puerta de atrás.
- R9 se prueba de forma estructural, recorriendo el `src` de la CLI y los assets enviados: nada
  fuera de `collect.ts` puede abrir un puerto. Falla nombrando el archivo, igual que
  `agent-descriptions.test.ts` sostiene su convención.
- El orden mezclado se prueba intercalando en un mismo log eventos de hook y eventos OTel con
  `tsMs` desordenado, y afirmando que el reporte los lee en orden real. Es lo que verifica que la
  decisión de escribir en el mismo archivo se sostiene.
- La degradación (R14) se prueba con un log **sin** la marca de R4, afirmando que el reporte sale y
  que declara la ausencia. Es el modo en que corren el 100% de las sesiones existentes.

## Migration

Ninguna. Todo es aditivo: un log sin la marca de R4 produce hoy y seguirá produciendo el mismo
reporte más una línea que declara la ausencia. Los tipos de evento nuevos entran por el mismo
`readJsonl` que ya tolera y cuenta lo que no reconoce, así que un log escrito por esta versión se
lee sin romper en una anterior.

## NOT in scope

- **Los demás eventos del catálogo**: `api_error` (`status_code`, `attempt`), `cost_usd`,
  `mcp_server.name`, `tool_result.error_type`, `api_refusal`, y los cuerpos crudos de API. Todos
  tienen valor y ninguno justifica por sí solo el receptor; entran cuando haya evidencia de que el
  pipeline de dos eventos funciona.

  `tool_result.error_type` merece una nota: #686 ya clasifica los errores de tool desde el
  transcript, por prefijo. El atributo del host haría con esa taxonomía lo mismo que `skill.name`
  hace con la heurística de skills — cambiar inferencia por dato declarado. Es el tercer punto ciego
  natural, y la razón de dejarlo fuera es de secuencia, no de valor.

  **Entró en #698**, cumplida esa condición. Con una diferencia respecto a lo previsto aquí: NO
  reemplaza la taxonomía de #686 ni se mapea sobre ella. Las seis clases de navori y las cadenas
  del host responden la misma pregunta desde fuentes distintas, y forzar la equivalencia habría
  inventado justo la inferencia que el dato declarado viene a quitar — así que el reporte muestra
  las dos y el lector compara. Se persisten solo los `tool_result` que fallaron: el host lo emite
  en cada llamada de herramienta, y es el mismo argumento de volumen que mantiene a `api_request`
  fuera salvo que nombre una skill.

- **Las métricas de OTel.** Son otra señal, otro exportador y otro consumidor. navori ya deriva de
  tokens lo que las métricas darían agregado.

- **`http/protobuf` y `grpc`.** Se soportan del lado del host; el receptor solo habla `http/json` y
  lo dice en su salida.

- **Que navori levante el receptor.** Ni desde `--arm`, ni desde `--start`, ni desde un hook. R9 lo
  sostiene con un test. Reabrirlo exige enmendar el invariante 9 con evidencia de que la fricción
  manual resultó fatal, no antes.

- **Reemplazar la heurística de skills.** R14 es explícito: la fuente nueva agrega evidencia. La
  remedición de activación se rehará con ambas y se comparará, que es el único modo de saber cuánto
  se equivocaba la heurística.
