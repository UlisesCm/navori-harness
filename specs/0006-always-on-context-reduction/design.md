# Spec 0006 — Reducción de contexto always-on (trim + inglés)

- **Status**: proposed (planning only — NO implementar hasta aprobación)
- **Fecha**: 2026-07-24
- **Autor**: Ulises Ciprés
- **Relacionado**: spec 0005 (lectura eficiente), plugin engram, harness assets

## 1. Problema

Los skills ya son **lazy** (solo su nombre+descripción vive en contexto; el cuerpo carga
al invocarse). El costo evitable no está ahí — está en lo **always-on**: lo que se
inyecta en **cada turno de cada sesión, se use o no**. Eso se paga siempre, así que cada
token que le quites se ahorra en cada mensaje de tu vida con la herramienta.

## 2. Baseline medido

| Archivo | Chars | ~Tokens (ES) | Cuándo se paga |
|---|---|---|---|
| Global `~/.claude/CLAUDE.md` | 4,120 | ~1,150 | Cada turno, **todos** los proyectos |
| Proyecto `navori/CLAUDE.md` | 2,761 | ~800 | Cada turno en navori |
| **Total always-on CLAUDE.md** | — | **~2,000/turno** | — |
| 8 core skills (cuerpos) | 37,481 | ~10,500 | **Lazy** (solo al invocar) |

Referencia de conversión: ES ≈ 3.3-3.7 char/token, EN ≈ 4.0 char/token.

## 3. Los levers, por prioridad

### Lever A — Quitar de always-on lo que es consulta ocasional (el más grande)
El global CLAUDE.md carga el **diccionario completo de Bonum** (tabla de frontends/
backends/servicios + variables `VITE_APP_*`) en cada turno de **cada** proyecto, aunque
estés en navori y no toques Bonum.
- **Acción:** mover esa tabla-referencia a un **skill lazy** (`bonum-workspace-map`) o a
  engram, que solo cargue cuando de verdad navegas el workspace Bonum.
- El global CLAUDE.md always-on queda solo con lo que aplica *siempre*: idioma, rol,
  reglas globales (branching, Jira CLI, engram).
- **Ahorro estimado: ~500-600 tok/turno.**

### Lever B — Traducir a inglés lo que queda always-on (secundario, barato)
El tokenizer de Claude favorece inglés; el español cuesta **~15-25% más tokens** por el
mismo contenido.
- **Aplica a:** archivos que instruyen al modelo (CLAUDE.md, AGENTS.md, descripciones de
  skills). **NO al chat** — las respuestas siguen en español MX (regla de Ulises).
- **Ahorro estimado:** ~15-25% sobre el texto traducido. En always-on ≈ ~300-400
  tok/turno adicional (encima del Lever A).
- **Bonus:** mejor adherencia a instrucciones en inglés.
- **Mecanizable:** sí, con agentes en batch (es traducción + verificación, no diseño).

### Lever C — Descripciones de skills en una línea
La `description` de cada skill es always-on (va al índice de skills). Descripciones de 3
líneas × N skills se suman en cada turno.
- **Acción:** una línea con verbo trigger, punto. Auditar las actuales.

### Lever D — Progressive disclosure dentro de skills
Skill corto (`SKILL.md`) que apunta a archivos de referencia leídos solo cuando hacen
falta. El cuerpo tampoco infla al invocarse; carga el detalle solo si el caso lo pide.

## 4. Español→inglés: análisis y caveats

**Verdad:** ahorro real de ~15-25% sobre el texto traducido. Pero es el lever
**secundario** — quitar (Lever A) rinde más que traducir. El orden correcto es: primero
quitar, luego traducir lo que quede.

**Dónde SÍ traducir:**
- CLAUDE.md global + proyecto (always-on, se paga siempre) → mayor ROI.
- AGENTS.md (Codex).
- Descripciones/frontmatter de skills (always-on en el índice).
- Cuerpos de skills (lazy) → ROI menor, pero consistencia + leve ahorro por invocación.

**Dónde NO:**
- El chat / las respuestas al usuario → **siempre español MX**.
- Comentarios de código ya están en inglés (regla vigente).

**Caveats para los assets de navori (Track B):**
1. **`TRIGGER_RE`** en `packages/cli/src/lib/skill-meta.ts` matchea verbos trigger en
   español (`aplica|usar|cuando|antes de`) **y** en inglés (`use when|use this`). Al
   traducir descripciones hay que **verificar** que la nueva descripción siga matcheando
   (usar "Use when…"). Si algún test valida trigger en español, actualizarlo.
2. **Identidad de producto:** navori es un harness para un equipo hispanohablante. Pasar
   todos los assets a inglés es una **decisión de producto**, no solo de tokens. El
   argumento a favor: instrucciones en inglés (eficiencia + adherencia), chat en español.
3. **Tests:** `packages/cli/src/lib/__tests__/schema.test.ts` y otros pueden asertar
   contenido en español. Quality gate: `cd packages/cli && pnpm test` tras cada tanda.

## 5. Plan por tracks

### Track A — Archivos personales de Ulises (quick win, sin impacto de producto)
1. Global `~/.claude/CLAUDE.md`:
   - Mover diccionario Bonum → skill lazy `bonum-workspace-map` (o engram). (Lever A)
   - Traducir lo que quede a inglés. (Lever B)
2. Proyecto `navori/CLAUDE.md`: traducir a inglés + trim de lo redundante con el código.
3. **Mecanización:** agente que (a) separa always-siempre vs consulta-ocasional, (b)
   traduce, (c) reporta diff antes de aplicar.

### Track B — Assets de navori (decisión de producto)
1. Traducir descripciones de skills (always-on en el índice) → inglés, verificando
   `TRIGGER_RE`. (Lever B + C)
2. Traducir cuerpos de core + library skills → inglés (lazy, ROI menor). Opcional.
3. Progressive disclosure en los skills más largos (`review-diff` 7.2K, `loop-back-debug`
   6.3K, `verify-before-done` 6.2K). (Lever D)
4. Quality gate `pnpm test` tras cada tanda; verificar que no rompe asserts de contenido.
5. **Requiere decisión explícita** antes de arrancar (identidad de producto).

## 6. Estimación de ahorro

| Lever | Ahorro always-on | Esfuerzo |
|---|---|---|
| A — Quitar tabla Bonum del global | ~500-600 tok/turno | Bajo (mover a skill) |
| B — Traducir always-on a inglés | ~300-400 tok/turno | Bajo (mecanizable) |
| C — Descripciones a 1 línea | ~100-300 tok/turno | Bajo |
| D — Progressive disclosure | Reduce carga al invocar | Medio |
| **Combinado (A+B+C) sobre CLAUDE.md** | **global ~1,150 → ~450 (~60% recorte)** | — |

Todo el ahorro es always-on → se cobra en cada turno, compone sobre miles de mensajes.

## 7. Decisiones abiertas

- ¿Track A (personal) ya, y Track B (navori) como decisión aparte?
- Diccionario Bonum: ¿skill lazy `bonum-workspace-map` o memoria engram?
- Track B: ¿traducir solo descripciones (always-on) o también cuerpos (lazy)?
- ¿Quién verifica `TRIGGER_RE` + tests tras la traducción de assets navori?
