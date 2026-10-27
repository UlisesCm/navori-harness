/** Generate the favicon and touch/app icons from one vector source. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pngWithOrigin } from "./png-origin.mjs";

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const sharp = astroRequire("sharp");
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("src/assets/navori-mark.svg", root), "utf8");
const origin =
  "Origin: derived from src/assets/navori-mark.svg by scripts/gen-brand.mjs; geometric vector artwork, no generated bitmap.";
const out = new URL("public/", root);
await writeFile(new URL("favicon.svg", out), source);

for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  const bytes = await sharp(Buffer.from(source)).resize(size, size).png().toBuffer();
  await writeFile(new URL(name, out), pngWithOrigin(bytes, origin));
}
const png = await sharp(Buffer.from(source)).resize(32, 32).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 32;
header[7] = 32;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile(new URL("favicon.ico", out), Buffer.concat([header, png]));
process.stdout.write("Brand assets generated from src/assets/navori-mark.svg\n");
