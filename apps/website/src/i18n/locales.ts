/** Public locale metadata; route casing and language tags are deliberately distinct. */
export const locales = {
  en: { name: "English", prefix: "", html: "en", og: "en_US", image: "og-en.png" },
  es: { name: "Español", prefix: "es", html: "es", og: "es_MX", image: "og.png" },
  "zh-CN": { name: "简体中文", prefix: "zh-cn", html: "zh-CN", og: "zh_CN", image: "og-zh-CN.png" },
} as const;

/** The publishing order is English, Spanish, then Simplified Chinese. */
export const localeOrder = ["en", "es", "zh-CN"] as const;
export type Locale = keyof typeof locales;

/** Build a locale URL without relying on runtime locale negotiation. */
export function localePath(locale: Locale, path = "/", base = "/"): string {
  const root = `/${base.split("/").filter(Boolean).join("/")}`.replace(/\/$/, "");
  const topic = path.replace(/^\//, "").replace(/^versiones(?=\/|#|$)/, "releases");
  const prefix = locales[locale].prefix;
  return `${root}/${prefix ? `${prefix}/` : ""}${topic}`;
}
