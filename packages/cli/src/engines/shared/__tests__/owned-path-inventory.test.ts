import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import {
  computeManagedHash,
  extractManagedContent,
  injectManagedSection,
  readMarkerAttrs,
} from "../../../lib/render/marker.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { navoriAuthorship } from "../../../lib/render/removable.ts";
import {
  collectPlan,
  executePlan,
  preparePlan,
  type AdapterCtx,
  type EngineAdapter,
  type PlacementRequest,
  type PreparedDestination,
  type PreparedPlan,
  type CollectedPlan,
  type PendingWrite,
  type SkippedFile,
} from "../execute-plan.ts";
import type { HarnessPlan } from "../harness-plan.ts";
import { OwnedPathInventory, type SealedOwnedPaths } from "../owned-path-inventory.ts";

const EMPTY_PLAN: HarnessPlan = { agents: [], skills: [], hooks: [] };
const META = { source: "@navori/core", version: readCliVersion() };
let cwd: string;

beforeEach((): void => {
  cwd = mkdtempSync(join(tmpdir(), "owned-inventory-"));
});
afterEach((): void => {
  rmSync(cwd, { recursive: true, force: true });
});

function context(): AdapterCtx {
  return {
    cwd,
    repoRoot: cwd,
    isWorkspace: false,
    coreAssets: cwd,
    preset: null,
    plugins: [],
    config: NavoriConfigSchema.parse({
      name: "inventory",
      engines: ["codex"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "true", full: "true" },
    }),
  };
}

function request(path: string, body: string = "body\n"): PlacementRequest {
  return { destRelPath: path, body, managedId: path, commentStyle: "shell" };
}

function adapter(requests: PlacementRequest[]): EngineAdapter {
  return {
    id: "fake",
    placeAgent: (): null => null,
    placeSkill: (): null => null,
    placeHook: (): null => null,
    extraFiles: (): PlacementRequest[] => requests,
    orphanScans: () => [],
  };
}

function guard(): PlacementRequest {
  return {
    ...request("guard.sh"),
    finalize: (inventory: SealedOwnedPaths) => ({ body: `owned='${inventory.value}'\n` }),
  };
}

function existing(path: string, body: string = "body\n", version: string = META.version): string {
  const content = injectManagedSection("", path, body, { ...META, version }, "shell").output;
  writeFileSync(join(cwd, path), content);
  return content;
}

describe("OwnedPathInventory", (): void => {
  // Covers: R8
  it("seals a deduplicated sorted exact union, not foreign selection", (): void => {
    const inventory = new OwnedPathInventory();
    inventory.observe("z/file", "modified");
    inventory.observe("a/file", "newer");
    inventory.observe("a/file", "newer");
    inventory.observe("foreign", "foreign");
    inventory.observe("new", "missing");
    inventory.observe("veto", "missing");
    inventory.exclude("veto");
    const sealed = inventory.seal();
    expect(sealed.paths).toEqual(["a/file", "new", "z/file"]);
    expect(sealed.value).toBe("a/file\nnew\nz/file");
    expect(Object.isFrozen(sealed.paths)).toBe(true);
    expect(inventory.seal()).toBe(sealed);
    expect((): void => inventory.observe("late", "ours")).toThrow("sealed");
    expect((): void => inventory.accept("foreign")).toThrow("sealed");
    expect((): void => inventory.exclude("new")).toThrow("sealed");
  });

  // Covers: R8
  it("unions block observations without erasing conflicting evidence or file vetoes", (): void => {
    const inventory = new OwnedPathInventory();
    inventory.observe("mixed", "ours", "core");
    inventory.observe("mixed", "modified", "edited");
    inventory.observe("mixed", "newer", "newer");
    inventory.observe("mixed", "foreign", "absent");
    expect((): void => inventory.observe("mixed", "ours", "edited")).toThrow("Conflicting");
    inventory.observe("foreign-only", "foreign", "absent");
    inventory.observe("veto", "ours", "core");
    inventory.observe("veto", "foreign", "absent");
    inventory.exclude("veto");
    expect(inventory.seal().paths).toEqual(["mixed"]);
  });

  // Covers: R8
  it("requires observed explicit acquisition and uses the empty sentinel", (): void => {
    const inventory = new OwnedPathInventory();
    expect((): void => inventory.accept("unselected")).toThrow("Unobserved");
    inventory.observe("foreign", "foreign");
    inventory.accept("foreign");
    expect(inventory.seal().paths).toEqual(["foreign"]);
    expect(new OwnedPathInventory().seal().value).toBe("-");
  });

  // Covers: R8
  it.each([
    "",
    "-",
    "/abs",
    "../escape",
    "x/../y",
    "x\ny",
    "x\ry",
    "x\0y",
    "x\\y",
    "x//y",
    "./x",
    "C:/x",
  ])("rejects unsafe serialization %j", (path: string): void => {
    expect((): void => new OwnedPathInventory().observe(path, "ours")).toThrow("Invalid");
  });
});

describe("retained executor inventory", (): void => {
  // Covers: R8
  it("selects once, retains requests, and invokes stateful extraFiles last", (): void => {
    const order: string[] = [];
    const engine = adapter([]);
    engine.placeAgent = vi.fn((): PlacementRequest => {
      order.push("agent");
      return request("agent");
    });
    engine.placeSkill = vi.fn((): PlacementRequest => {
      order.push("skill");
      return request("skill");
    });
    engine.placeHook = vi.fn((): PlacementRequest => {
      order.push("hook");
      return request("hook");
    });
    engine.extraFiles = vi.fn((): PlacementRequest[] => {
      order.push("extra");
      expect(order).toEqual(["agent", "skill", "hook", "extra"]);
      return [guard()];
    });
    const plan: HarnessPlan = {
      agents: [{ id: "a", managedId: "a", assetPath: "unused" }],
      skills: [{ id: "s", managedId: "s", assetPath: "unused" }],
      hooks: [{ id: "h", managedId: "h", assetPath: "unused" }],
    };
    const prepared = preparePlan(plan, engine, context(), { prune: false });
    expect(
      prepared.requests.map((req: Readonly<PlacementRequest>): string => req.destRelPath),
    ).toEqual(["agent", "skill", "hook", "guard.sh"]);
    const final = prepared.finalize();
    expect(prepared.finalize()).toBe(final);
    expect(engine.extraFiles).toHaveBeenCalledTimes(1);
    expect(final.pending.at(-1)?.content).toContain("agent\nguard.sh\nhook\nskill");
    expect(existsSync(join(cwd, "agent"))).toBe(false);
  });

  // Covers: R8
  it("observes unchanged, edited and newer ownership without granting overwrite", (): void => {
    existing("unchanged");
    const edited = existing("edited").replace("body", "edited");
    writeFileSync(join(cwd, "edited"), edited);
    existing("newer", "body\n", "999.0.0");
    writeFileSync(join(cwd, "foreign"), "user content");
    const inventory = new OwnedPathInventory();
    const prepared = preparePlan(
      EMPTY_PLAN,
      adapter([
        request("unchanged"),
        request("edited"),
        request("newer"),
        request("foreign"),
        guard(),
      ]),
      context(),
      { prune: false, inventory },
    );
    expect(
      prepared.destinations.map((dest: PreparedDestination): string => dest.authorship),
    ).toEqual(["ours", "modified", "newer", "foreign", "missing"]);
    const final = prepared.finalize();
    expect(inventory.seal().paths).toEqual(["edited", "guard.sh", "newer", "unchanged"]);
    expect(
      final.pending.some((pending: PendingWrite): boolean => pending.relPath === "unchanged"),
    ).toBe(false);
    expect(
      final.skipped.find((skip: SkippedFile): boolean => skip.path === "newer")?.resolution,
    ).toBeUndefined();
    expect(
      final.skipped.find((skip: SkippedFile): boolean => skip.path === "edited")?.resolution?.basis,
    ).toBe(edited);
    expect(readFileSync(join(cwd, "foreign"), "utf-8")).toBe("user content");
  });

  // Covers: R8
  it.each([false, true])(
    "retains mixed block classifications with shared producers=%s without acquiring a missing subblock",
    (shared: boolean): void => {
      const path = "mixed.sh";
      const assetPath = join(cwd, "plugin-source.sh");
      writeFileSync(assetPath, "replacement\n");
      let basis = injectManagedSection(
        "user preamble\n",
        "core",
        "core body\n",
        META,
        "shell",
      ).output;
      basis = injectManagedSection(basis, "edited", "plugin body\n", META, "shell").output;
      basis = injectManagedSection(
        basis,
        "newer",
        "future body\n",
        { ...META, version: "999.0.0" },
        "shell",
      ).output.replace("plugin body", "user-edited plugin body");
      writeFileSync(join(cwd, path), basis);
      const requests: PlacementRequest[] = [
        { ...request(path, "core body\n"), managedId: "core" },
        ...["edited", "newer", "absent"].map((managedId: string): PlacementRequest => ({
          ...request(path),
          managedId,
          assetPath,
          meta: { source: "@navori/plugin-test", version: META.version },
        })),
      ];
      const inventory = new OwnedPathInventory();
      const groups = shared
        ? requests.map((req: PlacementRequest): PlacementRequest[] => [req])
        : [requests];
      const prepared = groups.map((group: PlacementRequest[]): PreparedPlan =>
        preparePlan(EMPTY_PLAN, adapter(group), context(), { inventory, prune: false }),
      );
      const destinations = prepared.flatMap(
        (producer: PreparedPlan): readonly PreparedDestination[] => producer.destinations,
      );
      expect(destinations.map((dest: PreparedDestination): string => dest.managedId)).toEqual([
        "core",
        "edited",
        "newer",
        "absent",
      ]);
      expect(destinations.map((dest: PreparedDestination): string => dest.authorship)).toEqual([
        "ours",
        "modified",
        "newer",
        "foreign",
      ]);
      expect(destinations.every((dest: PreparedDestination): boolean => dest.basis === basis)).toBe(
        true,
      );
      const results = prepared.map((producer: PreparedPlan): CollectedPlan => producer.finalize());
      expect(inventory.seal().paths).toEqual([path]);
      expect(results.flatMap((result: CollectedPlan): PendingWrite[] => result.pending)).toEqual(
        [],
      );
      expect(results.flatMap((result: CollectedPlan) => result.removals)).toEqual([]);
      const skipped = results.flatMap((result: CollectedPlan): SkippedFile[] => result.skipped);
      expect(skipped.map((skip: SkippedFile): string | undefined => skip.status)).toEqual([
        "user-modified-skipped",
        "downgrade-skipped",
        "user-modified-skipped",
      ]);
      expect(skipped[0]?.resolution?.basis).toBe(basis);
      for (const skip of skipped.slice(1)) {
        expect(skip.resolution).toBeUndefined();
        expect(skip.markerlessResolution).toBeUndefined();
      }
      expect(readFileSync(join(cwd, path), "utf-8")).toBe(basis);
      expect(navoriAuthorship(join(cwd, path), "absent", { verifyHash: true })).toBe("foreign");
    },
  );

  // Covers: R8
  it("checks each mixed producer's retained basis before materialization", (): void => {
    const path = "mixed.sh";
    const basis = injectManagedSection("", "core", "core body\n", META, "shell").output;
    writeFileSync(join(cwd, path), basis);
    const inventory = new OwnedPathInventory();
    const materialize = vi.fn(() => ({ body: "unreachable" }));
    const first = preparePlan(
      EMPTY_PLAN,
      adapter([{ ...request(path, "core body\n"), managedId: "core" }]),
      context(),
      { inventory, prune: false },
    );
    const second = preparePlan(
      EMPTY_PLAN,
      adapter([{ ...request(path), managedId: "absent", finalize: materialize }]),
      context(),
      { inventory, prune: false },
    );
    first.finalize();
    writeFileSync(join(cwd, path), `${basis}user change\n`);
    expect(() => second.finalize()).toThrow("Prepared destination changed");
    expect(materialize).not.toHaveBeenCalled();
  });

  // Covers: R8
  it("defers materialization until all target engines and acquisitions are known", (): void => {
    writeFileSync(join(cwd, "acquired"), "user body");
    const inventory = new OwnedPathInventory();
    const materialize = vi.fn((paths: SealedOwnedPaths) => ({ body: paths.value }));
    const first = preparePlan(
      EMPTY_PLAN,
      adapter([{ ...guard(), finalize: materialize }]),
      context(),
      { inventory, prune: false },
    );
    const second = preparePlan(
      EMPTY_PLAN,
      adapter([request("acquired"), request("other")]),
      context(),
      { inventory, prune: false },
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(second.destinations[0]?.basis).toBe("user body");
    inventory.accept("acquired");
    const final = first.finalize();
    second.finalize();
    expect(materialize).toHaveBeenCalledTimes(1);
    const content = final.pending[0]?.content ?? "";
    expect(content).toContain("acquired\nguard.sh\nother");
    const body = extractManagedContent(content, "guard.sh", "shell");
    expect(readMarkerAttrs(content, "guard.sh", "shell")?.existingHash).toBe(
      computeManagedHash(body ?? ""),
    );
    expect(() =>
      preparePlan(EMPTY_PLAN, adapter([request("late")]), context(), { inventory }),
    ).toThrow("sealed");
  });

  // Covers: R8
  it("finalizes forced guard resolutions with final paths, preserving the basis", (): void => {
    const basis = existing("guard.sh", "old guard\n").replace("old guard", "user edit");
    writeFileSync(join(cwd, "guard.sh"), basis);
    const prepared = preparePlan(EMPTY_PLAN, adapter([guard(), request("later")]), context(), {
      prune: false,
    });
    const resolution = prepared.finalize().skipped[0]?.resolution;
    expect(resolution?.basis).toBe(basis);
    expect(resolution?.content).toContain("guard.sh\nlater");
    const body = extractManagedContent(resolution?.content ?? "", "guard.sh", "shell");
    expect(readMarkerAttrs(resolution?.content ?? "", "guard.sh", "shell")?.existingHash).toBe(
      computeManagedHash(body ?? ""),
    );
    expect(readFileSync(join(cwd, "guard.sh"), "utf-8")).toBe(basis);
  });

  // Covers: R8
  it("interpolates asset guard paths before hashing and defers markerless acquisition", (): void => {
    const assetPath = join(cwd, "source.sh");
    writeFileSync(assetPath, "owned={{shq:navoriOwnedPaths}}\n");
    writeFileSync(join(cwd, "guard.sh"), "foreign guard\n");
    const inventory = new OwnedPathInventory();
    const materialize = vi.fn((paths: SealedOwnedPaths): Pick<PlacementRequest, "extraVars"> => ({
      extraVars: { navoriOwnedPaths: paths.value },
    }));
    const prepared = preparePlan(
      EMPTY_PLAN,
      adapter([
        {
          ...request("guard.sh"),
          assetPath,
          body: undefined,
          meta: { source: "@navori/plugin-test", version: META.version },
          finalize: materialize,
        },
        request("quote's path"),
      ]),
      context(),
      { inventory, prune: false },
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(prepared.destinations[0]?.authorship).toBe("foreign");
    inventory.accept("guard.sh");
    const final = prepared.finalize();
    expect(final.pending.map((pending: PendingWrite): string => pending.relPath)).toEqual([
      "quote's path",
    ]);
    const resolution = final.skipped[0]?.markerlessResolution;
    expect(resolution?.basis).toBe("foreign guard\n");
    expect(resolution?.content).toContain("guard.sh\nquote");
    expect(resolution?.content).not.toContain("not configured");
    const body = extractManagedContent(resolution?.content ?? "", "guard.sh", "shell");
    expect(readMarkerAttrs(resolution?.content ?? "", "guard.sh", "shell")?.existingHash).toBe(
      computeManagedHash(body ?? ""),
    );
    expect(readFileSync(join(cwd, "guard.sh"), "utf-8")).toBe("foreign guard\n");
  });

  // Covers: R8
  it("excludes a foreign plugin collision without acceptance", (): void => {
    const assetPath = join(cwd, "source.sh");
    writeFileSync(assetPath, "new body\n");
    writeFileSync(join(cwd, "foreign"), "user body\n");
    const prepared = preparePlan(
      EMPTY_PLAN,
      adapter([
        {
          ...request("foreign"),
          assetPath,
          meta: { source: "@navori/plugin-test", version: META.version },
        },
        guard(),
      ]),
      context(),
      { prune: false },
    );
    const final = prepared.finalize();
    expect(prepared.inventory.seal().paths).toEqual(["guard.sh"]);
    expect(final.skipped[0]?.markerlessResolution?.basis).toBe("user body\n");
    expect(
      final.pending.some((pending: PendingWrite): boolean => pending.relPath === "foreign"),
    ).toBe(false);
  });

  // Covers: R8
  it("refuses a changed decision basis before materialization or writes", (): void => {
    writeFileSync(join(cwd, "acquired"), "basis");
    const materialize = vi.fn(() => ({ body: "final" }));
    const prepared = preparePlan(
      EMPTY_PLAN,
      adapter([request("acquired"), { ...guard(), finalize: materialize }]),
      context(),
      { prune: false },
    );
    prepared.inventory.accept("acquired");
    writeFileSync(join(cwd, "acquired"), "changed");
    expect(() => prepared.finalize()).toThrow("Prepared destination changed");
    expect(materialize).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "guard.sh"))).toBe(false);
  });

  // Covers: R8
  it("does not permit a materializer to change selected placement identity", (): void => {
    const prepared = preparePlan(
      EMPTY_PLAN,
      adapter([
        {
          ...guard(),
          finalize: (): { body: string; destRelPath: string; managedId: string } => ({
            body: "final",
            destRelPath: "unselected",
            managedId: "unselected",
          }),
        },
      ]),
      context(),
      { prune: false },
    );
    const final = prepared.finalize();
    expect(final.pending[0]?.relPath).toBe("guard.sh");
    expect(readMarkerAttrs(final.pending[0]?.content ?? "", "guard.sh", "shell")).not.toBeNull();
    expect(prepared.inventory.seal().paths).toEqual(["guard.sh"]);
  });

  // Covers: R8
  it("direct dry-run has a local inventory and no preview filesystem effects", (): void => {
    const before = existing("own");
    const engine = adapter([request("own"), guard()]);
    const extras = vi.spyOn(engine, "extraFiles");
    executePlan(EMPTY_PLAN, engine, context(), { dryRun: true, prune: false });
    expect(extras).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cwd, "guard.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".navori"))).toBe(false);
    expect(readFileSync(join(cwd, "own"), "utf-8")).toBe(before);
  });

  // Covers: R8
  it("rejects late registration before committing any earlier pending operation", (): void => {
    const inventory = new OwnedPathInventory();
    const engine = adapter([
      request("first"),
      {
        ...guard(),
        finalize: (): Pick<PlacementRequest, "body"> => {
          inventory.observe("late", "missing");
          return { body: "unreachable" };
        },
      },
    ]);
    expect((): void => {
      executePlan(EMPTY_PLAN, engine, context(), { inventory, prune: false });
    }).toThrow("sealed");
    expect(existsSync(join(cwd, "first"))).toBe(false);
    expect(existsSync(join(cwd, "guard.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".navori"))).toBe(false);
  });

  // Covers: R8
  it("direct apply hashes final guard bytes while legacy collection stays unchanged", (): void => {
    const engine = adapter([request("own"), guard()]);
    executePlan(EMPTY_PLAN, engine, context(), { prune: false });
    const content = readFileSync(join(cwd, "guard.sh"), "utf-8");
    expect(content).toContain("guard.sh\nown");
    expect(navoriAuthorship(join(cwd, "guard.sh"), "guard.sh", { verifyHash: true })).toBe("ours");
    const collected = collectPlan(EMPTY_PLAN, adapter([request("own")]), context(), {
      prune: false,
    });
    expect(collected.pending).toEqual([]);
    expect(collected.skipped).toEqual([]);
  });
});
