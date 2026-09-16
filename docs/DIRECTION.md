# DIRECTION — Fuente de verdad de navori

> **Lee esto ANTES de proponer o construir cualquier cosa en navori** (humano o agente de IA).
> Es el norte del proyecto: qué es, hacia dónde va, qué SÍ y qué NO debe hacer.
> Si una idea contradice lo que aquí se declara como invariante, no se implementa sin
> pasar primero por "Qué requiere discusión". Las decisiones formales viven en `specs/`;
> este doc las resume y enlaza, no las duplica.

## Qué es navori

navori es un paquete npm (CLI, binario `navori`) que replica un **harness multi-agente + SDD**
en cualquier repo, de forma reproducible y con soporte **multi-engine**: hoy renderean Claude
Code, Codex nativo (Spec 0004, ejecutada), AGENTS.md universal, Cursor y Copilot sobre el
mismo spine engine-agnostic. Reconstruye
`CLAUDE.md` + `.claude/` + `progress/` de forma **idempotente** desde una única fuente de
verdad (`navori.config.json`), sin pisar el trabajo manual del usuario. Estado actual: MVP
funcional en producción interna (rollout a 15 repos Bonum), monorepo pnpm con `@navori/cli` +
`@navori/core` + `apps/website`.

### La capa global (`~/.claude`) — qué es y qué no es

Además del harness por repo, navori instala opcionalmente un **piso por máquina** con
`navori global init` (Spec 0010): el manifest `~/.navori/global.json` y el plugin
`navori@skills-dir` en `~/.claude/skills/navori/` — agentes, skills y un hook `SessionStart`
que inyecta el baseline de doctrina. Existe por una razón acotada: las sesiones que arrancan
**fuera** de un repo con navori (un scratch, un repo ajeno, tu `~`) hoy no tienen harness de
ninguna clase. Es opt-in y de huella cero — sin ese `init` no existe nada y navori no tocó la
máquina.

Lo que **no** es: no sustituye al harness del repo; no es un segundo lugar donde vivan las reglas
del proyecto (ésas siguen saliendo de `navori.config.json`, fuente de verdad única, y duplicarlas
arriba sería exactamente la deriva que el invariante 3 evita); y no se aplica dentro de un repo con
navori — el hook encuentra el `navori.config.json` y se hace a un lado sin emitir nada, que es el
invariante 8 en su forma ejecutable.

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
  codegraph (Spec 0009) entró como índice AST local barato, no como LSP — y **se retiró del
  motor el 2026-09-15** junto con `tgrep` (Spec 0017), para reimplementarse desde cero con
  una integración que los haga trabajar entre sí. Mientras tanto la búsqueda de contenido es
  `Grep`/`Glob` nativos. Lo medido antes de retirarlos —codegraph con cableado correcto y
  cero llamadas; tgrep al 7.4% por doctrina y 40.7% con guard mecánico— vive en
  [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md); el rechazo
  a LSP/Serena no se re-litiga por esto.
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

## Criterio de admisión por superficie

Antes de sumar una superficie nueva (plugin, servidor MCP, bloque managed o skill), el
orden de admisión por mecanismo es: reglas always-on → skill on-demand → MCP → CLI local
→ API directa, con sesgo explícito hacia la superficie de runtime más chica, el menor
overhead de tokens y menos piezas móviles. Es un eje distinto del de `docs/EXTENDING.md`
(dónde vive conocimiento NUEVO de tu repo, ordenado por quién es dueño: user-section →
skill project-local → preset local → plugin → core) — ahí el bloque always-on (`core`)
es el escalón más caro y último, no el primero. Los dos ejes no se mezclan: uno decide
qué mecanismo usar, el otro dónde vive el conocimiento una vez elegido el mecanismo.

Para un servidor MCP en particular, gana su slot solo si se cumplen **las dos**
condiciones: (1) **universal** — aplica a prácticamente cualquier sesión, no a un caso
de nicho; (2) **MCP le gana a un CLI/API envuelto en skill** — el trabajo necesita algo
que solo MCP da (estado de sesión interactivo, streaming, un handshake de auth, browsing
estructurado). Trabajo stateless de request/response es una skill, no un servidor.

El argumento de costo con el que otros harnesses (ECC) sostienen esta regla —que cada
conector default carga sus ~30 esquemas de tools en cada sesión— es un dato de 2026 ya
superado en Claude Code: [la doc oficial de context window](https://code.claude.com/docs/en/context-window)
confirma que los esquemas de tools MCP quedan **diferidos por default** y se cargan bajo
demanda vía tool search; lo que sí carga siempre es el listado de nombres. El criterio
que se adopta aquí es el **arquitectónico** (stateless → skill, menos piezas móviles), no
el de costo de tokens de ECC.

`packages/core/core-assets/` no declara ningún `mcpServers` hoy — cero connectors
default. Esta regla es criterio para lo que venga, no auditoría de lo que ya existe.

**Retirados** (superficie, veredicto y reemplazo — para que nadie los reproponga sin
saber qué se midió):

| Superficie | Veredicto | Reemplazo |
|---|---|---|
| plugin `tgrep` (capa de búsqueda) | doctrina sola dio 7.4% de activación, guard mecánico 40.7% — se retira para reimplementarse con integración real, no por bajo valor medido | `Grep`/`Glob` nativos mientras tanto (`7c6930dc`, #803) |
| plugin `codegraph` (índice AST local) | cableado correcto y cero llamadas — el acoplamiento con `tgrep` era de ruteo, no de infraestructura | ídem; detalle en [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md) |

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

   Y antes de escribir nada, **ubica en qué capa rinde más el cambio** — `docs/EXTENDING.md`.
   Cinco destinos ordenados de más barato a más caro, donde el más barato suele ser el más
   efectivo: sumar a la skill que ya cubre el tema llega más rápido y con la autoridad ya
   establecida. Ese doc trae además las cuatro preguntas que hacen fuerte a una propuesta.
2. **Las decisiones formales viven en `specs/`.** No inventes dirección nueva en un PR: si
   necesitas una decisión de arquitectura, va en una spec. Respeta el estado que declare su header
   (`proposed` / `planning only — NO implementar` / `EJECUTADA`) **y confírmalo contra el
   código**, que es la fuente más fresca (ver "Referencias").
3. **Quality gate (obligatorio antes de cerrar cambios en `packages/cli`)** — `pnpm check` desde
   la raíz del monorepo. Es lo que valida el job `quality` de CI, o el PR falla.

   El gate vive en **un solo lugar**: `qualityGate.full` en `navori.config.json`. `pnpm check` es
   su alias, y de ahí salen también los bloques managed de `CLAUDE.md`. Este doc no lo transcribe
   a propósito — una segunda copia es una copia que se desincroniza, y ya pasó una vez (#508).

   Lo que no se deduce del comando —los disparadores del re-render del espejo, el golden snapshot,
   y qué cuenta como cambio doc-only— está en `CONTRIBUTING.md`.
4. **Commits**: Conventional, español MX, atómicos.
5. **Branching/PR**: cada ticket en branch nueva con base `main`; **este repo mergea a `main`**
   (excepción a la regla Bonum de mergear a `develop`). Nunca commitees el harness local de un
   repo `/bonum`.
6. **Memoria (engram)**: `mem_search` al inicio si el mensaje referencia navori; `mem_save`
   proactivo tras una decisión de diseño; `mem_session_summary` antes de cerrar.

## Referencias

- `docs/architecture.md` — cómo funciona el render, las 5 capas y los bloques managed.
- `docs/EXTENDING.md` — en qué capa rinde más lo que quieres agregar (user-section / skill
  project-local / preset local / plugin / core) y las cuatro preguntas que hacen fuerte a una
  propuesta.
- `docs/recipes/skill-authoring.md` — el contrato de un `SKILL.md`: frontmatter, tipos, caps y
  triggers.
- `specs/` — decisiones de arquitectura formales. Al día de hoy van de 0001 a 0021 más
  `gitignore-harness`: 0001 render por workspace,
  0002 engine Claude, 0003 v0.2 calidad/tokens, 0004 engine Codex, 0005 lectura eficiente, 0006
  reducción de contexto, 0007/0008 render-plan unificado, 0009 codegraph, 0010 harness global,
  0011 Dominio, 0012 capa de solutioning, 0013 redefinición de `audit`, 0014 harness ajeno, 0015
  orquestación fuera del always-on, 0016 paridad de modos de permiso, 0017 capa de búsqueda tgrep
  (**retirada**, como la 0009: las dos llevan banner y apuntan a
  `docs/research/tgrep-como-funcionaba.md`),
  0018 harness por workspace, 0019 orquestación que cabe en el arranque, 0020 delegación por
  mecanismo nativo, 0021 eventos OTel como tercera fuente.

  **Cómo leerlas con confianza.** El header de cada spec declara la intención con la que se
  escribió, y el código dice dónde acabó. Varias se escribieron antes de aterrizar y su header se
  quedó en ese primer momento —0001 y 0002 siguen diciendo `proposed` con su contenido ya en
  producción—, y once todavía no declaran `Status`. Combinar ambas fuentes toma un minuto y da el
  estado real; lo que sí sigue pendiente de decidir lo dice sin ambigüedad (`planning only — NO
  implementar hasta aprobación`, como 0005 y 0006). Normalizar esos headers es una mejora
  pendiente con buen retorno: es la primera señal que lee quien llega nuevo.
- `docs/audit-2026-07.md` — auditoría del harness generado y del CLI.
- `CLAUDE.md` (raíz) — instrucciones vivas del repo (secciones "Qué es este proyecto",
  "Decisiones ya tomadas", "Quality gate").
