import { ui, type Lang, type UIKey } from "./ui";
import { localePath } from "./locales";

/** Identify a canonical locale after removing the configured project base. */
export function getLangFromUrl(url: URL): Lang {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path =
    base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
  if (/^\/es(?:\/|$)/.test(path)) return "es";
  if (/^\/zh-cn(?:\/|$)/.test(path)) return "zh-CN";
  return "en";
}

/** Read a required translation; missing values are build errors, never fallbacks. */
export function useTranslations(lang: Lang): (key: UIKey) => string {
  return (key: UIKey): string => {
    const value = ui[lang][key];
    if (!value) throw new Error(`Missing UI translation: ${lang}/${key}`);
    return value;
  };
}

/**
 * Build a localized URL that respects Astro's `base` config and i18n routing.
 * Always use this for internal links — a literal `href="/foo"` will 404 when
 * the site is served from a subpath (e.g. GitHub project Pages).
 */
export function localizedPath(lang: Lang, path: string): string {
  return localePath(lang, path, import.meta.env.BASE_URL);
}
