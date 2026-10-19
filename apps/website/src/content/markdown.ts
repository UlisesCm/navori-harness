import { ui, type Lang } from "../i18n/ui";
import { locales, localeOrder } from "../i18n/locales";
import { commandDocs, commandOrder } from "./commands";
import { narratives } from "./narratives";
import { pageIds, pagePath, markdownPath, indexPath, type PageId } from "./pages";
import { primaryGuides, guideUrl } from "./guides";
import { INVENTORY, REPO_URL, NPM_URL } from "../consts";
import cliPkg from "../../../../packages/cli/package.json";
import projectConfig from "../../../../navori.config.json";

/** Decode entities emitted by Astro without changing technical command text. */
function decode(text: string): string {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match: string, value: string) =>
      String.fromCodePoint(
        value.charAt(0).toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value),
      ),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Convert the actual static main content, retaining paragraphs, links and examples. */
export function htmlMarkdown(html: string, canonical: string): string {
  const main = /<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/.exec(html)?.[1];
  if (!main) throw new Error("Canonical page rendered no main content");
  const examples: string[] = [];
  const destinations: string[] = [];
  const prose = main
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g, (_match: string, body: string) => {
      examples.push(decode(body.replace(/<[^>]*>/g, "")));
      return `\n\nEXAMPLE_TOKEN_${examples.length - 1}\n\n`;
    });
  return (
    decode(
      prose
        .replace(
          /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
          (_match: string, href: string, text: string): string => {
            destinations.push(new URL(decode(href), canonical).href);
            return `[${text.replace(/<[^>]*>/g, "").trim()}](LINK_TOKEN_${destinations.length - 1})`;
          },
        )
        .replace(
          /<h([1-6])\b[^>]*>/g,
          (_match: string, level: string) => `\n\n${"#".repeat(Number(level))} `,
        )
        .replace(/<li\b[^>]*>/g, "\n- ")
        .replace(/<\/(?:p|div|section|article|h[1-6]|ul|ol|details|summary)>/g, "\n\n")
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
      // Restore resolved URLs after entity decoding and before fenced examples: neither may rewrite them.
      .replace(
        /LINK_TOKEN_(\d+)/g,
        (_match: string, index: string): string => destinations[Number(index)]!,
      )
      .replace(
        /EXAMPLE_TOKEN_(\d+)/g,
        (_match: string, index: string) => `\`\`\`\n${examples[Number(index)]}\n\`\`\``,
      )
  );
}

/** Add every narrative state that an interactive panel can expose, from its HTML owner. */
export function interactiveMarkdown(lang: Lang, page: PageId): string {
  const t = ui[lang];
  if (page === "home") {
    const stops = Array.from({ length: 8 }, (_, index) => {
      const key = `graph.s${index + 1}` as "graph.s1";
      return `## ${t[`${key}.name`]}: ${t[`${key}.title`]}\n\n${t[`${key}.body`]}`;
    });
    const chips = Object.entries(t)
      .filter(([key]) => key.startsWith("graph.chip."))
      .map(([, value]) => value);
    return [
      ...stops,
      ...chips,
      t["graph.loop"],
      ...["core", "preset", "workspace", "project"].map(
        (layer) => t[`flow.${layer}.note` as "flow.core.note"],
      ),
    ].join("\n\n");
  }
  if (page === "deep-dive") {
    return [0, 4, 8, 12, 16, 20, 24, 28]
      .map((index) => {
        const role = narratives[`deep-dive.${index}` as "deep-dive.0"][lang];
        const detail = narratives[`deep-dive.${index + 3}` as "deep-dive.3"][lang];
        return `## ${role}\n\n${detail}`;
      })
      .join("\n\n");
  }
  return "";
}

/** A page alternative shares its rendered source and supplements hidden narrative states. */
export function pageMarkdown(
  lang: Lang,
  page: PageId,
  html: string,
  origin: string,
  base = "/",
): string {
  const canonical = new URL(pagePath(lang, page, base), origin).href;
  const description = decode(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "");
  return `[navori](${canonical}) · ${locales[lang].name}\n\n${description}\n\n${htmlMarkdown(html, canonical)}\n\n${interactiveMarkdown(lang, page)}\n`;
}

/** Curated locale index built from the same command, runtime and inventory authorities. */
export function llmsIndex(lang: Lang, origin: string, base = "/"): string {
  const t = ui[lang];
  const url = (path: string): string => new URL(path, origin).href;
  const facts = [
    `# navori — ${locales[lang].name}`,
    `> ${t["site.description"]}`,
    `v${cliPkg.version} · Node ${cliPkg.engines.node} · MIT`,
    Object.entries(INVENTORY)
      .map(([key, count]) => `${key}: ${count}`)
      .join(" · "),
    `[${t["nav.github"]}](${REPO_URL})`,
    `[npm](${NPM_URL}) · [JSON Schema](${projectConfig.$schema})`,
    `## ${t["nav.docs"]}`,
    ...pageIds
      .filter((page) => !page.startsWith("docs/"))
      .map(
        (page) =>
          `- [${page === "home" ? t["site.tagline"] : page === "deep-dive" ? t["nav.deepdive"] : page === "quickstart" ? t["nav.quickstart"] : t["nav.releases"]}](${url(markdownPath(lang, page, base))}) · [HTML](${url(pagePath(lang, page, base))})`,
      ),
    `## ${t["commands.eyebrow"]}`,
    ...commandOrder.map((id) => {
      const doc = commandDocs[lang][id];
      if (!doc) throw new Error(`Missing command translation: ${lang}/${id}`);
      return `- [navori ${id}](${url(markdownPath(lang, `docs/${id}`, base))}): ${doc.summary}`;
    }),
    `## ${t["nav.docs"]} — GitHub`,
    ...primaryGuides.map((path) => `- [${path}](${guideUrl(path, lang)})`),
    ...localeOrder.map(
      (locale: Lang): string =>
        `[${locales[locale].name} — llms.txt](${url(indexPath(locale, base))})`,
    ),
  ];
  return facts.join("\n\n") + "\n";
}
