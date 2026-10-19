import type { APIRoute } from "astro";
import { llmsIndex } from "../../content/markdown";
import { locales } from "../../i18n/locales";

/** Canonical non-default locale indexes; English lives at the root. */
export function getStaticPaths() {
  return (["es", "zh-CN"] as const).map((lang) => ({
    params: { locale: locales[lang].prefix },
    props: { lang },
  }));
}
export const GET: APIRoute = ({ props, site }) =>
  new Response(llmsIndex(props.lang, site!.href, import.meta.env.BASE_URL), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
