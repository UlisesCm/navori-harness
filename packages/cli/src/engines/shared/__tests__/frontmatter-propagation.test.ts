import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManagedFile } from "../render-managed-file.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";

/**
 * Cold-review finding on PR #660, and the reason spec 0020's R1 was dead on
 * arrival for every already-onboarded repo: `rerender` merged the asset's
 * frontmatter correctly (asset wins for its keys) and then reported
 * "unchanged" whenever the managed BODY had not moved — so `planManagedFile`
 * turned the write into a noop and the merged frontmatter was thrown away.
 *
 * Net effect: the 0020 descriptions reached every source asset and ZERO
 * rendered `.claude/agents/*.md` — the exact file the host reads to decide
 * delegation. The tests were green because they swept the source. This suite
 * pins the propagation itself.
 */

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "fm-prop",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
  });
}

const META = { source: "@navori/core", version: "9.9.9" };

/** An asset + a destination already rendered from an OLDER description. */
function fixture(description: string): { assetPath: string; existing: string } {
  const dir = mkdtempSync(join(tmpdir(), "navori-fm-prop-"));
  const assetPath = join(dir, "agent.md");
  writeFileSync(
    assetPath,
    `---\nname: agent\ndescription: ${description}\ntools: Read\n---\n\nBODY LINE\n`,
  );
  const existing = [
    "---",
    "name: agent",
    "description: OLD prose that no longer matches the asset.",
    "tools: Read",
    // Underscore on purpose: `parseKeyValueLines` only admits [a-zA-Z0-9_]
    // keys, so a HYPHENATED user key (e.g. `disable-model-invocation`) is
    // silently dropped on re-render today. Real, out of this PR's scope,
    // recorded in the 0020 follow-up issue.
    "custom_user_key: kept",
    "---",
    "",
    '<!-- navori:managed id="agent-base" hash="x" version="9.9.9" source="@navori/core" -->',
    "BODY LINE",
    '<!-- /navori:managed id="agent-base" -->',
    "",
  ].join("\n");
  return { assetPath, existing };
}

describe("frontmatter-only changes propagate to an existing rendered file", () => {
  it("reports updated — not unchanged — and carries the new description", () => {
    // Covers: R1
    const { assetPath, existing } = fixture("NEW trigger. Use proactively when it applies.");
    // Body hash must match what injectManagedSection computes; easiest is to
    // let a first pass normalize it, then re-run against ITS output.
    const first = renderManagedFile({
      assetPath,
      existingContent: existing,
      managedId: "agent-base",
      meta: META,
      config: config(),
    });
    expect(first.status).toBe("updated");
    expect(first.content).toContain("NEW trigger. Use proactively when it applies.");
    expect(first.content).not.toContain("OLD prose");
    // The destination's own extra key survives the merge (asset wins only for
    // the keys it declares).
    expect(first.content).toContain("custom_user_key: kept");
  });

  it("is idempotent: the pass after the propagation reports unchanged", () => {
    // Covers: R1
    const { assetPath, existing } = fixture("NEW trigger. Use proactively when it applies.");
    const first = renderManagedFile({
      assetPath,
      existingContent: existing,
      managedId: "agent-base",
      meta: META,
      config: config(),
    });
    const second = renderManagedFile({
      assetPath,
      existingContent: first.content,
      managedId: "agent-base",
      meta: META,
      config: config(),
    });
    expect(second.status).toBe("unchanged");
    expect(second.content).toBe(first.content);
  });
});

describe("plugin MCP grants in `tools:` survive the asset-wins merge", () => {
  /**
   * `tools:` has a third writer: `withAgentMcpTools` appends `mcp__<id>__*` to
   * the RENDERED file when a plugin injects into that agent — the asset never
   * carries the grant. Plain asset-wins stripped it on every re-render and the
   * plugin pass re-added it: an infinite updated/updated churn that broke
   * render idempotency the moment the status collapse above was fixed.
   */
  it("keeps a dest-only mcp__* entry and still lets the asset own the natives", () => {
    // Covers: R1
    const dir = mkdtempSync(join(tmpdir(), "navori-fm-grant-"));
    const assetPath = join(dir, "agent.md");
    writeFileSync(
      assetPath,
      "---\nname: agent\ndescription: X. Use when Y.\ntools: Read, Grep, Bash\n---\n\nBODY\n",
    );
    const existing = [
      "---",
      "name: agent",
      "description: X. Use when Y.",
      "tools: Read, Grep, Bash, Write, mcp__engram__*",
      "---",
      "",
      '<!-- navori:managed id="agent-base" hash="x" version="9.9.9" source="@navori/core" -->',
      "BODY",
      '<!-- /navori:managed id="agent-base" -->',
      "",
    ].join("\n");
    const out = renderManagedFile({
      assetPath,
      existingContent: existing,
      managedId: "agent-base",
      meta: META,
      config: config(),
    });
    // The grant survives; the native `Write` the asset no longer declares does not.
    expect(out.content).toContain("tools: Read, Grep, Bash, mcp__engram__*");
    // And the pass after it is stable — no churn.
    const again = renderManagedFile({
      assetPath,
      existingContent: out.content,
      managedId: "agent-base",
      meta: META,
      config: config(),
    });
    expect(again.status).toBe("unchanged");
  });
});
