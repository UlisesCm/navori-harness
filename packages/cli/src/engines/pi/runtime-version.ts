export const MIN_PI_VERSION = "0.87.1";
export const MIN_NODE_VERSION = "22.19.0";

type Version = readonly [major: number, minor: number, patch: number];
type RuntimeCheck = (piVersion: string, nodeVersion?: string) => void;

/** Keep serialized code closure-free so bundled function names remain valid. */
function createRuntimeCheck(minPiVersion: string, minNodeVersion: string): RuntimeCheck {
  function parseStableVersion(value: string): Version | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value.trim());
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return null;
    return [major, minor, patch];
  }

  function isAtLeast(actual: Version, minimum: Version): boolean {
    if (actual[0] !== minimum[0]) return actual[0] > minimum[0];
    if (actual[1] !== minimum[1]) return actual[1] > minimum[1];
    return actual[2] >= minimum[2];
  }

  return (piVersion: string, nodeVersion: string = process.versions.node): void => {
    const node = parseStableVersion(nodeVersion);
    const minimumNode = parseStableVersion(minNodeVersion);
    if (!node || !minimumNode || !isAtLeast(node, minimumNode)) {
      throw new Error(
        `Navori's Pi engine requires Node.js ${minNodeVersion} or later; found ${nodeVersion}.`,
      );
    }

    const pi = parseStableVersion(piVersion);
    const minimumPi = parseStableVersion(minPiVersion);
    if (!pi || !minimumPi || !isAtLeast(pi, minimumPi)) {
      throw new Error(
        `Navori's Pi engine requires @earendil-works/pi-coding-agent ${minPiVersion} or later; found ${piVersion}. Run pi --version and upgrade Pi.`,
      );
    }
  };
}

/** Embed a stable binding to the same self-contained check after bundling. */
export function renderPiRuntimeVersionSource(): string {
  return (
    `const assertSupportedPiRuntime = (${createRuntimeCheck.toString()})` +
    `(${JSON.stringify(MIN_PI_VERSION)}, ${JSON.stringify(MIN_NODE_VERSION)});\n`
  );
}

/** Reject incompatible Pi/Node versions before loading Navori's Pi extension. */
export const assertSupportedPiRuntime: RuntimeCheck = createRuntimeCheck(
  MIN_PI_VERSION,
  MIN_NODE_VERSION,
);
