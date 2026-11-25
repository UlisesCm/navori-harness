# Preguntas interactivas nativas en Rust (0.13.x, rebanada 1)

## Resultado

Quien usa navori corre `backup restore`, `migrations restore`, `remove` o `sync` sin banderas en su terminal, o `sync --interactive`, y el binario `navori-rust` hace él mismo las preguntas que hoy hace el CLI de TypeScript, sin Node. Ve el mismo texto, las mismas opciones, el mismo valor por omisión y el mismo efecto de cada respuesta. Cancelar nunca escribe nada. Sin terminal interactiva, el binario nunca se queda esperando (Q1 decide cómo responde). Las demás rebanadas de 0.13.x reusan esta base.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, terminal interactiva y un repo de prueba con un respaldo, una migración aplicada, un harness instalado y un `sync` con dos bloques en conflicto.

1. `navori backup restore <ts>` y pulsar Enter. **Esperado:** la pregunta del TS con "no" por omisión; nada cambia y sale con 0.
2. Repetirlo y responder "sí". **Esperado:** el mismo árbol que `backup restore --yes`.
3. `navori migrations restore <ts> <repo>`, primero Enter y después "sí". **Esperado:** igual que los pasos 1 y 2.
4. `navori remove <plugin>` y pulsar Enter. **Esperado:** la pregunta del TS con su valor por omisión (hoy "sí"; ver Q3) y su efecto; en otra copia, "no" no borra nada.
5. `navori sync` con los conflictos y elegir en corridas separadas `skip-conflicts`, `abort` e `interactive`. **Esperado:** las opciones y efectos del TS; `interactive` pregunta bloque por bloque.
6. `navori sync --interactive` y elegir "mantener el mío" en un bloque y "aceptar el nuevo" en el otro. **Esperado:** el diff del TS y cada bloque según lo elegido.
7. Pulsar Ctrl-C a mitad del paso 6, después de responder el primer bloque. **Esperado:** no escribe ningún bloque y sale con 0, como el TS al cancelar.
8. Pendiente de Q1: `echo y | navori backup restore <ts>` y `navori remove <plugin> < /dev/null`. **Esperado:** ninguno se queda esperando, y responden según lo que decida Q1.
9. Repetir los pasos 1 y 4 con la config en inglés. **Esperado:** como en el TS, `backup restore` pregunta en español y `remove`, en inglés.
10. `navori backup restore <ts>` con un respaldo que no existe y con uno vacío. **Esperado:** el mensaje del TS y exit 1, sin pregunta.

## Reglas aplicables

- R1 — Las preguntas usan `dialoguer` (dependencia nueva, aprobada por Ulises el 24 nov). No entra otra biblioteca de interfaz en el binario.
- R2 — El texto, las opciones, el orden, el valor por omisión de cada pregunta (`backup` y `migrations`: "no"; `remove`: el que decida Q3) y el flujo donde se dibujan son los del TS. El idioma también: `backup restore` y `migrations restore` usan siempre el idioma por omisión (español); `remove` y `sync`, el de la config.
- R3 — Cancelar con Ctrl-C, Esc, EOF o "no" nunca escribe ni borra, y sale con 0, como el TS. Una tecla que el TS no usa para cancelar tampoco cancela en el binario.
- R4 — Pendiente de Q1. Sin terminal interactiva en la entrada, el binario nunca se queda esperando. Propuesta: sale con error, sin escribir, y nombra la bandera que responde. Hoy el TS toma la respuesta de una tubería, sale con 13 en EOF o se queda colgado.
- R5 — Con una bandera que responde la pregunta, el comando no pregunta, como hoy.
- R6 — `backup restore`, `migrations restore`, `remove` y `sync` salen de la delegación permanente a TS, y `sync --interactive`, de la transitoria. Esto revierte la decisión de mantenerlos en TS (18 y 22 nov) por la de Ulises del 24 nov.
- R7 — Un fallo a mitad de un `restore` deja el repo como lo deja el TS: copia archivo por archivo y lo informa.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Respaldo inexistente o vacío: el mensaje del TS y exit 1, sin pregunta. Sin conflictos en `sync`: no pregunta. |
| Error | Respaldo ilegible: el error del TS, sin escribir. Sin terminal: el error de R4. |
| Sin conexión | n/a: ninguna de estas preguntas usa la red. |
| Sin permiso | Archivo sin escritura a mitad de un `restore`: el error del TS y lo que R7 deja. |

## Entorno y datos

- Inventario en H (`997128b9`): las cuatro entradas están en `PERMANENT_DELEGATION` (`scripts/js/rust-areas.mjs:121-144`), y `sync --interactive` en la transitoria. Llamadas de clack: `backup` 1, `migrations` 1, `remove` 1 y `sync` 4, dos de ellas del resolutor de `--interactive` (`packages/cli/src/commands/sync.ts:1053` y `:1097`), al que también se llega desde la opción `interactive` del primer select (`:400-402`).
- Desafío del auditor (24 nov), incorporado; resumen en el PR de esta spec.
- Pregunta abierta Q1 para Ulises: ¿se acepta la propuesta de R4, que diverge del TS sin terminal?
- Pregunta abierta Q3: `remove` borra con "sí" por omisión. ¿Se mantiene, por paridad con el TS, o pasa a "no" en los dos, por ser destructivo?
- Pregunta abierta Q2: ¿se aprueba una dependencia de desarrollo para manejar una terminal (PTY) en el oráculo? Sin ella, los pasos 1 a 7 se prueban a mano en cada plataforma.
- Área crítica: escrituras y borrados de `restore`, `remove` y `sync` en el repo del usuario.

## Fuera de alcance

- Las preguntas de `init`, `refresh`, `add` y `update`: rebanadas 0068 y 0069, sobre esta base.
- `configure`: segunda tanda, después de estas preguntas.

## Tareas

1. La base de preguntas nativa existe con `dialoguer` y cumple R2 y R3; R4 cuando se decida Q1.
2. `backup restore` y `migrations restore` preguntan en el binario.
3. `remove` pregunta en el binario.
4. `sync` pregunta en el binario, incluido el resolutor de `--interactive`.
5. El oráculo compara cada pregunta, su cancelación y su efecto con el TS.
6. Las entradas salen de las delegaciones permanente y transitoria, y `cutover:check` lo refleja.
7. El guion pasa sobre el binario construido, sin Node en `PATH`.
