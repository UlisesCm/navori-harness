import { crc32 } from "node:zlib";

/**
 * Preserve the vector origin in a standard PNG text chunk, reproducibly and without a CLI dependency.
 * @param {Buffer} png A freshly generated PNG.
 * @param {string} origin The source artifact and generator.
 * @returns {Buffer}
 */
export function pngWithOrigin(png, origin) {
  if (png.length < 20 || png.toString("ascii", png.length - 8, png.length - 4) !== "IEND")
    throw new Error("Expected a complete generated PNG");
  const data = Buffer.from("impeccable:prompt\0" + origin, "utf8");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
