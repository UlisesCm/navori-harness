import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Rolldown } from "tsdown";
import { describe, expect, it } from "vitest";
import {
  bundleRenderDataPlugin,
  encodeBridgeRenderData,
} from "../../../scripts/bundle-render-data.ts";
import { bundleCommentsPlugin } from "../../../scripts/bundle-comments.ts";
import { PI_BRIDGE_SOURCE } from "../../engines/pi/bridge-source.ts";

const bridge = fileURLToPath(new URL("../../engines/pi/bridge-source.ts", import.meta.url));
const extension = fileURLToPath(new URL("../../engines/pi/extension-source.ts", import.meta.url));

/** Real native input transform, legal pass and minifier; evaluate only fixed test fixture modules. */
async function bundleBridge(code: string, codec = true): Promise<{ code: string; map: unknown }> {
  const bundle = await Rolldown.rolldown({
    input: bridge,
    external: ["node:zlib", "node:crypto"],
    plugins: [
      {
        name: "bridge-fixture",
        load(id: string): string | undefined {
          if (id === bridge) return code;
        },
      },
      ...(codec ? [bundleRenderDataPlugin()] : []),
      bundleCommentsPlugin(),
    ],
  });
  try {
    const result = await bundle.generate({ format: "esm", minify: true, sourcemap: true });
    const chunk = result.output[0];
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing fixture output");
    return { code: chunk.code, map: chunk.map };
  } finally {
    await bundle.close();
  }
}

async function value(code: string): Promise<unknown> {
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  )) as { PI_BRIDGE_SOURCE: unknown };
  return loaded.PI_BRIDGE_SOURCE;
}

/** Compare the complete renderer in the same native compile mode, including serialized helper source. */
async function renderer(
  codec: boolean,
  fixture?: string,
): Promise<((plugins?: readonly string[]) => string) & { testTrace: readonly string[] }> {
  const bundle = await Rolldown.rolldown({
    input: extension,
    external: (id: string): boolean => id.startsWith("node:"),
    plugins: [
      {
        name: "renderer-fixture",
        load(id: string): string | undefined {
          return id === extension ? fixture : undefined;
        },
      },
      ...(codec ? [bundleRenderDataPlugin()] : []),
      bundleCommentsPlugin(),
    ],
  });
  try {
    const result = await bundle.generate({ format: "esm", minify: true });
    const output = result.output[0];
    if (!output || output.type !== "chunk") throw new Error("Missing renderer chunk");
    const directory = mkdtempSync(join(tmpdir(), "navori-render-codec-"));
    try {
      const path = join(directory, "renderer.mjs");
      writeFileSync(path, output.code);
      const module = (await import(pathToFileURL(path).href)) as {
        renderPiExtensionSource: (plugins?: readonly string[]) => string;
        trace?: readonly string[];
      };
      return Object.assign(module.renderPiExtensionSource, { testTrace: module.trace ?? [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    await bundle.close();
  }
}

describe("explicit Pi render-data codec", () => {
  // Covers: R16
  it.each(["ordinary", "undefined", "symbol", "throw", "empty"])(
    "preserves intrinsic substitution evaluation/coercion/throws for %s",
    async (mode: string) => {
      const substitutions = Array.from({ length: 10 }, (_, index) => "${pick(" + index + ")}").join(
        "-",
      );
      const fixture = `import {PI_BRIDGE_SOURCE} from './bridge-source.ts';export const anchor=PI_BRIDGE_SOURCE;export const trace=[];function pick(n){trace.push('eval:'+n);if(n===2&&${JSON.stringify(mode)}==='symbol')return Symbol('x');if(n===2&&${JSON.stringify(mode)}==='undefined')return undefined;if(n===2&&${JSON.stringify(mode)}==='empty')return '';return {toString(){trace.push('coerce:'+n);if(n===0&&${JSON.stringify(mode)}==='throw')throw Error('coerce-failed');return 'v'+n;}};}export function renderPiExtensionSource(){return String.raw\`a${substitutions}z\`;}`;
      const baseline = await renderer(false, fixture);
      const encoded = await renderer(true, fixture);
      const call = (fn: () => string): string => {
        try {
          return fn();
        } catch (error: unknown) {
          if (error instanceof Error) return error.name + ":" + error.message;
          throw error;
        }
      };
      expect(call(encoded)).toBe(call(baseline));
      expect(encoded.testTrace).toEqual(baseline.testTrace);
      expect(encoded.testTrace.slice(0, 10)).toEqual(
        Array.from({ length: 10 }, (_, index) => `eval:${index}`),
      );
    },
  );
  // Covers: R16
  it("preserves the complete same-mode Pi renderer without normalizing serialized helpers", async () => {
    const baseline = await renderer(false);
    const encoded = await renderer(true);
    for (const plugins of [[], ["engram"], ['quote"line\n', "é😀"]])
      expect(encoded(plugins)).toBe(baseline(plugins));
  });
  // Covers: R16
  it("preserves the exact current bridge through actual minifier/legal/map phases", async () => {
    const input = readFileSync(bridge, "utf8");
    const baseline = await bundleBridge(input, false);
    const encoded = await bundleBridge(input);
    expect(await value(encoded.code)).toBe(PI_BRIDGE_SOURCE);
    expect(await value(encoded.code)).toBe(await value(baseline.code));
    expect(Buffer.byteLength(encoded.code)).toBeLessThan(Buffer.byteLength(baseline.code));
    expect(encoded.map).toBeTruthy();
    expect(encoded.code).toContain("node:zlib");
  });

  // Covers: R16
  it.each(["a\r\nb", "a\rb", "é😀\u2028\u2029", String.raw`\n\uD800\q\``, ""])(
    "preserves native raw semantics for %j",
    async (raw: string) => {
      const code = `/*! exact notice */ export const PI_BRIDGE_SOURCE=String.raw\`${raw}\`;`;
      const baseline = await bundleBridge(code, false);
      const encoded = await bundleBridge(code);
      expect(await value(encoded.code)).toBe(await value(baseline.code));
      expect(encoded.code).toContain("/*! exact notice */");
    },
  );

  // Covers: R16
  it.each(["\ud800", "\udfff"])("rejects literal unsupported surrogate %j", async (raw: string) => {
    // The native bundler's UTF-8 FFI replaces lone surrogates before hooks; check the codec boundary first.
    expect(() =>
      encodeBridgeRenderData(`export const PI_BRIDGE_SOURCE=String.raw\`${raw}\`;`, bridge, () => {
        throw new Error("Parser must not receive unsupported source");
      }),
    ).toThrow("UTF-8 domain");
  });

  // Covers: R16
  it.each([
    "export const other=String.raw`unchanged`;",
    "export const PI_BRIDGE_SOURCE='not raw';",
    "export const PI_BRIDGE_SOURCE=String.raw`a${1}`;",
    "const __navoriRenderData=1; export const PI_BRIDGE_SOURCE=String.raw`x`;",
  ])("rejects invalid target/cardinality/binding %s", async (code: string) => {
    await expect(bundleBridge(code)).rejects.toThrow();
  });

  // Covers: R16
  it("rejects a corrupted in-bundle payload instead of returning a partial guard", async () => {
    const encoded = await bundleBridge(readFileSync(bridge, "utf8"));
    const damaged = encoded.code.replace(/([a-f0-9]{64})/, "0".repeat(64));
    expect(damaged).not.toBe(encoded.code);
    await expect(value(damaged)).rejects.toThrow("render data integrity");
  });
});
