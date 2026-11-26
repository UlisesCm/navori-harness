# Preguntas interactivas nativas en Rust (0.13.x, rebanada 1)

## Resultado

Quien usa navori corre `backup restore`, `migrations restore`, `remove` o `sync` sin banderas en su terminal, o `sync --interactive`, y el binario `navori-rust` hace él mismo las preguntas que hoy hace el CLI de TypeScript, sin Node. Ve el mismo texto, las mismas opciones y el mismo efecto de cada respuesta; el valor por omisión también es el del TS, salvo en `remove`, que pasa a "no". Cancelar nunca escribe nada. Sin terminal interactiva, el binario falla con un error que nombra la bandera no interactiva, sin leer la tubería ni quedarse esperando. Las demás rebanadas de 0.13.x reusan esta base.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript, terminal interactiva y un repo de prueba con un respaldo, una migración aplicada, un harness instalado y un `sync` con dos bloques en conflicto.

1. `navori backup restore <ts>` y pulsar Enter. **Esperado:** la pregunta del TS con "no" por omisión; nada cambia y sale con 0.
2. Repetirlo y responder "sí". **Esperado:** el mismo árbol que `backup restore --yes`.
3. `navori migrations restore <ts> <repo>`, primero Enter y después "sí". **Esperado:** igual que los pasos 1 y 2.
4. `navori remove <plugin>` y pulsar Enter. **Esperado:** la pregunta del TS con "no" por omisión; nada se borra. En otra copia, "sí" borra igual que `remove --yes`.
5. `navori sync` con los conflictos y elegir en corridas separadas `skip-conflicts`, `abort` e `interactive`. **Esperado:** las opciones y efectos del TS; `interactive` pregunta bloque por bloque.
6. `navori sync --interactive` y elegir "mantener el mío" en un bloque y "aceptar el nuevo" en el otro. **Esperado:** el diff del TS y cada bloque según lo elegido.
7. Pulsar Ctrl-C a mitad del paso 6, después de responder el primer bloque. **Esperado:** no escribe ningún bloque y sale con 0, como el TS al cancelar.
8. `echo y | navori backup restore <ts>` y `navori remove <plugin> < /dev/null`. **Esperado:** ninguno lee la tubería ni se queda esperando; los dos salen con un código distinto de 0, sin escribir, y nombran `--yes`.
9. Repetir los pasos 1 y 4 con la config en inglés. **Esperado:** como en el TS, `backup restore` pregunta en español y `remove`, en inglés.
10. `navori backup restore <ts>` con un respaldo que no existe y con uno vacío. **Esperado:** el mensaje del TS y exit 1, sin pregunta.

## Reglas aplicables

- R1 — Las preguntas usan `dialoguer` (dependencia nueva, aprobada por Ulises el 24 nov). No entra otra biblioteca de interfaz en el binario.
- R2 — El texto, las opciones, el orden, el valor por omisión de cada pregunta (`backup` y `migrations`: "no"; `remove`: "no", ver R8) y el flujo donde se dibujan son los del TS. El idioma también: `backup restore` y `migrations restore` usan siempre el idioma por omisión (español); `remove` y `sync`, el de la config.
- R3 — Cancelar con Ctrl-C, Esc, EOF o "no" nunca escribe ni borra, y sale con 0, como el TS. Una tecla que el TS no usa para cancelar tampoco cancela en el binario.
- R4 — Sin terminal interactiva en la entrada, el binario no pregunta, no lee la tubería y no espera: sale con un código distinto de 0, sin escribir, y con un error que nombra la bandera no interactiva (por ejemplo `--yes`). Diverge del TS a propósito (decisión de Ulises, 24 nov): hoy el TS toma la respuesta de una tubería, sale con 13 en EOF o se queda colgado.
- R5 — Con una bandera que responde la pregunta, el comando no pregunta, como hoy.
- R6 — `backup restore`, `migrations restore`, `remove` y `sync` salen de la delegación permanente a TS, y `sync --interactive`, de la transitoria. Esto revierte la decisión de mantenerlos en TS (18 y 22 nov) por la de Ulises del 24 nov.
- R7 — Un fallo a mitad de un `restore` deja el repo como lo deja el TS: copia archivo por archivo y lo informa.
- R8 — `remove` pregunta con "no" por omisión, porque borra (decisión de Ulises, 24 nov; el TS usa "sí"). El cambio va en las notas del release de la versión que lo publique.

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
- Decisiones de Ulises (24 nov): R4 sin terminal; R8 para `remove`; y una dependencia de desarrollo para manejar una terminal (PTY) en el oráculo, que no viaja en el binario.
- Área crítica: escrituras y borrados de `restore`, `remove` y `sync` en el repo del usuario.

## Fuera de alcance

- Las preguntas de `init`, `refresh`, `add` y `update`: rebanadas 0068 y 0069, sobre esta base.
- `configure`: segunda tanda, después de estas preguntas.

## Tareas

1. La base de preguntas nativa existe con `dialoguer` y cumple R2 a R4.
2. `backup restore` y `migrations restore` preguntan en el binario.
3. `remove` pregunta en el binario.
4. `sync` pregunta en el binario, incluido el resolutor de `--interactive`.
5. El oráculo, con una terminal de prueba (PTY), compara cada pregunta, su cancelación y su efecto con el TS, y comprueba R4 y R8 donde difieren.
6. Las entradas salen de las delegaciones permanente y transitoria, y `cutover:check` lo refleja.
7. El guion pasa sobre el binario construido, sin Node en `PATH`.
