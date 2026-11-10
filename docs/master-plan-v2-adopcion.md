# Adopción del plan maestro v2 en jey

Esta guía describe cómo adoptar el plan maestro v2 en jey tras migrar un plan v1. Cubre la ronda de QA por lote, el entorno de aceptación, la migración, el enganche al gate local y el caso de S17.

## 1. Ronda de QA por lote

Tras migrar, varios slices ya aparecen integrados sin aceptar. En el clon de jey el WIP queda en 6/1: S1, S12, S13, S17, S18 y S19 integrados.

1. Revisa el estado con `navori master status --qa`.
2. Ejecuta los guiones de aceptación de #248–#250.
3. Registra cada veredicto tú, con `navori master accept S<n> --approved-by user` o `navori master reject S<n> --notes "<tarea abierta>"`. `--notes` es obligatorio en `reject` y puede repetirse.

Solo el usuario ejecuta `accept` y `reject`. `migrate` nunca escribe `navori/acceptance`; solo imprime sugerencias para las decisiones `accepted` de la v1.

Los slices S2–S8 ya están en qa, pero se construyeron por capas en la etapa 01, antes de existir las ramas `slice/`. Por eso `migrate` los deja `pendiente`. Pon en la columna `Commit` de PLAN.md el SHA de qa contra el que se verificaron los guiones: `75fe3ef` (según las PR #248–#250). Esa columna existe para slices construidos antes de v2: el slice pasa a `integrado` cuando ese SHA es ancestro de la rama de aceptación.

## 2. Entorno de aceptación

Elige una de dos opciones:

- Promover cada slice a qa después de la demo.
- Usar un entorno de dev como rama de aceptación.

Edita los campos `Entorno` y `Rama de aceptación` en PLAN.md. `migrate` deja los valores de la plantilla y avisa de ello.

## 3. Migrar

1. No migres en un checkout con trabajo sin commitear.
2. Dry-run primero: `navori master migrate`. Imprime PLAN.md y la tabla E<n> → S<n>.
3. Revisa la salida y luego ejecuta `navori master migrate --write`. Escribe PLAN.md sin sobrescribir nada, activa `harness.masterPlan` y re-renderiza. Si `navori.config.json` está formateado a mano, edita la bandera a mano.

Reglas de numeración: `migrate` conserva el número `slice/sNN-` de cada entrega y nunca renumera. S01, s1 y S1 son el mismo slice. Un outcome v1 sin «→» se escribe tal cual; reescríbelo como «actor → resultado». `check` lo marca.

En el dry-run de jey, E1…E20 pasan a S1…S20, y `slice/s17-entrega-2-wip` pasa a S21.

## 4. Enganche al gate local de jey

jey no usa GitHub Actions. Agrega al gate local (`bun run gate` o pre-push):

```sh
navori master check --incoming HEAD --base dev --branch "$(git branch --show-current)"
```

- `--incoming` requiere `--base`.
- Sin fetch o con clon superficial, el check falla cerrado. `--no-fetch` omite el fetch.
- Si no existe PLAN.md en `origin/<base>`, el check pasa con un aviso.

## 5. Alternativa con GitHub Actions

Si el proyecto usa GitHub Actions, haz checkout con `fetch-depth: 0`, trae `origin/navori/acceptance` y ejecuta:

```yaml
- env: # never interpolate the title into run: (injection)
    BASE: ${{ github.base_ref }}
    BRANCH: ${{ github.head_ref }}
    TITLE: ${{ github.event.pull_request.title }}
  run: navori master check --incoming HEAD --base "$BASE" --branch "$BRANCH" --title "$TITLE" --no-fetch
```

## 6. Caso S17, entrega 2

La rama `origin/slice/s17-entrega-2-wip` tiene commits sin marca y no tiene PR. Por eso `migrate` la trata como S21. Antes de abrir el PR:

1. Renombra la rama local a `slice/s21-entrega-2-wip`.
2. Publica la rama nueva y borra la vieja. `migrate` no renombra ni publica nada.
3. Usa `[S21]` en el título del PR.

La regla de rama extra solo cuenta ramas `slice/sNN-` sin integrar en la rama destino, cuyo nombre no es el `git.branch` de una entrega y cuyos commits no llevan la marca S<NN>. Por eso `s14-regalos-mensuales` y `s18-bloqueos-y-auditoria` siguen siendo S14 y S18.
