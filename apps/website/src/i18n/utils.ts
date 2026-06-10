import { getRelativeLocaleUrl } from "astro:i18n";
import { ui, defaultLang, type Lang, type UIKey } from "./ui";

export function getLangFromUrl(url: URL): Lang {
  // Strip Astro base so `/navori-harness/en/foo` parses the same as `/en/foo`.
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const stripped = base && url.pathname.startsWith(base)
    ? url.pathname.slice(base.length)
    : url.pathname;
  const [, maybeLang] = stripped.split("/");
  if (maybeLang === "en") return "en";
  return defaultLang;
}

export function useTranslations(lang: Lang) {
  return function t(key: UIKey): string {
    return ui[lang][key] ?? ui[defaultLang][key];
  };
}

/**
 * Build a localized URL that respects Astro's `base` config and i18n routing.
 * Always use this for internal links — a literal `href="/foo"` will 404 when
 * the site is served from a subpath (e.g. GitHub project Pages).
 */
export function localizedPath(lang: Lang, path: string): string {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return getRelativeLocaleUrl(lang, clean);
}

export function alternateLang(lang: Lang): Lang {
  return lang === "es" ? "en" : "es";
}
