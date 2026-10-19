import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandDocs } from "../src/content/commands";
import { narratives, narrativeExamples } from "../src/content/narratives";
import { ui } from "../src/i18n/ui";
import { INVENTORY } from "../src/consts";
import { pageFragments } from "../src/content/pages";
import { RELEASES } from "../src/content/releases";
import pkg from "../../../packages/cli/package.json";
import projectConfig from "../../../navori.config.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = resolve(root, "apps/website/dist");
const origin = process.env.SITE_URL ?? "https://navori.github.io";
const base = ("/" + (process.env.SITE_BASE ?? "/").split("/").filter(Boolean).join("/")).replace(
  /\/$/,
  "",
);
const langs = ["en", "es", "zh-CN"] as const;
const prefixes = { en: "", es: "es", "zh-CN": "zh-cn" };
const registry = readFileSync(resolve(root, "packages/cli/src/cli.ts"), "utf8").match(
  /subCommands:\s*\{([\s\S]*?)\n\s*\},/,
)?.[1];
assert.ok(registry, "CLI command registry must be independently readable");
const commands = [...registry.matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((match) => match[1]!);
assert.equal(
  commands.length,
  29,
  "Update the expected inventory intentionally when adding commands",
);
const topics = ["", "quickstart", "deep-dive", "releases", ...commands.map((id) => "docs/" + id)];
const canonical = new Set<string>();
const expectedAgentArtifacts = new Set<string>();
const repository = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const guides = [
  "README.md",
  "CONTRIBUTING.md",
  "packages/cli/README.md",
  "packages/cli/src/engines/README.md",
  "apps/website/README.md",
  "docs/DIRECTION.md",
  "docs/EXTENDING.md",
  "docs/architecture.md",
  "docs/pi.md",
  "docs/recipes/model-tiering.md",
  "docs/recipes/setup-proveedores-externos.md",
  "docs/recipes/skill-authoring.md",
  "docs/references/skills-security-quality.md",
  "docs/runbook-curacion-engram.md",
];
const normalized = (value: string): string => value.replace(/\s+/g, " ").trim();
const url = (path: string): string => new URL(path, origin).href;
const route = (lang: (typeof langs)[number], topic: string): string =>
  base + "/" + (prefixes[lang] ? prefixes[lang] + "/" : "") + topic;

/** Parse the small static attribute grammar emitted by Astro, independently of page owners. */
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
      match[1]!,
      match[2]!.replace(/&amp;/g, "&"),
    ]),
  );
}

/** Domain-local paths must resolve to an actual generated resource under the configured base. */
function artifact(href: string): string {
  const target = new URL(href, origin);
  assert.equal(target.origin, new URL(origin).origin);
  assert.ok(target.pathname.startsWith(base + "/"), "Base escape: " + href);
  const local = decodeURIComponent(target.pathname.slice(base.length)).replace(/^\//, "");
  return resolve(
    dist,
    /\.[a-z0-9]+$/i.test(local)
      ? local
      : local
        ? local.replace(/\/$/, "") + "/index.html"
        : "index.html",
  );
}

/** Check a resolved local resource and its HTML fragment. */
function checkLocalTarget(target: URL): void {
  if (target.origin !== new URL(origin).origin) return;
  const file = artifact(target.href);
  assert.ok(existsSync(file), "Missing local target " + target.href);
  if (target.hash && file.endsWith(".html")) {
    assert.ok(
      readFileSync(file, "utf8").includes('id="' + decodeURIComponent(target.hash.slice(1)) + '"'),
      "Missing fragment " + target.href,
    );
  }
}

/** Check local resources and fragment targets in an emitted document. */
function checkTargets(html: string, current: string): void {
  for (const match of html.matchAll(/<(?:a|link)\b[^>]*href="([^"]+)"/g))
    checkLocalTarget(new URL(match[1]!.replace(/&amp;/g, "&"), url(current)));
}

/** Inspect published Markdown links, excluding literal executable examples. */
function checkMarkdownTargets(markdown: string): Set<string> {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");
  const links = new Set<string>();
  for (const match of prose.matchAll(/\]\(([^)\n]+)\)/g)) {
    const href = match[1]!;
    assert.ok(URL.canParse(href), "Agent link is not absolute: " + href);
    const target = new URL(href);
    checkLocalTarget(target);
    const repositoryUrl = new URL(repository);
    const blobPrefix = repositoryUrl.pathname + "/blob/main/";
    if (target.origin === repositoryUrl.origin && target.pathname.startsWith(blobPrefix))
      assert.ok(
        existsSync(resolve(root, decodeURIComponent(target.pathname.slice(blobPrefix.length)))),
        "Missing repository guide: " + href,
      );
    links.add(href);
  }
  return links;
}

/** Enumerate real agent outputs so missing and extra resources cannot hide behind source manifests. */
function agentArtifacts(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...agentArtifacts(path));
    else if (entry.name.endsWith(".md") || entry.name === "llms.txt") files.push(path);
  }
  return files;
}

/** Every supported fragment, including historical aliases, must have a unique rendered destination. */
function checkFragments(html: string, topic: string, location: string): void {
  const page = topic === "" ? "home" : topic;
  const entry = Object.entries(pageFragments).find(([identity]) => identity === page);
  if (!entry) return; // Command references declare no fragment contract.
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  for (const fragment of entry[1]) {
    assert.equal(
      ids.filter((id) => id === fragment).length,
      1,
      "Missing or duplicate declared fragment " + location + "#" + fragment,
    );
  }
}

// Covers: R2, R3, R4, R5, R7, R8, R9, R12
for (const lang of langs) {
  const indexFile = artifact(url(route(lang, "llms.txt")));
  expectedAgentArtifacts.add(indexFile);
  const index = readFileSync(indexFile, "utf8");
  assert.ok(
    index.includes(pkg.version) && index.includes(pkg.engines.node),
    "Index must use current runtime/version",
  );
  const expectedIndexLinks = new Set([
    repository,
    "https://www.npmjs.com/package/" + pkg.name,
    projectConfig.$schema,
    ...langs.map((other: (typeof langs)[number]): string => url(route(other, "llms.txt"))),
    ...topics.flatMap((topic: string): string[] => {
      const markdown = url(route(lang, topic ? topic + ".md" : "index.md"));
      return topic.startsWith("docs/") ? [markdown] : [markdown, url(route(lang, topic))];
    }),
    ...guides.map(
      (path: string): string =>
        repository +
        "/blob/main/" +
        (lang === "en" ? path : path.replace(/\.md$/, "." + lang + ".md")),
    ),
  ]);
  assert.deepEqual(
    checkMarkdownTargets(index),
    expectedIndexLinks,
    "Curated discovery inventory " + lang,
  );
  assert.ok(
    existsSync(resolve(dist, "schema/navori.config.v1.json")),
    "Official config schema must be published",
  );
  for (const topic of topics) {
    const path = route(lang, topic);
    const html = readFileSync(artifact(url(path)), "utf8");
    checkFragments(html, topic, path);
    const tags = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => attributes(match[0]));
    assert.equal(tags.find((tag) => tag.rel === "canonical")?.href, url(path), "Canonical " + path);
    canonical.add(url(path).replace(/\/$/, ""));
    assert.ok(html.includes('<html lang="' + lang + '"'), "HTML language " + path);
    assert.ok(!html.includes(">undefined<") && !html.includes('content="undefined"'));
    for (const other of langs)
      assert.ok(
        tags.some((tag) => tag.hreflang === other && tag.href === url(route(other, topic))),
        "hreflang " + path + "/" + other,
      );
    assert.ok(
      tags.some((tag) => tag.hreflang === "x-default" && tag.href === url(route("en", topic))),
      "English x-default " + path,
    );
    const nav = [...html.matchAll(/<a\b[^>]*data-language-link[^>]*>/g)].map((match) =>
      attributes(match[0]),
    );
    assert.equal(nav.length, 3, "Static language links " + path);
    for (const other of langs)
      assert.ok(nav.some((tag) => tag.hreflang === other && tag.href === route(other, topic)));
    const mdPath = route(lang, topic ? topic + ".md" : "index.md");
    assert.ok(
      tags.some(
        (tag) =>
          tag.rel === "alternate" && tag.type === "text/markdown" && tag.href === url(mdPath),
      ),
    );
    assert.ok(
      tags.some((tag) => tag.rel === "describedby" && tag.href === url(route(lang, "llms.txt"))),
    );
    const markdown = readFileSync(artifact(url(mdPath)), "utf8");
    expectedAgentArtifacts.add(artifact(url(mdPath)));
    const markdownLinks = checkMarkdownTargets(markdown);
    assert.ok(markdown.includes(url(path)) && index.includes(url(mdPath)));
    const main = /<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/.exec(html)?.[1];
    assert.ok(main, "Missing visible source main " + path);
    for (const match of main.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      const target = new URL(match[1]!.replace(/&amp;/g, "&"), url(path)).href;
      assert.ok(markdownLinks.has(target), "Visible link omitted from " + mdPath + ": " + target);
    }
    if (topic.startsWith("docs/")) {
      const doc = commandDocs[lang][topic.slice(5)]!;
      for (const value of [
        doc.summary,
        doc.usage,
        ...doc.flags.map((flag) => flag.desc),
        ...doc.example.flatMap((example) => [example.title, example.code]),
        ...(doc.notes ?? []),
      ]) {
        assert.ok(
          normalized(markdown).includes(normalized(value)),
          "Agent source omitted from " + mdPath + ": " + value.slice(0, 60),
        );
      }
    }
    if (topic === "deep-dive" || topic === "quickstart") {
      for (const [key, text] of Object.entries(narratives).filter(([key]) =>
        key.startsWith(topic + "."),
      )) {
        assert.ok(
          normalized(markdown).includes(normalized(text[lang])),
          "Narrative source omitted from " + mdPath + ": " + key,
        );
      }
      for (const example of narrativeExamples[topic])
        assert.ok(markdown.includes(example), "Technical example changed in " + mdPath);
    }
    if (!topic) {
      for (let stop = 1; stop <= 8; stop++) {
        for (const field of ["name", "title", "body"] as const) {
          const key = ("graph.s" + stop + "." + field) as "graph.s1.body";
          assert.ok(
            markdown.includes(ui[lang][key]),
            "Missing walkthrough source " + key + "/" + lang,
          );
        }
      }
      for (const [key, text] of Object.entries(ui[lang]))
        if (
          key.startsWith("graph.chip.") ||
          key === "graph.loop" ||
          /^flow\.(?:core|preset|workspace|project)\.note$/.test(key)
        )
          assert.ok(markdown.includes(text), "Missing interactive source " + key + "/" + lang);
    }
    if (topic === "releases")
      for (const release of RELEASES) {
        const texts = [release.headline, ...release.bullets];
        for (const patch of release.patches ?? []) texts.push(patch.note);
        for (const text of texts)
          assert.ok(
            normalized(markdown).includes(normalized(text[lang])),
            "Release source omitted from " + mdPath,
          );
      }
    checkTargets(html, path);
  }
  const image = lang === "en" ? "og-en" : lang === "es" ? "og" : "og-zh-CN";
  const svg = readFileSync(resolve(dist, image + ".svg"), "utf8");
  assert.ok(svg.includes(pkg.version) && svg.includes(pkg.engines.node.replace(/>/g, "&gt;")));
  assert.ok(svg.includes(String(INVENTORY.commands)) && svg.includes(String(INVENTORY.engines)));
  assert.ok(existsSync(resolve(dist, image + ".png")));
}

assert.deepEqual(
  new Set(agentArtifacts(dist)),
  expectedAgentArtifacts,
  "Exactly99 Markdown alternatives and3 curated indexes must be emitted",
);

// Covers: R6
for (const topic of topics) {
  const html = readFileSync(artifact(url(base + "/en/" + topic)), "utf8");
  assert.ok(html.includes('href="' + url(route("en", topic)) + '"'));
  assert.ok(html.includes('href="' + route("en", topic) + '"'));
  assert.ok(html.includes("noindex, follow") && html.includes("location.hash"));
  checkFragments(
    readFileSync(artifact(url(route("en", topic))), "utf8"),
    topic,
    base + "/en/" + topic,
  );
}
assert.ok(
  readFileSync(artifact(url(base + "/versiones")), "utf8").includes(
    'href="' + route("es", "releases") + '"',
  ),
);

// Covers: R5
const sitemap = readdirSync(dist)
  .filter((name) => /^sitemap-\d+\.xml$/.test(name))
  .map((name) => readFileSync(resolve(dist, name), "utf8"))
  .join("");
const published = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
  match[1]!.replace(/\/$/, ""),
);
assert.deepEqual(
  new Set(published),
  canonical,
  "Sitemap must contain exactly canonical HTML pages",
);
process.stdout.write(
  "i18n artifacts: " +
    canonical.size +
    " HTML pages and Markdown alternatives, 3 indexes; aliases, source coverage and targets valid at " +
    (base || "/") +
    "\n",
);
