import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit coverage for the `global init` wizard (#545). @clack needs a TTY, so the
 * pickers are driven in-process with the same mocked-prompts pattern
 * `src/__tests__/interactive-flows.test.ts` documents: `queue` pre-loads the
 * answers each prompt consumes in call order, and `CANCEL` is the only value
 * `isCancel` recognises.
 *
 * The mock is file-scoped and hoisted, which is why this lives in its own spec
 * rather than next to the command's e2e cases.
 */
const clk = vi.hoisted(() => ({
  queue: [] as unknown[],
  calls: [] as Record<string, unknown>[],
  CANCEL: Symbol("clack-cancel"),
}));

vi.mock("@clack/prompts", () => {
  const dequeue = async (opts: Record<string, unknown>) => {
    clk.calls.push(opts);
    return clk.queue.shift();
  };
  return {
    confirm: vi.fn(dequeue),
    text: vi.fn(dequeue),
    multiselect: vi.fn(dequeue),
    isCancel: (v: unknown) => v === clk.CANCEL,
  };
});

const { parseRuleList, pickGlobalBlocks, pickGlobalPermissions } = await import(
  "../global-prompts.ts"
);
const { GLOBAL_SAFE_BLOCK_IDS } = await import("../../lib/render-plan.ts");
const { DEFAULT_GLOBAL_BLOCKS } = await import("../../lib/global-config.ts");

beforeEach(() => {
  clk.queue = [];
  clk.calls = [];
});

/** Options a multiselect/confirm/text was called with, by call index. */
function optionsOf(index: number): Record<string, unknown> {
  return clk.calls[index] ?? {};
}

describe("global init — the block picker enumerates globalSafe (#545)", () => {
  it("offers exactly the assets that DECLARE globalSafe, not a hand-written list", async () => {
    clk.queue.push([...DEFAULT_GLOBAL_BLOCKS]);
    await pickGlobalBlocks(DEFAULT_GLOBAL_BLOCKS, "es");

    const offered = (optionsOf(0).options as { value: string }[]).map((o) => o.value);
    expect(offered).toEqual([...GLOBAL_SAFE_BLOCK_IDS]);
    // Every default is offered — the shipped baseline must be reachable from
    // the picker without editing global.json by hand.
    for (const id of DEFAULT_GLOBAL_BLOCKS) expect(offered).toContain(id);
  });

  it("pre-selects the CURRENT selection, so a re-init does not reset it", async () => {
    clk.queue.push(["idioma-rol"]);
    await pickGlobalBlocks(["idioma-rol"], "es");
    expect(optionsOf(0).initialValues).toEqual(["idioma-rol"]);
  });

  it("drops a pre-selected id that is not global-safe (it could never render)", async () => {
    clk.queue.push(["idioma-rol"]);
    await pickGlobalBlocks(["idioma-rol", "tipado-fuerte"], "es");
    expect(optionsOf(0).initialValues).toEqual(["idioma-rol"]);
  });

  it("returns the selection in emission order, not toggle order", async () => {
    // `blocks.include` IS the baseline emission order; a multiselect hands back
    // whatever order the user toggled in. Toggled here in reverse on purpose.
    clk.queue.push(["formato-respuesta", "idioma-rol"]);
    const chosen = await pickGlobalBlocks([], "es");
    expect(chosen).toEqual(["idioma-rol", "formato-respuesta"]);
  });

  it("accepting the pre-checked defaults writes what --recommended writes", async () => {
    // The two paths must converge: a user who runs the wizard and just hits
    // enter has made the SAME choice as `--recommended`, so the baseline it
    // composes has to be byte-identical. Sorting by asset order alone put
    // `orquestacion` first and `operaciones-seguras` last — the inverse of the
    // shipped curation, for an identical selection.
    clk.queue.push([...DEFAULT_GLOBAL_BLOCKS]);
    const chosen = await pickGlobalBlocks(DEFAULT_GLOBAL_BLOCKS, "es");
    expect(chosen).toEqual([...DEFAULT_GLOBAL_BLOCKS]);
  });

  it("orders a non-curated globalSafe block after the curated ones", async () => {
    // The curated array leads; anything else global-safe follows in asset
    // order. Guards the tail of EMISSION_ORDER, which the two cases above
    // never reach.
    const extra = GLOBAL_SAFE_BLOCK_IDS.filter(
      (id) => !DEFAULT_GLOBAL_BLOCKS.includes(id as (typeof DEFAULT_GLOBAL_BLOCKS)[number]),
    );
    if (extra.length === 0) return; // nothing to assert until an asset adds one
    clk.queue.push([extra[0], "idioma-rol"]);
    const chosen = await pickGlobalBlocks([], "es");
    expect(chosen).toEqual(["idioma-rol", extra[0]]);
  });

  it("returns null when the user cancels", async () => {
    clk.queue.push(clk.CANCEL);
    expect(await pickGlobalBlocks(DEFAULT_GLOBAL_BLOCKS, "es")).toBeNull();
  });

  it("every offered block carries copy in BOTH locales", async () => {
    // The hint map is hand-written copy keyed by asset id while the picker
    // enumerates the assets: a NEW globalSafe block would otherwise ship with an
    // id and no explanation, which is the silent aging #541 fixed on the
    // enforcement side. The runtime degrades to no hint; this is what stops the
    // gap from reaching a release unnoticed.
    const { tc } = await import("../../lib/i18n.ts");
    for (const lang of ["es", "en"] as const) {
      for (const id of GLOBAL_SAFE_BLOCK_IDS) {
        expect(tc(lang).global.blockHints[id], `${lang}/${id}`).toBeTruthy();
      }
    }
  });

  it("labels the blocks with a hint in both languages", async () => {
    for (const lang of ["es", "en"] as const) {
      clk.calls = [];
      clk.queue.push([]);
      await pickGlobalBlocks([], lang);
      const options = optionsOf(0).options as { value: string; hint?: string }[];
      const orchestration = options.find((o) => o.value === "orquestacion");
      expect(orchestration?.hint).toBeTruthy();
    }
  });
});

describe("global init — the permissions prompt (#545)", () => {
  it("declining the opt-in PRESERVES what was already declared", async () => {
    // Critical area: an empty answer must never silently drop rules the user
    // declared earlier — `permissions` is what feeds the ownership record.
    const current = { allow: ["Bash(git status:*)"], deny: [], ask: [] };
    clk.queue.push(false);
    expect(await pickGlobalPermissions(current, "es")).toEqual(current);
  });

  it("declining on a fresh install writes no permission at all", async () => {
    clk.queue.push(false);
    expect(await pickGlobalPermissions({ allow: [], deny: [], ask: [] }, "es")).toEqual({
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("asks for the three buckets, pre-filled with what is declared", async () => {
    const current = { allow: ["Read(//tmp/**)"], deny: ["Bash(rm:*)"], ask: [] };
    clk.queue.push(true, "Read(//tmp/**)", "Bash(rm:*)", "Bash(git push:*)");
    const next = await pickGlobalPermissions(current, "es");

    expect(next).toEqual({
      allow: ["Read(//tmp/**)"],
      deny: ["Bash(rm:*)"],
      ask: ["Bash(git push:*)"],
    });
    expect(optionsOf(1).initialValue).toBe("Read(//tmp/**)");
    expect(optionsOf(2).initialValue).toBe("Bash(rm:*)");
    expect(optionsOf(3).initialValue).toBe("");
    // Opting in defaults to yes only when something is already declared.
    expect(optionsOf(0).initialValue).toBe(true);
  });

  it("clearing a bucket removes it — the user saw the value and deleted it", async () => {
    clk.queue.push(true, "", "", "");
    expect(
      await pickGlobalPermissions({ allow: ["Read(//tmp/**)"], deny: [], ask: [] }, "es"),
    ).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("returns null when the user cancels, at the confirm or mid-bucket", async () => {
    clk.queue.push(clk.CANCEL);
    expect(await pickGlobalPermissions({ allow: [], deny: [], ask: [] }, "es")).toBeNull();

    clk.queue.push(true, "Read(//tmp/**)", clk.CANCEL);
    expect(await pickGlobalPermissions({ allow: [], deny: [], ask: [] }, "es")).toBeNull();
  });
});

describe("global init — parseRuleList", () => {
  it("trims, drops empties and de-dupes while keeping the user's order", () => {
    expect(parseRuleList(" Bash(a:*) , Read(b) ,, Bash(a:*) ")).toEqual(["Bash(a:*)", "Read(b)"]);
  });

  it("an empty answer is no rules, not one empty rule", () => {
    expect(parseRuleList("")).toEqual([]);
    expect(parseRuleList("   ")).toEqual([]);
  });
});
