import { defineConfig } from "tsdown";
import { bundleCommentsPlugin } from "./scripts/bundle-comments.ts";
import { bundleRenderDataPlugin } from "./scripts/bundle-render-data.ts";

// Migrated from tsup in #890. Code splitting is on (spec 0055 R14): `src/cli.ts` loads each
// subcommand through `import()`, so every command becomes a chunk. `chunkFileNames` has no
// directory, which keeps every chunk at the root of `dist/` next to `index.js` — required by
// `bundled-assets.ts`, which resolves `dist/assets/` and `../package.json` relative to the
// directory of the running chunk (`cli-lazy-load.test.ts` pins the layout).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  minify: true,
  deps: { alwaysBundle: [/./] },
  banner: { js: "#!/usr/bin/env node" },
  plugins: [bundleRenderDataPlugin(), bundleCommentsPlugin()],
  outputOptions: {
    entryFileNames: "index.js",
    chunkFileNames: "[name].js",
    comments: { legal: true, annotation: false, jsdoc: false },
  },
});
