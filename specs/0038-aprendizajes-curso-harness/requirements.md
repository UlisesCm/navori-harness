# Aprendizajes del curso de harness engineering — Requirements

**Fecha:** 2026-09-30 · **Estado:** absorbida por la [spec 0039](../0039-claude-first/requirements.md); no se implementa por separado.
**Base del checkout:** `cb32c6c5b309d0a9fe71584aa3748fcb5db03843`.
**Evidencia:** [evidence.md](evidence.md) — curso, código de navori y documentación oficial de
Claude Code y Codex, con fuentes y contradicciones.

## Context

El curso `walkinglabs/learn-harness-engineering` propone mecanismos para que los agentes no
declaren éxito sin evidencia, no se atasquen repitiendo el mismo fallo y no acumulen reglas que
nadie usa. navori ya cubre la mayor parte (ver evidence.md § "Lo que navori ya cubre"). Esta spec
toma solo las brechas confirmadas en el código y las contrasta con lo que cada host soporta de
forma oficial. Prioridad de DIRECTION: calidad > tokens > velocidad.

## Alcance y decisiones conservadoras

- Cinco brechas: G (gating de estado), S (atasco), V (reviewer), P (captura de hallazgos),
  U (uso agregado). Todo lo demás del curso queda fuera (ver design.md § NOT in scope).
- navori genera, no ejecuta (invariante 9), sin excepciones: la evidencia de un criterio la
  produce el host al ejecutar el comando, y un hook solo la registra.
- Ningún hook nuevo bloquea herramientas del agente ni altera su resultado; el único rechazo nuevo
  es el de `navori plan update` (R3).
- Cada mecanismo declara su degradación en Codex; un soporte no verificable en los docs oficiales
  se documenta como tal, no se inventa.

## Requirements (EARS)

### G — Gating de estado de los criterios de aceptación

navori no ejecuta el `command` de ningún criterio: lo ejecuta el host, bajo sus propios hooks y
permisos, y un hook registra el resultado. Ver design.md § D1 y el challenge que descartó ejecutar
desde la CLI.

- **R1** — WHEN una ejecución Bash del agente termina con éxito y su comando coincide con el
  `command` de un `A<n>` de algún workplan del checkout, the system SHALL registrar evidencia
  (feature, `A<n>`, comando, `HEAD`, árbol sucio o limpio, directorio, fecha) en un log de
  solo-anexar bajo `.navori/state/`.
- **R2** — WHEN `navori plan update` recibe `--progress A<n>=cumplido`, the system SHALL aceptar la
  transición solo si existe evidencia de R1 para ese `A<n>` con el `command` actual del criterio y
  el `HEAD` actual del árbol donde corrió.
- **R3** — IF no existe evidencia válida THEN the system SHALL rechazar la transición, conservar el
  estado previo de `A<n>`, terminar con código distinto de 0 e imprimir qué falta, por qué y el
  comando exacto que debe ejecutarse (formato ERROR / WHY / FIX).
- **R4** — The system SHALL NOT ejecutar el `command` de un criterio desde la CLI de navori ni
  desde un hook.
- **R5** — WHERE el engine no expone una señal de éxito verificable para Bash, the system SHALL
  aceptar `cumplido` sin evidencia registrándolo como no evidenciado, y `navori doctor` SHALL listar
  el control como no soportado para ese engine.
- **R6** — WHEN `plan check` o `plan render` leen un workplan, the system SHALL distinguir un `A<n>`
  `cumplido` con evidencia de uno sin evidencia, sin cambiar el resultado `ok` de `plan check`.
- **R6b** — WHEN el reviewer revisa un cambio con workplan, the reviewer SHALL reportar cada `A<n>`
  `cumplido` sin evidencia como hallazgo de Pass 1.

### S — Detección de atasco

Condicionado a la sonda U1 (design.md § Verificaciones pendientes): IF `PostToolUseFailure.error`
no trae la salida del comando THEN R7–R10 se difieren a otra spec en lugar de implementarse con una
firma gruesa.

- **R7** — WHEN el mismo comando falla con la misma firma de error por tercera vez consecutiva
  dentro de una sesión, the system SHALL inyectar un aviso aditivo al modelo que indique cambiar
  de enfoque o escalar al usuario.
- **R8** — The system SHALL guardar el estado de fallos repetidos bajo `.navori/state/hooks/`,
  indexado por `session_id`, sin versionarlo.
- **R9** — IF el hook de atasco falla, excede su tiempo límite o no puede leer su estado THEN the
  system SHALL terminar sin bloquear la herramienta ni alterar su resultado.
- **R10** — WHERE el engine es Codex, the system SHALL registrar el aviso de atasco solo si su
  forma de entrega no reemplaza el resultado de la herramienta; en otro caso SHALL documentarlo
  como no soportado en el reporte de `navori doctor`.

### V — Reviewer adversarial

- **R11** — The system SHALL permitir que el handoff del implementer declare una lista opcional
  de dudas, cada una con archivo y motivo.
- **R12** — WHEN el handoff del implementer trae dudas, the reviewer SHALL responder a cada una
  en su veredicto con una conclusión y evidencia `file:line`.
- **R13** — WHEN el reviewer emite `APPROVED` sin hallazgos bloqueantes, the reviewer SHALL
  declarar qué revisó en cada dimensión de Pass 2, en lugar de un aprobado sin cobertura.

### P — Captura estructurada de hallazgos

- **R14** — WHEN el reviewer emite un veredicto, the system SHALL registrar sus hallazgos de score
  ≥ 50 como registros estructurados (categoría, severidad, score, archivo) en un log de
  solo-anexar bajo `.navori/state/`, que no se sobrescribe entre features.
- **R15** — *Diferido a otra spec.* Resumir categorías repetidas como candidatas a regla requiere
  datos que hoy no existen (17 reviews locales, 6 hallazgos con score, ninguno con categoría).
  Criterio de entrada: ≥ 30 hallazgos en el log de R14, de ≥ 10 features distintas.

### U — Uso agregado del harness

`navori audit --days N` ya agrega el uso de skills por sesión con ceros explícitos
(`lib/audit/report.ts` — `tallySkills`, `skillRangeSection`); U cubre solo lo que falta.

- **R16** — WHEN `navori audit` genera un reporte de rango, the system SHALL contar en cuántas
  sesiones se invocó cada agente declarado, incluidos los que tienen cero invocaciones.
- **R17** — The system SHALL marcar como candidata a revisión cada skill o agente managed sin
  invocaciones en las sesiones del rango, junto con el número de sesiones consideradas.
