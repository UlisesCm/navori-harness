# Cómo contribuir a navori

**Lee primero [`docs/DIRECTION.md`](docs/DIRECTION.md)** — es la fuente de verdad del objetivo,
metas, no-metas e invariantes de navori. Aplica a humanos **y** agentes de IA: si tu idea
contradice un invariante o reabre una no-meta, abre/edita una spec en `specs/` antes de tocar
código; no la metas en un PR suelto.

## Antes de codear

1. Lee `docs/DIRECTION.md`, luego `docs/architecture.md` (cómo funciona el render y las 5 capas)
   y la(s) spec(s) del área que vas a tocar (`specs/000X-*.md`). Respeta el `Status` de cada
   spec (`proposed` / `planning only — NO implementar` / `EJECUTADA`), y **confírmalo contra el
   código**, que es la fuente más fresca: varias specs se escribieron antes de aterrizar y su
   header quedó en la intención original —0001 y 0002 dicen `proposed` con su contenido ya en
   producción—, y once todavía no declaran uno. Un vistazo al código y a `git log` te da el estado
   real en un minuto; y lo que sigue pendiente de decidir lo dice sin ambigüedad
   (`planning only — NO implementar hasta aprobación`).
2. **Ubica en qué capa rinde más tu cambio antes de escribirlo** —
   [`docs/EXTENDING.md`](docs/EXTENDING.md). Hay cinco destinos ordenados de más barato a más
   caro, y el más barato suele ser el más efectivo: si el tema ya lo cubre una skill, sumar ahí
   (user-section o `injectInto`) llega más rápido y con la autoridad ya establecida. Ese doc trae
   además las cuatro preguntas que hacen fuerte a una propuesta — respóndelas y tu PR entra con
   muy poca fricción.
3. Pregúntate: ¿es lo más simple? ¿legible en 6 meses? ¿mantiene el patrón existente?
   Simplicidad > cleverness.

## Instalar dependencias

`bun install` desde la raíz. El `package.json` raíz declara
`"trustedDependencies": ["esbuild", "sharp"]` — sin eso bun ignora sus scripts de postinstall (y
ahí es donde antes, con pnpm, saltaba un error en vez de un warning). Ambos necesitan el suyo:
esbuild descarga su binario nativo (del que depende vitest) y sharp compila contra libvips
para el sitio Astro. Se listan explícitamente y se comitean para que un clon fresco instale sin que
nadie tenga que aprobar nada a mano.

## Quality gate (obligatorio antes de cerrar cambios en `packages/cli`)

Es lo que valida el job `quality` de CI; si no pasa, el PR falla:

1. **`bun check` desde la raíz del monorepo.** Es un alias de `qualityGate.full` en
   `navori.config.json`, que es **el único lugar** donde vive el gate: de ahí salen los bloques
   managed de `CLAUDE.md` y el comando que corre el `publisher`. No lo transcribas aquí ni
   en ningún otro archivo — una segunda copia es una copia que se desincroniza, y ya pasó
   (`repo-config-gate.test.ts` existe por eso; ver el detalle al final de esta sección).

   Dos trampas dentro de ese comando:
   - **`bun run test:coverage`, no `bun test`.** Corre la misma suite más
     `check-coverage-floor.mjs`, que además del umbral caza una entrada obsoleta en `KNOWN_ZERO`
     (los módulos que navori envía sin tests). Correr sólo `bun test` lo deja pasar, y ya costó
     un CI rojo con el gate verde.
   - **`bun run format:check` (oxfmt) NO está bajo `packages/cli`**: corre en la raíz, y es el paso
     que más se olvida. Se arregla con `bun run format`.
   - **`blame.ignoreRevsFile`**: configúralo (`git config blame.ignoreRevsFile .git-blame-ignore-revs`)
     para que `git blame` salte los commits de reformateo masivo (p. ej. la migración a oxfmt,
     #889) listados en `.git-blame-ignore-revs` en la raíz. Un commit entra ahí **solo después de
     aterrizar en `main`**, nunca en el mismo PR que se va a mergear por squash — el squash reescribe
     el SHA y la entrada deja de ser ancestro de `main` (#986, #1004). `bun run check:blame-ignore`
     (parte del gate) exige ambas cosas por entrada: que sea ancestro de `origin/main` y que su diff
     sea mecánico.
   - **Dos gates corriendo el mismo `test:coverage` sobre el mismo árbol de trabajo** (dos agentes
     en la misma sesión local, no en worktrees distintos) chocan escribiendo al mismo
     `packages/cli/coverage/` (#909). Para aislar una corrida, exporta
     `NAVORI_COVERAGE_DIR=coverage-<algo único>` antes del comando — `vitest.config.ts` y
     `check-coverage-floor.mjs` leen la misma variable, con fallback a `coverage` (el default, sin
     tocarlo, es lo que sigue corriendo en CI y en el gate normal).

   **`jscpd:check` y `semgrep:check`** entraron al gate en #777: son los mismos scripts que corren
   como hook de `git commit` con stdin cerrado, para que la revisión prediga el commit — antes, el
   primer contacto del diff con seguridad era el hook, **después** de un APPROVED ya firmado.
   Comparten receta y cache de contenido con el hook (#402), así que el re-escaneo tras un gate
   verde es un cache-hit, no un segundo escaneo; el hook queda como backstop. Si la herramienta no
   está instalada, el paso sale `⊘ … not installed` y exit 0 — opcional local, no dependencia dura.
2. **Si tocaste cualquier cosa que alimente el render**: `bun run check:render` desde la raíz. Este
   repo se auto-hospeda —`.claude/` y `CLAUDE.md` son salida de `navori render`—, así que el PR
   debe incluir el re-render del espejo (`bun run render:apply` desde la raíz, que es exactamente
   `bun run --filter navori build && node packages/cli/dist/index.js render --apply`) o el
   job `quality` queda en rojo (#421). **El build de esa cadena NO es opcional**: sin él el
   render compara contra los assets del último build, no contra tu árbol de trabajo — te dice
   `unchanged` y un `--apply` llega a *revertir* el espejo. Por eso existe el alias: para que no
   se copie a medias. Disparadores; cualquiera de los cuatro obliga al re-render:
   - **assets del core**: `packages/core/core-assets/**`.
   - **assets de un plugin**: `packages/plugins/*/{managed,scripts,skills,hooks}/**` y el
     `plugin.json` que los declara. El build los empaqueta igual que los del core
     (`packages/cli/scripts/copy-assets.mjs`) y renderizan bloques dentro de `CLAUDE.md` y
     archivos bajo `.claude/`. **Por aquí se coló #429**: tocó un asset de plugin, no del core, y
     el espejo quedó desfasado un día.
   - **el bump de versión de `packages/cli/package.json`**: el marcador de cada bloque managed
     estampa `readCliVersion()`, así que subir la versión desfasa el espejo **entero** — medido en
     0.6.0 → 0.6.1: **30 archivos** `updated`, 16 bloques de `CLAUDE.md`. Un commit
     `chore(release)` NO es una excepción; ver "Releases" en el `README.md`.
   - **el `navori.config.json`** de este repo, que define qué se renderiza.

   El check rebuildea antes de renderizar a propósito: `dist/assets/` es una copia del core y de
   los plugins hecha en build, y renderizar con un `dist` viejo compara contra los assets
   anteriores y pasa en silencio.

   Dos reglas que solo se descubren cuando ya te mordieron (#435):

   - **El re-render caduca cuando la base se mueve.** Tras cualquier rebase o merge de `main`,
     vuelve a correr `bun run render:apply`: tu espejo se generó contra los assets de antes, y si
     entre medias entró otro PR de assets, el tuyo ya está viejo. Pasó tres veces seguidas
     mientras se construía #421.
   - **Nunca resuelvas a mano un conflicto dentro de un bloque managed.** Toma la versión de la
     base y regenera con `bun run render:apply`. El motivo importa: cada bloque lleva el `hash` de su
     propio contenido, así que editarlo a mano lo marca como *modificado por el usuario* y
     `render --apply` **deja de pisarlo** — pasa a `user-modified-skipped`, la clase de drift
     que ya solo arregla `navori sync`. Es la trampa fácil: ante un conflicto de git el reflejo
     es editar, y aquí ese reflejo convierte un problema de un comando en uno que exige entender
     el modelo de marcadores.
3. **Si el paso 2 aplicó, el golden snapshot del árbol renderizado también se mueve**:
   regenéralo con `cd packages/cli && bun run test:golden` (~1 s) y **lee el diff** antes de
   commitearlo. Son cinco fixtures, uno por engine, en
   `packages/cli/src/engines/__tests__/__golden__/<engine>.snap`; existen porque los ~11 tests de
   wiring apuntan a tokens sueltos y nadie ve el output completo (#394). Un cambio que no sepas
   explicar en ese diff es el hallazgo, no ruido a aplanar con `-u`.

   Un disparador del paso 2 que **no** aplica aquí: el bump de versión. El snapshot normaliza el
   `version=` y el `hash=` del marcador, así que subir la versión mueve 30 archivos del espejo y
   **cero** líneas del golden. Es a propósito: sin esa normalización se invalidaría en cada
   release y dejaría de tener señal.

`repo-config-gate.test.ts` sostiene el gate contra `ci.yml` en las **dos** direcciones: si el
workflow gana un paso que el gate no declara, o el gate gana uno que CI no corre, la suite falla y
dice cuál. Las excepciones viven en dos mapas, `EXEMPT_FROM_LOCAL_GATE` y `EXEMPT_FROM_CI`, con
razón obligatoria por entrada y anti-staleness en ambos sentidos. Hoy están exentos:

- **`check:assets:ci`** (de `EXEMPT_FROM_LOCAL_GATE`): es la misma verificación que `check:assets`
  con `--strict`, y lo estricto depende de tags que CI trae a propósito y un clon fresco no tiene —
  en el gate local fallaría por una causa ambiental, no por el fondo.
- **`check:assets`, `jscpd:check` y `semgrep:check`** (de `EXEMPT_FROM_CI`): CI corre el superset
  estricto de `check:assets`, y ninguna de las otras dos herramientas está en el lockfile — un paso
  de CI que las invocara se saltaría a sí mismo y saldría verde en falso.

Cambios **doc-only** (.md): basta `bun run lint` + `bun run format:check`; no necesitas la suite
completa.
**"Doc-only" son los docs del repo, no los assets**: un `.md` bajo `packages/core/core-assets/`
o `packages/plugins/*/` es la fuente del harness renderizado, así que dispara los pasos 2 y 3
(espejo y golden) aunque su extensión diga lo contrario.

## Presupuesto de prosa: qué se capea y qué solo se reporta

Toda la prosa que navori envía vive en el contexto residente de cada sesión, así que crece por
acumulación: cada sesión que aprende algo agrega, ninguna poda. Hay **dos superficies de arranque**
y se tratan distinto a propósito.

| Superficie | Quién la escribe | ¿Techo? | Quién lo vigila |
|---|---|---|---|
| Assets managed (`core-assets/managed/`, `presets/*/managed/`, `plugins/*/managed/`) | navori | **Sí**, por archivo | `bun run check:doc-budgets` en el gate |
| Bloques computados (`skills-index`, `contexto-proyecto`, `agentes-disponibles`) | navori, desde la config del consumidor | **Sí**, fórmula `base + k · filas` | `navori doctor` (reporta) |
| Prosa propia del consumidor, fuera de los marcadores | el dueño del repo | **No, nunca** | se reporta y ya |
| `.claude/context/*.md` | navori | **No todavía** (#919) | `navori doctor` (reporta) |
| `AGENTS.md` (engines prosa) | navori | **No** — se reporta contra el cap del host | `navori doctor` (aviso amarillo desde el 80 %) |

Los techos viven en un solo lugar: `packages/cli/src/lib/assets/doc-budgets.ts`. Está bajo `src/lib/` y no
en un JSON bajo `scripts/` porque npm publica `["dist", "README.md"]`: `doctor` tiene que leer esos
mismos números dentro del repo de un consumidor, y solo puede si van en el bundle. Política: cada
techo carga **≥5 % de margen** sobre lo medido, y la subida se justifica en el cambio que la pide —
poner el número exacto que pasa es cómo `CLAUDE.md` llegó a 2548/2550.

Tres decisiones que no son obvias:

- **La prosa del consumidor no se capea.** navori no tiene standing para ponerle techo al
  `CLAUDE.md` de otro repo; este mismo repo tiene 536 palabras propias contra 1771 managed. Se
  reporta separada ("X tuyas, Y de navori") y punto.
- **Los bloques computados no pueden tener constante.** `contexto-proyecto` mide 54 palabras aquí y
  335 en `bonum-dashboard` — 6.2x — solo porque ese repo declara más entradas en `project.*`, que es
  usar la herramienta como debe usarse. La `k` está calibrada **generosa** a propósito: el bloque
  cobra lo que cuesta cada entrada de config, no castiga tenerlas.
- **El reporte de `doctor` no mueve `ok` ni falla `--strict`.** Hay 30 repos en el registry global;
  engancharlo al veredicto los pone en rojo el día del bump por prosa legítima. `render` tampoco
  imprime una línea informativa fija: solo avisa cuando el techo **se cruza en esa ejecución**.

Un detalle de la métrica que vale la pena conocer antes de leer un número: **los bloques sin
techo no entran en la comparación**. Un bloque que navori no budgetea (típicamente uno retirado
que sigue en un archivo viejo) suma palabras al total pero aporta 0 al techo, así que contarlo en
el cociente reporta un exceso que inventó la métrica. Medido en el `CLAUDE.md` real de
`bonum-webapp`: `engram-protocol` (497) + `codegraph-protocol` (255) eran **752 de 1207** del
exceso reportado, el 62 %. Se cuentan aparte y se nombran en su propia línea, no se esconden.

La superficie prosa (`AGENTS.md`, que comparten `codex`, `agents-md`, `cursor` y `copilot`) se
mide en **bytes**, no en palabras, y por una razón: el único límite que existe ahí es del host.
Codex concatena de la raíz hacia abajo y **deja de agregar archivos** al llegar a
`project_doc_max_bytes` (32 KiB por defecto), sin avisar — truncamiento silencioso, que ningún
techo de palabras detecta. navori reporta su parte y nada más: la cadena suma el
`~/.codex/AGENTS.md` del usuario y los `AGENTS.md` anidados, así que lo medido es una **cota
inferior**. Tampoco se mide bloque a bloque: `AGENTS.md` renderiza como un solo bloque
`navori-agents`, y un reporte por bloque ahí daría `ceiling 0, overBy 0` — una línea que no puede
fallar nunca. Darle diagnóstico por bloque cambiaría la topología de markers de un archivo ya
desplegado (área crítica): eso es una spec aparte.

Y la distinción que decide qué hacer con el aviso: **"tu archivo está gordo" no es lo mismo que "tu
archivo es viejo"**. Un `CLAUDE.md` rendereado por una versión anterior arrastra bloques que ya
adelgazaron — en `bonum-webapp` un `navori render --apply` recorta 1175 palabras (−37 %) sin que su
dueño decida nada. `doctor` reporta primero la staleness por eso: es la única palanca que no pide
ninguna decisión.

Un último número que el reporte nombra y conviene tener presente al escribir prosa managed: **cada
subagente recarga `CLAUDE.md` + las project rules desde cero** en su propio contexto (Claude Code,
"What loads at startup"; solo `omitClaudeMd` lo evita). No hay multiplicador fijo —el ticket decide
cuántos agentes corren— pero un ciclo implementer→reviewer→publisher paga ese archivo una vez por
agente, además de la sesión principal. **Es un hecho de Claude, no portable**: un subagente de
Codex se lanza desde su propio archivo de agente con `developer_instructions` obligatorias, así que
el reporte omite esa línea cuando `engines` no incluye `claude`.

## Commits y PRs

- Commits: Conventional, español MX, atómicos (`feat|fix|chore|docs(scope): mensaje`).
- Cada ticket en branch nueva con base `main`. **Este repo mergea a `main`** (excepción a la
  regla Bonum de mergear a `develop`).
- No commitees el harness local (`CLAUDE.md`, `.claude/`) de un repo `/bonum`.
