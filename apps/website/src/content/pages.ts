import { commandOrder } from "./commands";
import { locales, localeOrder, localePath, type Locale } from "../i18n/locales";

/** Canonical page identity is independent of URL prefix and language. */
export const pageIds = [
  "home",
  "quickstart",
  "deep-dive",
  "releases",
  ...commandOrder.map((id) => `docs/${id}` as const),
] as const;
export type PageId = (typeof pageIds)[number];

/** Translate page identity to its canonical topic path. */
export function topicPath(page: PageId): string {
  return page === "home" ? "/" : `/${page}`;
}

/** One canonical location per topic and language, including project base. */
export function pagePath(locale: Locale, page: PageId, base = "/"): string {
  return localePath(locale, topicPath(page), base);
}

/** Resolve a current URL including legacy English prefixes to a known topic. */
export function pageFromPath(pathname: string, base = "/"): PageId {
  const root = base.replace(/\/$/, "");
  const stripped = root && pathname.startsWith(`${root}/`) ? pathname.slice(root.length) : pathname;
  const topic = stripped.replace(/^\/(?:en|es|zh-cn)(?=\/|$)/, "").replace(/^\/|\/$/g, "");
  if (!topic) return "home";
  if (topic === "versiones") return "releases";
  const found = pageIds.find((page) => page === topic);
  if (!found) throw new Error(`Unknown public page: ${pathname}`);
  return found;
}

/** Canonical routes drive navigation, metadata and static exports. */
export const canonicalPages = localeOrder.flatMap((lang) =>
  pageIds.map((page) => ({ lang, page })),
);

/** Explicit static compatibility inventory, excluded from the sitemap. */
export const legacyPages = [
  ...pageIds.map((page) => ({
    path: `en/${page === "home" ? "" : page}`,
    lang: "en" as const,
    page,
  })),
  { path: "versiones", lang: "es" as const, page: "releases" as const },
];

/** Supported semantic fragments shared across the locale editions. */
export const pageFragments = {
  home: [
    "anatomy",
    "problem",
    "scopes",
    "how-it-works",
    "commands",
    "engines",
    "quickstart",
    "faq",
  ],
  "deep-dive": [
    "glossary",
    "diccionario",
    "agent-detail-role",
    "agent-detail-model",
    "agent-detail-body",
  ],
  quickstart: [],
  releases: [],
} as const;

/** Markdown resources are siblings of HTML topics; the landing uses index.md. */
export function markdownPath(lang: Locale, page: PageId, base = "/"): string {
  return localePath(lang, page === "home" ? "/index.md" : `/${page}.md`, base);
}

/** Localized llms.txt indexes describe rather than replace page alternatives. */
export function indexPath(lang: Locale, base = "/"): string {
  return localePath(lang, "/llms.txt", base);
}

/** Native names are used for language controls and reader-facing indexes. */
export const languageNames = Object.fromEntries(
  localeOrder.map((lang) => [lang, locales[lang].name]),
);
