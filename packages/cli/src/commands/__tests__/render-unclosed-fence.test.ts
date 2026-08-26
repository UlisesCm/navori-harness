import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #498: an ODD number of ``` in the user's prose left `proseLines`'s fence
 * toggle stuck ON to EOF, hiding every managed marker below it. The writer then
 * re-appended blocks it could not see (24 → 48 → 72 markers, 27 KB → 82 KB in
 * three renders) while `doctor`, walking the same parser, reported OK.
 *
 * The invariant these tests defend is IDEMPOTENCE: render twice, get the same
 * bytes — the property the duplication broke, whatever the parser does inside.
 * createBackup writes under ~/.navori/backups, so safeHomedir is mocked.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../lib/config.ts");
const { runRender } = await import("../render.ts");

let cwd: string;
let claudeMd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-fence-"));
  claudeMd = join(cwd, "CLAUDE.md");
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

/** Every managed marker token (open AND close) in the document. */
const countMarkers = (text: string): number => (text.match(/navori:managed/g) ?? []).length;

const renderAndRead = (): string => {
  const result = runRender(cwd, { dryRun: false });
  expect(result.ok).toBe(true);
  return readFileSync(claudeMd, "utf-8");
};

describe("render — unclosed code fence in the user's prose (#498)", () => {
  it("does not duplicate the managed blocks it renders BELOW the stray fence", () => {
    // Pre-existing prose with an opening ```bash and no closing fence: the exact
    // markdown typo from the issue. The managed region lands after it.
    writeFileSync(claudeMd, "# My repo\n\nInstall:\n\n```bash\nnpm i\n\nMore prose.\n");

    const first = renderAndRead();
    const second = renderAndRead();
    const third = renderAndRead();

    // Before the fix: 22 → 44 → 66 markers, 24524 → 48995 → 73466 bytes.
    expect(countMarkers(second)).toBe(countMarkers(first));
    expect(countMarkers(third)).toBe(countMarkers(first));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("does not duplicate the user-zone markers when the fence sits inside the user zone", () => {
    const base = renderAndRead();
    // An unclosed fence written INSIDE the preserved user zone hides the
    // `user-end` marker, so emitUserSection re-emitted it on every render.
    writeFileSync(claudeMd, `${base}\n## My notes\n\n\`\`\`bash\nnpm run dev\n`);
    const seeded = readFileSync(claudeMd, "utf-8");

    const first = renderAndRead();
    const second = renderAndRead();

    expect(countMarkers(first)).toBe(countMarkers(seeded));
    expect(first.match(/navori:user-end/g) ?? []).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("still treats a marker quoted inside a CLOSED fence as documentation", () => {
    // The fence rule is only relaxed for a MALFORMED file: a balanced fence keeps
    // hiding quoted markers, which is what #432 fixed.
    const base = renderAndRead();
    const quoted =
      `${base}\n## Docs\n\n\`\`\`md\n` +
      `<!-- navori:managed id="idioma-rol" hash="deadbeef" version="0.0.1" source="@navori/core" -->\n` +
      `example\n<!-- /navori:managed id="idioma-rol" -->\n\`\`\`\n`;
    writeFileSync(claudeMd, quoted);

    const first = renderAndRead();
    const second = renderAndRead();

    expect(first).toContain('```md\n<!-- navori:managed id="idioma-rol" hash="deadbeef"');
    expect(second).toBe(first);
  });
});
