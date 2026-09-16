# Lecciones de deepseek-harness (dsh) para navori

> Auditoría del repo [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
> — snapshot `0d1f500` (HEAD 2026-09-15), MIT, developer preview — desde la
> perspectiva de navori.
>
> **Diferencia de categoría, declarada antes de nada: dsh es un *runtime* de
> agentes, no un generador de harnesses.** Su tesis es *"Every part of the
> product is a plugin… There is no privileged core to patch"*
> (`docs/architecture.md:11-13`), montado sobre
> [Cordis](https://github.com/cordiverse/cordis). No competimos ni nos
> parecemos: lo que compartimos con ellos no es el producto, es **el problema
> de gobernar un repo grande con instrucciones para agentes**. Todo lo que se
> destila aquí son mecanismos de ese gobierno; nada de su arquitectura.
>
> 225 561 ★ · 26 858 forks · 11 228 archivos tracked · TypeScript · monorepo
> pnpm.
>
> Las citas de rutas, mensajes de error y nombres de campo son literales de ese
> snapshot, en su idioma original. Lo que es lectura nuestra va marcado como
> tal.

---

## TL;DR

dsh es el repo más grande que hemos auditado y el que **menos texto** usa para
gobernarse. Es interesante por una sola razón: es el primero que trae
mecanismos de **subtracción** — herramientas cuyo propósito es que la doctrina
no crezca — y ese es exactamente el lente del proyecto ahora mismo.

Las siete cosas que más importan, una línea cada una:

1. **`verify-doc-budgets` pone un techo de palabras a 8 documentos**, en 58
   líneas de script y un manifiesto `ruta → entero`. De todo el campo
   auditado, es la única herramienta cuyo output es **texto borrado** — y
   navori ya tiene esa primitiva, aplicada solo a las skills (§2.4).
2. **Gobierna 11 228 archivos con 1 859 palabras y 38 enlaces.** navori usa
   3 355 palabras y **1 enlace** — y ese enlace está fuera de todo bloque
   managed.
3. **La longitud media de regla es prácticamente idéntica** (~26 palabras en
   los dos). La diferencia no es la prosa: es que dsh **enlaza** el porqué y
   navori lo **inlinea**.
4. **El modo rápido de gates es un `filter`, no una segunda lista**
   (`gate.quick === true`). Dos listas se desincronizan; un filtro no puede.
5. **El reparto de checks está escrito como regla**: *"Never default to the
   full suite"*; `pre-push` corre **solo** `typecheck` y CI tiene un job
   agregador que falla si algún job salió `skipped`.
6. **El estado vive en el path** (`implemented/architecture/2026-…-tema.md`);
   `git mv` es la transición. Sin frontmatter y **sin índice**, porque el
   índice era *"a predictable merge hotspot"*.
7. **La regla estrella no está mecanizada** — *"Non-trivial changes MUST
   include an Agent Note in the same PR"* no tiene gate, a propósito. Y la
   regla "one home per fact" está ella misma duplicada en dos archivos.

Lo que **no** debemos copiar: 3 082 archivos de notas de decisión para 11 228
de código, un contrato bilingüe que triplica el costo de cada nota, y una
taxonomía de 6 clases con 3 combinaciones vacías.

---

## 1. Qué es dsh, y por qué la diferencia de categoría importa

dsh es un harness de agentes ejecutable: model adapters, tool registry, session
log y el propio `agent-loop` son plugins montados en un árbol de Cordis
compuesto por capas `profile → bundles → patches`. Se corre con
`dsh --profile web`.

navori no ejecuta nada. Renderiza archivos en el repo del usuario desde
`navori.config.json` y se retira.

> **Lectura nuestra, no cita**: esa asimetría invalida de entrada la mayoría de
> las comparaciones. dsh puede permitirse un registro de gates de 1 608 líneas
> porque tiene 17 modos de agregación y una matriz de plataformas; nosotros
> tenemos **un** comando de gate declarado en `qualityGate.full`. Copiar su
> maquinaria sería justo lo contrario de lo que este documento busca. Lo que sí
> transfiere son sus **reglas de economía**: dónde poner un techo, qué enlazar,
> qué no mecanizar.

Lo que sí es comparable, y es el eje de todo el documento:

| | dsh | navori |
|---|---|---|
| Archivos tracked | 11 228 | 739 (`git ls-files`) |
| Archivo de instrucciones raíz | `AGENTS.md` — 175 líneas · **1 859 palabras** | `CLAUDE.md` — 240 líneas · **3 355 palabras** |
| Enlaces markdown en ese archivo | **38** | **1** (y está fuera de todo bloque managed) |
| Techo declarado | `AGENTS.md: 1950`, verificado por un gate | ninguno |

---

## 2. `verify-doc-budgets` — el mecanismo central

Es el hallazgo principal de toda la auditoría, y cabe en 58 líneas. Se lee
mejor sabiendo que navori ya tiene la mitad: `SKILL_TYPE_CAPS` y `countWords`
en `packages/cli/src/lib/skill-meta.ts` son la misma primitiva aplicada a las
skills (§2.4). Lo que sigue es lo que dsh agrega alrededor de ella.

### 2.1 — Mecánica completa

**La unidad es `wc -w`**, sin adornos (`scripts/verify-doc-budgets.ts:16-19`):

```ts
/** `wc -w` equivalent: count whitespace-delimited tokens. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
```

Cuenta el archivo **entero**: frontmatter, tablas, code fences, links. Sin
descuentos, deliberadamente — un techo con excepciones es un techo negociable.

**El manifiesto son 8 entradas `ruta → entero`**
(`scripts/doc-budgets.manifest.json`):

```json
{
  "AGENTS.md": 1950,
  "docs/AGENTS.md": 1320,
  "docs/architecture.md": 2400,
  "docs/cordis-primer.md": 600,
  "docs/defensive-patterns.md": 550,
  "docs/testing.md": 1350,
  "packages/AGENTS.md": 750,
  "packages/README.md": 994
}
```

**Tres modos de fallo, los tres exit 1** — y el tercero es el que casi nadie
escribe:

| Caso | Línea | Qué produce |
|---|---|---|
| Techo inválido (no entero positivo) | `:28-31` | `ceiling must be a positive integer, got <x>` |
| **Archivo presupuestado que no existe** | `:34-37` | `budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)` |
| Exceso | `:41-43` | el mensaje de abajo |

El mensaje de exceso, literal:

```
${path}: ${words} words exceeds the ${ceiling}-word ceiling — relocate or condense per docs/AGENTS.md (raising the ceiling requires justification in the PR)
```

Y el epílogo del fallo (`:54`):

```
See docs/AGENTS.md for the documentation standard and the relocation-first rule.
```

> **Lectura nuestra, no cita**: el segundo modo de fallo es lo que impide la
> evasión trivial. Sin él, renombrar el archivo desactiva su techo en silencio
> y el gate sigue verde. Con él, mover un documento **obliga** a tocar el
> manifiesto en el mismo cambio, que es donde el reviewer lo ve. Es el mismo
> instinto que el `scanned === 0` de nuestro `check-asset-commands.mjs:143-150`
> ("Zero assets walked is not 'no violations'"), aplicado a un manifiesto en
> vez de a un glob.

`--list` imprime `ok / OVER / MISS` con el uso actual y **sale 0** (`:46-49`):
inspección sin veredicto, separada del gate.

### 2.2 — La política: relocate → condense → raise

El script no decide qué hacer; delega en `docs/AGENTS.md:54-56`, y el orden es
obligatorio:

> 1. **Relocate** content that belongs in another tier; leave a one-line link if needed.
> 2. **Condense** content that belongs here but can be shorter.
> 3. **Raise** the ceiling only when the words need the space; justify the manifest diff in the PR. A too-low ceiling is a budget bug.

Subir el techo es legítimo — es el paso 3, no un pecado — pero es el **único**
de los tres que deja un diff en el manifiesto, y ese diff es lo que se discute
en el PR. El costo social está puesto exactamente donde debe.

### 2.3 — La histéresis del 5 %

`docs/AGENTS.md:58`:

> *"Ceilings are guardrails, not reduction targets. At or below target, retain at least 5% headroom; above target, freeze the ceiling until relocation or condensation brings the document under target. Lower a ceiling only when the document still has room."*

Traducido: el techo **no** es una meta de reducción a la que haya que acercarse
ni un valor que se persiga hacia abajo cada semana. Si el documento está bajo
su objetivo, el techo conserva holgura; si está arriba, el techo se **congela**
hasta que el documento baje. Eso evita las dos patologías del ratchet: el techo
que sube cada PR y el techo que baja tanto que cada edición legítima es roja.

> **Lectura nuestra, no cita**: la histéresis vive en prosa, no en el script.
> `verify-doc-budgets` solo compara `words <= ceiling`; **nada verifica el
> 5 %**. Y se nota. Medidos los 8 documentos del manifiesto con `wc -w` sobre
> el mismo snapshot, contra su techo y contra la holgura que su propia política
> exige (5 % del techo):
>
> | Documento | Palabras / techo | Margen | Holgura exigida (5 %) | ¿Cumple? |
> |---|---|---|---|---|
> | `AGENTS.md` | 1 859 / 1 950 | 91 | 98 | no |
> | `docs/AGENTS.md` | 1 319 / 1 320 | **1** | 66 | no |
> | `docs/architecture.md` | 2 389 / 2 400 | 11 | 120 | no |
> | `docs/cordis-primer.md` | 600 / 600 | **0** | 30 | no |
> | `docs/defensive-patterns.md` | 518 / 550 | 32 | 28 | **sí** |
> | `docs/testing.md` | 1 349 / 1 350 | **1** | 68 | no |
> | `packages/AGENTS.md` | 717 / 750 | 33 | 38 | no |
> | `packages/README.md` | 950 / 994 | 44 | 50 | no |
>
> **Uno de ocho cumple.** `docs/cordis-primer.md` está en **600/600**: margen
> cero, exactamente en el techo — la siguiente palabra que alguien escriba ahí
> pone el gate en rojo. Y los dos documentos que definen la política
> (`docs/AGENTS.md`, `docs/testing.md`) están a **una** palabra del suyo.
>
> La conclusión no descalifica el mecanismo — hay que copiarlo —, pero su
> propia práctica exhibe el modo de fallo: **un techo sin presión de reducción
> no adelgaza nada, solo fija dónde se detiene el crecimiento.** El techo acaba
> siendo una cuota que se llena hasta el borde, que es exactamente contra lo
> que su propio texto advierte al abrir con *"Ceilings are guardrails, not
> reduction targets"*.
>
> De ahí el orden que este documento recomienda para navori (§13): **primero la
> poda, después el techo.** Un techo puesto antes de podar congela el estado
> actual como línea base y se llena hasta el borde, igual que aquí. Y conviene
> no confundir las dos piezas al copiarlas: **el techo es el gate, la histéresis
> es doctrina**, y solo una de las dos está mecanizada.

Dos derivas más, verificables en el mismo par de archivos:

- La prosa de `docs/AGENTS.md:58` declara `testing.md` **1,300**; el manifiesto
  dice **1350**. La prosa perdió.
- Esa misma prosa declara un techo para `examples/AGENTS.md` (310) y una regla
  genérica "subtree `AGENTS.md` ≤ 600". Ninguna de las dos está en el
  manifiesto, y `examples/AGENTS.md` no existe en el repo: de los 22
  `AGENTS.md` tracked, el gate cubre 3.

Es decir: el documento que prohíbe duplicar hechos duplicó sus propias cifras,
y la copia en prosa se quedó atrás. Vale como advertencia de uso, no como
descalificación del mecanismo.

### 2.4 — La contraparte en navori, verificada en frío

navori **ya cuenta palabras y ya falla en CI** por exceso, sobre las skills que
empaqueta. `packages/cli/src/lib/skill-meta.ts:58-65` declara los techos por
tipo:

```ts
export const SKILL_TYPE_CAPS = {
  /** Dictates how the agent behaves (e.g. tdd-workflow). Keep it tight. */
  behavior: 200,
  /** Documents a pattern/stack (e.g. mantine-patterns). */
  reference: 500,
  /** Wraps an external tool (e.g. bun-runtime). */
  tool: 300,
} as const;
```

`skillWordCap()` (`:134-138`) resuelve el override explícito `maxWords` antes
del default por tipo, y `skill-caps.test.ts` lo sostiene en CI con la razón
escrita: *"Guards against a skill silently ballooning and spending tokens on
every load."*

La convergencia llega hasta la implementación: `countWords`
(`skill-meta.ts:112-115`) es **la misma función** que la de dsh
(`verify-doc-budgets.ts:16-19`) — `trimmed.split(/\s+/)`, equivalente a
`wc -w` — escrita por separado en los dos repos.

Y en un punto navori decidió **distinto y mejor** para su caso. dsh cuenta el
archivo entero, a propósito. navori mide **solo el cuerpo managed**, y el
docblock del test dice por qué:

> *"The cap is measured over the MANAGED body only — the zone navori owns and regenerates. Everything past the `<!-- navori:user-section -->` sentinel is the repo's own domain (#323)… Charging that to navori's budget would mean a skill gets less room the more useful the repo makes it."*

Las dos decisiones son correctas para su contexto: dsh es dueño de todo su
repo; navori no es dueño de la sección del usuario.

Hay además un segundo precedente de la misma forma sobre otro eje:
`check-bundle-size.mjs` es un techo de bytes con política de subida
justificada, con el historial escrito (`800 -> 900` cuando entró `audit`,
`900 -> 1000` con #603/#605/#607) y un disparador de obsolescencia declarado:

> *"If a third raise ever gets proposed for first-party growth, the guard has stopped measuring what it claims to: at that point split the check in two — a hard ceiling for bundled deps and a soft trend line for our own code."*

> **Lectura nuestra, no cita**: la diferencia con dsh **es la superficie, no la
> primitiva**. Hoy el techo cubre las skills y **no** cubre la prosa que navori
> envía a todos los repos onboardeados: el `CLAUDE.md` de **3 355 palabras**,
> sus **10 bloques managed** y los agentes (`commit-pr-pilot` 26 588 B,
> `leader` 20 552, `reviewer` 17 921 — media 13,4 KB, medidos sobre el render
> en `.claude/agents/`, no sobre el asset fuente, que da otros números).
>
> Tres condiciones al extenderlo, y las tres salen de este documento: el
> manifiesto presupuesta **el asset fuente** (`packages/core/core-assets/…`),
> no el render, que es derivado y reconstruible; necesita el modo de fallo por
> **archivo faltante** de §2.1, que `SKILL_TYPE_CAPS` no necesita porque
> descubre por glob; y la distinción cuerpo managed / sección del usuario se
> conserva. Sobre el orden manda §2.3: un techo fijado antes de podar convierte
> el texto de hoy en línea base y el techo en una cuota que se llena hasta el
> borde.

---

## 3. Densidad del archivo raíz: enlazar el porqué vs. inlinearlo

### 3.1 — El dato que ordena todo

| | dsh `AGENTS.md` | navori `CLAUDE.md` |
|---|---|---|
| Archivos gobernados | 11 228 | 739 |
| Palabras | 1 859 | 3 355 |
| Reglas / bullets (`^- `) | 36 | 68 |
| Palabras dentro de esos bullets | 934 | 1 763 |
| **Palabras por regla** | **25,9** | **25,9** |
| Enlaces markdown | 38 | 1 |

Medido con `grep -c '^- '` y `grep '^- ' … | wc -w` sobre cada archivo en el
snapshot; los totales de palabras y las cuentas de enlaces salen del dossier.

> **Lectura nuestra, no cita**: esto refuta la explicación cómoda. No escribimos
> reglas más largas ni más verbosas — nuestras reglas miden **lo mismo**. Lo
> que difiere es la **cantidad** (68 vs 36) y el destino del porqué: dsh pone
> la obligación en la línea y manda la justificación a un documento enlazado;
> nosotros ponemos obligación **y** justificación en la misma línea, y por eso
> necesitamos el doble de líneas para cubrir un repo quince veces más chico.

### 3.2 — El patrón canónico

La forma se repite 36 veces y es estrictamente posicional:

```
- **<obligación en negrita>**: <condición, excepción o mecanismo en texto plano> ([<etiqueta tipada>](<ruta>)).
```

- **Negrita = la obligación.** Lo que cambia el comportamiento del agente.
- **Texto plano = la condición.** Cuándo aplica, qué queda fuera, qué NO cuenta
  como cumplimiento.
- **Paréntesis = el link tipado.** La etiqueta nombra **qué** hay del otro
  lado, no dice "aquí" ni repite la ruta.

Cuatro literales, tal cual:

```md
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
```
(`AGENTS.md:125` — regla autosuficiente, sin link: no hay nada más que decir.)

```md
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
```
(`:129` — la obligación cabe en la línea; la semántica completa vive en el
primer, etiquetada `semantics`.)

```md
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.
```
(`:135` — la mitad de la regla es **qué no cuenta como cumplirla**, que es la
parte que un agente necesita y la que casi siempre se omite.)

```md
- **Ban `prove` + `nance`** ([rule](.agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md)).
```
(`:143` — cinco palabras y un link. La regla más corta del archivo prohíbe
**una** palabra, y su justificación entera está afuera.)

El patrón está declarado explícitamente en `AGENTS.md:171`:

> *"Keep each rule self-contained while linking high-level docs. Condense when clarity survives; raise a `verify-doc-budgets` ceiling when the required content genuinely needs more space."*

Las etiquetas que usan son un vocabulario cerrado y reconocible: `why`,
`semantics`, `rule`, `scope`, `policy`, `mechanism`, `rationale`, `decision`,
`taxonomy`, `layout`, `glossary`, `mapping`, `contract`, `primer`. Un agente
que lee `([rationale](…))` sabe que del otro lado no hay una instrucción nueva,
y puede no abrirlo.

### 3.3 — Qué significa para navori

Nuestro caso está medido, y la cifra importa menos que su composición. La
sección `## Quality gate` de `CLAUDE.md` son **411 palabras, el 12,3 % del
archivo**. No es la más pesada —`## Operations on data and infrastructure` son
634 (18,9 %) y los dos bloques `## Engram` suman 574 (17,1 %)—, pero las tres
juntas son **1 619 palabras, el 48,3 % del archivo**, y las tres son sobre todo
*porqué*.

Se reproduce así, sobre el mismo `CLAUDE.md` del que salen las 3 355 palabras
totales:

```sh
awk '/^## Quality gate/{f=1;next} /^## /{f=0} f' CLAUDE.md | wc -w   # 411
wc -w < CLAUDE.md                                                    # 3 355

# desglose completo, sección por sección:
awk '/^## /{if(s)printf "%6d  %s\n", n, s; s=$0; n=0; next} {n+=NF} \
     END{printf "%6d  %s\n", n, s}' CLAUDE.md | sort -rn
```

Lo que hay dentro de `## Quality gate` es el *porqué* de cada paso (por qué
`test:coverage` y no `test`, por qué `jscpd`/`semgrep` entraron en #777, cómo
`repo-config-gate.test.ts` sostiene el gate contra `ci.yml`). Todo eso es
cierto, está bien escrito y **no es una orden**: es la justificación de una
orden de una línea.

> **Lectura nuestra, no cita**: el único enlace markdown de nuestro `CLAUDE.md`
> está en la línea 12, dentro de la sección escrita a mano. Los **diez** bloques
> managed — los que navori envía a todos los repos onboardeados — tienen cero.
> Eso no es casualidad ni descuido: un bloque managed no puede enlazar rutas
> del repo destino porque no sabe qué existe ahí. Pero sí puede enlazar sus
> propias skills (`.claude/skills/<id>/SKILL.md`), que navori renderiza y por
> tanto garantiza. Ese es el destino natural del porqué, y ya existe.
>
> Con una condición previa: hoy **no hay ningún gate que verifique enlaces
> relativos** en este repo (`grep -rn 'md-links\|link-check\|lychee'` sobre
> `package.json` y `.github/workflows/ci.yml` no devuelve nada). Multiplicar
> los enlaces antes de tener un `verify-md-links` es multiplicar la deuda a
> mayor velocidad.

---

## 4. El registro central de gates, y `quick` como mecanismo

`scripts/run-gates.ts` (1 608 líneas) es un registro tipado: un `Gate` es un
comando más su metadata de dependencia (`:47-63`), y hay **17 modos** de
agregación declarados como unión de tipos (`:24-41`), resueltos por un único
`switch` en `gatesForMode()`.

Eso, para nosotros, es sobredimensionado y no se copia. Lo que sí vale es **un
campo de tres líneas** dentro de esa interfaz:

```ts
  /** Include this leaf in the build-free documentation aggregate. */
  quick?: boolean
```

y cómo se consume (`scripts/run-gates.ts:794-796`):

```ts
function docQuickLeafGates(): Gate[] {
  return docSyncLeafGates({ includeDocTypecheck: false }).filter(gate => gate.quick === true)
}
```

El modo `doc-quick` **no es una segunda lista de gates**: es el modo completo
`doc-sync` pasado por un filtro. No existe un lugar donde alguien pueda agregar
un gate al modo rápido y olvidarlo en el completo, ni viceversa; la única
manera de que un gate esté en el rápido es que ya esté en el completo con
`quick: true`.

> **Lectura nuestra, no cita**: navori tiene hoy **un** gate
> (`qualityGate.full`), declarado en un solo lugar y anclado por
> `repo-config-gate.test.ts` contra `ci.yml` en las dos direcciones. Eso está
> bien y no hay nada que arreglar. Lo que este hallazgo aporta es una **regla
> para el futuro**: el día que alguien proponga un "gate rápido" para iterar,
> la forma correcta es *derivarlo por filtro del completo*, nunca escribir una
> segunda lista. Dicho ahora, cuesta cero; dicho después de que existan dos
> listas, ya se pagó el drift.

`run-gates.spec.ts` ancla el registro contra sí mismo (`:139-162`, `:243-248`,
`:257-270`) — el mismo patrón que nuestro `subcommand-inventory.test.ts`,
que parsea `index.ts` y lo compara contra la frase de `CLAUDE.md`.

---

## 5. La familia `verify-*`: 60 scripts, uno por invariante

`scripts/` tiene **60** archivos `verify-*`. Ninguno es un linter genérico: cada
uno prueba **una** cosa que ningún linter del mercado prueba. Los relevantes:

### 5.1 — `verify-md-wrap`: una línea física por párrafo

86 líneas. Parsea el Markdown a AST GFM y marca cualquier párrafo cuyo
`end.line > start.line` (`:62`). La justificación está en su docblock:

> *"The GFM AST distinguishes paragraphs—including those in lists and blockquotes—from multiline structural nodes. The checker never rewrites; symlinked instruction files are deduped."*

La convención que impone (`docs/AGENTS.md:41`) es *"One physical line per
paragraph (`verify-md-wrap`): use editor soft-wrap"*.

> **Lectura nuestra, no cita**: el beneficio real no es estético, es el
> **diff**. Un párrafo en una línea produce un diff de una línea cuando cambia
> una palabra; un párrafo envuelto a 78 columnas produce un diff de seis líneas
> por la misma palabra. En un repo donde los agentes editan prosa
> constantemente, eso cambia la legibilidad de cada review. Nuestro `docs/`
> hace lo contrario (envuelve a ~78), y este mismo archivo también — es una
> convención existente y cambiarla no es gratis. Vale registrar el trade-off,
> no invertirlo por decreto.

### 5.2 — `verify-concrete-terms`: prohibir **una** palabra

El docblock completo es una línea: *"Reject one ambiguous origin label from
maintained tracked files."* La palabra prohibida se construye concatenada para
que el propio script no se atrape a sí mismo (`:9`):

```ts
const blockedTerm = 'prove' + 'nance'
const excludedPrefixes = ['vendor/', '.agents/notes/archived/'] as const
```

> **Lectura nuestra, no cita**: lo que lo hace sostenible es el alcance. Un
> gate que prohíbe *una* palabra tiene cero falsos positivos, se explica en una
> frase, y su regla en `AGENTS.md` cabe en cinco palabras. Un gate que
> prohibiera "prosa vaga" sería un generador infinito de discusiones y moriría
> en tres meses. La lección no es "prohíban palabras": es que **un invariante
> mecanizable se elige por ser decidible, no por ser importante**. La regla
> importante y no decidible se deja en prosa a propósito (§8.3).

### 5.3 — `verify-export-jsdoc`: "Unknown forms fail closed"

607 líneas que exigen JSDoc en todo export no vendorizado. La última frase de
su docblock (`:7`) es la que importa:

> *"Inline callable types, overload signatures, namespace members, and public class members are included; framework slots, constructors, inherited contracts, augmentations, and source re-exports keep their docs at the declaring contract. **Unknown forms fail closed.**"*

Una forma sintáctica que el script no reconoce **falla**, no pasa. Es la
postura opuesta a la habitual (ignorar lo no reconocido), y es la única que
mantiene el gate honesto mientras el lenguaje evoluciona.

### 5.4 — Anti-atrofia: el piso numérico

`verify-client-ui-i18n.ts:15` declara:

```ts
const MINIMUM_CLIENT_UI_SOURCES = 450
```

y si el glob devuelve menos, falla (`:341-343`):

```
verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_CLIENT_UI_SOURCES}.
```

Sin eso, mover el directorio de UI convierte el gate en un ✓ permanente sobre
cero archivos.

> **Lectura nuestra, no cita**: este concepto **ya lo tenemos**, verificado en
> frío. `scripts/check-asset-commands.mjs:143-150` falla explícitamente cuando
> caminó cero assets — *"Zero assets walked is not 'no violations': a renamed
> or unbuilt asset layout would otherwise print a ✓ over an empty scan (same
> family as #454's '0 files to scan')"* — y `:79` hace lo mismo si no puede
> parsear `subCommands`. Incluso tenemos el vocabulario de salida separado
> (`⊘ could not run: … — NO asset was compared against a published CLI`), que
> es más honesto que un simple exit 1. Lo único que dsh agrega es el **piso
> numérico**: nosotros comparamos contra cero, ellos contra 450. Un piso
> numérico caza la atrofia *parcial* (el glob que pasa de 450 a 12), que la
> comparación contra cero no ve. Es un refinamiento de algo que ya funciona, no
> una capacidad que falte.

### 5.5 — `verify-cordis-config`: el gate que existe por un fallo silencioso

Su docblock explica por qué existe, y es el mejor ejemplo del criterio de "qué
merece un gate" (`:1-11`):

> *"The Loader interpolates a plugin entry's `config` (after declared injections activate, against that plugin context) and the entry `disabled` field (at every mount decision, against the loader context). Every other entry metadata field stays static, so an expression there remains truthy data and silently changes composition."*

Un `!!js` en el campo equivocado no explota: queda como dato truthy y cambia la
composición del árbol **sin error**. El gate existe porque el modo de fallo es
silencioso, no porque el campo sea importante.

---

## 6. El reparto de checks: contra el gate monolítico

Esta es la sección donde dsh y navori están más lejos, y donde hay que tener
más cuidado al leer.

La regla, literal (`AGENTS.md:113-115`):

> - *"Match evidence to the surface: focused behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths, and real-API e2e for providers."*
> - *"**Never default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage and the platform matrix**; rehearse all locally only by explicit request, for CI diagnosis, or for an irreducibly repository-wide change."*
> - *"`test:coverage`, not `test`, is the CI coverage gate (`[why](docs/testing.md)`)."*

El tercer bullet es palabra por palabra el mismo hallazgo que nuestro
`CLAUDE.md` ya documenta — dos proyectos independientes tropezaron con la misma
piedra y escribieron la misma línea. Ellos la resolvieron con un link al
porqué; nosotros con tres párrafos inline.

### 6.1 — Los hooks de git son un checkpoint, no el gate

`lefthook.yml:1-2`:

```yaml
# Git hooks (lefthook). Keep these local checkpoints fast; CI owns the full
# repository-wide gate matrix.
```

`pre-commit` corre 6 jobs, **todos acotados a `{staged_files}`**: pairing de
traducción sobre los `.i18n.yaml` staged, notas archivadas, lint staged con
`--fix` y `stage_fixed: true`, regeneración de `THIRD_PARTY_NOTICES.md`,
`git diff --cached --check` y el guard del manifiesto de `vendor/`.

Y `pre-push` (`:52-55`) es esto, completo:

```yaml
pre-push:
  jobs:
    - name: typecheck
      run: pnpm run typecheck
```

**Ningún gate de documentación corre en un hook de git.** Ni budgets, ni
md-wrap, ni pairing corpus-wide. Todos viven en CI y en el agregado `doc-sync`
que el contribuidor corre a mano cuando toca docs.

### 6.2 — El job agregador de CI

`.github/workflows/ci.yml` cierra con un job que depende de los 9 jobs
paralelos y falla así (`:735`):

```yaml
      - name: Fail if any needed job did not succeed
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
```

`skipped` cuenta como fallo. Es el único status requerido por branch
protection: un job que se saltó a sí mismo (por una condición mal escrita, por
una herramienta ausente) no puede colarse como verde.

> **Lectura nuestra, no cita**: navori cubre el mismo fallo por el otro lado y
> de forma estática, con `repo-config-gate.test.ts` — desarrollado en
> [§9.3 de `ecc-lessons.md`](./ecc-lessons.md#93--el-bug-que-navori-no-tiene-).
> Son dos defensas contra el mismo fallo, una estática y una en runtime; la de
> ellos es más barata.

### 6.3 — Corrección con documentación oficial: los hooks no son serie

Los jobs de `pre-commit` de dsh son **dependientes del orden por
construcción**: el job de lint usa `stage_fixed: true` y el de notices corre
`gen-third-party-notices.ts && git add THIRD_PARTY_NOTICES.md`. Eso solo es
correcto si no corren en carrera contra el job de whitespace que lee el índice
de git.

> **Corrección**: ese patrón **no transfiere a los hooks de Claude Code**. La
> documentación oficial es explícita: *"All matching hooks run in parallel."*
> (https://code.claude.com/docs/en/hooks). Un diseño que encadene "hook A
> arregla y re-stagea, hook B verifica el resultado de A" en un mismo evento
> está roto de origen en nuestro host, aunque funcione en lefthook. Y el
> timeout tampoco rescata: *"A timed-out `command`, `http`, or `mcp_tool` hook
> doesn't block the tool call… don't count on a stalled hook to act as a
> gate."* Nuestro `guard-destructive.sh:92-93` ya documenta honestamente ese
> fail-open; la mala atribución de los 10 s que lo acompaña es el punto 3 del
> issue **#804**, desarrollado en
> [§8.5 de `ecc-lessons.md`](./ecc-lessons.md#85--el-veredicto-escéptico-).

---

## 7. El contrato bilingüe, y su confesión

No lo vamos a copiar (§10), pero su honestidad sí se copia.

Un par son **tres archivos hermanos** — `foo.md`, `foo.zh.md`, `foo.i18n.yaml`
— y el sidecar guarda **hashes de blob de git** de cada lado:

```yaml
foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
```

Blob y no commit, y la razón está escrita (`docs/i18n/README.md:18`):

> *"Blob hashes, not commit hashes, so the record is computable for files edited in the same PR (`git hash-object foo.md`) and consistency is a pure content comparison."*

Los dos idiomas tienen **autoridad igual**: *"A document may be authored and
reviewed in either language first… Neither file outranks the other; what binds
them is that they must say the same thing."* No hay "fuente" y "traducción".

Cuando el par se desincroniza, el mensaje del gate
(`verify-translation-pairing.ts:239`) dice qué hacer:

> *"out of sync — content no longer matches the pair's last confirmed-consistent state in ${meta} (bring the other side along, then re-record with --write)"*

Y `--write` **exige nombrar el par**: ese diff del yaml *es* el acto revisable
de confirmar consistencia, no un efecto colateral.

### La confesión, que es lo que vale

`docs/i18n/README.md:40`:

> *"The gate's limit, stated plainly: **a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound.** It checks hashes and Markdown structure; it cannot judge whether the two sides say the same thing… A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review."*

> **Lectura nuestra, no cita**: esa frase es el modelo de cómo documentar
> cualquier gate nuestro. Un gate verde siempre prueba algo más angosto que lo
> que el lector asume, y el lugar donde se corrige esa expectativa es el doc del
> gate — no el post-mortem del día que alguien confió de más. Nuestro
> `check-asset-commands.mjs` ya lo hace con su `⊘ could not run`; la práctica
> generalizable es **declarar el límite junto al verde**, no solo junto al
> rojo.

---

## 8. `.agents/notes/` — decisiones como corpus

3 082 archivos. El diseño es más interesante que el tamaño.

### 8.1 — El estado vive en el path

`{proposed|implemented|rejected|archived}/{clase}/yyyy-mm-dd-topic-title.md`.
Un `git mv` es la transición de estado: no hay campo `status` que actualizar en
dos lados, ni índice que regenerar, ni query que escribir.

**Sin frontmatter.** Los metadatos son el path más las tres primeras líneas
(`# Agent Note: <title>` / línea vacía / `Status: <status>`). Sin fechas
dentro: *"The date in the filename is when the topic was first proposed (per
git history)"*.

`verify-agent-note-format.ts:62-65` exige que la línea `Status:` sea la **única**
del archivo:

```ts
  const statusLines = prose.filter(l => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter(l => l === lines[2]).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }
```

Una nota que cite el `Status:` de otra envenenaría cualquier `grep` sobre el
corpus. El gate lo impide en cuatro líneas.

### 8.2 — Sin índice, por decisión

`.agents/notes/README.md:19`:

> *"Do not add a centralized `INDEX.md`; the `[no-index Agent Note](implemented/process/2026-07-19-remove-generated-agent-note-index.md)` owns the rationale."*

Y la razón, en la nota misma (`:9`):

> *"A committed Agent Note index duplicates facts already encoded by each file's lifecycle/class path, filename date, and H1. Every branch that adds, moves, or renames an otherwise unrelated Agent Note rewrites the same generated file, making that artifact **a predictable merge hotspot**."*

Tenían el índice, era generado, y lo **mataron**. La discoverability se resuelve
navegando el árbol o con `grep`.

### 8.3 — El sellado del archivo, con `base.sha` de la PR

Las notas archivadas están congeladas (`AGENTS.md:146`): *"Archived notes are
frozen: never edit or treat them as current authority."* El verificador usa un
manifiesto append-only de hashes, y su baseline es lo notable
(`ci.yml:106`):

```yaml
        env:
          DSH_ARCHIVE_BASE_REF: ${{ github.event.pull_request.base.sha }}
```

que cae a `HEAD` solo en local (`verify-archived-agent-notes.ts:86-87`).

> **Lectura nuestra, no cita**: eso cierra el agujero obvio. Un agente que
> reescriba una nota archivada **y** su sello en el mismo commit pasa el hook
> local (porque compara contra HEAD, que ya incluye su cambio) y **falla en
> CI** (porque compara contra la base de la PR). La asimetría local/CI no es un
> descuido: es el diseño. Vale como patrón para cualquier ratchet que hagamos —
> el baseline nunca debe ser algo que el mismo cambio pueda mover.

### 8.4 — La regla estrella NO está mecanizada

`AGENTS.md:146`:

> *"**Non-trivial changes MUST include an Agent Note in the same PR;** only mechanical/local edits are exempt (`[scope](.agents/notes/README.md#when-to-write-one)`)."*

En un repo con 60 scripts `verify-*`, **esta regla no tiene gate**. Vive en
prosa, y la skill de review manda al reviewer a leer las notas y a verificar
que una nota `implemented/` describa lo que de verdad se shippeó
(`dsh-code-review/SKILL.md:18`, `:33`, `:46`).

> **Lectura nuestra, no cita**: es la decisión de diseño más madura del repo, y
> es la contracara exacta de §5.2. "No trivial" no es decidible por script; un
> gate que lo intentara produciría notas-ceremonia — archivos escritos para
> apagar el rojo. Ellos mecanizan lo decidible (formato, clase, sello, unicidad
> del `Status:`) y dejan el juicio en revisión. **La ausencia de ese gate es
> parte del diseño, no una tarea pendiente.**

### 8.5 — La ironía, y es citable

El repo predica *"one home per fact"* (`AGENTS.md:167`) y su slop checklist
abre con *"Duplicated rules: search a distinctive phrase; keep one home and
link the rest"* (`docs/AGENTS.md:64`).

La regla de las Agent Notes está en dos homes:

- `AGENTS.md:146` — *"Non-trivial changes MUST include an Agent Note in the same PR"*
- `docs/AGENTS.md:40` — *"Every non-trivial change includes at least one Agent Note in the same PR."*

Redactadas distinto, sin link entre ellas. La regla más importante del repo
viola el checklist del propio repo.

> **Lectura nuestra, no cita**: no es hipocresía, es física. La duplicación
> gana cuando la regla es la más importante, porque el autor prefiere repetirla
> a arriesgarse a que no se lea. La conclusión práctica para nosotros: un
> checklist anti-duplicación **no** sobrevive por disciplina; necesita el gate
> de §5.2 (una frase distintiva, buscable) o no se cumple ni en el repo que lo
> inventó.

---

## 9. Skills: disparo sin tabla y sin hook

12 skills, 31 archivos, entre 6 069 y 18 039 B — **más grandes** que las
nuestras (la mayor de navori es `review-diff`, 9 446 B).

### 9.1 — El frontmatter es de 4 campos, en todo el corpus

`name` y `description` en las 12. Y en **una sola** skill,
`dsh-translate-docs/SKILL.md:4-5`:

```yaml
disable-model-invocation: true
user-invocable: true
```

Nada más. Ni `allowed-tools`, ni `context`, ni `model`, ni metadata de diseño
propia. El disparo se apoya enteramente en la `description`, que promedia **51
palabras** (las nuestras: 34, mediana 241 caracteres).

Cómo escriben esas descripciones — cuatro tácticas, todas visibles en un
literal:

```yaml
description: Use when landing a stack of dependent GitHub PRs (A ← B ← C, where each bases on the one below) onto master, merging a PR whose base is another open PR's branch, or whenever a request mentions "stacked PRs", "PR stack", "dependent PRs", or merging several related PRs in sequence.
```

1. **Enumeran el momento**, no la capacidad ("Use when landing…", no "Lands
   stacks").
2. **Citan frases literales del usuario** entre comillas (`"PR stack"`,
   `"dependent PRs"`) — el disparo se ancla en lo que la persona escribe.
3. **Citan el string ofensor** cuando aplica: `dsh-trim-cot-leakage` lista
   `(decision N)`, `"used to"`, `"no longer"`, `"a later PR in this stack"`.
4. **Declaran la no-superposición con la skill vecina**, dentro de la misma
   `description` (`dsh-ci-test-reliability:3`):
   *"…use dsh-pre-push-checks separately to select outgoing commands."*

Solo **2 de 12** están enlazadas por path desde `AGENTS.md` (`:111`, `:165`).
Las otras 10 cuelgan del documento donde su condición ocurre. **No hay tabla
índice de skills, y no hay hook que las inyecte.**

> **Lectura nuestra, no cita**: nuestro bloque `skills-index` (2 144 B, 21
> líneas) es una tabla de 16 entradas dentro del always-on. Verificado además:
> `hasTrigger` (`packages/cli/src/lib/skill-meta.ts:146`) valida la presencia de
> un verbo de disparo por regex, no la calidad del disparo. La táctica 4
> —declarar la no-superposición dentro de la propia `description`— es la que
> más barato se adopta y la única que ataca un problema que sí tenemos
> (`review-diff` vs `security-guidance`, `structural-search` vs `debug-error`),
> porque no agrega un archivo ni un campo: cambia una frase.

### 9.2 — El opt-out, y su razón

`disable-model-invocation: true` es opt-out del disparo automático. Lo usan en
**una** skill, la cara y lenta. La razón está escrita en una nota archivada
(`archived/process/2026-08-08-lightweight-routine-documentation-translation.md:25`):

> *"size-based inference is another hidden policy and can unexpectedly activate the expensive workflow. **The user, not the agent, chooses when the extended path is worth its cost.**"*

Rechazaron explícitamente la heurística por tamaño ("si el doc es grande, corre
el flujo caro") por ser una política oculta.

> **Verificado contra documentación oficial**: el campo existe y hace más de lo
> que dsh usa — *"Set to `true` to prevent Claude from automatically loading
> this skill… **Also prevents the skill from being preloaded into subagents.**
> Default: `false`."* (https://code.claude.com/docs/en/skills). Ese segundo
> efecto es relevante para nosotros: marcar una skill como manual-only también
> la saca del `skills:` precargado de un subagente, que no es lo mismo que
> "solo por `/`".

### 9.3 — El grafo skill → skill

No hay orquestador; hay enlaces tipados dentro del cuerpo:

- `**REQUIRED BACKGROUND:**` seguido del link
  (`dsh-trim-cot-leakage/SKILL.md:8`).
- "use X **first**" para ordenar (`dsh-pre-push-checks:31`).
- Un bloque `Sources of truth` con 7 links (`dsh-code-review:10-19`).

Cada skill declara de qué otra depende y en qué orden, en prosa marcada. El
grafo es legible sin herramienta.

### 9.4 — Paridad cross-engine, con un caveat que la anula en frío

`verify-skill-invocation-metadata.ts:94-104` falla si Claude y Codex no
coinciden:

```ts
    const claudeManualOnly = disableModelInvocation === true
    const codexManualOnly = allowImplicitInvocation === false
    if (claudeManualOnly !== codexManualOnly) {
      violations.push(
        `${relativeRoot}: Claude Code manual-only=${String(claudeManualOnly)}`
        + ` but Codex manual-only=${String(codexManualOnly)}`,
      )
    }
```

y también si una skill manual-only deja de ser user-invocable (`:103`: *"a
manual-only skill must remain user-invocable"*).

> **Caveat, verificado**: `.agents/skills/.gitignore` contiene una sola línea,
> `*/agents/openai.yaml`. Los archivos de Codex **están gitignored**, así que
> en un clon limpio —y en CI— ese gate escanea **cero pares** y sale verde sin
> haber comparado nada. Es el modo de fallo de §5.4 (atrofia por glob vacío)
> ocurriendo en el repo que inventó el piso numérico contra él. Un
> `MINIMUM_SKILL_PAIRS` lo hubiera cazado.

### 9.5 — El symlink multi-engine, y por qué no lo copiamos

```
.claude/skills -> ../.agents/skills
CLAUDE.md -> AGENTS.md            (raíz y packages/)
```

> **Corrección con documentación oficial**: el symlink de `CLAUDE.md` **está
> documentado** (*"ln -s AGENTS.md CLAUDE.md"*), igual que el de
> `.claude/rules/`. El de **`.claude/skills` NO está documentado**. Funciona en
> su repo, pero apoyar la proyección multi-engine de navori en un
> comportamiento no documentado del host sería construir sobre algo que puede
> cambiar sin aviso y sin deprecación. Nuestro modelo —renderizar por engine
> desde un asset core— cuesta más código y no tiene ese riesgo. Se queda como
> está.

---

## 10. `dsh-trim-cot-leakage`: la fuga de cadena de pensamiento

La skill más original del corpus, y la que ataca un problema que nosotros
tenemos y no habíamos nombrado.

**El problema** (`SKILL.md:8`):

> *"Chain-of-thought leakage is prose whose vantage is the authoring session rather than the repository: it cites artifacts only that session could see, narrates the change instead of the state, or argues with a reviewer who has left."*

**El test, uno solo** (`:12`):

> *"could a reader at HEAD, with no access to any session transcript, PR thread, or uncommitted draft, resolve every reference and verify every claim?"*

**La regla de reparación, no de borrado** (`:8`):

> *"The fix is never deletion alone when a passage carries factual clauses — restate each so it stands at HEAD, then delete the transcript around it; a passage carrying none (an audit code, control-flow narration) is deleted outright."*

La taxonomía tiene 8 clases (citas de sesión muertas, vantage de PR/stack,
narración de cambio, coreografía de review, justificación dirigida al
reviewer, transcripciones de derivación, hedges, deslices de idioma) — y una
lista **"What is not leakage"** del mismo tamaño, con su razón (`:28`):

> *"Unaided citation passes fail in both directions by deleting durable references and keeping dead ones."*

Entre lo que **se conserva**: referencias a issues (`#1470` resuelve en HEAD,
se queda incluso en un README), justificaciones de supresión de lint
(*"fix a false reason, never delete it"*), cotas medidas (*"the evidence word
'measured' is load-bearing"*) y contrafácticos presentes (*"without X, Y
happens"*).

Y las baterías de grep se calibran antes de confiar en ellas (`:42`):
*"calibrating each probe against a known positive and a near-miss negative
before trusting its output"* — más el reconocimiento de que las baterías no son
la definición: *"each review round of the original purge found cases the
batteries missed"*.

> **Lectura nuestra, no cita**: nuestro `.claude/progress/` tiene unos 150
> archivos —esto es local, no observable en un clon: está en `.gitignore:18` y
> el número se mueve con cada sesión— y es fuga de cadena de pensamiento por
> construcción: son reportes de sesión, escritos desde la sesión, para la
> sesión. Eso está bien: es su género, y el equivalente de dsh (los
> transcripts) no está commiteado. El riesgo real es el **trasvase**: cuando
> un hecho de `impl_*.md` sube a un asset core o a un comentario de código, se
> lleva su vantage puesto ("esto antes rompía", "ver el audit de #X"). La
> clase 3 de la taxonomía —narración de cambio y sellos indexicales— es
> exactamente lo que le pasa a un docblock que acumula "Raised 800 -> 900…
> Raised 900 -> 1000". El test de una línea es adoptable hoy, gratis, dentro
> de `review-diff`.

---

## 11. Cableado Cordis: doctrina que ya cumplimos por otra vía

Esta sección se escribió primero como deuda y se reescribió como
**convergencia**, después de verificar el código de navori en frío. La
diferencia importa: lo que sigue no es una lista de cosas por hacer.

### 11.1 — "Registrations are effects"

`docs/architecture.md:11-13`:

> *"Every part of the product is a plugin… **There is no privileged core to patch**: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads."*

y la forma operativa, `AGENTS.md:125`:

> *"**Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer."*

El adjetivo que usan en las firmas es **"the exact disposer"**, y aparece
repetido en el JSDoc de cada método de registro
(`packages/core/tools/src/index.ts:952,1041,1075,1114`;
`packages/core/scope/src/store.ts:224`):

```ts
   * @returns the exact disposer that unregisters the tool.
   * @returns the exact disposer that lifts this restriction.
   * @returns the exact disposer returned by `ctx.effect()`.
```

No "un disposer equivalente" ni "una función de limpieza": **el mismo objeto**,
para que desregistrar no pueda divergir de registrar.

### 11.2 — Qué significa para `add` / `remove` / `sync` de navori

> **Verificado en el código, en frío.** La lectura intuitiva —"`remove` es
> código espejo de `add`, y debería ejecutar un manifiesto de disposers en vez
> de re-deducir qué tocó `add`"— es **falsa** para navori.
> `packages/cli/src/commands/remove.ts` son **111 líneas** contra las 262 de
> `add.ts`, y no contienen ninguna rama de desinstalación: marcan el plugin
> como `{ enabled: false }`, llaman a `runRender`, y recién entonces borran la
> clave. El comentario del código lo dice (`remove.ts:73-75`):
>
> > *"Phase 1: mark disabled and re-render. The disabled entry is what lets the engine strip the plugin's managed blocks, injectInto sub-blocks and scripts (#80) — deleting the key first would skip that cleanup."*
>
> **El render ES el disposer.** navori llega al mismo invariante de dsh por una
> vía distinta: en vez de que cada registro devuelva su deshacer, la
> configuración es la fuente de verdad y el render es idempotente sobre ella,
> así que "quitar" es apagar un flag y reconstruir. No hay dos caminos que
> puedan divergir porque solo hay uno.

La doctrina sigue siendo útil como **criterio de revisión**, no como tarea:
cualquier código nuevo en navori que borre artefactos por su cuenta —fuera del
render— reintroduce el camino espejo que hoy no existe. Esa es la regla que
vale escribir; la implementación ya está hecha.

### 11.3 — Las otras tres reglas de cableado, y su estado en navori

**`AGENTS.md:136` — "Misconfiguration fails loud":**

> *"**Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent."*

**`AGENTS.md:134` — "Explicit > implicit at package boundaries":**

> *"defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()`."*

**`AGENTS.md:135` — "No hardcoded tunables in plugins"**, que es la más
interesante porque **no tiene gate**: se sostiene por revisión más el catálogo
de config generado.

Ese catálogo (`scripts/gen-config-catalog.ts:2-7`):

> *"Generate `docs/config-catalog.md` from package entry points, config types, JSDoc, and static Schemastery schemas. **Every package must classify**, referenced types must resolve without collisions… `--check` verifies the committed artifact."*

Cada paquete clasifica en `'config' | 'no-config' | 'seam' | 'library'`; un
campo de config no documentado no compila.

> **Verificado en el código, en frío: navori ya tiene esto, y mejor resuelto.**
> `packages/cli/scripts/gen-schemas.mjs` deriva los JSON Schema públicos
> **desde los schemas zod** vía `z.toJSONSchema()` — no desde JSDoc ni desde
> tipos parseados con el compilador, sino desde la definición que el CLI
> ejecuta:
>
> > *"Single source of truth: the JSON Schemas are DERIVED from the zod schemas via `z.toJSONSchema()` (native in zod v4), so editors validate against the exact shape the CLI enforces. A drift test (schema-publish.test.ts) regenerates in memory and fails if the checked-in files fall behind the zod definitions."*
>
> `packages/cli/src/lib/__tests__/schema-publish.test.ts` es el `--check` de
> dsh, con una ventaja: regenera **en memoria** en vez de comparar contra un
> artefacto en disco. Paridad alcanzada, no pendiente. (El mismo archivo aplica
> el patrón una segunda vez, a las `CLASSIFY_RULES` que `mine-activation.py` no
> puede importar, con la razón escrita: *"two copies of a definition is how
> this term ended up…"*.)

---

## 12. Anti-patrones (qué NO copiar)

### 12.1 — El corpus de notas, medido contra el código

**3 082 archivos** en `.agents/notes/` para 11 228 tracked. Más de un cuarto
del repo son documentos de decisión. El tier `archived/` —con su manifiesto
append-only de sellos, su verificador dedicado y su baseline de `base.sha`—
solo se paga cuando hay **629 notas archivadas** que congelar. Con unos 150
archivos en `.claude/progress/`, para nosotros ese aparato cuesta más que el
problema que resuelve.

### 12.2 — El bilingüe triplica el costo por nota

Cada nota son **tres** archivos, y *"Pairs merge whole: a PR never lands one
language without the other two files."* En un repo que documenta cada cambio
no trivial con una nota, eso multiplica por tres el costo marginal de
documentar. dsh lo paga porque su doc la leen dentro y fuera de la empresa en
dos idiomas. navori es monolingüe; copiarlo sería pagar el costo sin el
beneficio.

### 12.3 — Una taxonomía con celdas vacías

6 clases (`feature`, `bug-fix`, `simplification`, `architecture`, `process`,
`testing`) × 4 ciclos de vida. En la práctica `rejected/bug-fix`,
`rejected/feature` y `rejected/testing` **no existen**, y `proposed/bug-fix`
tiene **una** nota.

> **Lectura nuestra, no cita**: una taxonomía cerrada cuyo gate la impone
> (`scripts/agent-note-tree.ts`) tiene que elegir entre dos males: clases
> vacías o clases forzadas. Antes de proponer cualquier taxonomía para navori,
> el test es contar cuántas celdas se llenarían de verdad.

### 12.4 — El gate cross-engine que escanea cero

Ver §9.4: los `agents/openai.yaml` están gitignored, así que
`verify-skill-invocation-metadata` sale verde sin comparar nada en un clon
limpio.

### 12.5 — La doctrina duplicada y la prosa que se quedó atrás

Ver §8.5 (la regla de Agent Notes en dos homes sin link) y §2.3 (los techos
declarados en prosa que ya no coinciden con el manifiesto, más dos techos que
la prosa promete y el manifiesto no tiene). El repo que inventó el checklist
anti-duplicación lo incumple en su regla más importante. No es un argumento
contra el checklist; es la prueba de que un checklist sin gate no se sostiene.

---

## 13. Qué incorporar y en qué orden

El lente declarado del proyecto es **pulir, simplificar y quitar hasta lo
indispensable**: la tabla está ordenada por cuánta complejidad **resta**, no
por cuánto valor promete. Cada ítem se verificó contra el código de navori
antes de escribirse; lo que no pasó ese filtro está en §11 como convergencia,
no aquí, y lo que agrega peso está abajo en "No ahora".

| Ítem | Prioridad | Qué resta | Issue |
|---|---|---|---|
| Extender a la prosa managed el techo de palabras que ya existe para las skills ([§2.4](#24--la-contraparte-en-navori-verificada-en-frío)) | P0 | Pone límite al texto que navori envía a todos los repos y hoy no lo tiene. Va **después** del ítem siguiente, nunca antes | — |
| Enlazar el porqué en vez de inlinearlo, en los 10 bloques managed ([§3.3](#33--qué-significa-para-navori)) | P0 | Saca justificación del archivo always-on hacia las skills que navori ya renderiza, sin perder un hecho | — |
| Añadir un `verify-md-links` antes de multiplicar los enlaces relativos ([§3.3](#33--qué-significa-para-navori)) | P0 | Prerrequisito del ítem anterior: sin gate de enlaces, enlazar más es acumular deuda más rápido | — |
| Escribir la regla del modo rápido derivado por filtro, antes de que alguien proponga uno ([§4](#4-el-registro-central-de-gates-y-quick-como-mecanismo)) | P0 | Evita de antemano la segunda lista de gates que después se desincroniza | — |
| Cerrar #804 con la documentación oficial ([§6.3](#63--corrección-con-documentación-oficial-los-hooks-no-son-serie)) | P1 | Quita doctrina falsa de un bloque managed en área crítica | #804 |
| Declarar junto a cada verde qué **no** prueba ([§7](#la-confesión-que-es-lo-que-vale)) | P1 | Evita que un gate verde se lea como una garantía más ancha de la que da | — |
| Anti-superposición en la `description` de las skills que se pisan ([§9.1](#91--el-frontmatter-es-de-4-campos-en-todo-el-corpus)) | P1 | Cambia una frase por skill; no agrega archivos, campos ni gates | — |
| Añadir a `review-diff` el test de una línea de `trim-cot-leakage` ([§10](#10-dsh-trim-cot-leakage-la-fuga-de-cadena-de-pensamiento)) | P1 | Caza prosa que no se puede verificar en HEAD, con reparación en vez de borrado | — |
| Piso numérico en los gates que globbean ([§5.4](#54--anti-atrofia-el-piso-numérico)) | P1 | Convierte la atrofia parcial en rojo; hoy solo se compara contra cero | — |

Cada ítem accionable se abre como issue de GitHub y el detalle vive ahí: esta
tabla es el índice, y el porqué está en la sección enlazada. El `—` significa
que el issue todavía no existe, no que el ítem se haya descartado.

### No ahora (agrega peso — con razón)

| Mecanismo | Por qué no |
|---|---|
| Corpus tipo `.agents/notes/` con 6 clases | Ya tenemos tres homes para decisiones (`specs/`, engram, `docs/research/`). Un cuarto es lo contrario de "one home per fact". El problema real es consolidar los tres, no agregar. |
| Tier `archived/` con manifiesto de sellos | Se paga con 629 notas archivadas. Tenemos unos 150 archivos de progreso y ningún ciclo de vida declarado. |
| Contrato bilingüe con sidecar de blobs | Triplica el costo de cada documento. navori es monolingüe. |
| Registro tipado de gates (1 608 líneas, 17 modos) | Nuestro gate es una línea en `qualityGate.full`, anclada por `repo-config-gate.test.ts`. Un registro se justifica con 17 modos, no con uno. |
| Symlink `.claude/skills → …` para multi-engine | No documentado por el host (§9.5). El render por engine cuesta más código y no depende de comportamiento no documentado. |
| Gate para "cambios no triviales llevan nota" | dsh **decidió no mecanizarlo** teniendo 60 verificadores (§8.4). "No trivial" no es decidible; el gate produce ceremonia. |
| Catálogo de config generado con `--check` | **Ya existe y mejor**: `gen-schemas.mjs` + `schema-publish.test.ts` derivan desde zod y regeneran en memoria (§11.3). |
| Manifiesto de disposers para `remove` | **Ya resuelto por otra vía**: el render idempotente sobre la config es el disposer (§11.2). |
| `verify-md-wrap` (una línea física por párrafo) | El beneficio es real (diffs de una línea), pero invierte la convención de todo nuestro `docs/`. Registrado como trade-off, no como tarea. |

---

## Apéndice — rutas de referencia rápida

| Tema | Archivo en dsh |
|---|---|
| Techos de palabras | `scripts/verify-doc-budgets.ts`, `scripts/doc-budgets.manifest.json` |
| Política relocate/condense/raise e histéresis | `docs/AGENTS.md:50-58` |
| Reglas raíz (patrón canónico) | `AGENTS.md:121-160`; el patrón declarado en `:171` |
| Reparto de checks | `AGENTS.md:113-115`, `lefthook.yml`, `.github/workflows/ci.yml:735` |
| Registro de gates y modo derivado | `scripts/run-gates.ts:24-63`, `:232-295`, `:794-796` |
| Familia de verificadores | `scripts/verify-*.ts` (60 archivos) |
| Anti-atrofia | `scripts/verify-client-ui-i18n.ts:15`, `:341-343` |
| Fail-closed sintáctico | `scripts/verify-export-jsdoc.ts:7` |
| Prohibición de una palabra | `scripts/verify-concrete-terms.ts:9` |
| Contrato bilingüe y su límite | `docs/i18n/README.md`, `scripts/verify-translation-pairing.ts:239` |
| Notas de decisión | `.agents/notes/README.md`, `.agents/notes/AGENTS.md` |
| Formato y unicidad del `Status:` | `scripts/verify-agent-note-format.ts:55-65` |
| Sellado del archivo | `scripts/verify-archived-agent-notes.ts:86-87`, `.github/workflows/ci.yml:106` |
| Por qué no hay índice | `.agents/notes/implemented/process/2026-07-19-remove-generated-agent-note-index.md:9` |
| Skills | `.agents/skills/*/SKILL.md`, `scripts/verify-skill-invocation-metadata.ts:94-104` |
| Fuga de cadena de pensamiento | `.agents/skills/dsh-trim-cot-leakage/SKILL.md` |
| Cableado Cordis | `docs/architecture.md:11-13`, `AGENTS.md:125-136` |
| Catálogo de config | `scripts/gen-config-catalog.ts:2-7` |
| Límites de la seguridad, declarados | `SAFETY.md:13` |

### Contrapartes en navori (verificadas en frío para este documento)

| Tema | Archivo en navori |
|---|---|
| Techo de palabras con gate (skills) | `packages/cli/src/lib/skill-meta.ts:58-65`, `:112-115`, `:134-138`; `skill-caps.test.ts` |
| Techo de bytes con política de subida | `packages/cli/scripts/check-bundle-size.mjs` |
| Anti-atrofia por glob vacío | `scripts/check-asset-commands.mjs:79`, `:143-150` |
| Artefacto generado con drift test | `packages/cli/scripts/gen-schemas.mjs`, `packages/cli/src/lib/__tests__/schema-publish.test.ts` |
| El render como disposer | `packages/cli/src/commands/remove.ts:73-106` |
| Gate anclado contra CI | `repo-config-gate.test.ts`, `subcommand-inventory.test.ts` |
| Corrección pendiente de doctrina | issue **#804** — `packages/core/core-assets/managed/operaciones-seguras.md:23`, `hooks/guard-destructive.sh:92-93` |
