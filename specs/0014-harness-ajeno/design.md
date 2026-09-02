# Harness ajeno que choca con navori — Design

## Approach

Un módulo de detección de solo lectura (`lib/foreign-harness.ts`) que compara el
inventario managed de navori contra tres scopes ajenos, y un consumidor en `doctor` que
imprime **solo** lo que choca. La adopción es un camino aparte, explícito y con `--apply`,
porque es lo único aquí que escribe sobre un archivo que el usuario hizo a mano.

La forma la marca #547 (`lib/global-scope.ts`), que ya resolvió la rebanada global: un
scan que devuelve una estructura, `doctor` que la imprime en amarillo, y **el marcador
managed como discriminante**. Esta spec generaliza ese patrón a los otros dos scopes y al
otro tipo de asset, en vez de inventar un mecanismo paralelo.

**Lo que se descartó.** Detectar "harness ajeno presente" y avisar (lo que `detectClaudeInfra`
ya sabría contestar hoy): imprimiría la misma sección en cada repo, para siempre, y en dos
corridas se vuelve ruido que se aprende a ignorar. El criterio es conflicto real —
R1/R2 — y esa es la invariante de huella cero del output (spec 0010 §2.4) aplicada aquí.

## Precedencia — la tabla que decide quién gana

Verificada contra `code.claude.com/docs/en/sub-agents` y `/skills` (2026-08-31, spec 0010).
**No es uniforme, y para skills es al revés de lo intuitivo**; el aviso se equivocaría de
ganador la mitad de las veces si asumiera una sola regla (R4, R5).

| Asset  | Gana                    | Pierde                  | Nota |
|--------|-------------------------|-------------------------|------|
| Agente | `.claude/agents/` (repo) | `~/.claude/agents/`     | y ambos ganan al agente de un plugin |
| Skill  | `~/.claude/skills/` (personal) | `.claude/skills/` (repo) | *enterprise > personal > project* |
| Skill de plugin | — | — | namespaced `/<plugin>:<skill>`: no colisiona con nada (R5) |

## Components

- `lib/foreign-harness.ts` — `scanForeignHarness(cwd, config, opts)`: inventario managed
  de navori vs. los tres scopes ajenos, resolución de precedencia, y el id estable de cada
  conflicto — covers R1, R2, R3, R4, R5, R6, R10, R17.
- `lib/foreign-harness.ts` — `isAcknowledged` / `staleAcknowledgements`: filtro por
  `project.foreignHarness.acknowledged` y detección de entradas obsoletas — covers R8, R9.
- `commands/doctor.ts` — sección advisory nueva, con la acción que cierra cada conflicto —
  covers R7, R16, R17.
- `lib/schema.ts` — `project.foreignHarness.acknowledged: string[]` — covers R8.
- `commands/adopt.ts` (o `configure adopt`, ver Decisions) — preview/apply, backup e
  inyección del bloque managed sobre el archivo del repo — covers R11, R12, R13, R14, R15.

Se reutiliza sin tocar: `injectManagedSection` (`lib/marker.ts`), `createBackup`
(`lib/backup.ts`), `listSkillDirs`/`detectClaudeInfra` (`lib/claude-infra.ts`) y el
patrón de sección advisory de `doctor`.

## Decisions

- **El marcador managed es el discriminante, no el nombre del archivo.** En un repo navori
  sano los ocho agentes existen en dos scopes por diseño; avisar de eso sería ruido puro.
  Ajeno = sin marcador de navori. Es la misma regla de #547, y por eso no se re-decide.
- **Una lista de `acknowledged`, no `localSkills`.** `localSkills` significa otra cosa —
  una skill del usuario que navori **indexa** en el índice de skills— y sobrecargarla haría
  que silenciar un conflicto además cambie el `CLAUDE.md` renderizado. Son dos
  observables distintos; una clave para cada uno.
- **El id del conflicto es `<tipo>:<scope>:<nombre>`** (p. ej. `skill:personal:verify-before-done`).
  Sin rutas absolutas: la lista se commitea y tiene que significar lo mismo en la máquina
  de al lado (R10).
- **La adopción solo aplica a archivos del repo.** navori no escribe en `~/.claude` desde
  el scope de repo, así que para un conflicto contra el scope personal la única acción es
  asumirlo (R7, R14). Decirlo en el aviso evita ofrecer una salida que no existe.
- **Adoptar es envolver, no reescribir.** El contenido del usuario entra tal cual dentro
  del bloque; navori pasa a versionar ese archivo, no a dictar su contenido (R11).
- **Comando propio (`navori adopt`) y no una bandera de `doctor`.** `doctor` es read-only
  por contrato y ese contrato es la razón por la que se puede correr sin miedo; meterle una
  escritura lo rompe para siempre. La alternativa —`configure adopt`— queda abierta a
  criterio del implementador si la superficie de comandos pesa más que la simetría.
- **Gitignored es señal secundaria, nunca disparador.** Un harness ajeno fuera de git es
  un problema de equipo real, pero avisarlo por sí solo reincide en el ruido que R2
  prohíbe. Entra como una línea dentro de un conflicto que ya se está reportando (R6).

## Contracts

`navori.config.json`:

```jsonc
{
  "project": {
    "foreignHarness": {
      // ids de conflicto asumidos; ver R10 para su forma
      "acknowledged": ["skill:personal:verify-before-done"]
    }
  }
}
```

La clave es opcional y su default es la lista vacía: un repo que nunca la escribe se
comporta exactamente como hoy.

## Failure modes

- **`~/.claude` ilegible o inexistente** (CI, contenedor sin HOME): la detección devuelve
  cero conflictos de ese scope y no lanza. Un scan que revienta convertiría a `doctor` en
  algo que falla por el entorno, no por el repo.
- **Adopción interrumpida a media escritura**: el backup se crea ANTES de la primera
  escritura y su ruta se reporta (R13), así que el estado previo siempre es recuperable.
- **Archivo con marcador de una navori más nueva**: se rechaza (R14) por la misma razón
  que el prune no borra hacia atrás — no es nuestro para reescribirlo.
- **Colisión entre dos scopes ajenos** (personal vs. otro plugin, sin navori en medio): no
  es asunto de navori y no se reporta; el inventario managed es un lado obligatorio de
  toda comparación (R1).

## Testing strategy

- La tabla de precedencia se prueba con un caso por fila, incluido el de skill de plugin
  que NO debe reportarse: es la fila donde una regla uniforme se equivocaría (R4, R5).
- El caso real de la máquina del autor entra como fixture: skill personal en archivo plano
  (`~/.claude/skills/x.md`) contra skill de navori en directorio (`.claude/skills/x/SKILL.md`).
  Los dos layouts conviven y la detección tiene que ver ambos.
- Anti-ruido con aserción propia: un repo navori sano, con sus ocho agentes en dos scopes,
  produce **cero** conflictos y `doctor` no imprime la sección (R2, R16).
- La adopción se prueba por bytes: contenido idéntico dentro del bloque, backup existente
  con el contenido previo, y segunda corrida sin cambios (R11, R13, R15).
- `HOME` se mockea (`lib/home.ts`) en toda spec que lea el scope personal — es la misma
  regla que ya siguen las specs del harness global.

## NOT in scope

- **Escribir o borrar en `~/.claude`.** Fuera del repo, navori solo lee. Cambiar eso es
  una decisión de producto aparte, no un detalle de esta feature.
- **Resolver la colisión renombrando.** Elegir un nombre nuevo para el asset del usuario
  es una decisión suya; el sistema reporta y ofrece adoptar o asumir.
- **Hooks ajenos.** El issue los menciona junto con los permisos, pero un hook ajeno no
  "gana": corre además del de navori, y decidir si eso contradice algo exige leer su
  contenido. Queda fuera y se evalúa cuando haya un caso real. Los permisos sí entran
  (R3), porque ahí la contradicción es declarativa y verificable sin ejecutar nada.
- **`status`.** La sección vive en `doctor`, que es donde ya viven las advertencias
  accionables. Duplicarla en `status` es el tipo de copia que después se desincroniza.
