import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pkg from "../../package.json";

const root = resolve(import.meta.dirname, "../../../..");
type Lang = "en" | "es" | "zh-CN";
const guideModule: unknown = await import(
  /* @vite-ignore */ new URL("../../../../apps/website/src/content/guides.ts", import.meta.url).href
);
const { guidePath, guideUrl, primaryGuides } = guideModule as {
  guidePath: (path: string, lang: Lang) => string;
  guideUrl: (path: string, lang: Lang) => string;
  primaryGuides: readonly string[];
};

const editions = ["en", "es", "zh-CN"] as const;
const repository = new URL(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
const inventory = new Map<string, { family: string; lang: Lang }>();
for (const family of primaryGuides)
  for (const lang of editions) inventory.set(guidePath(family, lang), { family, lang });
const nativeNames: Record<Lang, string> = { en: "English", es: "Español", "zh-CN": "简体中文" };
const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
interface LinkMismatch {
  source: string;
  line: number;
  target: string;
  expected: string;
}

/** Resolve relative and canonical repository URLs without discarding queries or fragments. */
function guideTarget(href: string, source: string): { path: string; suffix: string } | undefined {
  const target = new URL(href, pathToFileURL(resolve(root, source)));
  let file: string;
  if (target.protocol === "file:") file = fileURLToPath(target);
  else {
    const prefix = repository.pathname + "/blob/main/";
    if (target.origin !== repository.origin || !target.pathname.startsWith(prefix)) return;
    file = resolve(root, decodeURIComponent(target.pathname.slice(prefix.length)));
  }
  return { path: relative(root, file).split(sep).join("/"), suffix: target.search + target.hash };
}

/** Only a complete native-name selector for this same guide is exempt from body-link parity. */
function languageBar(line: string, source: string): boolean {
  const links = [...line.matchAll(linkPattern)];
  if (links.length !== 3 || line.replace(linkPattern, "").replace(/[|>\s]/g, "")) return false;
  const family = inventory.get(source)?.family;
  if (!family) return false;
  for (const lang of editions) {
    const link = links.find((match: RegExpMatchArray): boolean => match[1] === nativeNames[lang]);
    if (!link || guideTarget(link[2]!, source)?.path !== guidePath(family, lang)) return false;
  }
  return true;
}

/** Report every cross-language primary link, retaining original line numbers and URL suffixes. */
function mismatchedLinks(source: string, lang: Lang, text: string): LinkMismatch[] {
  const mismatches: LinkMismatch[] = [];
  let fence: { marker: string; width: number } | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.width &&
        !delimiter[2]!.trim()
      )
        fence = undefined;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1]![0]!, width: delimiter[1]!.length };
      continue;
    }
    if (languageBar(line, source)) continue;
    for (const match of line.matchAll(linkPattern)) {
      const target = guideTarget(match[2]!, source);
      const edition = target && inventory.get(target.path);
      if (edition && edition.lang !== lang)
        mismatches.push({
          source,
          line: index + 1,
          target: match[2]!,
          expected: guidePath(edition.family, lang) + target!.suffix,
        });
    }
  }
  return mismatches;
}

/** Count content sections rather than accepting summary-only translation stubs. */
function sections(source: string): number {
  return [...source.matchAll(/^#{1,6}\s+\S/gm)].length;
}

/** Commands remain executable while prose and comments can be translated. */
function commands(source: string): string[] {
  const examples = [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(
    (match) => match[1] ?? "",
  );
  return examples
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:\$ ?)?(?:npx|pnpm|bun|bunx|npm|node|git|navori|acli|gh|brew|pip|uv|python|curl)\s/.test(
        line,
      ),
    );
}

describe("primary guide parity and links", () => {
  // Covers: R1, R10, R11
  it("keeps in-body primary-guide links in the language of all42 editions", () => {
    const mismatches: LinkMismatch[] = [];
    expect(inventory.size).toBe(42);
    for (const [path, edition] of inventory)
      mismatches.push(
        ...mismatchedLinks(path, edition.lang, readFileSync(resolve(root, path), "utf8")),
      );
    expect(mismatches).toEqual([]);
  });

  // Covers: R10
  it("normalizes relative and absolute repository links while retaining their query and fragment", () => {
    const source = "docs/recipes/skill-authoring.es.md";
    const expected = { path: "docs/EXTENDING.md", suffix: "?mode=one&second=two#placement" };
    expect(guideTarget("../EXTENDING.md?mode=one&second=two#placement", source)).toEqual(expected);
    expect(guideTarget(guideUrl("docs/EXTENDING.md", "en") + expected.suffix, source)).toEqual(
      expected,
    );
  });

  // Covers: R10, R11
  it("exempts only native selectors and fenced examples while checking ordinary English labels and repository URLs", () => {
    const source = "docs/recipes/skill-authoring.es.md";
    const bar = editions
      .map(
        (lang: Lang): string =>
          `[${nativeNames[lang]}](${guidePath("docs/recipes/skill-authoring.md", lang).split("/").at(-1)})`,
      )
      .join(" | ");
    const external = guideUrl("docs/EXTENDING.md", "en") + "?source=body#placement";
    const text = [
      "> " + bar,
      "",
      "> " + bar,
      "[English](../EXTENDING.md?source=body#placement)",
      `[external reference](${external})`,
      "````md",
      "[example](../EXTENDING.md)",
      "```",
      "[still example](../EXTENDING.md)",
      "````",
      "~~~md",
      `[example](${external})`,
      "~~~",
      "[localized](../EXTENDING.es.md?source=body#placement)",
      "[historical](../../specs/0003-skills/requirements.md)",
      "[outside inventory](https://example.test/docs/EXTENDING.md)",
    ].join("\n");
    expect(mismatchedLinks(source, "es", text)).toEqual([
      {
        source,
        line: 4,
        target: "../EXTENDING.md?source=body#placement",
        expected: "docs/EXTENDING.es.md?source=body#placement",
      },
      { source, line: 5, target: external, expected: "docs/EXTENDING.es.md?source=body#placement" },
    ]);
    expect(languageBar("Read " + bar, source)).toBe(false);
  });

  // Covers: R1, R10
  it("publishes fourteen complete guide families with reciprocal language links", () => {
    expect(primaryGuides).toHaveLength(14);
    for (const path of primaryGuides) {
      const family = editions.map((lang) => ({
        lang,
        path: guidePath(path, lang),
        text: readFileSync(resolve(root, guidePath(path, lang)), "utf8"),
      }));
      const english = family[0]!;
      expect(english.text.length).toBeGreaterThan(200);
      for (const edition of family) {
        expect(sections(edition.text), edition.path).toBeGreaterThanOrEqual(sections(english.text));
        expect(edition.text.length, edition.path).toBeGreaterThan(
          english.text.length * (edition.lang === "zh-CN" ? 0.18 : 0.6),
        );
        expect(commands(edition.text), edition.path).toEqual(commands(english.text));
        for (const target of editions) {
          const name = guidePath(path, target).split("/").at(-1)!;
          expect(edition.text, edition.path).toContain(name);
        }
        if (edition.lang === "zh-CN") expect(edition.text).toMatch(/[\u3400-\u9fff]/);
      }
    }
  });

  // Covers: R10
  it("uses stable absolute translation URLs from the published CLI README", () => {
    for (const lang of editions) {
      const text = readFileSync(resolve(root, guidePath("packages/cli/README.md", lang)), "utf8");
      for (const target of editions)
        expect(text).toContain(guideUrl("packages/cli/README.md", target));
    }
  });
});
