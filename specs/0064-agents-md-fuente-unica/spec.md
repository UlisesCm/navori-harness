# AGENTS.md como fuente única de la doctrina compartida

## Resultado

Quien renderiza navori con Claude Code y `agents-md` obtiene un `CLAUDE.md` que importa `AGENTS.md` (`@AGENTS.md`) y agrega solo lo exclusivo de Claude. Pi lee el mismo `AGENTS.md`, y sus hijos ya no cargan la doctrina del orquestador. El texto del usuario se conserva, el preview lo muestra todo y el backup se restaura. Va en 0.12.5, antes de retomar Rust. Issue: #1598, diseño en #1519.

## Reglas aplicables

- **Dos capas.**
  - Compartida: idioma y rol, formato, tipado, operaciones seguras, SDD, la versión corta de tickets, descubrimiento de código, los bloques de búsqueda de plugins (tgrep, codegraph) y contexto del proyecto. Va en `AGENTS.md`, sin herramientas ni rutas de un motor (`code-discovery-routing`, `codegraph-search` y tickets se neutralizan).
  - Orquestador: planeación, rol, arranque, catálogo de agentes y los bloques de plugins del orquestador. Llega solo al hilo principal: en Claude por `.claude/context/` y el hook de inicio; en Pi, la extensión inyecta `.pi/navori/orchestrator.md` solo en el padre.
- **Un solo escritor.** `agents-md` escribe `AGENTS.md`, neutral para todos los motores; Pi deja de escribirlo. Lo propio de cada motor (rutas, herramienta de subagentes, `TaskCreate`, Glob/Grep pre-aprobados, auto mode, hook `ask`, modo de permisos, monorepo) va en el apéndice gestionado de `CLAUDE.md` o en la capa del orquestador de Pi, renderizada con el adaptador de Pi.
- **Orquestador de Pi.** `.pi/navori/orchestrator.md` es un archivo gestionado entero dentro de la regla de todo o nada, como la extensión; una edición a mano se reporta como en cualquier archivo gestionado. Se personaliza en la zona del usuario de `AGENTS.md`.
- **Quien usa `agents-md` solo (Cursor, Copilot).** `AGENTS.md` gana los bloques de búsqueda de plugins y contexto del proyecto, tickets pasa a la versión corta y los bloques neutralizados pierden el vocabulario de Claude. Nada más cambia.
- **Invariante 2.** El core no depende de ningún motor; `claude` y `pi` se apoyan en `agents-md`.
- **Invariante 3.** La config decide la forma, sin migración ni error. Con `agents-md` en `engines`, `CLAUDE.md` importa `AGENTS.md`. Sin `agents-md`, o con `codex`, queda como hoy y `render` avisa la línea que falta. Única excepción a "sin engines implícitos", ya vigente: si ningún valor de `engines` es válido, se usa `claude`.
- **Invariante 4.** El contrato de marcadores no cambia. El import va dentro de un bloque gestionado (Claude quita los comentarios HTML y la línea queda). Fuera de los marcadores no se toca nada; `CLAUDE.local.md` y `.claude/CLAUDE.md` tampoco.
- **Retiro protegido.** Un bloque compartido sale de `CLAUDE.md` solo si está intacto; si fue editado a mano, se queda (`retired-kept`). Sin `pi`, ese id se omite en `AGENTS.md` para no dar a Claude dos reglas contradictorias: única salida de `AGENTS.md` que depende de otro archivo y no de la config. Con `pi`, `AGENTS.md` lo lleva completo. `render` y `doctor` avisan sin quedar verdes; se resuelve moviendo la edición a la zona del usuario o aceptando la versión de navori en `navori sync`, que ofrece esos ids como conflicto. Un bloque de un CLI más nuevo se respeta.
- **CLI viejos y duplicación.** Cada bloque retirado deja en `CLAUDE.md` un marcador vacío con versión 0.12.5, que un CLI anterior no sobrescribe y no cuesta tokens. Sin la protección de `harnessVersion`, `doctor` reporta la duplicación: un bloque de `AGENTS.md` que reaparece en `CLAUDE.md`. El siguiente render retira la copia intacta.
- **Texto del usuario en `AGENTS.md`.** Un archivo previo sin marcadores se conserva y recibe el bloque. El prune quita solo el bloque y borra el archivo solo si queda vacío (hoy lo borra entero).
- **Medición.** Presupuesto y `navori audit` miden `CLAUDE.md` con el import resuelto; goldens de `claude+agents-md`, `claude+pi+agents-md` y `agents-md` solo.

## Estados

| Estado | Qué ve el usuario |
|---|---|
| Vacío | Repo sin `CLAUDE.md` ni `AGENTS.md`: se crean ambos, con su zona de usuario. |
| Error | Un bloque de `AGENTS.md` reaparece en `CLAUDE.md`: `doctor` falla y nombra el id. Lo cubre la prueba de la tarea 4. |
| Sin conexión | n/a: el render es local. |
| Sin permiso | Archivo de solo lectura: `render --apply` falla y lo nombra; `backup restore <id>` por cada backup impreso, más borrar a mano un `AGENTS.md` nuevo, deja todo como estaba. |

## Entorno y datos

- Tarball del CLI 0.12.5 (`npm pack`), CLI 0.12.4 publicado y repos desechables en `/tmp` con datos ficticios.
- Fixture A: `engines: ["claude", "agents-md"]`, `harnessVersion` 0.12.4, `CLAUDE.md` con preámbulo, texto entre bloques, zona de usuario y `tipado-fuerte` editado a mano.
- Fixture B: `engines: ["claude", "pi", "agents-md"]`, y un `AGENTS.md` previo con texto propio.
- Claude Code ≥ v2.1.277 y Pi 1.5.0.

## Guion de aceptación

1. Fixture A: `navori render`. **Esperado:** el preview lista `AGENTS.md` nuevo y `CLAUDE.md` modificado, sin escribir.
2. `navori render --apply`. **Esperado:** el texto del usuario sigue idéntico; aparecen el import y el apéndice; `tipado-fuerte` sigue con el aviso y `AGENTS.md` no lo trae; se imprimen las rutas de backup.
3. Claude Code en el fixture, `/context all`. **Esperado:** Memory files lista `CLAUDE.md` y `AGENTS.md` una vez.
4. `navori render --apply` otra vez. **Esperado:** sin cambios.
5. `navori backup restore <id>` por cada ruta impresa en el paso 2, y borrar `AGENTS.md`. **Esperado:** `CLAUDE.md` vuelve a estar como antes del paso 2.
6. Fixture B: `render --apply`. **Esperado:** el texto propio de `AGENTS.md` se conserva; el bloque no trae el orquestador ni rutas o herramientas de Claude.
7. Pi en el fixture B: despacha un hijo. **Esperado:** en el archivo de sesión de Pi, "Role: orchestrator" está en el prompt del padre y no en el del hijo.
8. Fixture B: deja `engines: ["cursor"]` y corre `render --apply --prune`. **Esperado:** `AGENTS.md` pierde solo el bloque gestionado y conserva el texto del usuario.
9. Fixture A renderizado, con y sin `harnessVersion`: `render --apply` con el CLI 0.12.4 y luego `doctor` con el tarball. **Esperado:** 0.12.4 no reinyecta lo retirado y `doctor` no reporta duplicación.
10. Fixture A restaurado, sin `agents-md` en `engines`: `render --apply`. **Esperado:** `CLAUDE.md` conserva su forma y `render` avisa la línea que falta.

## Fuera de alcance

- Codex (congelado, #1513): conserva su forma, sin import ni inyección en Pi.
- `CLAUDE.md` de workspaces de un monorepo: quedan como hoy.
- Paridad en Rust: al reanudarse esa rama (#1473).
- Estado de sesión en `progress/`: lo resolvió #1579.

## Tareas

1. Spec y enmienda de DIRECTION (invariantes 2, 3 y 4), tres idiomas. PR 1.
2. El orquestador de Pi sale de `AGENTS.md` y la extensión lo inyecta solo al padre (~2.3k tokens menos por hijo). PR 2.
3. El prune de `AGENTS.md` conserva el texto del usuario. PR 3, área crítica.
4. `agents-md` como único escritor de `AGENTS.md`, con los bloques neutralizados. `CLAUDE.md` = import + apéndice + marcadores vacíos, con retiro protegido, y `doctor` con la detección de duplicación y su prueba. Un solo PR. PR 4.
5. Presupuestos y auditoría con el import resuelto, y goldens nuevos. PR 5.
6. Documentos para personas en tres idiomas y el E2E del camino feliz contra el tarball. PR 6.

PRs desde dev, sin apilar, en orden; cada uno con reviewer Opus, `navori gate full` y receipt.
