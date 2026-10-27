[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

# @navori/website

Landing pública y sitio de documentación de Navori. Está construido con Astro y Tailwind CSS v4, y se publica en GitHub Pages.

## Dev

```bash
# desde la raíz del monorepo (Bun 1.4.4; el repo requiere Node.js >=24)
bun install
bun run --cwd apps/website dev
# abre http://localhost:4321
```

## Build

```bash
bun run --cwd apps/website build
bun run --cwd apps/website preview
```

El build ejecuta Astro y después `scripts/check-i18n.ts`. El verificador revisa las páginas generadas, los enlaces por idioma y fragmento, las alternativas Markdown, los índices localizados, la cobertura de comandos y narrativas, los aliases de compatibilidad y el inventario del sitemap.

## Estructura

El inglés es el idioma canónico y vive en `/`. Las páginas en español usan `/es/`; las de chino simplificado, `/zh-cn/`. Astro tiene `en` como locale predeterminado y no agrega prefijo al idioma default. `SITE_URL` define el origen del sitio y `SITE_BASE` su ruta base; sus valores por defecto corresponden al despliegue raíz configurado en `astro.config.mjs`.

Para conservar compatibilidad, el sitio también genera páginas estáticas `/en/…` que apuntan a las rutas canónicas en inglés, y `/versiones`, que apunta a `/es/releases`. Son páginas HTML con `noindex, follow`, meta refresh y un script que conserva el fragmento de la URL. No son redirecciones HTTP 301. El sitemap excluye estos aliases y también los recursos `.md` y `.txt`.

El build actual genera **99 páginas HTML canónicas**, una alternativa Markdown hermana por cada página y **3 índices `llms.txt` localizados**. En cada uno de los tres idiomas publica inicio, quickstart, deep dive, releases y las 29 páginas de comandos del CLI. También genera 34 páginas estáticas de compatibilidad: 33 aliases `/en/…` y `/versiones`.

Los componentes Astro y las fuentes de contenido se comparten entre idiomas:

- `src/i18n/ui.ts` contiene los textos del recorrido interactivo de ocho pasos: Arrives, Context, Orchestrates, Locates, Works, Guards, Filters y Closes.
- `src/content/narratives.ts` contiene las narrativas de los ocho roles de deep dive: Orchestrator, Scout, Auditor, Architect, Implementer, Reviewer, Publisher y Scribe.
- `src/content/commands.ts` contiene la documentación localizada de comandos; `src/content/pages.ts` define páginas canónicas, aliases y fragmentos.
- Los mismos componentes de página alimentan HTML y alternativas Markdown. El Markdown agrega los estados del recorrido que pueden quedar ocultos en la interfaz y los ejemplos técnicos.

```text
apps/website/
├── astro.config.mjs              # rutas por idioma, base y sitemap
├── scripts/
│   ├── check-i18n.ts             # checker de resultados y enlaces en el build
│   └── gen-og.mjs                # generación manual de Open Graph SVG/PNG
├── src/
│   ├── components/pages/         # páginas compartidas de landing, quickstart, deep dive y releases
│   ├── components/sections/      # secciones reutilizables de la landing
│   ├── content/
│   │   ├── commands.ts           # documentación de comandos localizada
│   │   ├── guides.ts              # inventario de guías y URLs localizadas
│   │   ├── markdown.ts            # alternativas de páginas e índices llms.txt
│   │   ├── narratives.ts          # narrativas compartidas por HTML y Markdown
│   │   └── pages.ts               # rutas canónicas, aliases y fragmentos
│   ├── i18n/
│   │   ├── locales.ts             # idiomas soportados y nombres nativos
│   │   └── ui.ts                  # interfaz y recorrido localizados
│   └── pages/
│       ├── [...localized].astro   # páginas canónicas /es/ y /zh-cn/
│       ├── [...page].md.ts        # alternativa Markdown de cada página canónica
│       ├── [locale]/llms.txt.ts   # índices localizados para agentes
│       ├── index.astro            # landing canónica en inglés en /
│       ├── llms.txt.ts            # índice en inglés en la raíz
│       ├── robots.txt.ts          # política de rastreo y referencia al sitemap
│       └── en/                    # aliases estáticos de compatibilidad en inglés
└── public/
    ├── og*.svg y og*.png          # fuentes y renders de tarjetas de compartir
    └── schema/                    # JSON Schema publicados
```

`src/content/pages.ts` establece una ubicación canónica por tema e idioma. El inglés no lleva prefijo; los otros idiomas usan sus prefijos configurados. Al agregar una página o un comando, actualiza su fuente propietaria y conserva válidos la página localizada, su alternativa Markdown, los enlaces de idioma, los fragmentos y el sitemap. El checker del build señala recursos faltantes o desincronizados.

El monorepo usa Bun `1.4.4` y requiere Node.js `>=24` (`package.json`) para desarrollar y compilar el sitio. El CLI publicado tiene su propio requisito mínimo de Node.js `>=22.12` (`packages/cli/package.json`); ese mínimo del CLI no sustituye el requisito de desarrollo del monorepo.

## Lo que no se edita a mano

`src/consts.ts` contiene los números que se publican en la landing. El test `packages/cli/src/__tests__/landing-inventory.test.ts` los compara con el inventario real del CLI; si se desincronizan, corrige la fuente, no el test. Las páginas de comandos también se contrastan con el registro del CLI: documenta cada comando en `src/content/commands.ts`, en lugar de ocultar una entrada faltante en el checker.

El checker del build valida los artefactos HTML y Markdown, los fragments declarados para la landing y deep dive, las ocho paradas del recorrido en los tres idiomas, ejemplos técnicos, aliases y el sitemap. Mantén alineados el contenido, el inventario y las rutas; no reemplaces una expectativa del checker para hacer pasar una discrepancia.

Las tarjetas Open Graph (`public/og*.svg` y `public/og*.png`) se generan con `node apps/website/scripts/gen-og.mjs` y se versionan. El script resuelve `sharp` desde la instalación existente del gestor de paquetes, en lugar de declararlo como dependencia separada del sitio. No se ejecuta en el build porque estas imágenes cambian pocas veces al año; genera tanto la fuente SVG como el PNG para cada idioma.

## `llms.txt` y rastreo

El sitio genera un índice `llms.txt` en la raíz inglesa y en cada idioma no predeterminado. Cada índice enumera las páginas localizadas, la documentación de comandos, las guías principales del repo, la versión actual del CLI y su requisito de Node.js; también enlaza a los recursos HTML y Markdown. Las alternativas Markdown se renderizan desde los mismos componentes Astro, conservan el contenido visible y agregan estados narrativos que la interfaz puede ocultar.

`llms.txt` es una ayuda opcional para que agentes descubran contenido. No reemplaza las páginas del sitio, no garantiza que un agente use ese contenido ni promete indexación o posicionamiento en buscadores. El sitio no ofrece un servidor MCP.

`robots.txt` conserva la política existente: permite el rastreo por defecto (`User-agent: *` / `Allow: /`) y enumera explícitamente los crawlers de IA con `Allow: /`. También anuncia el índice inglés `llms.txt` y el sitemap. En GitHub Pages de proyecto, el sitio vive bajo una ruta del repo, pero los crawlers consultan `robots.txt` en la raíz del dominio. Por eso esta política generada solo es autoritativa con dominio propio o en un sitio Pages publicado en la raíz del usuario.

## Tarjetas Open Graph

Ejecuta manualmente `node apps/website/scripts/gen-og.mjs` para regenerar las tarjetas versionadas. El script lee las cantidades publicadas desde `src/consts.ts` y la versión actual y el requisito de Node.js desde `packages/cli/package.json`. Para cada idioma escribe la fuente SVG junto al PNG: `og.svg`/`og.png`, `og-en.svg`/`og-en.png` y `og-zh-CN.svg`/`og-zh-CN.png`.

El generador resuelve `sharp` desde la instalación existente del gestor de paquetes, sin declararlo como dependencia separada del sitio. No forma parte del build porque los assets cambian con poca frecuencia. Si no encuentra `sharp`, termina con error en lugar de dejar PNGs desactualizados.

## Deploy

La GitHub Action `.github/workflows/deploy-website.yml` compila y publica a GitHub Pages en cada push a `main` que toque `apps/website/**`.

**Antes del primer deploy:** en `Settings → Pages` del repo, elige **Source: GitHub Actions**.

Si publicas bajo una ruta de proyecto (`<user>.github.io/<repo>/`), define estas repository variables:

- `SITE_URL` = `https://<user>.github.io`
- `SITE_BASE` = `/<repo>/`

Si es un sitio `<user>.github.io` en la raíz, conserva los valores por defecto.

## Diseño

- **Tipografía:** Instrument Serif para display, Geist Sans para texto y Geist Mono para código.
- **Paleta:** sky `#0EA5E9` y violet `#7C3AED` sobre marfil cálido `#FAFAF7`; el dark mode usa azul noche `#0A0E1A`.
- **Patrones:** hero dividido asimétrico con terminal animada solo con CSS, grid de fondo sutil y glows radiales sky→violet contenidos.
