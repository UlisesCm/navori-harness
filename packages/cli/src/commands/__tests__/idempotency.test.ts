import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../render.ts";

/**
 * Spec 0003 §3.1.2 — idempotency is a class-A regression guard.
 * `navori render` is idempotent by construction (managed markers + hashes),
 * but "by construction" rots silently when a template refactor changes
 * byte-for-byte output. This test makes the guarantee explicit: render twice,
 * the generated tree must be identical bit-for-bit and the second pass must
 * report zero writes.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-idempotency-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Snapshot every render output under `root` as a path→content map. Excludes
 * `navori.config.json` (the input, not an output) so the comparison is purely
 * about what the render produced.
 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (rel === "navori.config.json") continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out[rel] = readFileSync(abs, "utf-8");
      }
    }
  };
  walk(root);
  return out;
}

/** Render once to seed, then render again and assert nothing changed. */
function assertIdempotent(seed: () => void): void {
  seed();

  const first = runRender(cwd);
  expect(first.ok).toBe(true);
  const snapshotA = snapshotTree(cwd);
  expect(Object.keys(snapshotA).length).toBeGreaterThan(0);

  const second = runRender(cwd);
  expect(second.ok).toBe(true);

  // Second pass must be a no-op: no root write, no workspace write.
  expect(second.written).toBe(false);
  expect(second.workspaces.every((w) => !w.written)).toBe(true);

  // No entry may report a mutation on the second pass.
  const mutatingStatuses = ["created", "updated", "removed-condition-false"];
  for (const e of second.entries) {
    expect(mutatingStatuses).not.toContain(e.status);
  }

  // The bytes on disk must be identical.
  const snapshotB = snapshotTree(cwd);
  expect(snapshotB).toEqual(snapshotA);
}

describe("render idempotency (spec 0003 §3.1.2)", () => {
  it("single-app (custom preset): second render is a byte-for-byte no-op", () => {
    assertIdempotent(() => {
      writeConfig(join(cwd, "navori.config.json"), {
        name: "single-app",
        engines: ["claude"],
        preset: "custom",
        qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      });
    });
  });

  it("preset with extras (nextjs): second render is a byte-for-byte no-op", () => {
    assertIdempotent(() => {
      writeConfig(join(cwd, "navori.config.json"), {
        name: "next-app",
        engines: ["claude"],
        preset: "nextjs",
        qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      });
    });
  });

  it("monorepo (root + workspaces): second render is a byte-for-byte no-op", () => {
    assertIdempotent(() => {
      mkdirSync(join(cwd, "apps/backend"), { recursive: true });
      mkdirSync(join(cwd, "apps/web"), { recursive: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "monorepo-demo",
        engines: ["claude"],
        preset: "monorepo-pnpm",
        qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
        monorepo: {
          enabled: true,
          tool: "pnpm",
          workspaces: [
            { name: "backend", path: "apps/backend" },
            { name: "web", path: "apps/web" },
          ],
        },
      });
    });
  });
});
