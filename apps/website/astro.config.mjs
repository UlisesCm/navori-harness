// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// Production site. Override via env when deploying behind a project path.
const SITE = process.env.SITE_URL ?? "https://navori.github.io";
const BASE = process.env.SITE_BASE ?? "/";

export default defineConfig({
  site: SITE,
  base: BASE,
  // Astro 7 defaults to "jsx" and strips whitespace between inline elements; keep the 5.x output.
  compressHTML: true,
  trailingSlash: "ignore",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es", "zh-cn"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    sitemap({
      filter: (page) =>
        !/\/en(?:\/|$)|\/versiones\/?$/.test(new URL(page).pathname) &&
        !page.endsWith(".md") &&
        !page.endsWith(".txt"),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
