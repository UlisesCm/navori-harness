export const MIN_PI_VERSION = "0.87.1";
export const MIN_NODE_VERSION = "22.19.0";

type Version = readonly [major: number, minor: number, patch: number];

function parseStableVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return [major, minor, patch];
}

/** Embed the same version check in the standalone project extension. */
export function renderPiRuntimeVersionSource(): string {
  return (
    `const MIN_PI_VERSION = ${JSON.stringify(MIN_PI_VERSION)};\n` +
    `const MIN_NODE_VERSION = ${JSON.stringify(MIN_NODE_VERSION)};\n` +
    `${parseStableVersion.toString()}\n${isAtLeast.toString()}\n` +
    `${assertSupportedPiRuntime.toString()}\n`
  );
}

function isAtLeast(actual: Version, minimum: Version): boolean {
  if (actual[0] !== minimum[0]) return actual[0] > minimum[0];
  if (actual[1] !== minimum[1]) return actual[1] > minimum[1];
  return actual[2] >= minimum[2];
}

/** Reject incompatible Pi/Node versions before loading Navori's Pi extension. */
export function assertSupportedPiRuntime(
  piVersion: string,
  nodeVersion: string = process.versions.node,
): void {
  const node = parseStableVersion(nodeVersion);
  if (!node || !isAtLeast(node, [22, 19, 0])) {
    throw new Error(
      `Navori's Pi engine requires Node.js ${MIN_NODE_VERSION} or later; found ${nodeVersion}.`,
    );
  }

  const pi = parseStableVersion(piVersion);
  if (!pi || !isAtLeast(pi, [0, 87, 1])) {
    throw new Error(
      `Navori's Pi engine requires @earendil-works/pi-coding-agent ${MIN_PI_VERSION} or later; found ${piVersion}. Run pi --version and upgrade Pi.`,
    );
  }
}
