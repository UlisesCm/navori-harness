# EXTENDING — dónde va lo que quieres agregar

> navori está diseñado para que lo extiendas. El harness que instala es un piso, no un techo: lo
> que lo hace valioso en **tu** repo es el conocimiento que sólo tú tienes. Este doc es el mapa
> para colocarlo donde rinda más.
>
> Lee [`DIRECTION.md`](DIRECTION.md) para el norte del proyecto; aquí resolvemos la pregunta
> práctica: *tengo algo nuevo —una regla, una skill, una herramienta, un bloque de doctrina—
> ¿dónde lo pongo para que funcione y siga funcionando en seis meses?*
>
> Sirve igual a las dos audiencias que llegan: **(a)** quien extiende navori dentro de su repo y
> **(b)** quien contribuye a navori. La mayoría llega por (a), y (a) es donde está el mejor
> retorno por minuto invertido.

## La buena noticia: casi siempre ya tienes dónde ponerlo

Hay cinco destinos, ordenados de más barato a más caro. "Barato" significa menos archivos, menos
revisión y menos tokens por sesión — y el más barato suele ser además el más efectivo, porque deja
tu conocimiento justo donde el agente ya iba a mirar.

Empieza arriba y baja sólo cuando el escalón anterior se te quede corto.

| Lo que tienes | Su lugar | Quién lo versiona |
|---|---|---|
| Una regla de **tu repo** (patrón propio, convención de tu data layer, área crítica) | la **user-section** de la skill que ya cubre el tema | tu repo |
| Conocimiento que ninguna skill instalada cubre todavía | **skill project-local** — `.claude/skills/<id>/SKILL.md` | tu repo |
| Conocimiento de un **stack**, reusable en varios repos tuyos | **preset local** — `.navori/presets/<id>/` | tu repo |
| La envoltura de una **herramienta externa** (binario o servidor MCP) | **plugin** | navori |
| Doctrina **universal**: cierta en cualquier repo, stack y engine | **core** | navori |

Cada escalón está pensado para que el de abajo casi nunca haga falta. Si dudas entre dos, el de
arriba gana: siempre puedes promoverlo después, y promover es más fácil que retirar.

---

## 1. user-section — el default, y casi siempre la mejor jugada

Cada skill que navori renderiza trae un sentinel `<!-- navori:user-section -->`. Todo lo que
escribas debajo es tuyo: `render` y `sync` lo respetan íntegro, y sobrevive a cualquier bump del
CLI. Las plantillas ya te sugieren qué poner —mira el final de
`.claude/skills/review-diff/SKILL.md`.

Lo que ganas: **cero archivos nuevos, cero config, cero revisión**, y la regla queda dentro de la
skill que el agente ya carga para ese tema. Es la forma más rápida que existe de convertir
conocimiento tuyo en comportamiento del agente.

`navori doctor` te señala las user-sections que siguen con la plantilla: son oportunidades
abiertas —skills genéricas corriendo en un repo que tiene reglas propias listas para declarar.

## 2. Skill project-local

Cuando el tema merece su propio archivo, este escalón es tuyo por completo.

1. Crea `.claude/skills/<id>/SKILL.md`. La **forma directorio** es la que el host descubre, así
   que con esa estructura tu skill queda cargable desde el primer momento
   (`packages/cli/src/lib/skill-meta.ts`, `resolveLocalSkillPath`).
2. Escribe el frontmatter con una `description` que declare **cuándo** usarla. Ese trigger es lo
   que hace que el host la cargue sola en el momento justo. El contrato completo —campos, tipos,
   caps— está en [`recipes/skill-authoring.md`](recipes/skill-authoring.md).
3. Declara el id en `project.localSkills` de `navori.config.json`. Con eso aparece en el índice de
   `CLAUDE.md` etiquetada `project-local`, con su trigger leído de tu propio archivo.

**navori nunca escribe dentro de ese archivo.** No lleva bloque managed ni user-section: es tuyo
entero, y ningún render futuro lo va a tocar. Lo que navori aporta es indexarlo y cuidarlo:

| `doctor` te avisa | Para que puedas |
|---|---|
| `missingLocalSkills` | conectar el id declarado con su archivo, y recuperar la skill en el índice |
| `triggerlessSkills` | darle a una skill ya escrita la línea que le falta para activarse sola |

Ese segundo aviso es el de mayor retorno del set: una skill con buen contenido y sin trigger ya
hizo el trabajo difícil. Añadir un *"Usar cuando…"* la pone a funcionar.

## 3. Preset local

`navori preset init <id>` te deja `.navori/presets/<id>/` andando (manifest + `managed/stack.md` +
`skills/`) y cableado al config. La resolución es **local → bundled**, así que un preset local con
el id de uno oficial gana: es la vía limpia para adaptar un preset incluido a como trabaja tu
equipo, sin tocar el paquete.

Es el escalón indicado cuando el conocimiento es del **stack** y lo vas a querer igual en el
siguiente repo que lo use. Escríbelo una vez, cóbralo en todos.

## 4. Plugin — la envoltura de una herramienta externa

Aquí es donde navori conecta el harness con el mundo: un plugin envuelve un binario o un servidor
MCP y lo deja instalado, permisado, enganchado y documentado de una sola pieza. Los cinco que
existen —`engram`, `acli`, `gh`, `jscpd`, `semgrep`— comparten esa forma: todos declaran
`externalTool.checkBinary`. Ése es el patrón a seguir, y es lo que hace que
`navori add <plugin>` pueda ofrecerte la instalación y que `doctor` sepa verificarla.

> **`codegraph` y `tgrep` son el sexto y el séptimo.** Se retiraron el 2026-09-15 y #838 los
> reintrodujo el 2026-09-16 con una integración nueva (routing de *Code discovery* entre
> discovery estructural y textual). La anatomía del diseño anterior —binario externo, servidor
> MCP, guard, hook de sesión y cinco inyecciones de doctrina— sigue documentada pieza por pieza
> en [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md).

Si lo que traes no tiene herramienta que instalar, tienes buenas noticias: es una skill o un bloque
managed, y esos escalones son bastante más rápidos de aterrizar.

Un `plugin.json` te da hasta seis piezas, y usas sólo las que necesites:

| Pieza | Qué te da |
|---|---|
| `externalTool` | binario a verificar + comando de instalación por plataforma |
| `managed[]` | bloque(s) inyectados en `CLAUDE.md` |
| `settingsFragment` | los permisos que tu herramienta necesita, ya puestos |
| `scripts[]` | archivos copiados a `.claude/scripts/` |
| `hooks[]` | hooks registrados por evento (`SessionStart`, `PreToolUse`, …) |
| `skills[]` | assets propios **o** extensiones vía `injectInto` |

**`injectInto` es la pieza más elegante del formato.** Si tu plugin tiene doctrina para un agente
que ya existe, la inyecta dentro de ese archivo: el agente aprende tu herramienta sin que nadie
tenga que mantener una copia paralela. `engram` llega a cinco destinos (`leader`,
`implementer`, `reviewer`, `ticket-audit`, `auditor`) sin aportar un solo asset nuevo —
cinco agentes mejores por el precio de dos archivos de extensión.

Vale la pena medirlo: el archivo **compuesto** es lo que la sesión carga, y tiene su propio techo
(`maxWordsComposed`). Inyectar sale mucho más barato que duplicar, y ese techo está para que siga
siéndolo.

## 5. Core — lo que le sirve a todo el mundo

El listón es alto y por buena razón: lo que entra aquí se le renderiza a cada repo que instaló
navori. Un buen candidato es **cierto en cualquier repo, cualquier stack y cualquier engine**. Si
la frase necesita un *"si usas X"*, tienes un preset excelente; si necesita un *"en nuestro
equipo"*, tienes una user-section perfecta. Las tres son contribuciones reales — sólo viven en
capas distintas.

Cuando sí es universal, el camino está abierto: relee los invariantes y las no-metas de
`DIRECTION.md`, y si tu idea toca alguno, ábrela como spec en `specs/`. Una spec es precisamente
el lugar donde una idea grande consigue que la discutan en serio.

---

## Las cuatro preguntas que hacen fuerte a una propuesta

Respóndelas antes de escribir y tu cambio entra con muy poca fricción. Son las mismas cuatro que
usa quien revisa.

### 1. ¿Dónde vive hoy este tema?

Abre el bloque "Skills disponibles" de tu `CLAUDE.md`: ahí están los triggers de las skills core,
las de workflow, las de librería auto-detectadas y las del preset. Es el mejor minuto que vas a
invertir, porque muy seguido descubres que el tema ya tiene casa — y entonces tu aporte va a la
**user-section de esa skill** o a un `injectInto`, que es más rápido de escribir y llega con la
autoridad ya establecida.

Concentrar el conocimiento de un tema en un solo lugar es lo que hace que el agente responda igual
siempre. Cada vez que sumas a lo que ya existe, en vez de al lado, esa consistencia se refuerza.

### 2. ¿Cómo conversa con la dirección del proyecto?

`DIRECTION.md` declara diez invariantes y una lista de no-metas — el acuerdo que mantiene a navori
coherente entre versiones y entre repos. Alinearse con ellos es el atajo: una propuesta que se
apoya en un invariante se revisa en minutos.

Y si tu idea sí necesita mover uno, eso también tiene vía: se abre una spec. El proyecto cambia de
rumbo por specs, y esa puerta está abierta para quien traiga el argumento.

### 3. ¿Qué presupuesto ocupa, y qué devuelve?

Aquí hay números concretos, y saberlos te deja escribir con puntería:

- El contexto de arranque tiene **8000 bytes** (`NAVORI_CTX_BUDGET`, en
  `packages/core/core-assets/hooks/session-start-context.sh`). Lo que entra ahí lo lee el agente en
  cada sesión: es el espacio más valioso del harness. Lo que no cabe se degrada a un puntero
  *"léelo con `Read`"*, que sigue sirviendo, pero rinde menos.
- Cada skill tiene su cap de palabras por tipo, y `maxWords` te deja subirlo cuando la longitud
  está justificada — el override es explícito para que la razón quede escrita junto al número.
- Un bloque managed de `CLAUDE.md` se cobra en cada sesión de cada repo que lo tenga.

La pregunta que afina cualquier texto: *¿esto rinde más que lo que ocupa?* Un párrafo preciso suele
ganarle a una página, y el harness entero se beneficia.

### 4. ¿Es una implementación o una decisión?

Las dos son bienvenidas, y llegan mejor por separado. Si tu cambio mueve **cómo se decide** algo
—qué se delega, qué se renderiza always-on, qué escribe navori en el repo del usuario, qué permisos
trae el harness—, esa parte luce mucho más en una spec, donde se discute por su propio mérito. La
implementación después entra sola, porque la decisión ya está acordada.

---

## Checklist antes de mandar

Para (a), extender tu repo:

- [ ] Revisé el índice de skills y ya sé si el tema tiene casa o estrena una.
- [ ] Está en el escalón más barato que le sirve (user-section antes que skill; skill antes que preset).
- [ ] La `description` dice **cuándo** usarlo, no sólo qué hace.
- [ ] `.claude/skills/<id>/SKILL.md` en forma directorio, y el id declarado en `project.localSkills`.
- [ ] `navori doctor` en verde.

Para (b), contribuir a navori — lo anterior más:

- [ ] Leí `DIRECTION.md` y sé con qué invariante se alinea mi cambio (o qué spec lo propone).
- [ ] Si extiende un asset existente, usa `injectInto` y suma a lo que ya hay.
- [ ] Respeta el cap de su tipo, o declara `maxWords` con la razón escrita al lado.
- [ ] El quality gate (`pnpm check`) queda verde, y el re-render del espejo va en el mismo PR —
      los disparadores exactos están en [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Si te toca revisar una propuesta

Cuatro preguntas, en orden, y en tono de conversación: casi siempre hay una versión de la idea que
sí entra, y encontrarla es el trabajo.

1. **¿Cuál es su capa natural?** (tabla de arriba)
2. **¿El tema ya tiene casa?** Si la tiene → user-section o `injectInto`, y llega más rápido.
3. **¿Con qué parte de la dirección se alinea?** Si propone moverla → una spec le hace justicia.
4. **¿Qué ocupa y qué devuelve?** Si entra al always-on, vale decir qué gana el lector a cambio.

## Referencias

- [`DIRECTION.md`](DIRECTION.md) — objetivo, metas, no-metas e invariantes.
- [`recipes/skill-authoring.md`](recipes/skill-authoring.md) — el contrato de un `SKILL.md`:
  frontmatter, tipos, caps y triggers.
- [`architecture.md`](architecture.md) — cómo funciona el render, las 5 capas y los bloques managed.
- [`../packages/cli/src/engines/README.md`](../packages/cli/src/engines/README.md) — el sexto
  destino, y el más ambicioso: **agregar un engine**. Trae el contrato `EngineAdapter` y el
  checklist de spike, pensado justo para que un proveedor nuevo cueste una tabla declarativa.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — quality gate, re-render del espejo, commits y PRs.
