import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  // Bundle every runtime dependency INTO the binary (zod, citty, clack,
  // picocolors) and minify. Trade-off chosen deliberately: dist/index.js grows
  // (~370KB → ~660KB) but the user's install footprint drops ~82% (6.1MB → 1.1MB)
  // because npm no longer resolves any third-party dependency — zod alone is 5MB
  // on disk of which we tree-shake down to what we use. Zero runtime deps also
  // means zero install-time dependency resolution and supply-chain surface.
  // Requires the runtime deps to live in devDependencies (they ship inlined).
  minify: true,
  noExternal: [/./],
  // Emit a single self-contained file — simpler to `npm pack`, smoke-test and
  // reason about than hashed dynamic-import chunks for a CLI bin.
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
