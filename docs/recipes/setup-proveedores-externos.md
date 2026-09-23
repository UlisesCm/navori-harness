# Recipe — setup de codegraph y tgrep después de instalarlos

> Qué hacer después de `navori add codegraph` / `navori add tgrep` (o de que
> `navori init --full` los habilite) para que el MCP y el índice realmente
> respondan. Destilado de `docs/research/search-v2.md` §6.1, sin el protocolo
> interno de dogfood (branch, SHA base, git hooks) que ese doc también cubre.

## Cuándo aplica

Solo a los 2 plugins que traen binario propio + índice: `codegraph` (servidor
MCP, `packages/plugins/codegraph`) y `tgrep` (CLI + servidor,
`packages/plugins/tgrep`). El resto de los plugins (`engram`, `semgrep`,
`jscpd`, `gh`, `acli`) no necesita estos pasos — `navori add <plugin>` ya deja
el binario listo para usarse.

## Pasos

1. Confirma el binario: `codegraph --version` / `tgrep --version`. Si `navori
   add` no lo instaló (lo rechazaste, o tu plataforma no tiene un comando
   automático), instálalo con el que te mostró `navori doctor`.
2. Inicializa el índice de codegraph en la raíz del proyecto:

   ```
   codegraph init .
   ```

   Si ya existe un índice, `init` falla — reconstrúyelo con
   `codegraph index --force`, no vuelvas a correr `init`.
3. Levanta tgrep en la misma raíz. Primero revisa si ya hay un servidor:

   ```
   tgrep status .
   ```

   Si no lo hay, inicia uno en una terminal dedicada:

   ```
   tgrep serve .
   ```

   El servidor vive mientras esa terminal siga abierta — navori no mata
   procesos externos, así que cerrarla es la forma de apagarlo. Si no puedes
   mantener una terminal abierta, usa `tgrep index .` (modo disco, sin
   servidor: las búsquedas siguen funcionando, sin mantenerse al día solas).
4. Abre (o reinicia) Claude Code desde esa misma raíz y aprueba el servidor
   MCP de codegraph cuando el host lo pregunte. Esa aprobación es interactiva
   por diseño — navori nunca preautoriza un MCP declarado en el propio repo.
5. Verifica que ambos responden: una llamada real a `codegraph_explore` desde
   un agente, y una búsqueda con `tgrep search -n -- "algo" .`. A partir de
   aquí, `navori doctor` avisa si el índice de cualquiera de los dos queda
   desactualizado.

## Notas

- `codegraph init` crea `.codegraph/` con su propio `.gitignore` — no hace
  falta ignorarlo a mano. `tgrep index`/`serve` no escriben ningún ignore
  propio; si tu modo (`local`/`full`) no cubre `.tgrep/`, agrégalo tú.
- Desactivar el plugin (`navori remove codegraph` / `navori remove tgrep`) no
  borra el índice ya generado en disco.
