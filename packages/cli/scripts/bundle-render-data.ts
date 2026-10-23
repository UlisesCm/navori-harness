import { brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Rolldown, type TsdownPlugin } from "tsdown";

const bridgeModule = fileURLToPath(new URL("../src/engines/pi/bridge-source.ts", import.meta.url));
const extensionModule = fileURLToPath(
  new URL("../src/engines/pi/extension-source.ts", import.meta.url),
);
const decoderName = "__navoriRenderData";
const decoder = `
import { brotliDecompressSync as __navoriBrotli } from "node:zlib";
import { createHash as __navoriDataHash } from "node:crypto";
function __navoriRenderData(encoded, bytes, digest) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 131072 || typeof encoded !== "string" || encoded.length > 262144) throw new Error("Invalid render data boundary");
  const input = Buffer.from(encoded, "base64");
  if (input.toString("base64") !== encoded) throw new Error("Invalid render data encoding");
  const decoded = __navoriBrotli(input, { maxOutputLength: Math.max(1, bytes) });
  if (decoded.length !== bytes || __navoriDataHash("sha256").update(decoded).digest("hex") !== digest) throw new Error("Invalid render data integrity");
  const text = decoded.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(decoded)) throw new Error("Invalid render data UTF-8");
  return text;
}
`;

type Node = Record<string, unknown>;
type Parse = (code: string) => unknown;

function node(value: unknown): Node {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid render data parser node");
  return value as Node;
}

/** Traverse parser objects only to identify the exact module-owned declaration. */
function nodes(ast: unknown, type: string): Node[] {
  const found: Node[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value && typeof value === "object") {
      const entry = node(value);
      if (entry.type === type) found.push(entry);
      for (const child of Object.values(entry)) visit(child);
    }
  }
  visit(ast);
  return found;
}

/** Encode only well-formed parser raw values, whose native CRLF normalization is already applied. */
function encodedRaw(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing render data raw value");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 131072 || bytes.toString("utf8") !== value)
    throw new Error("Unsupported render data UTF-8 domain");
  const compressed = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString("base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${decoderName}(${JSON.stringify(compressed)},${bytes.length},${JSON.stringify(digest)})`;
}

/** Stable input identity and native mapped edits; never match names after minification. */
export function encodeBridgeRenderData(
  code: string,
  id: string,
  parse: Parse,
): Rolldown.RolldownMagicString | null {
  if (id !== bridgeModule && id !== extensionModule) return null;
  if (Buffer.from(code, "utf8").toString("utf8") !== code)
    throw new Error("Unsupported render data UTF-8 domain");
  const ast = node(parse(code));
  if (ast.type !== "Program") throw new Error("Expected render data Program");
  if (nodes(ast, "Identifier").some((entry) => String(entry.name).startsWith("__navori")))
    throw new Error("Render data decoder binding collision");
  const declarationType = id === bridgeModule ? "VariableDeclarator" : "FunctionDeclaration";
  const name = id === bridgeModule ? "PI_BRIDGE_SOURCE" : "renderPiExtensionSource";
  const declarations = nodes(ast, declarationType).filter((entry) => node(entry.id).name === name);
  if (declarations.length !== 1) throw new Error(`Expected exactly one ${name} target`);
  const owner = node(declarations[0]);
  const init =
    id === bridgeModule
      ? node(owner.init)
      : nodes(owner.body, "ReturnStatement")[0] &&
        node(nodes(owner.body, "ReturnStatement")[0]?.argument);
  if (!init) throw new Error("Missing named renderer return");
  const tag = node(init.tag);
  if (
    init.type !== "TaggedTemplateExpression" ||
    tag.type !== "MemberExpression" ||
    tag.computed !== false ||
    node(tag.object).name !== "String" ||
    node(tag.property).name !== "raw"
  )
    throw new Error("Unsupported render data target expression");
  const quasi = node(init.quasi);
  const expected = id === bridgeModule ? 0 : 10;
  if (
    !Array.isArray(quasi.expressions) ||
    quasi.expressions.length !== expected ||
    !Array.isArray(quasi.quasis) ||
    quasi.quasis.length !== expected + 1
  )
    throw new Error("Unsupported named render data fragment/expression cardinality");
  const start = init.start;
  const end = init.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > code.length
  )
    throw new Error("Invalid render data target span");
  const fragments = quasi.quasis.map((entry: unknown): string =>
    encodedRaw(node(node(entry).value).raw),
  );
  const substitutions = quasi.expressions.map((entry: unknown): string => {
    const expression = node(entry);
    if (
      typeof expression.start !== "number" ||
      typeof expression.end !== "number" ||
      expression.start < start ||
      expression.end > end ||
      expression.end <= expression.start
    )
      throw new Error("Invalid render data expression span");
    return code.slice(expression.start, expression.end);
  });
  const expression =
    expected === 0
      ? fragments[0]!
      : `String.raw({raw:[${fragments.join(",")}]},${substitutions.join(",")})`;
  const output = new Rolldown.RolldownMagicString(code);
  output.overwrite(start, end, expression);
  output.prepend(decoder);
  return output;
}

/** Explicit release-data codec runs before TypeScript conversion and counts all payload bytes in index. */
export function bundleRenderDataPlugin(): TsdownPlugin<unknown> {
  const transformed = new Set<string>();
  return {
    name: "encode-named-pi-render-data",
    buildStart(): void {
      transformed.clear();
    },
    transform: {
      order: "pre",
      handler(code: string, id: string): { code: Rolldown.RolldownMagicString } | null {
        const result = encodeBridgeRenderData(code, id, (source: string): unknown =>
          this.parse(source, { lang: "ts" }),
        );
        if (result && transformed.has(id)) throw new Error("Duplicated release render data module");
        if (result) transformed.add(id);
        return result ? { code: result } : null;
      },
    },
    buildEnd(error): void {
      if (!error && !transformed.has(bridgeModule))
        throw new Error("Missing release bridge render data module");
    },
  };
}
