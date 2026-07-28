# Spec 0005 — Capa de lectura eficiente (structural-search + higiene de engram)

- **Status**: proposed (planning only — NO implementar hasta aprobación)
- **Fecha**: 2026-07-24
- **Autor**: Ulises Ciprés
- **Relacionado**: capa de library-skills (PR #56), plugins como bundles, engine adapters Claude/Codex, plugin engram

## 1. Problema

El agente gasta tokens y tiempo re-descubriendo la estructura del código en cada
tarea: lee archivos completos para orientarse, hace búsquedas de texto ambiguas que
provocan reads de seguimiento, y arranca cada sesión "ciego". Queremos que el harness
que genera navori le enseñe al agente a **leer lo mínimo posible para encontrar lo
correcto**, con la herramienta correcta en cada caso — y que la memoria (engram) se
mantenga lean en vez de acumular ruido.

Insight clave: navori **no ejecuta** herramientas, **genera el harness** (skills +
allowlists + plugins) que le dicta al agente qué herramienta usar. Todo esto es
skill + permisos + protocolo, no código nuevo del CLI.

> **Decidido:** Serena / LSP (Rung 3) queda FUERA del plan. El overhead (~3k tokens/
> sesión fijos + language server + fricción de infra) no se justifica. La escalera se
> corta en Rung 2 (ast-grep).

## 2. La doctrina — escalera de escalamiento (Rung 0-2)

Regla que gobierna todo: **entra siempre por el nivel más barato; escala solo con un
trigger definido, nunca por default.** Las herramientas de precisión sirven para
*verificar una hipótesis*, no para *formarla*.

```
Rung 0  ORIENTACIÓN  engram        "dónde vive X / cuál es la convención"    (memoria, ~gratis)
Rung 1  TEXTO        ripgrep/Grep  token conocido: nombre, string, import    (1-5ms, ~0 tokens)
Rung 2  ESTRUCTURA   ast-grep (sg) "forma del código": hooks, async fns      (10-50ms, bajo)
```

Entrada por default = **Rung 1**. Rung 0 (engram) corre como pre-flight para acotar el
scope. Rung 2 es **solo por escalamiento**: hay que haber pegado a un trigger.

### Rung 0 — Orientación (engram)
- **Usar SIEMPRE primero** para el "dónde/qué/por qué" del repo mismo: dónde viven los
  módulos, entry points, convenciones. Acota el *scope* contra el que corren todos los
  greps posteriores — el mayor ahorro de tokens.
- **Herramienta equivocada cuando:** necesitas número de línea, firma actual, o call
  sites exactos. Engram NUNCA es fuente de verdad para datos volátiles precisos.
- **Escala cuando:** engram te da una *región* → pásala a Rung 1 como filtro de path.

### Rung 1 — Texto (ripgrep / tool Grep — ya integrada en el host)
- **El caso ~80%:** cualquier query con un token literal conocido — nombre de
  función/variable, string, mensaje de error, import, config key.
- **Disciplina:** arranca con `-l` (solo archivos) o patrón estrecho, nunca un dump.
  Comprime resultados a `file:line + ≤2 líneas de contexto + dedup`.
- **Herramienta equivocada cuando:** lo que buscas es una *forma sintáctica*, no un
  string ("todas las async fn sin try/catch"). Regex sobre código = ruido = tokens.
- **Escala a Rung 2 cuando:** 0 resultados tras 2 patrones razonables · resultados
  puro ruido · estás escribiendo un regex para aproximar un AST.

### Rung 2 — Estructura (ast-grep / `sg`)
- **Usar para la *forma* del código y refactors multi-sitio seguros.** Un binario, sin
  infra, sin warmup. Ejemplos: `sg -p 'async function $N($$$){ $$$ }'`, "todos los
  componentes que usan `useAuth`", codemods por estructura.
- **Herramienta equivocada cuando:** solo buscas un nombre (eso es Rung 1) o la
  pregunta es *conceptual* ("¿dónde se refresca la sesión?" — ningún patrón sintáctico
  lo captura). Para eso vuelve a Rung 0 (orientación) y baja de nuevo.
- **Techo del plan:** no escalamos a LSP. Si un caso realmente necesita semántica
  cross-file (rename con shadowing, "quién llama a esto" con tipos), se resuelve a mano
  leyendo el span confirmado — no montamos infra por el caso raro.

## 3. Mapa query → herramienta (va en el skill)

| Necesidad | Rung | Comando |
|---|---|---|
| "¿Dónde vive el adapter de Codex?" | 0 | engram `mem_search` → región |
| "Dónde se importa `harness-assets`" | 1 | `rg "harness-assets" -l` |
| "El string de error 'engine not found'" | 1 | `rg "engine not found" -n -C2` |
| "Config keys `render.*`" | 1 | `rg "render\." --type json` |
| "Toda async fn sin manejo de error" | 2 | `sg -p 'async function $N($$$){ $$$ }'` |
| "Componentes que usan `useAuth`" | 2 | `sg` patrón de hook |
| "Rename `renderAsset`→`emitAsset` en el repo" | 2 | `sg` codemod (revisar diffs) |

## 4. Regla estable-vs-volátil (mantener engram fresco)

**engram guarda el mapa de orientación durable; las herramientas traen lo perecedero.
Nunca invertir esto.**

- **Estable → engram (persistir):** mapa de módulos, entry points, capas/convenciones,
  decisiones arquitectónicas, *dónde buscar*. Cambia en escala de meses.
- **Volátil → herramientas, siempre (nunca persistir):** líneas, firmas actuales, listas
  de call-sites, contenido de archivo. Cambia en escala de commits. Una línea en memoria
  es una mina.
- **Disciplina anti-staleness:**
  1. Guarda *punteros, no snapshots* ("el entry de render es el comando `render` en
     `commands/`", NO "la lógica está en la línea 142").
  2. *Verify-on-use:* cada hit de engram es una *hipótesis* → confírmala con un grep
     barato antes de actuar. Grep es el chequeo de frescura.
  3. *Write-back on contradiction:* si una herramienta contradice a engram, `mem_save`/
     `mem_update` de inmediato. La doctrina se auto-cura.
  4. Si una memoria no se puede frasear como "hecho estructural durable", no va en engram.

## 5. Higiene de engram: guardar normal, curar al cerrar

### 5.1 Qué SÍ y qué NO se puede modificar (hallazgo de investigación)

Engram = binario Go + un SQLite (`~/.engram/engram.db`). Sin retention/TTL/auto-expiry:
todo persiste hasta borrado manual.

- **NO configurable — el formato/volumen de inyección al arranque.** El `SessionStart`
  inyecta **5 sesiones + 20 observaciones + 20 prompts** del proyecto, y esos límites
  están **hardcodeados** (`MaxContextResults=20` compile-time). No hay env var ni config
  file para bajarlo. Reducirlo exige fork+rebuild o trimear `session-start.sh`. → **La
  preocupación de "se carga demasiado al arrancar" es infundada: está topado y es
  modesto, sin importar cuánto acumules.**
- **SÍ modificable — qué se escribe y cómo.** Contenido, `type`, `topic_key`, pin: 100%
  en nuestro control vía protocolo. Aquí está la palanca real.

### 5.2 Estrategia "save normal durante, curar al cerrar"

1. **Durante la sesión:** `mem_save` proactivo (como hoy) **pero con `topic_key`** para
   que saves del mismo tema hagan **UPSERT** (bump `revision_count`) en vez de crear
   filas nuevas. Esto frena el bloat en origen — 10 saves de un tema = 1 observación que
   evoluciona, no 10.
2. **Al cerrar (parte de `mem_session_summary`):** pasada de curación —
   - **Consolidar:** los saves triviales de la sesión → merge o `mem_delete`.
   - **Ascender:** los hallazgos durables → `topic_key` estable y/o `mem_pin`.
   - **Borrar:** lo volátil que no debió persistir (líneas, estados temporales).
   - El `session_summary` queda como registro canónico; las observaciones intermedias ya
     cubiertas por el summary se pueden `mem_delete --hard`.
3. **Implementación en navori:** protocolo en el claude-md block del plugin engram (o
   skill dedicado `memory-curation`) que corre en el cierre. Es **juicio → agente**, no
   hook mecánico (un script no sabe qué es "importante").
4. **Opcional:** skill `/curate-memory` on-demand para pasar review→consolidate→prune
   sobre lo ya acumulado (útil para las 302 obs de navori-harness).

> Caveat: el borrado agresivo automático es riesgoso. La curación consolida + deja el
> summary como canónico, y solo borra lo claramente trivial/volátil. No perder lo durable.

### 5.3 Higiene one-time del store personal (acción, no feature de navori)

Estado real medido: **786 sesiones · 1510 obs · 32 proyectos** (~12 reales). Drift a limpiar:
- Probes de Codex: `navori-codex-agent-probe.*`, `navori-generated-codex.*`,
  `navori-codex-render-check`, `navori-codex-spike` (0 obs).
- Otros drift: `ulisescm`, `moonar` (0 obs), `poker-2`, `alertaciudadana` (bare) y
  `alertaciudadana_backend_audit` (1 obs c/u), variantes de sessions
  (`services-sessions` / `bonum-services-sessions` / `bonum-sessions`).
- Comandos: `engram projects consolidate` / `prune`, `mem_merge_projects`.
- Bloqueo de sync aparte: **201 obs en navori-harness sin `title`** frenan la replicación
  cloud (no es bloat). Fix: `engram cloud upgrade doctor --project navori-harness`
  (solo relevante si usa cloud sync).

## 6. Plan de implementación por fases

### Fase 1 — ast-grep core skill + allowlist (rápido, cero infra) ⭐
1. `packages/core/core-assets/skills/structural-search.md` — core skill.
   - Frontmatter: `type: reference` (cap 500; `maxWords` explícito solo si se excede),
     `description` con verbo trigger ("Usar cuando…" per `TRIGGER_RE`).
   - Cuerpo = doctrina §2 + tabla §3 + anti-patterns §7 + fallback ("si `sg` no está,
     cae a Grep — no bloquees").
   - Zona `<!-- navori:user-section -->` para patrones del stack.
2. Registrar id en `CORE_SKILLS` (`packages/cli/src/engines/shared/harness-assets.ts`).
   Ambos engines lo renderizan solos (Claude `.claude/skills/`, Codex
   `.codex/skills/<id>/SKILL.md` — confirmado en Spec 0004 Fase 0; `.agents/skills/`
   también funciona pero se estandariza en `.codex/` por consistencia de raíz).
3. Allowlist en `packages/core/core-assets/settings/settings-base.json` →
   `permissions.allow`: `"Bash(sg:*)"`, `"Bash(ast-grep:*)"`. Claude-only; Codex ya lo
   permite por `sandbox_mode = workspace-write`.
4. doctor: check opcional "¿`sg` en PATH?" → warning no-bloqueante con hint de instalación.

### Fase 2 — Protocolo de curación de engram
1. Actualizar el claude-md block del plugin engram (o nuevo skill `memory-curation`) con
   §5.2: `topic_key` upserts durante + pasada de curación al cerrar.
2. Opcional: skill `/curate-memory` on-demand.

**ripgrep:** nada que construir; ya es la tool `Grep`. Solo se menciona como default de
texto en el skill de Fase 1.

## 7. Anti-patterns que la doctrina mata

1. **Reflejo de leer-el-archivo-completo** (#1 sumidero de tokens) → Rung 0 dice *cuál*
   archivo; `rg -l`/`sg` dicen *dónde* en él. Lee solo el span confirmado.
2. **Regex-ear un AST** — el momento en que codificas sintaxis en regex, estás en el
   rung equivocado → `sg`.
3. **Grep ancho sin scope** — `rg "user"` en un monorepo = miles de hits. Siempre acota
   (región de engram + `--type` + path). Un dev recortó 83% de input tokens solo con esto.
4. **Sin triggers de escalamiento** — define hard stops: 0 resultados → escala;
   presupuesto de búsqueda ≈ 15% del context window → deja de buscar, actúa.
5. **Confiar en memoria stale para datos precisos** — verify-on-use es innegociable.
6. **Guardar volátil en engram** — líneas/firmas/estados. Solo punteros durables (§4).

## 8. Estimación de eficiencia

| Herramienta | Ahorro sostenido de input tokens | Costo/riesgo |
|---|---|---|
| ripgrep | Ya activo (es la tool Grep) | 0 |
| **ast-grep solo** | **~8-12% promedio, picos 20-30% en refactor/búsqueda de patrón** | Cero overhead |
| + engram Rung 0 + curación | Suma en arranque (menos reads de orientación) + memoria más limpia = búsqueda mejor | Mantener protocolo de cierre |

Todo el ahorro es **barato y sin riesgo**. No hay capa cara (LSP fuera).

## 9. Decisiones abiertas

- ¿Fase 1 y Fase 2 juntas o ast-grep primero?
- ¿`type: reference` (cap 500) alcanza para el skill de structural-search?
- ¿doctor check de `sg` warning o silencioso?
- Curación: ¿protocolo en el claude-md block del plugin engram, o skill dedicado
  `memory-curation` + `/curate-memory` on-demand?
- ¿Ejecutar la higiene one-time del store personal (§5.3) ahora, aparte del plan?
