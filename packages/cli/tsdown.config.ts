import { defineConfig } from "tsdown";

// Migrated from tsup in #890. `outputOptions.codeSplitting: false` disables
// tsdown's default (always-on) code splitting so the CLI ships as a single
// `dist/index.js` — required by `bundled-assets.ts`, which resolves
// `dist/assets/` relative to the running bundle file's own directory.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  minify: true,
  deps: { alwaysBundle: [/./] },
  banner: { js: "#!/usr/bin/env node" },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: "index.js",
  },
});
