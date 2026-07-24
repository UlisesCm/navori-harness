import { describe, it, expect } from "vitest";
import { mergeFrontmatter } from "../frontmatter-merge.ts";

describe("mergeFrontmatter", () => {
  it("asset wins for keys it declares", () => {
    const asset = { name: "leader", description: "new", model: "opus" };
    const dest = { name: "leader", description: "OLD-USER-EDIT", model: "sonnet" };
    const { merged } = mergeFrontmatter(asset, dest);
    expect(merged.description).toBe("new");
    expect(merged.model).toBe("opus");
  });

  it("preserves dest-only keys (user additions navori didn't ship)", () => {
    const asset = { name: "leader", tools: "Read, Bash" };
    const dest = { name: "leader", tools: "Read, Bash", customField: "x" };
    const { merged } = mergeFrontmatter(asset, dest);
    expect(merged.customField).toBe("x");
  });

  it("serializes asset keys first, then extras (stable order)", () => {
    const asset = { name: "leader", description: "d", tools: "t" };
    const dest = { customField: "c", name: "leader" };
    const { serialized } = mergeFrontmatter(asset, dest);
    expect(serialized).toBe("---\nname: leader\ndescription: d\ntools: t\ncustomField: c\n---");
  });

  it("works when dest has no extras (clean overwrite)", () => {
    const asset = { a: "1", b: "2" };
    const { merged, serialized } = mergeFrontmatter(asset, {});
    expect(merged).toEqual({ a: "1", b: "2" });
    expect(serialized).toBe("---\na: 1\nb: 2\n---");
  });
});
