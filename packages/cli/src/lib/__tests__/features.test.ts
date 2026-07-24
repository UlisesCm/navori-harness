import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeatureManifestSchema,
  loadFeature,
  featureExists,
  listFeatureIds,
  featureSource,
  resolveFeature,
  FeatureError,
} from "../features.ts";

const VALID_MANIFEST = {
  id: "app-builder",
  displayName: "App builder",
  description: "Trigger: build a mobile app, app from scratch. Phased end-to-end app creation.",
  type: "feature",
  kind: "bootstrap",
  phases: [
    { n: 0, slug: "product", objetivo: "Product def", skills: ["cognitive-doc-design"], gate: "user approves" },
    { n: 1, slug: "scaffold", objetivo: "Monorepo boots", skills: ["typescript"], gate: "app boots" },
  ],
  invariants: ["0-product", "1-scaffold"],
};

describe("FeatureManifestSchema — boundaries", () => {
  it("accepts a valid manifest and defaults kind to in-repo when omitted", () => {
    const r = FeatureManifestSchema.safeParse(VALID_MANIFEST);
    expect(r.success).toBe(true);

    const { kind, ...noKind } = VALID_MANIFEST;
    void kind;
    const r2 = FeatureManifestSchema.safeParse(noKind);
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.data.kind).toBe("in-repo");
  });

  it("rejects a manifest with no phases (min 1)", () => {
    const r = FeatureManifestSchema.safeParse({ ...VALID_MANIFEST, phases: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a bad kind", () => {
    const r = FeatureManifestSchema.safeParse({ ...VALID_MANIFEST, kind: "runtime" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-literal type", () => {
    const r = FeatureManifestSchema.safeParse({ ...VALID_MANIFEST, type: "skill" });
    expect(r.success).toBe(false);
  });

  it("rejects duplicate phase n", () => {
    const r = FeatureManifestSchema.safeParse({
      ...VALID_MANIFEST,
      phases: [
        { n: 0, slug: "a", objetivo: "x", skills: [], gate: "g" },
        { n: 0, slug: "b", objetivo: "y", skills: [], gate: "g" },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /duplicate phase/.test(i.message))).toBe(true);
  });

  it("rejects a non-kebab id and a non-kebab phase slug", () => {
    expect(FeatureManifestSchema.safeParse({ ...VALID_MANIFEST, id: "App_Builder" }).success).toBe(false);
    expect(
      FeatureManifestSchema.safeParse({
        ...VALID_MANIFEST,
        phases: [{ n: 0, slug: "Product_X", objetivo: "x", skills: [], gate: "g" }],
      }).success,
    ).toBe(false);
  });

  it("defaults optional arrays (skills, invariants)", () => {
    const r = FeatureManifestSchema.safeParse({
      ...VALID_MANIFEST,
      invariants: undefined,
      phases: [{ n: 0, slug: "product", objetivo: "x", gate: "g" }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.invariants).toEqual([]);
      expect(r.data.phases[0]!.skills).toEqual([]);
    }
  });
});

describe("feature loader — local-first resolution", () => {
  let cwd: string;

  // A local fixture id that will not collide with any bundled feature.
  const FID = "demo-feature-fixture";
  const localManifest = { ...VALID_MANIFEST, id: FID };

  const writeFeature = (id: string, manifest: unknown) => {
    const dir = join(cwd, ".navori/features", id);
    mkdirSync(join(dir, "phases"), { recursive: true });
    writeFileSync(join(dir, "feature.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(dir, "FEATURE.md"), "# Feature\n");
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-features-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("featureExists is false for an unknown id, true for a local bundle", () => {
    expect(featureExists("no-such-feature-zzz", cwd)).toBe(false);
    writeFeature(FID, localManifest);
    expect(featureExists(FID, cwd)).toBe(true);
  });

  it("loadFeature returns the parsed manifest for a local bundle", () => {
    writeFeature(FID, localManifest);
    const loaded = loadFeature(FID, cwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.id).toBe(FID);
    expect(loaded!.source).toBe("local");
  });

  it("loadFeature returns null for an unknown id", () => {
    expect(loadFeature("no-such-feature-zzz", cwd)).toBeNull();
  });

  it("loadFeature throws FeatureError on malformed JSON", () => {
    const dir = join(cwd, ".navori/features", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "feature.json"), "{ not json");
    expect(() => loadFeature("broken", cwd)).toThrow(FeatureError);
  });

  it("loadFeature throws when the id doesn't match the directory", () => {
    writeFeature(FID, { ...localManifest, id: "other" });
    expect(() => loadFeature(FID, cwd)).toThrow(FeatureError);
  });

  it("listFeatureIds enumerates local bundles", () => {
    writeFeature(FID, localManifest);
    expect(listFeatureIds(cwd)).toContain(FID);
  });

  it("featureSource follows the @navori/feature-<id> convention", () => {
    expect(featureSource("app-builder")).toBe("@navori/feature-app-builder");
  });

  // Defense-in-depth: resolveFeature rejects a path separator or `..` up front so
  // a raw id can never escape the features dirs, even if a caller skips the schema.
  it("resolveFeature returns null for traversal-shaped ids", () => {
    for (const bad of ["../evil", "..", "foo/bar", "foo\\bar", "a/../b", "/etc/passwd"]) {
      expect(resolveFeature(bad, cwd), `id '${bad}' must not resolve`).toBeNull();
    }
    // And loadFeature (which resolves first) is null for the same ids.
    expect(loadFeature("../evil", cwd)).toBeNull();
  });
});
