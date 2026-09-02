# La orquestación fuera de la capa always-on — Requirements

## Context

`Role: orchestrator (organic routing)` son **73 líneas / 3,147 tokens**: el bloque más caro
del `CLAUDE.md` renderizado. Está escrito en segunda persona al agente principal —"You are
the main agent"— y cada una de sus secciones decide algo que solo él decide: qué ruta tomar,
cuándo escalar, cómo paralelizar `Agent`, cómo sintetizar lo que vuelve.

Y lo recibe **cada subagente**. La doc de Claude Code lo confirma: el contexto inicial de un
subagente que no es fork incluye *"every level of the CLAUDE.md hierarchy the main
conversation loads"*. Ninguno de ellos puede actuar sobre él: solo `leader` declara la tool
`Agent` en su `tools:`, y `leader` nunca se lanza por contrato.

Medido con `navori audit` sobre una sesión real de 19 subagentes: **527,949 tokens solo en
arrancarlos** (28k c/u). 3,147 × 19 ≈ **60k de ese arranque** son el bloque de orquestación
entregado a agentes que no orquestan.

Dos cosas que esta spec verificó antes de proponer nada:

1. **No se pierde nada al sacarlo.** El único contenido del bloque que le habla a un
   subagente —dónde escribe su reporte, la línea `Status:`, no tocar `progress/current.md`—
   ya está declarado en el asset propio de cada agente (`implementer.md:16,43,51,87`,
   `reviewer.md:37,82,85`).
2. **El canal ya existe y navori ya lo usa.** La capa global entrega este mismo bloque por
   el `additionalContext` de un hook de `SessionStart` desde la spec 0010 FB (#546):
   `composeBaseline` → `generateHookScript`, con marcador, hash y verificación de drift. Lo
   que falta no es un mecanismo: es aplicarlo al scope del repo.

Público: cualquier repo que renderice el harness de navori con subagentes habilitados.

## Requirements (EARS)

### El canal

- **R1** — El bloque de orquestación SHALL entregarse al agente principal por el
  `additionalContext` del hook `SessionStart` del repo, y SHALL NOT formar parte del
  `CLAUDE.md` renderizado.
- **R2** — WHEN la sesión arranca, se reanuda o se compacta, el sistema SHALL entregar el
  bloque, para que sobreviva a la compactación igual que hoy.
- **R3** — IF el hook no puede leer el bloque por cualquier causa, THEN SHALL emitir el
  resto de su contexto y terminar con éxito: un bloque ausente degrada el arranque, nunca
  lo rompe.

### Qué recibe cada quien

- **R4** — Un subagente SHALL NOT recibir el bloque de orquestación por ninguna vía.
- **R5** — El contenido dirigido a subagentes que hoy vive dentro del bloque —la ruta de su
  archivo de reporte, la marca `Status:`, la prohibición de escribir `progress/current.md`—
  SHALL seguir declarado en el asset de cada agente, y la suite SHALL fallar si alguno lo
  pierde.

### Que siga siendo un bloque managed

- **R6** — El bloque entregado SHALL conservar su marcador managed con `id`, `hash` y
  `version`, de modo que `doctor` y `sync` detecten drift sobre él exactamente como hoy.
- **R7** — El bloque SHALL renderizarse con la config del repo interpolada
  (`{{qualityGate.*}}`, `{{branchBase}}`, `{{project.criticalAreas}}`), y un placeholder sin
  resolver SHALL hacer fallar el render en vez de llegar al agente.
- **R8** — WHEN `blocks.exclude` del config lista `orquestacion`, el sistema SHALL no
  entregarlo por ninguna vía, y el hook SHALL no mencionarlo.

### Que la migración sea verificable

- **R9** — El sistema SHALL reportar en el render que el bloque se entrega por el hook y ya
  no por `CLAUDE.md`, para que un `render --apply` sobre un repo existente sea legible.
- **R10** — IF un repo ya renderizado conserva el bloque dentro de su `CLAUDE.md`, THEN el
  render SHALL retirarlo de ahí, sin tocar el texto que el usuario haya escrito alrededor.
- **R11** — El sistema SHALL NOT entregar el bloque dos veces cuando la capa global también
  está instalada: la global ya se hace a un lado dentro de un repo con `navori.config.json`,
  y esta spec SHALL preservar esa exclusión mutua.

### Que se pueda medir

- **R12** — El reporte de `navori audit` SHALL poder mostrar el arranque por subagente
  antes y después del cambio, sin instrumentación nueva: la señal `startup-overhead` ya
  publica ese número.
