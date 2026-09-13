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

## Quality gate (obligatorio antes de cerrar cambios en `packages/cli`)

Es lo que valida el job `quality` de CI; si no pasa, el PR falla:

1. **`pnpm check` desde la raíz del monorepo.** Es un alias de `qualityGate.full` en
   `navori.config.json`, que es **el único lugar** donde vive el gate: de ahí salen los bloques
   managed de `CLAUDE.md` y el comando que corre el `commit-pr-pilot`. No lo transcribas aquí ni
   en ningún otro archivo — una segunda copia es una copia que se desincroniza, y ya pasó
   (`repo-config-gate.test.ts` existe por eso, y sostiene el gate contra `ci.yml`: si el workflow
   gana un paso de verificación que el gate no declara, la suite falla y dice cuál).

   Dos trampas dentro de ese comando:
   - **`pnpm test:coverage`, no `pnpm test`.** Corre la misma suite más
     `check-coverage-floor.mjs`, que además del umbral caza una entrada obsoleta en `KNOWN_ZERO`
     (los módulos que navori envía sin tests). Correr sólo `pnpm test` lo deja pasar, y ya costó
     un CI rojo con el gate verde.
   - **`pnpm format:check` (biome) NO está bajo `packages/cli`**: corre en la raíz, y es el paso
     que más se olvida. Se arregla con `pnpm format`.
2. **Si tocaste cualquier cosa que alimente el render**: `pnpm check:render` desde la raíz. Este
   repo se auto-hospeda —`.claude/` y `CLAUDE.md` son salida de `navori render`—, así que el PR
   debe incluir el re-render del espejo (`pnpm render:apply` desde la raíz, que es exactamente
   `pnpm --filter navori build && node packages/cli/dist/index.js render --apply`) o el
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
     vuelve a correr `pnpm render:apply`: tu espejo se generó contra los assets de antes, y si
     entre medias entró otro PR de assets, el tuyo ya está viejo. Pasó tres veces seguidas
     mientras se construía #421.
   - **Nunca resuelvas a mano un conflicto dentro de un bloque managed.** Toma la versión de la
     base y regenera con `pnpm render:apply`. El motivo importa: cada bloque lleva el `hash` de su
     propio contenido, así que editarlo a mano lo marca como *modificado por el usuario* y
     `render --apply` **deja de pisarlo** — pasa a `user-modified-skipped`, la clase de drift
     que ya solo arregla `navori sync`. Es la trampa fácil: ante un conflicto de git el reflejo
     es editar, y aquí ese reflejo convierte un problema de un comando en uno que exige entender
     el modelo de marcadores.
3. **Si el paso 2 aplicó, el golden snapshot del árbol renderizado también se mueve**:
   regenéralo con `cd packages/cli && pnpm test:golden` (~1 s) y **lee el diff** antes de
   commitearlo. Son cinco fixtures, uno por engine, en
   `packages/cli/src/engines/__tests__/__golden__/<engine>.snap`; existen porque los ~11 tests de
   wiring apuntan a tokens sueltos y nadie ve el output completo (#394). Un cambio que no sepas
   explicar en ese diff es el hallazgo, no ruido a aplanar con `-u`.

   Un disparador del paso 2 que **no** aplica aquí: el bump de versión. El snapshot normaliza el
   `version=` y el `hash=` del marcador, así que subir la versión mueve 30 archivos del espejo y
   **cero** líneas del golden. Es a propósito: sin esa normalización se invalidaría en cada
   release y dejaría de tener señal.

El único paso que CI corre y el gate local **no** repite es `check:assets:ci`: es la misma
verificación que `check:assets` con `--strict`, y lo estricto depende de tags que CI trae a
propósito y un clon fresco no tiene — en el gate fallaría por una causa ambiental, no por el
fondo. La razón está escrita en `repo-config-gate.test.ts`, que es también quien exige que
cualquier otro paso nuevo de CI entre al gate.

Cambios **doc-only** (.md): basta `pnpm lint` + `pnpm format:check`; no necesitas la suite
completa.
**"Doc-only" son los docs del repo, no los assets**: un `.md` bajo `packages/core/core-assets/`
o `packages/plugins/*/` es la fuente del harness renderizado, así que dispara los pasos 2 y 3
(espejo y golden) aunque su extensión diga lo contrario.

## Commits y PRs

- Commits: Conventional, español MX, atómicos (`feat|fix|chore|docs(scope): mensaje`).
- Cada ticket en branch nueva con base `main`. **Este repo mergea a `main`** (excepción a la
  regla Bonum de mergear a `develop`).
- No commitees el harness local (`CLAUDE.md`, `.claude/`) de un repo `/bonum`.
