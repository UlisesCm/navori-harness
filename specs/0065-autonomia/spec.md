# Modo autónomo por proyecto (Pi), fase 1

## Resultado

Quien mantiene un repo declara `autonomy` en la config, enciende `mode: "routine"` y consiente una vez en la terminal de Pi. Desde entonces la sesión principal abre PRs hacia una rama de integración, comenta, revisa sin aprobar y crea issues sin diálogo, con la marca de su sesión y un registro local. El merge y lo demás siguen pidiendo; lo crítico bloquea. Sin la clave, navori se comporta como en 0.12.

Enmienda el invariante 9 de `docs/DIRECTION.md` en un PR aparte (#1785), que se aprueba con esta spec.

## Guion de aceptación

Entorno: Linux, repo fabricado en GitHub con `main`, `dev` y una rama de trabajo, navori del paquete construido, Pi interactivo. Config: `autonomy: { mode: "routine", integrationBranches: ["dev"] }`.

1. Sin consentir, pedir un comentario en un PR. **Esperado:** aviso de consentimiento faltante y el diálogo de 0.12.
2. Correr el comando de autonomía y teclear su frase. **Esperado:** aviso de rutina activa. Por RPC se rechaza.
3. Pedir un PR hacia `dev`, un comentario, una revisión que pide cambios y un issue, con cuerpos en `.navori/state/publish/`. **Esperado:** se publican sin diálogo, cada cuerpo con la marca de la sesión.
4. Abrir el registro. **Esperado:** por operación, una línea con sesión y decisión y otra con el resultado; sin títulos, cuerpos ni secretos.
5. Pedir el merge del PR, `git push --force-with-lease` y una revisión que aprueba. **Esperado:** diálogo en los tres.
6. Pedir comentarios con cuerpo en `.env`, en línea, con un token y hacia un PR ajeno, y un PR con `--base dev --base main`. **Esperado:** diálogo en los cinco.
7. Pedir `npm publish`, `gh release create`, `gh pr merge --admin`, `git push origin main`, `git tag v1` y `git tag --sort=refname v1`. **Esperado:** cada uno bloquea nombrando su regla; `git tag --list` corre.
8. Pedir a un subagente un comentario. **Esperado:** rechazo y reenvío a la sesión principal.
9. Cambiar `integrationBranches` y, aparte, reinstalar `navori-rust`. **Esperado:** cada cambio apaga la rutina hasta consentir de nuevo, y el comando nombra el componente que cambió.
10. Sin la clave, en sesión nueva, repetir 3 y 7. **Esperado:** diálogo de 0.12 en el 3; ningún bloqueo nuevo en el 7.

## Reglas aplicables

- R1 — `autonomy.mode` acepta `off` y `routine`; otro valor es un error de config. `autonomy.integrationBranches` lista nombres exactos sin comodines y rechaza `main`; la rama por defecto se rechaza al consentir.
- R2 — Sin la clave nada cambia respecto de 0.12; con ella, en cualquier modo, rigen R5 y R6.
- R3 — Una llamada se aprueba sola solo si: modo `routine`, consentimiento vigente, sesión principal en la terminal interactiva, un solo comando de R4 sin `--approved-by`, y todas sus preguntas vienen de los hooks propios de esa operación. Deciden quién preguntó y la forma del comando, no el motivo. Lo no analizable no es rutina.
- R4 — Rutina, solo en el repo propio: abrir un PR con base explícita en una rama de integración; comentar en PRs e issues; revisar con cuerpo sin aprobar; crear un issue.
- R5 — Bloquean: publicar paquetes, crear o editar releases, merge de administrador, empujar o escribir por la API a `main` y crear tags (también `git tag --sort` o `--format` con nombre). Listar tags sigue permitido.
- R6 — Preguntan y nunca son rutina: el merge, el push forzado en cualquier forma, incluido `--force-with-lease`, y aprobar una revisión.
- R7 — Tampoco son rutina: otro repo, un flag repetido, un PR sin base o hacia `main`, el quality gate, el resto del guard, Jira y escribir la config.
- R8 — El consentimiento lo teclea el usuario en la terminal interactiva de Pi, nunca por RPC ni sin interfaz. Se guarda fuera del árbol de trabajo, por repo, atado a cuatro componentes: la política con la versión de la lista de rutina, el harness de Pi instalado (manifiesto, scripts de hooks, extensión), las extensiones y ajustes de shell de Pi del host, y el binario `navori-rust`. Si alguno cambia, se pide de nuevo. Sin consentimiento vigente, `routine` equivale a `off`. La extensión bloquea las escrituras directas del agente a esa ruta; no detecta una indirecta ni un proceso que maneje una terminal.
- R9 — El cuerpo viene solo de un archivo bajo `.navori/state/publish/`. La extensión publica lo que leyó más la marca; un secreto reconocible en cuerpo o título va al diálogo.
- R10 — El agente no aporta la marca de sesión; sin sesión identificable no hay rutina.
- R11 — El registro vive fuera del árbol de trabajo: una línea por decisión antes de ejecutar y otra por resultado. Sin escritura, diálogo.
- R12 — Ningún subagente aprueba rutina; su pregunta va a la sesión principal.
- R13 — La firma de los hooks portados no cambia; un hook que falla sigue bloqueando.
- R14 — Solo con rutina vigente la sesión principal recibe la instrucción de qué es rutina.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Sin clave: 0.12. Con `off` o sin consentimiento: diálogos, R5 y R6. |
| Error | Modo o rama inválidos: la config falla nombrando la clave. Registro sin escritura: diálogo. |
| Sin conexión | Repo no comprobable: diálogo. |
| Sin permiso | Subagente, RPC o sin interfaz: rechazo o reenvío. |

## Entorno y datos

- `gh` con escritura en el repo fabricado y un PR hacia `dev`.
- El dueño crea el ruleset de `main` y los tags.
- Previo: atribuir cada acción a su sesión (#1774).
- Ramas: el TS (`lib/config/schema.ts`, `lib/config/config.ts`, `engines/pi/policy-source.ts`, `extension-source.ts`, `denials.ts` y sus pruebas) nace en `dev`, con excepción al congelamiento de TS solo para esta fase, escrita aquí; la paridad va a `migration/rust` al sincronizar. Excepción a `DIRECTION.md:100`, solo para archivos que no existen en `dev`: `config.rs`, `extension.ts.in`, `gen-pi-extension-asset.mjs`, los casos del oráculo, `rust-manifest-check.mjs` y `rust.yml`. Queda escrita en `docs/DIRECTION.md` de `migration/rust` con la vigente de `bridge-source.ts` (#1784).

## Fuera de alcance

- Merge y `--force-with-lease` de rutina — fase posterior; mergea el dueño.
- Escrituras indirectas al consentimiento, veto de secretos en hooks, sesión en el journal — fase 2, con re-firma.
- Claude Code, Codex y hooks portados — re-firmas.
- Identidad de GitHub para agentes — después.
- Rutina en subagentes y Jira — no se proponen.

## Tareas

1. La clave `autonomy` existe con paridad en ambas implementaciones.
2. La extensión sabe qué hook hizo cada pregunta.
3. Con la clave, R5 bloquea y R6 pregunta, también a subagentes.
4. El consentimiento se pide, guarda y caduca según R8.
5. La sesión principal aprueba sola la rutina de R4, con cuerpo, marca y registro.
6. La instrucción de R14 está publicada; la enmienda y las excepciones, mergeadas.
7. El guion pasa sobre el paquete construido sin cambiar la firma de los hooks.
