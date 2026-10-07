import { createHash } from "node:crypto";

/**
 * Fingerprints of every plugin gate script navori wrote BEFORE #637 gave
 * scripts a managed marker (commit 44065d02). A marker-less script can only be
 * proven untouched navori output by reproducing it; reproducing it from the
 * CURRENT template fails the moment the template or an include evolves, so an
 * old install was skipped forever (#1226). This table is the reproduction for
 * every older output.
 *
 * Each entry is `[sha256, maskedLines]`: the hash of the fully rendered file
 * (template + `# navori:include` partials expanded, 0-based `maskedLines`
 * replaced by empty lines) and the lines that carry interpolated config values
 * (`base={{shq:branchBase}}`, the threshold, prose mentions). Masking makes the
 * match independent of the user's config; every other byte must be identical,
 * so any edit outside those lines still reads as the user's file.
 *
 * Generated once with a throwaway script (not shipped): for each commit before
 * 44065d02 that touched the plugin script or `_partials/`, read the script and
 * the partials at that commit, expand includes with the era's own regex (it
 * never changed), mask every line containing `{{`, and dedupe. Comments name
 * the first commit that produced each variant. The set is CLOSED: no new entry
 * is expected, because scripts rendered from #637 on carry a marker and take
 * the managed path.
 *
 * Accepted trade-off: masked lines are blanked wholesale, so an edit confined
 * to a config-bearing (`{{`-bearing) line, e.g. the `base=` or threshold line,
 * still matches and is overwritten on adoption (the pre-render backup keeps it
 * recoverable). Those lines hold config-derived values by construction.
 */
const LEGACY_FINGERPRINTS: Readonly<
  Record<string, ReadonlyArray<readonly [string, readonly number[]]>>
> = {
  "check-jscpd.sh": [
    // 5f44015d
    ["041234ccb943bc66ef798a8a20e59104c557a68e416455e7a38829b984de1cc9", [563, 564]],
    // ef79f648
    ["a40942c03cbe4045cf4412f49c957d6e14a1839ea36a8a0b5a3d9501ecdc5626", [523, 524]],
    // d3a0f803
    ["d2c4d0b8d1e0175a3550399929c229a87b4465a88b2d7157340e166502170c48", [514, 515]],
    // 1c20700e
    ["0250f89c0f000e97e06a9df61933948184ffe79b0b59577f6b15d1b3ed274b18", [313, 314]],
    // b399f3cd
    ["a06f8b54fe2c6938734f8eafeb59e3010c33a45fcc77ed1818d00c00bac5d6cf", [313, 314]],
    // bb2ec0b5
    ["927fd65ea856e3bb5459a04b887150b73f79ba593f00d9d084481e1bba27979a", [131, 132]],
    // e7e52f45
    ["f8a5f469167a380ea1f2e84696c3d84cfacfb54b71b343d332e5e34a2667f7ae", [131, 132]],
    // d07f4ca1
    ["78a5215c8ed4e1d6f75c26c911e77d25d1a8747ce1058fb4ed1e1584df18f344", [126, 127]],
    // 233c9c24
    ["563bb4e7f882f989d5d3e359e9adf99f290227d4aa7bf9ec0a8cef123f528fd0", [126, 127]],
    // 6bd3c830
    ["e60692b1c19c07a14f491692c73814e4a904cee9c7bc58249380e9ac2d70c13a", [113, 114]],
    // 07af3e5c
    [
      "31bbb433a1c95b120204035dcf8139067cd9b088fb548aa3e8052bc3c35d8b68",
      [2, 109, 110, 122, 125, 129, 138],
    ],
    // 271380eb
    [
      "1c137dc0074cdde8a3a85b3824c3bb14c7b4d7edd276c08b7f87f93f0912d7b0",
      [2, 98, 99, 111, 114, 118, 127],
    ],
    // 5ef6125f
    [
      "63cfce79b8feb7919f021649c9b05ed5fcf0fc3448900212f09616a56b6cacd8",
      [2, 41, 42, 54, 57, 61, 70],
    ],
    // 90e69e5e
    ["11d5288142511a4737c3655889d3b63a6f0418ef43f02e40200850470aed6080", [2, 42, 43, 55, 58, 62]],
    // 27fd71b4
    ["8983c9ecd9eae9d58ae27325d93dd94e6c23c9c458e6a24d78b67a13fec2fef5", [2, 29, 30, 42, 45, 49]],
    // 01cad2cb
    ["6a5c4406060f7bdf859ffb3535f3b16a8315f0132def8d7315d81e70af772b07", [2, 25, 26, 30, 32, 37]],
  ],
  "check-semgrep.sh": [
    // 5f44015d
    ["c72a061abbb3cbbc2c96dfaa286fb794abb095eedbe42e0fa9ba8a01afee6881", [557]],
    // ef79f648
    ["ea764d62bc4cb06a15e20250456cf9a3a79283f9ca9e62c201dca710dfc9e454", [517]],
    // d3a0f803
    ["3d5cfa005b64625a6bc430faa3091b76ae6b62802cce75452586e62f48df5b70", [508]],
    // 1c20700e
    ["3f9cd3c00b403c4529d9bad40549d9bf9d1a67f3c75ffebf0c514a441586bc43", [307]],
    // b399f3cd
    ["6a34990b770d41e540a6d196b8467f1d4f4bf19c7fdfac9b16b19196bff1d9ee", [307]],
    // bb2ec0b5
    ["cbf700a70cdaee13b7f30c2fc43622a1c6f652ab6111a1176d71c87adb741fd7", [129]],
    // 6fd96a75
    ["d46749a930a137a50fdb13fd5d7a086da12772617edb7fe0c1794016efbc8804", [129]],
    // e7e52f45
    ["192cd9d7e0e07263d8d2b7a5ba634139c9137243471650522d219c4dab3b5036", [127]],
    // d07f4ca1
    ["08aa28d128ee48866625327bcb42dc262a172393a422cce4d81a11de2d167bbc", [122]],
    // 233c9c24
    ["1298ce83fdbc5ed3519ce54d1bee5189c3786f99807139ecb02ade9137f98786", [122]],
    // 03f3c6ad
    ["30da64b0974f311b661c139f0d6c94dc0de55f0b5567ae015d6a43208612c5fe", [109]],
    // 6bd3c830
    ["b4543ee86d6a918d1715efa55a605aea0de2050256678b41abc4e03443d746d7", [109]],
    // 07af3e5c
    [
      "9bf0886e320c671ac700658d51f27cc437b3ca9c0b84636a085f6b625293fd2e",
      [2, 105, 106, 118, 121, 125],
    ],
    // 271380eb
    [
      "acd401f45cc51b2a8b99aac3f2377e534efe3ab89eb5d3fd07d1d4671ba51004",
      [2, 99, 100, 112, 115, 119],
    ],
    // 90e69e5e
    ["1052b801786b2b82ac9abd4dfc36cb5f05ed724c8b52048d188df8e9d346b553", [2, 42, 43, 55, 58, 62]],
    // 27fd71b4
    ["84c847391daae5c350b58c99d34acd992fa3e77d1f19d91a14265ef057bf0e73", [2, 29, 30, 42, 45, 49]],
    // 01cad2cb
    ["5495bfa4a26a1fd153de73605d8ade487ce36ae3351c496415fba9ecbf21ce50", [2, 25, 26, 30, 32, 37]],
  ],
};

/** Hash `content` with `masked` (0-based) lines blanked. */
function maskedSha256(content: string, masked: readonly number[]): string {
  const lines = content.split("\n");
  for (const i of masked) if (i < lines.length) lines[i] = "";
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * True when `onDisk` is byte-identical, modulo config-bearing lines, to a
 * pre-#637 render of the plugin script named `scriptFile` (basename of the
 * asset, e.g. `check-jscpd.sh`). Unknown script names and unknown content
 * return false, so the caller keeps its skip-and-report behavior.
 */
export function matchesLegacyFingerprint(scriptFile: string, onDisk: string): boolean {
  const entries = LEGACY_FINGERPRINTS[scriptFile];
  if (entries === undefined) return false;
  return entries.some(([sha256, masked]) => maskedSha256(onDisk, masked) === sha256);
}

/** Table accessor for tests (entry uniqueness, mask ranges). */
export function legacyFingerprintTable(): typeof LEGACY_FINGERPRINTS {
  return LEGACY_FINGERPRINTS;
}
