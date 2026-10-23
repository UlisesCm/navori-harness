import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../../..");
type Lang = "en" | "es" | "zh-CN";
type UIKey = string;
interface CommandDoc {
  summary: string;
  usage: string;
  flags: { flag: string; desc: string }[];
  example: { title: string; code: string }[];
  notes?: string[];
}
type LocalizedText = Record<Lang, string>;
interface ReleaseEntry {
  minor: string;
  headline: LocalizedText;
  bullets: LocalizedText[];
  patches?: { note: LocalizedText }[];
}

/**
 * Load the neighboring Astro package through its runtime entry rather than adding
 * it to the CLI build's rootDir. Assertions below verify these local contracts.
 */
async function websiteModule<T extends object>(path: string): Promise<T> {
  const location = pathToFileURL(resolve(root, "apps/website/src", path)).href;
  const loaded: unknown = await import(/* @vite-ignore */ location);
  if (typeof loaded !== "object" || loaded === null)
    throw new Error("Website module did not load: " + path);
  return loaded as T;
}
const { localeOrder, locales, localePath } = await websiteModule<{
  localeOrder: readonly Lang[];
  locales: Record<Lang, { name: string }>;
  localePath: (lang: Lang, path: string, base?: string) => string;
}>("i18n/locales.ts");
const { ui } = await websiteModule<{ ui: Record<Lang, Record<string, string>> }>("i18n/ui.ts");
const { sessionAnimation } = await websiteModule<{
  sessionAnimation: Record<
    Lang,
    {
      conversation: readonly { at: number; speaker: string; text: string }[];
      beats: readonly string[];
    }
  >;
}>("content/session-animation.ts");
const { useTranslations } = await websiteModule<{
  useTranslations: (lang: Lang) => (key: UIKey) => string;
}>("i18n/utils.ts");
const { commandDocs, commandOrder } = await websiteModule<{
  commandDocs: Record<Lang, Record<string, CommandDoc>>;
  commandOrder: readonly string[];
}>("content/commands.ts");
const { RELEASES } = await websiteModule<{ RELEASES: readonly ReleaseEntry[] }>(
  "content/releases.ts",
);
const { narratives, narrativeExamples } = await websiteModule<{
  narratives: Record<string, LocalizedText>;
  narrativeExamples: Record<string, readonly string[]>;
}>("content/narratives.ts");
const { pageFromPath, pagePath, markdownPath, legacyPages, pageIds, pageFragments } =
  await websiteModule<{
    pageFromPath: (path: string, base?: string) => string;
    pagePath: (lang: Lang, page: string, base?: string) => string;
    markdownPath: (lang: Lang, page: string, base?: string) => string;
    legacyPages: readonly object[];
    pageIds: readonly string[];
    pageFragments: Record<"home" | "deep-dive" | "quickstart" | "releases", readonly string[]>;
  }>("content/pages.ts");
const { htmlMarkdown, pageMarkdown, interactiveMarkdown, llmsIndex } = await websiteModule<{
  htmlMarkdown: (html: string, canonical: string) => string;
  pageMarkdown: (lang: Lang, page: string, html: string, origin: string, base?: string) => string;
  interactiveMarkdown: (lang: Lang, page: string) => string;
  llmsIndex: (lang: Lang, origin: string, base?: string) => string;
}>("content/markdown.ts");
const { INVENTORY } = await websiteModule<{ INVENTORY: { commands: number } }>("consts.ts");

const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
/** Compare executable lines; localized terminal output is intentionally different. */
const technicalLines = (code: string): string[] =>
  code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:\$\s*)?(?:npx|pnpm|bun|bunx|npm|node|git|navori|brew|acli|gh)\s/.test(line),
    );

describe("locale routing and navigation", () => {
  // Covers: R4, R6, R12
  it("keeps stable home fragments and both historical glossary targets on their section owners", () => {
    const owners = {
      anatomy: "HarnessGraph",
      problem: "Problem",
      scopes: "Scopes",
      "how-it-works": "Layers",
      commands: "Commands",
      engines: "Engines",
      quickstart: "Quickstart",
      faq: "FAQ",
    };
    expect(pageFragments.home).toEqual(Object.keys(owners));
    for (const [id, owner] of Object.entries(owners)) {
      expect(read("apps/website/src/components/sections/" + owner + ".astro")).toContain(
        'id="' + id + '"',
      );
    }
    expect(pageFragments["deep-dive"]).toEqual([
      "glossary",
      "diccionario",
      "agent-detail-role",
      "agent-detail-model",
      "agent-detail-body",
    ]);
    const deep = read("apps/website/src/components/pages/DeepDivePage.astro");
    for (const id of pageFragments["deep-dive"]) expect(deep).toContain('id="' + id + '"');
    expect(read("apps/website/scripts/check-i18n.ts")).toContain(
      "checkFragments(html, topic, path)",
    );
  });
  // Covers: R2, R4, R6
  it("uses English root and equivalent topics across locales and project bases", () => {
    expect(localeOrder).toEqual(["en", "es", "zh-CN"]);
    expect(localePath("en", "/")).toBe("/");
    expect(localePath("es", "/")).toBe("/es/");
    expect(localePath("zh-CN", "/")).toBe("/zh-cn/");
    for (const base of ["/", "/navori-harness/"])
      for (const lang of localeOrder)
        for (const page of pageIds) {
          const path = pagePath(lang, page, base);
          expect(pageFromPath(path, base)).toBe(page);
          expect(markdownPath(lang, page, base)).toContain(
            page === "home" ? "index.md" : page + ".md",
          );
        }
    expect(pageFromPath("/navori-harness/en/deep-dive", "/navori-harness/")).toBe("deep-dive");
    expect(pageFromPath("/versiones")).toBe("releases");
    expect(legacyPages).toHaveLength(pageIds.length + 1);
    expect(() => pageFromPath("/unknown")).toThrow("Unknown public page");
  });

  // Covers: R4, R12
  it("ships accessible native-name links with topic identity and progressive fragment support", () => {
    const header = read("apps/website/src/components/Header.astro");
    expect(Object.values(locales).map((lang) => lang.name)).toEqual([
      "English",
      "Español",
      "简体中文",
    ]);
    expect(header).toContain("pagePath(locale, page,");
    expect(header).toContain('aria-label={t("lang.label")}');
    expect(header).toContain("data-language-link");
    expect(header).toContain("window.location.hash");
    expect(header).toContain("getElementById");
    expect(header).toContain("flex-wrap");
    const style = read("apps/website/src/styles/global.css");
    expect(style).toContain(":lang(zh-CN)");
    expect(style).toContain("Microsoft YaHei");
  });

  // Covers: R5, R6
  it("separates canonical page metadata from static compatibility documents", () => {
    const layout = read("apps/website/src/layouts/BaseLayout.astro");
    expect(layout).toContain('hreflang="x-default" href={alternates[0].href}');
    expect(layout).toContain('rel="describedby"');
    expect(layout).toContain('rel="alternate" type="text/markdown" href={markdownUrl}');
    const alias = read("apps/website/src/components/LegacyRedirect.astro");
    expect(alias).toContain('content="noindex, follow"');
    expect(alias).toContain('http-equiv="refresh"');
    expect(alias).toContain("location.hash");
    expect(alias).not.toContain("301");
  });
});

describe("complete locale content", () => {
  // Covers: R3, R11
  it("requires every locale key and preserves command flags, usage and examples", () => {
    const registry = read("packages/cli/src/cli.ts").match(
      /subCommands:\s*\{([\s\S]*?)\n\s*\},/,
    )?.[1];
    expect(registry).toBeDefined();
    const registered = [...registry!.matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((match) => match[1]);
    expect([...commandOrder].sort()).toEqual(registered.sort());
    for (const lang of localeOrder) {
      expect(Object.keys(ui[lang]).sort()).toEqual(Object.keys(ui.en).sort());
      expect(Object.values(ui[lang]).every((value) => value.trim().length > 0)).toBe(true);
      expect(Object.keys(commandDocs[lang]).sort()).toEqual([...commandOrder].sort());
      for (const id of commandOrder) {
        const doc = commandDocs[lang][id]!;
        expect(doc.summary.trim().length).toBeGreaterThan(5);
        expect(doc.usage).toContain("navori " + id);
        expect(doc.flags.flatMap((flag) => flag.flag.match(/--[\w-]+/g) ?? [])).toEqual(
          commandDocs.en[id]!.flags.flatMap((flag) => flag.flag.match(/--[\w-]+/g) ?? []),
        );
        expect(doc.flags.every((flag) => flag.desc.trim().length > 0)).toBe(true);
        expect(doc.example.length).toBe(commandDocs.en[id]!.example.length);
        expect(doc.example.every((example) => example.code.trim().length > 0)).toBe(true);
        // Existing Spanish samples have localized fixture names; new Chinese samples retain English commands verbatim.
        if (lang === "zh-CN") {
          expect(doc.usage).toBe(commandDocs.en[id]!.usage);
          expect(doc.flags.map((flag) => flag.flag)).toEqual(
            commandDocs.en[id]!.flags.map((flag) => flag.flag),
          );
          expect(doc.example.map((example) => technicalLines(example.code))).toEqual(
            commandDocs.en[id]!.example.map((example) => technicalLines(example.code)),
          );
        }
        expect(doc.notes?.length ?? 0).toBe(commandDocs.en[id]!.notes?.length ?? 0);
      }
      for (const text of Object.values(narratives)) expect(text[lang].length).toBeGreaterThan(0);
      for (const release of RELEASES) {
        for (const text of [
          release.headline,
          ...release.bullets,
          ...(release.patches ?? []).map((patch) => patch.note),
        ])
          expect(text[lang].length).toBeGreaterThan(0);
      }
    }
    expect(() => useTranslations("en")("missing" as UIKey)).toThrow("Missing UI translation");
    expect(ui["zh-CN"]["site.tagline"]).toMatch(/[\u3400-\u9fff]/);
  });
});

describe("agent content completeness", () => {
  // Covers: R7
  it("indexes every registered command and uses current package and inventory facts at either base", () => {
    for (const lang of localeOrder)
      for (const base of ["/", "/navori-harness/"]) {
        const index = llmsIndex(lang, "https://example.test", base);
        expect(index).toContain(pkg.version);
        expect(index).toContain(pkg.engines.node);
        expect(index).toContain("commands: " + INVENTORY.commands);
        for (const id of commandOrder)
          expect(index).toContain("https://example.test" + markdownPath(lang, "docs/" + id, base));
        for (const path of ["llms.txt", "es/llms.txt", "zh-cn/llms.txt"])
          expect(index).toContain("https://example.test" + base + path);
        expect(index).toContain("https://github.com/UlisesCm/navori-harness");
        expect(index).toContain("https://www.npmjs.com/package/" + pkg.name);
        const config = JSON.parse(read("navori.config.json")) as { $schema: string };
        expect(index).toContain(config.$schema);
        expect(index).not.toContain("undefined");
      }
  });

  // Covers: R8
  it("exports every animated conversation message and beat, all role details and each layer note", () => {
    for (const lang of localeOrder) {
      const home = interactiveMarkdown(lang, "home");
      expect(sessionAnimation[lang].conversation).toHaveLength(7);
      for (const line of sessionAnimation[lang].conversation) expect(home).toContain(line.text);
      for (const beat of sessionAnimation[lang].beats) expect(home).toContain(beat);
      for (const layer of ["core", "preset", "workspace", "project"])
        expect(home).toContain(ui[lang][("flow." + layer + ".note") as "flow.core.note"]);
      const deep = interactiveMarkdown(lang, "deep-dive");
      for (const index of [3, 7, 11, 15, 19, 23, 27, 31])
        expect(deep).toContain(narratives[("deep-dive." + index) as "deep-dive.3"]![lang]);
    }
    expect(narrativeExamples["deep-dive"]!.some((code) => code.includes("navori workspace"))).toBe(
      true,
    );
    expect(read("apps/website/src/pages/[...page].md.ts")).toContain("container.renderToString");
  });

  // Covers: R7, R8, R12
  it.each(["/", "/navori-harness/"])(
    "exports absolute links against each canonical at base %s",
    (base: string) => {
      for (const lang of localeOrder) {
        const prefix = lang === "en" ? "" : lang === "es" ? "es/" : "zh-cn/";
        const rootUrl = "https://example.test" + base + prefix;
        const canonical = rootUrl + "deep-dive";
        const html = `<main><h1>Guide</h1><p>
        <a href="${base + prefix}docs/init?mode=a&amp;b=2#usage">root</a>
        <a href="quickstart?mode=fast#intro">relative</a>
        <a href="?view=all#glossary">query</a><a href="#diccionario">fragment</a>
        <a href="https://outside.test/x?one=1&amp;two=2#three">external</a>
        <a href="https://outside.test/?literal=&amp;amp;">entity</a>
        <a href="//cdn.test/guide#topic">network</a>
        <a href="mailto:agent@example.test?subject=Hello">mail</a>
        <a href="tel:+525555555555">phone</a><a href="urn:isbn:1234">URN</a></p>
        <pre>[example](/docs/init)\n  git clone &lt;repo&gt;</pre></main>`;
        const converted = pageMarkdown(lang, "deep-dive", html, "https://example.test", base);
        for (const target of [
          rootUrl + "docs/init?mode=a&b=2#usage",
          rootUrl + "quickstart?mode=fast#intro",
          canonical + "?view=all#glossary",
          canonical + "#diccionario",
          "https://outside.test/x?one=1&two=2#three",
          "https://outside.test/?literal=&amp;",
          "https://cdn.test/guide#topic",
          "mailto:agent@example.test?subject=Hello",
          "tel:+525555555555",
          "urn:isbn:1234",
        ])
          expect(converted).toContain("](" + target + ")");
        expect(converted).toContain("```\n[example](/docs/init)\n  git clone <repo>\n```");
        const nested = htmlMarkdown(
          '<main><a href="init?level=1#options">command</a><a href="../quickstart#intro">guide</a></main>',
          rootUrl + "docs/render",
        );
        expect(nested).toContain("](" + rootUrl + "docs/init?level=1#options)");
        expect(nested).toContain("](" + rootUrl + "quickstart#intro)");
      }
    },
  );

  // Covers: R8
  it("retains technical whitespace and angle-bracket examples while removing scripts", () => {
    const converted = htmlMarkdown(
      '<main><h1>Title</h1><p>Read <a href="/docs/init">init</a>.</p><pre>git clone &lt;repo&gt;\n  node --version</pre><script>secretScript()</script></main>',
      "https://example.test/deep-dive",
    );
    expect(converted).toContain("git clone <repo>\n  node --version");
    expect(converted).toContain("[init](https://example.test/docs/init)");
    expect(converted).not.toContain("secretScript");
    expect(() => htmlMarkdown("<div>empty</div>", "https://example.test/")).toThrow("no main");
  });

  // Covers: R9
  it("publishes intentional trilingual cards with authoritative runtime and product facts", () => {
    for (const [name, tagline] of [
      ["og-en", "The multi-agent harness"],
      ["og", "El harness multi-agente"],
      ["og-zh-CN", "多智能体 harness"],
    ]) {
      const svg = read("apps/website/public/" + name + ".svg");
      expect(svg).toContain(tagline);
      expect(svg).toContain(pkg.version);
      expect(svg).toContain(pkg.engines.node.replace(/>/g, "&gt;"));
      expect(svg).not.toContain("5 ENGINES");
      expect(
        readFileSync(resolve(root, "apps/website/public/" + name + ".png"))
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
    }
  });

  // Covers: R11
  it("preserves the existing robots policy without expanding crawler or training access", () => {
    const path = "apps/website/src/pages/robots.txt.ts";
    const previous = execFileSync("git", ["show", "HEAD:" + path], { cwd: root, encoding: "utf8" });
    expect(read(path)).toBe(previous);
  });
});
