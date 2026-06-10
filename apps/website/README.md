# @navori/website

Landing + docs de navori. Astro + Tailwind v4, bilingüe es/en, deploy a GitHub Pages.

## Dev

```bash
# desde la raíz del monorepo
pnpm install
pnpm --filter @navori/website dev
# abre http://localhost:4321
```

## Build

```bash
pnpm --filter @navori/website build
pnpm --filter @navori/website preview
```

## Estructura

```
apps/website/
├── astro.config.mjs        # i18n (es default, en), sitemap, tailwind vite plugin
├── src/
│   ├── components/         # Hero, Header, Footer, InstallTabs, HeroTerminal, Logo, ...
│   │   └── sections/       # Problem, Layers, Commands, Engines, Quickstart, FAQ, Trustband
│   ├── content/
│   │   └── commands.ts     # data source de las docs por comando (es + en)
│   ├── i18n/
│   │   ├── ui.ts           # diccionario de strings
│   │   └── utils.ts        # getLangFromUrl, useTranslations, localizedPath
│   ├── layouts/
│   │   ├── BaseLayout.astro
│   │   └── DocsLayout.astro
│   ├── pages/
│   │   ├── index.astro     # landing es
│   │   ├── quickstart.astro
│   │   ├── docs/[command].astro
│   │   └── en/
│   │       ├── index.astro
│   │       ├── quickstart.astro
│   │       └── docs/[command].astro
│   └── styles/global.css   # tokens (sky+violet+marfil), tema light/dark
└── public/
    └── favicon.svg
```

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
