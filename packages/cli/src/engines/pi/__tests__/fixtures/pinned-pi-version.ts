import { readFileSync } from "node:fs";

/** The Pi runtime this checkout pins: `devDependencies` is the single source, so a bump edits no test. */
export const PINNED_PI_VERSION: string = ((): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"),
  );
  const dev = (manifest as { devDependencies?: Record<string, string> }).devDependencies;
  const version = dev?.["@earendil-works/pi-coding-agent"];
  if (!version)
    throw new Error("packages/cli devDependencies lacks @earendil-works/pi-coding-agent");
  return version;
})();
