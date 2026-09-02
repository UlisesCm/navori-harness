# La orquestación fuera de la capa always-on — Design

## Approach

Un bloque managed marcado como **dirigido al orquestador** se renderiza a un archivo propio
bajo `.claude/`, y el hook `SessionStart` del repo lo concatena a su `additionalContext`. El
`CLAUDE.md` deja de contenerlo. El resto de la cascada de render no cambia.

La forma no se inventa aquí: **la capa global ya hace exactamente esto** (spec 0010 FB,
#546). `composeBaseline` arma los bloques, `generateHookScript` los sella con marcador y
hash, y el hook los emite como `additionalContext` de `SessionStart`. Esta spec aplica el
mismo canal al scope del repo, donde el bloque todavía viaja por el archivo que todos leen.

**Archivo intermedio, no texto embebido en el `.sh`.** El hook global embebe la baseline
dentro del script porque no tiene un repo donde escribir. En el repo sí lo hay, y separar
gana tres cosas que el embebido pierde: el bloque sigue siendo un archivo markdown managed
—o sea `sync`, `doctor`, el scan de drift y `render --prune` siguen funcionando sin saber
nada de este cambio—, el hook se mantiene en un `cat`, y el diff de un `render --apply` se
lee.

**Lo que se descartó.** Mover el bloque a una skill: la carga la decide el modelo, y la
doctrina de ruteo es justo lo que no puede depender de que alguien se acuerde de pedirla. El
hook la entrega siempre, y `CLAUDE.md` tampoco es un canal más fuerte de lo que parece —
la doc dice que *"CLAUDE.md content is delivered as a user message after the system prompt"*,
que es la misma clase de canal que `additionalContext`.

## Components

- `packages/core/core-assets/managed/orquestacion.md` — sin cambios de contenido; gana una
  marca de audiencia en su frontmatter (`audience: orchestrator`) — covers R1, R4.
- **Render (engine claude)** — un bloque con esa audiencia se escribe en
  `.claude/context/orquestacion.md` en vez de componerse dentro del `CLAUDE.md`; conserva
  marcador, hash y versión, y se interpola con la config del repo — covers R1, R6, R7, R9.
- **`session-start-context.sh`** — concatena el contenido de `.claude/context/*.md` a `$ctx`
  si existe; si no existe o no se puede leer, sigue con el resto — covers R2, R3.
- **Migración en el render** — al detectar el bloque dentro de un `CLAUDE.md` ya renderizado,
  lo retira por su marcador (la operación que `marker.ts` ya sabe hacer) — covers R10.
- **`lib/health.ts`** — `.claude/context` entra en `ENGINE_OUTPUTS` como directorio con
  marcadores html, para que el scan de drift lo cubra igual que `.claude/agents` — covers R6.

## Decisions

- **`audience` en el asset, no una lista en el código.** La misma razón por la que
  `globalSafe` se declaró en el asset (#541): una lista paralela en TypeScript es una lista
  que se desincroniza del archivo que describe.
- **`.claude/context/`, no `.claude/rules/`.** Un `rules/*.md` sin `paths:` se carga en cada
  sesión **y llega a los subagentes** — la doc lista las project rules dentro de la jerarquía
  que un subagente hereda. Usar `rules/` reintroduciría exactamente el problema que esta
  spec quita.
- **Un archivo por bloque, no un concatenado.** El marcador y el hash son por bloque; juntar
  dos en un archivo obligaría a inventar una segunda regla de propiedad para ese archivo.
- **La exclusión sigue viviendo en `blocks.exclude`.** El usuario que hoy excluye
  `orquestacion` no debería enterarse de que cambió el canal (R8).

## Contracts

Frontmatter del asset:

```yaml
---
id: orquestacion
globalSafe: true
audience: orchestrator   # nuevo: no entra al CLAUDE.md; lo entrega el hook
---
```

Salida del hook (sin cambios de forma, solo más texto en el mismo campo):

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }
```

## Failure modes

- **El archivo no existe** (repo renderizado por una navori anterior, o bloque excluido): el
  hook emite el resto y sale 0 (R3). El agente principal se queda sin doctrina de ruteo, que
  es el mismo estado que hoy tiene un repo con `blocks.exclude: ["orquestacion"]`.
- **El bloque quedó en el `CLAUDE.md` y también en el archivo nuevo**: el render lo retira
  del primero (R10); mientras la migración no corra, el agente lo lee dos veces — costoso,
  nunca incorrecto. Vale declararlo en el reporte del render en vez de dejarlo silencioso.
- **Capa global instalada en un repo navori**: el hook global no emite nada dentro de un repo
  con `navori.config.json`, así que no hay doble entrega (R11). Esa exclusión ya existe y esta
  spec no la toca; el test que la pinea es el que hay que conservar.
- **Placeholder sin resolver**: el render falla, como con cualquier otro bloque managed (R7).

## Testing strategy

- **La aserción de fondo es una ausencia**: el `CLAUDE.md` renderizado no contiene el marcador
  `orquestacion`, y el archivo nuevo sí. Una sola prueba dice si la mudanza ocurrió.
- **El subagente no lo recibe** se prueba donde se puede probar: el contenido no está en
  ninguno de los archivos que la doc lista como contexto inicial de un subagente
  (`CLAUDE.md`, jerarquía, `rules/`). Lo que el host haga con eso no es observable desde aquí,
  y afirmarlo sería afirmar de más.
- **El contrato del subagente sobrevive** (R5): una spec por agente que verifique que su asset
  sigue declarando su archivo de reporte y su marca `Status:`. Hoy está duplicado; el riesgo
  es que alguien "limpie" la duplicación creyéndola redundante.
- **Migración**: un repo renderizado con el bloque dentro del `CLAUDE.md` queda, tras
  `render --apply`, sin él ahí y con él en el archivo nuevo, conservando el texto del usuario
  alrededor.
- **Los ~22 archivos de test que nombran `orquestacion`**: la mayoría lo usa como id (lógica
  de exclusión, contratos de handoff, scope global) y no depende del destino. Los que sí
  atan el bloque al `CLAUDE.md` son `health`, `render-engine`, `cli.e2e`, `render-monorepo` y
  `render-summary-totals`; esos migran con el cambio y son parte del trabajo, no un daño
  colateral.

## Migration

Un repo ya renderizado migra con `navori render --apply`, sin pasos manuales: el bloque sale
del `CLAUDE.md` y aparece en `.claude/context/`. Un repo que no vuelva a renderizar sigue
funcionando con el bloque donde está — el hook simplemente no encuentra el archivo y calla.

## NOT in scope

- **Los demás bloques del `CLAUDE.md`.** Esta spec abre el canal y mueve UNO. Cuáles más
  merecen mudarse es la pregunta de #572, y se contesta con el canal ya probado.
- **La capa global.** Ya entrega este bloque por hook; no cambia nada de su lado.
- **Bajar el `CLAUDE.md` de 200 líneas.** Sacar 73 lo deja en ~297: mejor, no resuelto. Ese
  objetivo es de #572.
- **Tocar el contenido del bloque.** Se mueve tal cual. Reescribirlo en el mismo PR haría
  imposible saber si una regresión vino de la mudanza o de la edición.
