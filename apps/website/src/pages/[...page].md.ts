import type { APIRoute } from "astro";
import { experimental_AstroContainer } from "astro/container";
import LandingPage from "../components/pages/LandingPage.astro";
import QuickstartPage from "../components/pages/QuickstartPage.astro";
import DeepDivePage from "../components/pages/DeepDivePage.astro";
import ReleasesPage from "../components/pages/ReleasesPage.astro";
import DocsLayout from "../layouts/DocsLayout.astro";
import CommandDocBody from "../components/CommandDocBody.astro";
import { canonicalPages, markdownPath, pagePath, type PageId } from "../content/pages";
import { pageMarkdown } from "../content/markdown";
import { commandDocs } from "../content/commands";
import type { Lang } from "../i18n/ui";

/** Generate one Markdown sibling for every canonical HTML topic. */
export function getStaticPaths() {
  return canonicalPages.map(({ lang, page }) => ({
    params: { page: markdownPath(lang, page).replace(/^\//, "").replace(/\.md$/, "") },
    props: { lang, page },
  }));
}

/** Render the same components rather than maintaining a parallel content summary. */
export const GET: APIRoute = async ({ props, site }) => {
  const { lang, page } = props as { lang: Lang; page: PageId };
  const request = new Request(new URL(pagePath(lang, page, import.meta.env.BASE_URL), site));
  const container = await experimental_AstroContainer.create();
  const component =
    page === "home"
      ? LandingPage
      : page === "quickstart"
        ? QuickstartPage
        : page === "deep-dive"
          ? DeepDivePage
          : ReleasesPage;
  let html: string;
  if (page.startsWith("docs/")) {
    const doc = commandDocs[lang][page.slice(5)];
    const body = await container.renderToString(CommandDocBody, { props: { doc, lang }, request });
    html = await container.renderToString(DocsLayout, {
      props: { lang, title: `navori ${doc.title}`, description: doc.summary, current: doc.id },
      slots: { default: body },
      request,
    });
  } else {
    html = await container.renderToString(component, { props: { lang }, request });
  }
  return new Response(pageMarkdown(lang, page, html, site!.href, import.meta.env.BASE_URL), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
