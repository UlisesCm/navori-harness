# Redefinición de `navori audit` — Requirements

## Context

`navori audit` reporta cómo corrió de verdad el harness (atribución de tokens y huecos
de adherencia). Hoy falla en tres frentes verificados sobre datos reales:

1. **Falla abierta.** `navori audit --stop` sin id no sella nada y cae al reporte global,
   en silencio. El operador lee el reporte como confirmación de un sellado que no ocurrió.
2. **Se dispara al hablar de ella.** El hook detecta `audit mode` por subcadena en el
   prompt, así que mencionar la feature —el caso más frecuente mientras se desarrolla—
   pide activarla. Y apagarla exige la frase literal, que encender no exige.
3. **Captura y no muestra.** `AgentRun` ya guarda skills, tools, tokens, arranque,
   fricción, duración y veredicto por subagente; el Markdown renderiza una línea por
   agente y tira el resto.

Esta spec redefine la unidad de reporte (una ficha por subagente), convierte el log de
sesión en la fuente de verdad del harness (los hooks se auto-registran), reestructura la
salida en carpetas por sesión, y hace explícita la activación.

Público: el operador del harness (hoy, Ulises) auditando sus propias sesiones.

## Requirements (EARS)

### Activación explícita

- **R1** — WHEN `navori audit --start` recibe un id de sesión, el sistema SHALL crear el
  log de esa sesión y confirmar en su salida la ruta del archivo creado.
- **R2** — IF `--start` o `--stop` se invocan sin valor (cadena vacía), THEN el sistema
  SHALL terminar con error y código de salida distinto de 0, nombrando la bandera que
  quedó sin id, y SHALL NOT generar ningún reporte.
- **R3** — El hook `UserPromptSubmit` SHALL NOT proponer activar ni desactivar audit-mode
  a partir del texto del prompt.
- **R4** — WHEN audit-mode está activo, el hook `UserPromptSubmit` SHALL registrar el
  prompt tecleado en el log de la sesión.

### El log como fuente de verdad

- **R5** — WHEN un hook managed se ejecuta y audit-mode está activo para esa sesión, el
  hook SHALL registrar en el log un evento con su nombre, su fase (`PreToolUse`,
  `SessionEnd`, …), su veredicto y su duración en milisegundos.
- **R6** — IF audit-mode no está activo para la sesión, THEN el registro de hooks SHALL
  no escribir nada y SHALL NOT alterar el código de salida ni la salida estándar del hook.
- **R7** — IF el registro de un evento falla por cualquier causa, THEN el hook SHALL
  continuar su ejecución normal y terminar con el código que le corresponde por su propia
  lógica.

### La ficha por agente

- **R8** — El reporte Markdown SHALL emitir, por cada subagente, una ficha con su tipo,
  descripción, modelo, duración, tokens desglosados en arranque / razonamiento / contexto,
  `cache_read`, skills, tools, servidores MCP, hooks y veredicto.
- **R9** — El reporte SHALL agregar las llamadas a tools MCP por servidor, nombrando las
  operaciones invocadas de cada uno.
- **R10** — El reporte SHALL distinguir una skill invocada por la tool `Skill` de una
  detectada por lectura de su `SKILL.md`, indicando en la ficha cuál de las dos rutas la
  registró.
- **R11** — IF un `SKILL.md` aparece por el listado de un directorio o por un glob, THEN
  el sistema SHALL excluirlo de las skills usadas y SHALL reportar cuántas descartó.
- **R12** — El reporte SHALL indicar la duración de cada corrida de subagente.
- **R13** — El reporte SHALL distinguir la suma de duraciones de los subagentes del
  tiempo de reloj que ocuparon, cuando sus ventanas de ejecución se solapan.
- **R14** — El resumen que el comando imprime al terminar SHALL nombrar el total
  facturable, no solo el de arranque.
- **R19** — El reporte SHALL indicar, por cada servidor MCP que el harness instruye a usar
  y por cada subagente, si el servidor estaba alcanzable según el `tools:` declarado de ese
  agente, distinguiendo "disponible y no usado" de "vedado por la allowlist".
- **R20** — IF un subagente recibe instrucciones de un servidor MCP que su `tools:` no le
  permite alcanzar, THEN el reporte SHALL cuantificar los tokens de esas instrucciones que
  pagó en su arranque.
- **R21** — WHEN un subagente arranca o termina y audit-mode está activo, el sistema SHALL
  registrar en el log su identificador, su tipo, su modelo, el turno que lo originó y, al
  terminar, su duración y su veredicto.
- **R22** — El sistema SHALL registrar los eventos de hook cuyo veredicto es que no les
  correspondía actuar, en vez de omitirlos.

### Estructura de salida

- **R15** — WHEN se audita una sesión, el sistema SHALL escribir su log, su JSON y su
  Markdown bajo un directorio propio de esa sesión, nombrado por su fecha e id.
- **R16** — WHEN un reporte cubre más de una sesión, el sistema SHALL escribirlo bajo un
  directorio de rango propio, e incluir en él el índice de las sesiones que agrega.
- **R17** — El JSON del reporte SHALL declarar `schemaVersion: 2`.
- **R18** — El sistema SHALL NOT borrar, mover ni reescribir los reportes ni los logs
  escritos por versiones anteriores.
