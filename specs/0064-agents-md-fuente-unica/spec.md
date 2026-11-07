# AGENTS.md como fuente única de la doctrina compartida

## Resultado

Quien renderiza navori con Claude Code obtiene un `CLAUDE.md` que importa `AGENTS.md` (`@AGENTS.md`) y agrega solo lo exclusivo de Claude. Pi lee el mismo `AGENTS.md`, y sus hijos ya no cargan la doctrina del orquestador. El texto del usuario se conserva, el preview muestra todo y el backup se restaura. Va en 0.12.5, después de #1579 y antes de retomar Rust. Issue: #1598, diseño en #1519.

## Reglas aplicables

- **Dos capas.**
  - Compartida: idioma y rol, formato, tipado, operaciones seguras, SDD, tickets, descubrimiento de código y contexto del proyecto. Va en `AGENTS.md`, sin nombres de herramientas ni rutas de un motor.
  - Orquestador: planeación, rol, arranque, catálogo de agentes y los bloques de plugins del orquestador. Llega solo al hilo principal: en Claude por `.claude/context/` y el hook de inicio; en Pi, desde un archivo gestionado bajo `.pi/navori/` que la extensión inyecta solo en el proceso padre.
- **Un solo escritor.** `agents-md` escribe `AGENTS.md` con la misma doctrina para todos los motores. Pi deja de escribirlo y de adaptarle el vocabulario. Lo que cambia por motor (rutas, nombre de la herramienta de subagentes, `TaskCreate`, Glob/Grep pre-aprobados, auto mode, hook `ask`, modo de permisos, monorepo) va en el apéndice gestionado de `CLAUDE.md` o en la capa del orquestador de Pi.
- **Invariante 2.** El core no depende de ningún motor; `claude` y `pi` se apoyan en la salida de `agents-md`. La enmienda de DIRECTION lo dice en los tres idiomas.
- **Invariante 3.** `agents-md` aparece explícito en `engines`, sin motor implícito. Una config con `harnessVersion` anterior a 0.12.5 se migra una vez, con preview y backup. Después, `claude` o `pi` sin `agents-md` hacen fallar a `render` sin escribir nada.
- **Invariante 4.** El contrato de marcadores no cambia. El import va dentro de un bloque gestionado, porque Claude quita los comentarios HTML y la línea del import queda. Fuera de los marcadores no se toca nada. `CLAUDE.local.md` y `.claude/CLAUDE.md` no se tocan.
- **Retiro protegido.** Un bloque compartido sale de `CLAUDE.md` solo si está intacto. Si fue editado a mano, se queda (`retired-kept`). Sin `pi`, ese id se omite en `AGENTS.md`, así que Claude no recibe dos reglas contradictorias. Con `pi`, `AGENTS.md` lo lleva completo; `render` y `doctor` avisan sin quedar verdes y ofrecen dos salidas: aceptar la versión de navori para ese id o mover la edición a la zona del usuario. Un bloque estampado por un CLI más nuevo se respeta, como hoy.
- **CLI viejos.** En el lugar de cada bloque retirado, `CLAUDE.md` guarda un marcador vacío con versión 0.12.5. Un CLI anterior no reinyecta un bloque cuyo marcador es más nuevo. No cuestan tokens. Si aun así aparece una copia vieja intacta, el siguiente render la retira.
- **Texto del usuario en `AGENTS.md`.** Si el archivo ya existe sin marcadores, se conserva y se le agrega el bloque. El prune quita solo el bloque gestionado; el archivo se borra solo si no queda texto del usuario. Hoy lo borra entero, así que hace falta código.
- **Codex** (congelado, #1513): si `codex` está en `engines`, todo queda como hoy, sin import ni inyección en Pi, y con un aviso.
- **Medición.** El presupuesto de palabras y `navori audit` miden `CLAUDE.md` con el import resuelto. Hay goldens de `claude+agents-md` y de `claude+pi+agents-md`.

## Estados

| Estado | Qué ve el usuario |
|---|---|
| Vacío | Repo sin `CLAUDE.md` ni `AGENTS.md`: se crean los dos, cada uno con su zona de usuario. |
| Error | Config ya migrada con `claude` y sin `agents-md`: `render` falla sin escribir y muestra la línea que hay que agregar. |
| Sin conexión | n/a: el render es local. |
| Sin permiso | Archivo de solo lectura: `render --apply` falla, nombra el archivo y `backup restore` deja todo como estaba. |

## Entorno y datos

- Un tarball del CLI con la versión ya subida a 0.12.5 (`npm pack`), el CLI 0.12.4 publicado y repos desechables en `/tmp`, con datos ficticios.
- Fixture A: `engines: ["claude"]`, `harnessVersion` 0.12.4, `CLAUDE.md` con preámbulo propio, texto propio intercalado entre bloques, zona de usuario con texto y `tipado-fuerte` editado a mano.
- Fixture B: `engines: ["claude", "pi"]`, con un `AGENTS.md` previo que tiene texto propio fuera de los marcadores.
- Claude Code v2.1.277 o posterior y Pi 1.5.0.

## Guion de aceptación

1. Fixture A: `navori render`. **Esperado:** el preview lista `navori.config.json` (agrega `agents-md`), un `AGENTS.md` nuevo y `CLAUDE.md` modificado; nada se escribe.
2. `navori render --apply`. **Esperado:** el preámbulo, el texto intercalado y la zona de usuario siguen idénticos; aparecen el bloque del import y el apéndice; `tipado-fuerte` editado sigue ahí con el aviso; `AGENTS.md` no lo trae; se imprime la ruta del backup.
3. Claude Code en el fixture, `/context all` (la doc de memoria lo indica para confirmar el import). **Esperado:** `CLAUDE.md` y `AGENTS.md` aparecen en Memory files, `AGENTS.md` una sola vez.
4. `navori render --apply` otra vez. **Esperado:** sin cambios.
5. `navori backup restore`. **Esperado:** `CLAUDE.md` y `navori.config.json` vuelven a estar como antes del paso 2, y `AGENTS.md` desaparece.
6. Fixture B: `render --apply`. **Esperado:** el texto propio de `AGENTS.md` se conserva, el bloque ya no trae la sección del orquestador y no tiene vocabulario de ningún motor.
7. Pi en el fixture B: despacha un hijo y vuelca su prompt de sistema. **Esperado:** el del hijo no contiene "Role: orchestrator" y el del padre sí.
8. Fixture B: deja `engines: ["cursor"]` y corre `render --apply --prune`. **Esperado:** `AGENTS.md` pierde solo el bloque gestionado y conserva el texto del usuario.
9. Fixture A ya renderizado: `render --apply` con el CLI 0.12.4 y luego con el tarball. **Esperado:** 0.12.4 no reinyecta los bloques retirados, y el tarball no reporta duplicación.
10. Fixture A sin `agents-md` en `engines`. **Esperado:** el error de la fila Error, sin escribir nada.

## Fuera de alcance

- Codex, salvo conservar su forma (#1513).
- `CLAUDE.md` de workspaces de un monorepo: conservan su forma actual. Sus bloques que no son exclusivos de la raíz se duplican igual que hoy.
- Paridad en Rust: la porta la rama de Rust al reanudarse (#1473).
- Estado de sesión en `progress/`: resuelto por #1579 (`harness.sessionState`).

## Tareas

1. Spec y enmienda de DIRECTION (invariantes 2, 3 y 4) en los tres idiomas. PR 1.
2. La doctrina del orquestador de Pi sale de `AGENTS.md` y la extensión la inyecta solo al hilo principal; Claude no cambia. Ahorra unas 1,330 palabras (~2.3k tokens) por despacho de hijo. PR 2, el primero de código.
3. El prune de `AGENTS.md` conserva el texto del usuario. PR 3, área crítica.
4. `agents-md` como único escritor de `AGENTS.md` y explícito en `engines`, con migración. `CLAUDE.md` = import + apéndice + marcadores vacíos, con retiro protegido. Va en un solo PR para que ninguna combinación de motores pierda doctrina entre dos merges. PR 4.
5. Presupuestos y auditoría con el import resuelto, y goldens nuevos. PR 5.
6. Documentos para personas en tres idiomas y el E2E del camino feliz contra el tarball. PR 6.

PRs desde dev, sin apilar, mergeados en orden; cada uno con reviewer Opus, `navori gate full` y receipt.
