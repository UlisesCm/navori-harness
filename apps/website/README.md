# @navori/website

Landing + docs de navori. Astro + Tailwind v4, bilingüe es/en, deploy a GitHub Pages.

## Dev

```bash
# desde la raíz del monorepo
bun install
bun run --filter @navori/website dev
# abre http://localhost:4321
```

## Build

```bash
bun run --filter @navori/website build
bun run --filter @navori/website preview
```

## Estructura

```
apps/website/
├── astro.config.mjs        # i18n (es default, en), sitemap, tailwind vite plugin
├── scripts/                # utilidades fuera del build (generación de las imágenes og)
├── src/
│   ├── consts.ts           # links canónicos + los números que la landing publica
│   ├── components/         # Hero, Header, Footer, InstallTabs, HeroTerminal, Logo, ...
│   │   └── sections/       # una por bloque de la landing; se componen en index.astro
│   ├── content/
│   │   ├── commands.ts     # data source de las docs por comando (es + en)
│   │   └── command-groups.ts  # agrupa esos comandos por ciclo de vida en la landing
│   ├── i18n/
│   │   ├── ui.ts           # diccionario de strings
│   │   └── utils.ts        # getLangFromUrl, useTranslations, localizedPath
│   ├── layouts/
│   │   ├── BaseLayout.astro
│   │   └── DocsLayout.astro
│   ├── pages/
│   │   ├── index.astro     # landing es
│   │   ├── quickstart.astro
│   │   ├── deep-dive.astro
│   │   ├── llms.txt.ts     # + robots.txt.ts: el sitio servido para agentes y crawlers
│   │   ├── docs/[command].astro
│   │   └── en/             # el mismo árbol en inglés; es es el default sin prefijo
│   └── styles/global.css   # tokens (sky+violet+marfil), tema light/dark
└── public/
    ├── favicon.svg
    ├── og.png · og-en.png  # share cards (el .svg fuente queda al lado)
    └── schema/             # JSON Schemas publicados
```

## Lo que no se edita a mano

`src/consts.ts` declara los links canónicos y los números que la landing publica — comandos,
presets, plugins, engines, agentes, skills. `packages/cli/src/__tests__/landing-inventory.test.ts`
los compara contra el repo real y falla nombrando el que se desincronizó: **se arregla la
constante, nunca el test**.

Ese guard existe por una razón concreta. `/docs/<comando>` nunca derivó porque
`command-docs-inventory.test.ts` falla si un subcomando registrado no tiene página; la landing no
tenía equivalente y derivó un trimestre — decía 8 comandos con 21 registrados, 6 presets con 12, y
"Multi-engine roadmap" con los 5 engines ya entregados. La diferencia entre las dos mitades del
sitio era un test.

Por eso un subcomando nuevo necesita **dos** entradas: su `CommandDoc` en `commands.ts` (es *y*
en) y su grupo en `command-groups.ts`. Las dos están cubiertas por tests.

Las imágenes og (`public/og.png`, `og-en.png`) se generan con `node scripts/gen-og.mjs` y se
commitean. No corren en el build a propósito: `sharp` se resuelve del store de pnpm en vez de ser
dependencia declarada, porque es un asset que cambia dos veces al año.

## Deploy

GitHub Action `.github/workflows/deploy-website.yml` builda y publica a GitHub Pages en cada push a `main` que toque `apps/website/**`.

**Antes del primer deploy**: en `Settings → Pages` del repo, marcar **Source: GitHub Actions**.

Si publicas bajo path (`<user>.github.io/<repo>/`), define las repo variables:

- `SITE_URL` = `https://<user>.github.io`
- `SITE_BASE` = `/<repo>/`

Si es un repo `<user>.github.io` (root), dejá los defaults.

## Diseño

- **Tipografía**: Instrument Serif (display), Geist Sans (body), Geist Mono (code).
- **Paleta**: sky `#0EA5E9` + violet `#7C3AED` sobre marfil cálido `#FAFAF7`. Dark mode con azul-noche `#0A0E1A`.
- **Patrones**: hero split asimétrico con terminal animada (CSS-only typewriter), grid sutil de fondo, glows radiales sky→violet contenidos.
