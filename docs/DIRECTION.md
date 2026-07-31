# DIRECTION — Fuente de verdad de navori

> **Lee esto ANTES de proponer o construir cualquier cosa en navori** (humano o agente de IA).
> Es el norte del proyecto: qué es, hacia dónde va, qué SÍ y qué NO debe hacer.
> Si una idea contradice lo que aquí se declara como invariante, no se implementa sin
> pasar primero por "Qué requiere discusión". Las decisiones formales viven en `specs/`;
> este doc las resume y enlaza, no las duplica.

## Qué es navori

navori es un paquete npm (CLI, binario `navori`) que replica un **harness multi-agente + SDD**
en cualquier repo, de forma reproducible y con soporte **multi-engine** (Claude Code hoy;
Codex, AGENTS.md universal, Cursor, Copilot en el core engine-agnostic). Reconstruye
`CLAUDE.md` + `.claude/` + `progress/` de forma **idempotente** desde una única fuente de
verdad (`navori.config.json`), sin pisar el trabajo manual del usuario. Estado actual: MVP
funcional en producción interna (rollout a 15 repos Bonum), monorepo pnpm con `@navori/cli` +
`@navori/core` + `apps/website`.

## North Star

**Que cualquier repo entre a una sesión de IA con guardrails, doctrina de orquestación,
memoria y calidad ya puestos — reproducibles, versionados y sin degradar el trabajo del
usuario.** navori genera el harness; no ejecuta las herramientas del agente: dicta *qué*
herramienta y *qué* doctrina usar vía skills + permisos + protocolo, materializados como
assets managed.

navori es **tool-for-self primero**: el criterio de toda feature es "¿esto me ayuda a mí
(Ulises/Bonum) a trabajar mejor?", no "¿esto populariza el producto?". El MVP ya cubre el
workflow real; lo que sigue **endurece lo que existe** antes que agregar superficie nueva.

## Metas

- **Reproducibilidad**: `render` reconstruye todo el harness desde `navori.config.json`. Cero
  estado oculto; el config checked-in es la única fuente de verdad.
- **Modelo híbrido no destructivo**: lo managed se sincroniza; lo del usuario es intocable.
  El moat es regenerar sin destruir trabajo manual.
- **Multi-engine con un solo pipeline**: un proveedor N+1 cuesta ~una tabla declarativa, no
  reimplementar el render (spine compartido, Specs 0007/0008).
- **Calidad que sobrevive 6 meses**: la CLI y los assets generados no dan sorpresas; el
  quality gate es duro.
- **Optimización de tokens**: el harness rendereado se paga en cada sesión → reducir el peso
  always-on es leverage compuesto (Specs 0005/0006).
- **Base por-máquina y por-workspace**: piso de doctrina global (`~/.claude`, Spec 0010) +
  conocimiento durable transversal al workspace (Dominio, Spec 0011), ambos aditivos.

## No-metas (Non-goals)

Explícitamente **fuera de alcance** salvo que una razón nueva y fuerte lo cambie:

- **Popularizar / branding / marketing / monetización / i18n del producto / control plane
  en Rust.** navori es tool-for-self, no un producto de mercado (Spec 0003).
- **Ecosistema público formalizado de plugins.** Los plugins son bundles internos, no un
  marketplace.
- **Arquitectura de instalación selectiva** estilo otras herramientas.
- **Features grandes nuevas cuando el pendiente es endurecer lo existente.** Prioridad:
  calidad > tokens > velocidad, en ese orden.
- **LSP / Serena (Rung 3 de la escalera de búsqueda).** Descartado por overhead fijo (~3k
  tok/sesión + language server); la escalera se corta en Rung 2 / ast-grep (Spec 0005).
  codegraph (Spec 0009) entra como índice AST local barato, no como LSP.
- **Que navori ejecute las herramientas del agente.** navori genera el harness (skills +
  allowlists + plugins + protocolo); no corre grep/ast-grep/tests por el agente.
- **"Voz de navori" / app-builder / review 4R** del harness global — parqueados fuera del
  MVP lean de Spec 0010.

## Principios de diseño / invariantes (NO se re-litigan sin razón nueva)

1. **5 capas en cascada** — Core → Preset → Workspace → Project config (`navori.config.json` +
   plugins opt-in) → Engine adapters. Cada capa compone sobre la anterior. *Por qué*: separa
   baseline universal de lo específico por stack/org/repo/engine sin duplicación.
2. **Multi-engine desde día 1** — el core es engine-agnostic aunque solo se rendericen algunos
   engines. *Por qué*: agregar un proveedor no debe reescribir el pipeline.
3. **Source of truth = `navori.config.json` checked-in** — `render` reconstruye desde ahí.
   *Por qué*: reproducibilidad total; sin estado oculto.
4. **Modelo híbrido de sync con marcadores** — `<!-- navori:managed ... -->` se sincroniza;
   todo lo de afuera es del usuario e intocable. `hash` detecta drift de contenido; `version`
   detecta que el bundle avanzó. *Por qué*: regenerar idempotente sin pisar trabajo manual.
5. **Render preview por default** — `render` no toca disco; `--apply` escribe, con backup previo
   y escritura atómica (fsync). *Por qué*: nunca sorprender al usuario con cambios en disco.
6. **Plugins como bundles** — cada plugin trae hasta piezas opcionales (settings fragment,
   claude-md block, skill, hook, doctor check) y se declara dentro de la capa Project config.
   *Por qué*: addons opt-in cohesivos, no una capa aparte.
7. **Un solo pipeline de render (spine compartido)** — resolver inventario + placement +
   backup/write/prune viven una vez; los engines son tablas declarativas sobre ese spine
   (Specs 0007/0008). *Por qué*: un fix de pipeline llega a todos los engines a la vez; evita
   divergencia silenciosa entre proveedores.
8. **Huella-cero sin opt-in** — el harness global (`~/.claude`) y el Dominio son **aditivos**:
   se hacen a un lado cuando el repo trae su propia config navori y nunca degradan lo que el
   repo ya trae. Guard estructural protege el invariante (Spec 0010). *Por qué*: instalar base
   por-máquina no debe romper repos existentes.
9. **navori genera, no ejecuta** — el harness enseña al agente qué herramienta usar; navori no
   corre esas herramientas. *Por qué*: mantiene el CLI simple y el harness portable.
10. **Auto-hospedaje** — el harness (`.claude/` + `CLAUDE.md` + `navori.config.json`) SÍ se
    commitea en este repo y en todo repo no-Bonum: navori se come su propia comida. (En repos
    `/bonum` el harness va gitignored por convención.)

## Qué requiere discusión antes de cambiarse

Estas son "decisiones ya tomadas — no re-litigar sin razón nueva". Cambiarlas exige una
**spec nueva o una enmienda a la spec vigente** (no un PR suelto):

- Cualquiera de los 10 invariantes de arriba.
- La lista de No-metas (reabrir branding, plugin marketplace, LSP, etc. requiere justificación
  documentada de por qué cambió el contexto).
- El orden de prioridad de metas: **calidad > tokens > velocidad**.
- El alcance lean de harness global y Dominio (Specs 0010/0011): ampliarlos a "voz",
  app-builder o review 4R está parqueado a propósito.
- La forma de los assets managed (marcadores, `hash`/`version`, zona managed vs zona usuario):
  romper este contrato rompe `sync` en todos los repos ya instalados.

Regla práctica: si tu idea contradice un invariante o reabre una No-meta, **primero abre/edita
una spec** en `specs/` y consíguela aprobada; recién entonces se implementa.

## Cómo contribuir sin salirse de los parámetros (humanos Y agentes)

1. **Lee este doc primero**, luego `docs/architecture.md` (cómo funciona el render y las capas)
   y la(s) spec(s) del área que vas a tocar (`specs/000X-*.md`).
2. **Las decisiones formales viven en `specs/`.** No inventes dirección nueva en un PR: si
   necesitas una decisión de arquitectura, va en una spec. Los headers de cada spec traen
   Status/Objetivo; respeta el estado (`proposed` / `planning only — NO implementar` /
   `EJECUTADA`).
3. **Quality gate (obligatorio antes de cerrar cambios en `packages/cli`)** — es lo que valida
   el job `quality` de CI, o el PR falla:
   - `cd packages/cli && pnpm test` — suite vitest.
   - `cd packages/cli && pnpm lint` — oxlint.
   - **Desde la raíz del monorepo**: `pnpm format:check` — biome (el paso que más se olvida; NO
     está bajo `packages/cli`). Si falla, arréglalo con `pnpm format` antes de commitear.
   - CI corre además `pnpm --filter navori build` y `check:size` (guard de bundle size).
   - Cambios **doc-only** (.md): basta `pnpm lint` + `pnpm format:check`; no necesitas la suite.
4. **Commits**: Conventional, español MX, atómicos.
5. **Branching/PR**: cada ticket en branch nueva con base `main`; **este repo mergea a `main`**
   (excepción a la regla Bonum de mergear a `develop`). Nunca commitees el harness local de un
   repo `/bonum`.
6. **Memoria (engram)**: `mem_search` al inicio si el mensaje referencia navori; `mem_save`
   proactivo tras una decisión de diseño; `mem_session_summary` antes de cerrar.

## Referencias

- `docs/architecture.md` — cómo funciona el render, las 5 capas y los bloques managed.
- `specs/` — decisiones de arquitectura formales (0001 render por workspace, 0002 engine
  Claude, 0003 v0.2 calidad/tokens, 0004 engine Codex, 0005 lectura eficiente, 0006 reducción
  de contexto, 0007/0008 render-plan unificado, 0009 codegraph, 0010 harness global, 0011
  Dominio).
- `docs/audit-2026-07.md` — auditoría del harness generado y del CLI.
- `CLAUDE.md` (raíz) — instrucciones vivas del repo (secciones "Qué es este proyecto",
  "Decisiones ya tomadas", "Quality gate").
