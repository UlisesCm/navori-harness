import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The generator is the single source of truth for both the published files and
// this test — importing it guarantees we compare disk against the exact same
// derivation `pnpm gen:schemas` writes. It is plain JS, so its types come from
// inference (`allowJs` in packages/cli/tsconfig.json) instead of a hand-written
// declaration that would be a second thing to keep in sync.
import { SCHEMA_SPECS, schemaPath, serializeSchema } from "../../../scripts/gen-schemas.mjs";
import { schemaUrl } from "../schema-url.ts";

/**
 * Guards against drift between the zod schemas and the JSON Schema files
 * published under apps/website/public/schema/ (served at `SCHEMA_BASE_URL`).
 * The CLI stamps those URLs into every config/manifest it writes; if a schema
 * changes but the published file isn't regenerated, editors validate against a
 * stale contract. When this fails, run `pnpm gen:schemas`.
 *
 * The `$id` assertion below DERIVES the expected URL from `schemaUrl()` instead
 * of spelling it out. It used to freeze the literal `https://navori.dev/...`,
 * which is how a `$schema` pointing at an unregistered domain survived for
 * months: correcting the URL turned this suite red, so the fix looked like the
 * regression (#505). Where the URL should point is `schema-url.test.ts`'s job.
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
      expect(doc.$id).toBe(schemaUrl(spec.file));
      expect(doc.type).toBe("object");
      expect(doc.properties).toBeTypeOf("object");
    });
  }
});
