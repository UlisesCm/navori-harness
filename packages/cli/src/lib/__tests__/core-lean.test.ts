import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Core-flaco guard — the core never carries stack domain.
 *
 * A core managed block / agent / skill must hold true for ANY repo regardless
 * of framework. Stack-specific knowledge (mongoose, express, nestjs, mantine…)
 * lives in presets/plugins, never in core. This test fails when a stack token
 * leaks into core-assets/{managed,agents,skills}/ — so the core stays lean and
 * "heavy install" never becomes a function of how many stacks navori supports.
 *
 * The denylist is UNAMBIGUOUS package/tool names, derived from the detector's
 * stack signals (detect.ts) but trimmed to avoid false positives on ordinary
 * prose: we deliberately exclude bare "next" / "react" / "vue" / "solid", which
 * are also common words in Spanish/English.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..", ".."); // packages/cli
const coreAssets = resolve(cliRoot, "..", "core", "core-assets");

// Only CORE is scanned. presets/ and plugins/ are exactly where domain belongs.
const CORE_DIRS = ["managed", "agents", "skills"];

const DOMAIN_DENYLIST = [
  "nestjs",
  "mongoose",
  "mongodb",
  "express",
  "fastify",
  "medusa",
  "keystone",
  "prisma",
  "sequelize",
  "typeorm",
  "mantine",
  "tailwind",
  "redux",
  "zustand",
  "jotai",
  "svelte",
  "sveltekit",
  "astro",
  "remix",
  "angular",
  "qwik",
  "tauri",
  "electron",
  "vite",
  "expo",
  "react-native",
  "nextjs",
  "hono",
  "elysia",
];

function mdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => resolve(dir, f));
}

function collectCoreFiles(): string[] {
  return CORE_DIRS.flatMap((d) => mdFilesIn(resolve(coreAssets, d))).sort();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const files = collectCoreFiles();

describe("core-flaco guard — no stack domain in core", () => {
  it("finds the core asset files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.split("/").slice(-1)[0]!, f] as const))(
    "%s carries no stack-specific token",
    (_name, file) => {
      const text = readFileSync(file, "utf-8");
      const hits = DOMAIN_DENYLIST.filter((tok) =>
        new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i").test(text),
      );
      expect(
        hits,
        `${file} mentions stack token(s) [${hits.join(", ")}] — stack domain belongs in a preset/plugin, not core`,
      ).toEqual([]);
    },
  );
});
