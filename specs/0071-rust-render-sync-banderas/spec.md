# Banderas de `render` y `sync`, y render de Pi nativo (0.13.x, rebanada 5)

## Resultado

Quien mantiene uno o varios repos con navori corre `render` con `--all`, `--prune`, `--verbose` o `--workspace`, y `sync` con `--workspace`, y el binario `navori-rust` los resuelve sin Node. El render de Pi también deja de delegar cuando hay `project.localSkills` o plugins que declaran hooks. Lo que cada bandera escribe, borra y reporta es lo mismo que en el TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin el CLI de TypeScript, un `HOME` aislado con un registro global de cuatro repos (uno borrado del disco, uno sin `navori.config.json`, uno con el árbol sucio y uno con marcadores de una versión más nueva), un monorepo con dos workspaces y un repo con los engines `claude` y `pi` y `project.localSkills` no vacío.

1. `navori render --all`. **Esperado:** la vista previa del TS por repo; nada se escribe.
2. `navori render --all --apply`. **Esperado:** renderiza los repos válidos; en el de marcadores más nuevos conserva esos bloques y los informa como retrocesos evitados, como el TS; marca como error el borrado y el que no tiene config, y sale con 1 por esas dos filas.
3. `navori render --all --prune`. **Esperado:** quita del registro, como el TS, las entradas cuyo repo ya no tiene `navori.config.json`, también sin `--apply`.
4. `navori render --all --verbose`. **Esperado:** cada bloque gestionado que cambiaría, por repo, como el TS.
5. En un repo con salidas huérfanas y un archivo mixto, `navori render --prune --apply`. **Esperado:** el mismo recorte, respaldo, purga y borrado de directorios vacíos que el TS, con `.gitignore` y los retirados intactos.
6. `navori render --workspace api --apply` y `navori sync --workspace api --apply` en el monorepo. **Esperado:** solo ese workspace, con la poda de cada comando igual al TS.
7. `navori render --workspace api` en un repo que no es monorepo, y `--workspace` con un workspace borrado del disco. **Esperado:** los errores del TS, sin escribir.
8. `navori render --apply` en el repo con Pi, `localSkills` y un plugin que declara hooks. **Esperado:** render de Pi nativo, igual al TS, sin delegar.
9. `navori render --json` con `progress/` en tres estados: ignorado, rastreado y sin ignorar. **Esperado:** en cada estado, la misma lista de archivos que el TS.

## Reglas aplicables

- R1 — Con la misma config y el mismo árbol, el plan, las escrituras, los borrados, el reporte y el código de salida son los del TS.
- R2 — `--prune` tiene las dos semánticas del TS. Con `--all`, quita entradas del registro global sin config, aun sin `--apply`, y no poda dentro de cada repo. En un solo repo con `--apply`, recorta y poda las salidas que navori posee, nunca un archivo del usuario.
- R3 — `--all` sigue con los demás repos cuando uno falla, lo informa por repo y sale con 1, como el TS. Un repo que falla a mitad queda como lo deja el TS.
- R4 — `--verbose` solo cambia la salida con `--all`, como en el TS.
- R5 — La protección contra retroceso de marcadores rige igual en cada repo de `--all` y de `--workspace`.
- R6 — El render de Pi no delega por `project.localSkills` ni por plugins con hooks.
- R7 — #1838 se resuelve con la prueba diferencial del paso 9. Si el nativo difiere del TS en algún estado, se corrige el nativo y el TS no cambia.
- R8 — Estas banderas salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Registro vacío con `--all`: el aviso del TS. |
| Error | Repo borrado, sin config o con un render que falla: su fila de error, y exit 1. Marcadores más nuevos: no es error; los bloques se conservan y se informan, como en el TS. |
| Sin conexión | n/a: estas banderas no usan la red. |
| Sin permiso | Repo sin escritura: su fila de error, y sigue con los demás. Entrada del registro o salida gestionada que es un enlace simbólico: el trato del TS, sin seguirlo para borrar. |

## Entorno y datos

- Depende de la rebanada 0067: `sync --interactive` pasó allí, y las dos rebanadas editan la misma entrada transitoria de `sync`.
- Inventario en H (`997128b9`): las banderas están en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs`). La semántica de `--prune` está en `packages/cli/src/commands/render.ts`: `--all` en `:2365-2366` (`lib/workspace/registry.ts:206`), sin pasar `prune` al render de cada repo (`:2164`); un solo repo en `:1079-1146`; `--workspace`, `prune: true` (`:846`), frente a `sync --workspace`, `prune: false` (`sync.ts:549`). El render de Pi delega con `localSkills` o hooks de plugins (`crates/navori-core/src/render/pi_engine.rs:262-273`) y, sin `node`, al validar la extensión (`pi_owned.rs:146-156`, `pi_engine.rs:567`). #1838 frente a `scripts/js/check-render.mjs:112-133`.
- Desafío del auditor (24 nov), incorporado; resumen en el PR de esta spec.
- Pregunta abierta Q1 para Ulises: validar la extensión de Pi sin Node. Hoy se comprueba el hash y además que el TypeScript parsee, con `node`. Las opciones son (a) seguir pidiendo Node solo para esa validación, (b) quedarse con el hash, que cambia cuándo se considera propia la extensión y por lo tanto qué se borra, o (c) un parser de TypeScript nativo, que es una dependencia nueva. Mientras no decida, el guion corre con `node` en `PATH`.
- Área crítica: escrituras y borrados del render en el repo del usuario y en el registro global.

## Fuera de alcance

- El comando `registry`: sigue en TS (#1503). Solo `render --all --prune` escribe el registro.
- `sync --interactive`: rebanada 0067.
- Nuevos engines o cambios en qué renderiza cada uno.

## Tareas

1. `render --all`, con `--prune` y `--verbose`, recorre y poda el registro como el TS.
2. `render --prune --apply` en un repo recorta y poda como el TS.
3. `render --workspace` y `sync --workspace` limitan el render a un workspace, con su poda.
4. El render de Pi no delega por `localSkills` ni por hooks de plugins.
5. La validación de la extensión de Pi sigue la opción que elija Ulises (Q1).
6. #1838 queda confirmado o descartado con la prueba diferencial y, si aplica, corregido.
7. Las banderas salen de la delegación transitoria; el oráculo cubre cada una.
8. El guion pasa sobre el binario construido.
