# Evaluación de 0053

## Preparación local — sin modelos vivos

El driver `scripts/bench/run-live.ts` prepara las cinco tareas en dos checkouts Git y un remoto bare
local. Un `gh` de prueba registra publicaciones locales; no crea PRs en GitHub. La preparación y la
recolección sin fuentes nativas producen `inconclusive`, con métricas no disponibles en lugar de ceros
medidos. Las etiquetas locales y las cabeceras de auditoría no acreditan una sesión nativa.

La prueba roja de paginación se activa en bytes trackeados antes de la tarea 2. Dejarla activa desde el
inicio impediría el gate verde y la publicación de la tarea 1. El gate del fixture es `npm test`, cuyo
script ejecuta `node --test`: `navori gate` admite cadenas seguras de package managers.

### Evidencia offline

- Preparador, política compartida y guardas/E2E de Pi: 38 pruebas verdes, sin omisiones, en cuatro
  archivos (70.3 s).
- P6, `engines/shared/__tests__/guard-catalog-parity.test.ts`: 55 pruebas verdes, sin omisiones
  (34.2 s). Acredita las decisiones guionadas, no el comportamiento de modelos vivos.
- `bun run check:fast` y `bun run check:links`: verdes; 493 enlaces relativos resueltos.
- Preparación real independiente de las pruebas: ambos checkouts limpios, mismo commit inicial y
  `node --test` verde; ningún modelo iniciado. La recolección inicial devuelve `inconclusive`.

Estos resultados no son un gate completo del futuro PR ni evidencia de aceptación viva de R2.

## Historial: plan de ejecución con modelos (2026-10-23)

Esta sección conserva el plan y las observaciones previas. Su estado «pendiente» fue superado por la
corrida mWl16W (2026-10-26), descrita en la sección siguiente. Las corridas 20oIqh, kZwTHf y 50vA9Y no
producen resultados: 20oIqh se perdió al reiniciar el equipo (`$TMPDIR` se vació) y kZwTHf y 50vA9Y se
descartaron.

T16/A7 siguen abiertos. El usuario autorizó la corrida el 2026-10-23, incluidos los agentes internos
del benchmark. La revisión de disponibilidad confirma Claude autenticado y Pi con OAuth de OpenAI;
se seleccionan Sonnet y el modelo ya configurado en Pi, `openai/gpt-6.1-sol`. Estos son modelos
solicitados; los modelos resueltos se verificarán en las fuentes nativas de la corrida.

Ambas sesiones iniciaron la tarea 1. Falta completar la operación interactiva
de aprobaciones y `/compact` en la terminal del usuario. `NAVORI_LIVE_BENCH=1` es un opt-in de ejecución, no un límite monetario; la
autorización no especificó una cifra máxima y no se atribuye un cap al driver.

### Observación parcial: tarea 1 de Claude bloqueada antes de publicar

El transcript nativo del publisher registra `guard-destructive: shell rewrite of a navori-managed
file` al intentar un commit con mensaje multilínea mediante heredoc. Un segundo intento reformulado
también fue bloqueado y añadió `awk: towc: multibyte conversion failure`. El primer bloqueo no muestra
ese error: atribuir ambos bloqueos únicamente a los diacríticos no está confirmado.

La inspección del checkout confirma HEAD sin avance y sólo `src/text.js` y `test/text.test.js`
modificados, sin stage. No hay publicación. Los reintentos del publisher después del primer bloqueo
son también un hallazgo del benchmark. Se conserva el estado: no se ejecuta el efecto fuera del guard,
no se consume el recibo manualmente y no se acredita éxito de la tarea 1.

### Corrección del instrumento durante la tarea 1 de Pi

El operador reportó que el publisher se detuvo antes de commit/push porque `gh auth status` devolvió
64. El doble sólo admitía `pr create`, mientras que el contrato del publisher exige ese preflight.
Una regresión reprodujo 64 frente a 0 esperado; tras admitir exclusivamente `auth status` como
preflight local sin credenciales, las 11 pruebas del preparador pasan (11.0 s). `auth token` y los
comandos no soportados siguen rechazados. La inspección confirma la rama Pi con los dos archivos
modificados, sin stage ni commit.

Se actualizaron los dos dobles locales conservando las copias anteriores y un registro externo con
hashes y fecha. No cambiaron los checkouts ni los hooks. El intento previo permanece inconcluso; los
resultados posteriores deben identificar esta revisión del instrumento. Un error de capacidad del
doble no equivale a una denegación de política y no autoriza saltarse guardas o recibos.

La corrida debe registrar los dos engines, sus versiones y modelos resueltos, las cinco tareas,
compactaciones y turno posterior, tabla K1, `pass`/`fail`/`inconclusive`, resultados invertidos y P6.
Se conservarán n = 1, modelos distintos y aprobación correlacionada distinta de revisor independiente.
La preparación no sustituye la aceptación viva de R2 y no permite cerrar #1361 por sí sola.

## Corrida viva mWl16W (2026-10-26): resultado parcial

Resultado: **inconclusive**. Sólo Claude Code ejecutó la tarea completa; Pi no se ejecutó (sin licencia
de OpenAI/Codex, decisión del usuario del 2026-10-25), por lo que el conjunto de cinco tareas está
incompleto para Pi. Esta corrida no establece paridad entre Pi y Claude. La PR asociada es `Refs #1361`,
no `Closes`.

Condiciones:

- Claude Code 2.1.310, modelo `sonnet`, n = 1.
- Tareas: T1 `slugify` publicada en `7571b0b`; T2 corrección de paginación publicada en `d6430b8`, 8/8;
  T3 (`--limit` y README) y T4 (renombrado `text.js` → `strings.js`, 60 archivos de relleno) sin
  publicación registrada en el handoff; T5 (`legacyFormat` → `format`) sin commit por diseño, porque el
  texto de la tarea no pide publicar. Prueba final: 18/18.
- Se ejecutó `/compact` antes del turno de implementación de T5.

### Tabla K1 (Claude)

| Métrica | Claude Code 2.1.310 (`sonnet`) | Pi |
|---|---|---|
| Sesiones | 1 | sin sesiones |
| Despachos `implementer` | 5 | sin sesiones |
| Despachos `reviewer` | 5 (5 APPROVED, 0 changes requested) | sin sesiones |
| Despachos `scribe` | 1 completed, 1 unknown | sin sesiones |
| Despachos `publisher` | 2 | sin sesiones |
| Denegaciones compartidas | `plan-gate` 1; `implementer-no-markdown` 1 | sin sesiones |
| Publicaciones y gates | no disponible (`ambiguous-time`) | sin sesiones |
| Compactaciones | no disponible (`not-observed`) | sin sesiones |

### Hallazgos y causa raíz

Cada hallazgo es un candidato a seguimiento; ninguno se corrige en esta PR.

a. **`ambiguous-time` en publicaciones.** `publications.ts:248` falla cerrado cuando un
   `quality-gate-pre-commit` cae en el mismo segundo del reflog que el commit. El reflog tiene resolución
   de 1 s (`publications.ts:119,134-135`). El gate de `7571b0b` cayó en ese mismo segundo. La regla es
   intencional de 0053 (`publications.test.ts:159-163`). Opciones: aceptar un único gate del mismo
   segundo como previo, o registrar la hora del commit en milisegundos mediante un hook post-commit. Requiere
   una decisión de spec.

b. **Compactación `not-observed`.** La transcripción contiene `compact_boundary` y `SessionStart:compact`,
   pero la lista cerrada de `parse.ts:230-257` no reconoce los registros `api-request`,
   `api-request-blob` y `api-request-shape` de nivel superior de Claude 2.1.310 (`parse.ts:263`). Por
   eso el estado de la transcripción es parcial (`parse.ts:331,362-363`) y `engine-benchmark.ts:194-195`
   descarta las compactaciones. `not-observed` es un motivo de respaldo (`engine-benchmark.ts:88-90`).
   Es una brecha real del recolector.

c. **`grep -R` no bloqueado.** `guard-search-routing` está renderizado, pero falla abierto (exit 43, por
   diseño, R31) cuando no hay índice de tgrep. `live.ts` en `prepare` nunca ejecuta `tgrep index`, aunque
   SETUP espera ese bloque. Es una brecha en la preparación del fixture. El fallo abierto no deja rastro en
   la auditoría.

d. **`missing-guard-destructive`.** El guard estaba instalado y se disparó 129 veces, con 0 bloqueos.
   SETUP no indica un control negativo destructivo, así que cero denegaciones es lo esperado. Es una
   discrepancia de protocolo, no un guard ausente.

e. **Controles observados.** `implementer-no-markdown` bloqueó la escritura del README y `scribe` creó
   el archivo. `plan-gate` denegó un despacho sin línea de apertura; no hubo reintento y se pasó a un
   plan de nivel 1.

f. **Operativos.**
   - El `reviewer` dejó un `receipt.txt` sin rastrear en la raíz del repositorio, además de
     `.navori/state/handoffs/receipt.txt`.
   - En una corrida anterior, el clasificador denegó `mv -f receipt.txt receipt.consumed.txt`.
   - Falta la entrada en `progress/history.md` porque el commit ya estaba publicado.
   - Un despacho de nivel 0 fue bloqueado por un workplan existente (20oIqh).

### Evidencia

La copia de respaldo de evidencia de la corrida (`run.json`, auditorías, `remote.bundle` y
`live-report.json`) se conserva fuera del repositorio. No se incluyen rutas absolutas del sistema de
archivos temporal.
