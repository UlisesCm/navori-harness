import { SourceMap } from "node:module";
import { Rolldown } from "tsdown";
import { describe, expect, it } from "vitest";
import { bundleCommentsPlugin, deduplicateLegalComments } from "../../../scripts/bundle-comments";

/** Exercise the same native parser supplied to production renderChunk hooks. */
async function transform(code: string): Promise<string> {
  let result = "";
  const bundle = await Rolldown.rolldown({
    input: "fixture",
    plugins: [
      {
        name: "fixture",
        resolveId: (): string => "fixture",
        load: (): string => "export const fixture = 1;",
        buildStart(): void {
          result = deduplicateLegalComments(code, (source: string): unknown =>
            this.parse(source),
          ).toString();
        },
      },
    ],
  });
  try {
    await bundle.generate({ format: "esm" });
  } finally {
    await bundle.close();
  }
  return result;
}

describe("bundle legal comments", () => {
  it("retains distinct notices and removes only exact duplicates", async () => {
    const code = "/*! A */ /*! B */ /*! A */ export const x=1;";
    expect(await transform(code)).toBe("/*! A */ /*! B */   export const x=1;");
  });

  it.each(["// /*! A */\n", "/* prefix /*! A */\n"])(
    "does not seed notices from %s",
    async (prefix: string) => {
      const code = `${prefix}/*! A */ export const x=1;`;
      expect(await transform(code)).toBe(code);
    },
  );

  it.each(["\r", "\n", "\u2028", "\u2029"])(
    "recognizes line-comment termination %j",
    async (newline: string) => {
      const code = `// /*! A */${newline}/*! A */ /*! A */ export const x=1;`;
      expect(await transform(code)).toBe(`// /*! A */${newline}/*! A */   export const x=1;`);
    },
  );

  it("protects strings, regular expressions and complete nested templates", async () => {
    const literal = `const a='/*! A */', b="/*! A */", r=/\\/\\*! A \\*\\//, t=\`/*! A */ \${\`nested /*! A */\`}\`;`;
    expect(await transform(`${literal}/*! A *//*! A */`)).toBe(`${literal}/*! A */ `);
  });

  it("uses UTF-16 spans after astral and accented Unicode", async () => {
    expect(await transform('const x="😀é /*! A */";/*! A *//*! A */')).toBe(
      'const x="😀é /*! A */";/*! A */ ',
    );
  });

  it.each(["\r", "\n", "\r\n", "\u2028", "\u2029"])(
    "retains ASI and all %j terminators",
    async (newline: string) => {
      const notice = `/*! A${newline}*/`;
      const code = `${notice}function x(){return${notice}1;}`;
      expect(await transform(code)).toBe(`${notice}function x(){return${newline}1;}`);
    },
  );

  it("retains a separator between adjacent tokens", async () => {
    expect(await transform("/*! A */const x=typeof/*! A */undefined;")).toBe(
      "/*! A */const x=typeof undefined;",
    );
  });

  it("leaves no-match source byte-identical", async () => {
    const code = "/* ordinary */ // comment\nconst x=1n;";
    expect(await transform(code)).toBe(code);
  });

  it("rejects malformed JavaScript", async () => {
    await expect(transform("const x = ;")).rejects.toThrow();
  });

  it.each([
    {},
    { type: "Program", body: [{ type: "Literal", start: -1, end: 2 }] },
    { type: "Program", body: [{ type: "TemplateLiteral", start: 0 }] },
    { type: "Program", body: [{ type: "Literal", start: 0, end: Infinity }] },
    {
      type: "Program",
      body: [
        { type: "Literal", start: 0, end: 2 },
        { type: "Literal", start: 1, end: 3 },
      ],
    },
  ])("rejects untrusted parser shapes %j", (ast: unknown) => {
    expect(() => deduplicateLegalComments("/*! A */", (): unknown => ast)).toThrow();
  });

  it("rejects changed executable AST", () => {
    let calls = 0;
    expect(() =>
      deduplicateLegalComments("/*! A *//*! A */", (): unknown => ({
        type: "Program",
        body: [],
        sentinel: calls++,
      })),
    ).toThrow("changed executable JavaScript");
  });

  it("preserves native legal emission and maps expressions after Unicode and removed notices", async () => {
    const source = `/*! repeat */\nexport const unicode = "😀é";\n/*! repeat */\n/* @license other */\n/* @preserve keep */\n//! line notice\n/*! @license mixed @__PURE__ */\nexport function answer() { return unicode + "surviving-marker"; }\n`;
    let removed = false;
    const bundle = await Rolldown.rolldown({
      input: "fixture.js",
      plugins: [
        { name: "fixture", resolveId: (): string => "fixture.js", load: (): string => source },
        {
          name: "observe",
          renderChunk(code: string): null {
            removed = code.split("/*! repeat */").length > 2;
            return null;
          },
        },
        bundleCommentsPlugin(),
      ],
    });
    try {
      const result = await bundle.generate({
        format: "esm",
        sourcemap: true,
        comments: { legal: true, annotation: false, jsdoc: false },
      });
      const chunk = result.output.find(
        (item): item is Rolldown.OutputChunk => item.type === "chunk",
      );
      expect(chunk).toBeDefined();
      if (!chunk?.map) throw new Error("Missing native source map");
      expect(removed).toBe(true);
      expect(chunk.code.split("/*! repeat */")).toHaveLength(2);
      for (const notice of [
        "@license other",
        "@preserve keep",
        "//! line notice",
        "@license mixed @__PURE__",
      ]) {
        expect(chunk.code).toContain(notice);
      }
      const markerOffset = chunk.code.indexOf("surviving-marker");
      expect(markerOffset).toBeGreaterThan(0);
      const offset = chunk.code.lastIndexOf("return ", markerOffset);
      expect(offset).toBeGreaterThan(0);
      const prefix = chunk.code.slice(0, offset).split("\n");
      const mapped = new SourceMap({ ...chunk.map, sourceRoot: "" }).findEntry(
        prefix.length - 1,
        prefix.at(-1)?.length ?? 0,
      );
      if (!("originalLine" in mapped) || !("originalColumn" in mapped)) {
        throw new Error("Surviving return expression has no original source mapping");
      }
      const originalLine = source.split("\n")[7];
      if (!originalLine) throw new Error("Missing original fixture return expression");
      expect(mapped.originalLine).toBe(7);
      expect(mapped.originalColumn).toBe(originalLine.indexOf("return "));
      expect(chunk.map.sourcesContent).toContain(source);
    } finally {
      await bundle.close();
    }
  });
});
