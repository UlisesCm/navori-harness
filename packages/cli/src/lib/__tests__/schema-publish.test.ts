import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The generator is the single source of truth for both the published files and
// this test — importing it guarantees we compare disk against the exact same
// derivation `pnpm gen:schemas` writes.
import { SCHEMA_SPECS, schemaPath, serializeSchema } from "../../../scripts/gen-schemas.mjs";

/**
 * Guards against drift between the zod schemas and the JSON Schema files
 * published under apps/website/public/schema/ (served at navori.dev/schema/*).
 * The CLI stamps those URLs into every config/manifest it writes; if a schema
 * changes but the published file isn't regenerated, editors validate against a
 * stale contract. When this fails, run `pnpm gen:schemas`.
 */
describe("published JSON Schemas are in sync with the zod source", () => {
  for (const spec of SCHEMA_SPECS) {
    it(`${spec.file} matches the current zod schema`, () => {
      const onDisk = readFileSync(schemaPath(spec), "utf-8");
      expect(onDisk).toBe(serializeSchema(spec));
    });

    it(`${spec.file} is a valid JSON Schema document`, () => {
      const doc = JSON.parse(readFileSync(schemaPath(spec), "utf-8"));
      expect(doc.$schema).toBeTypeOf("string");
      expect(doc.$id).toBe(`https://navori.dev/schema/${spec.file}`);
      expect(doc.type).toBe("object");
      expect(doc.properties).toBeTypeOf("object");
    });
  }
});
