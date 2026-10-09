import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGlobalLayerLeftovers } from "../global-leftovers.ts";
import { globalLayerLeftoversMessage } from "../../../commands/doctor.ts";
import { tc } from "../../i18n.ts";

/** Spec 0046 D5 — the retired global layer's leftovers, found by `lstat` only. */

let home: string;
let claudeDir: string;

const manifest = (): string => join(home, ".navori", "global.json");
const plugin = (): string => join(claudeDir, "skills", "navori");
const hook = (): string => join(claudeDir, "hooks", "navori-global-baseline.sh");
const plist = (): string => join(home, "Library", "LaunchAgents", "com.navori.audit-collect.plist");

function seed(kind: "manifest" | "plugin" | "hook" | "plist"): void {
  const path = { manifest, plugin, hook, plist }[kind]();
  if (kind === "plugin") {
    mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    writeFileSync(join(path, ".claude-plugin", "plugin.json"), '{"name":"navori"}');
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
}

/** Every path under `dir` with size and mtime, for before/after comparison. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      out.push(`${full}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "navori-leftovers-home-"));
  claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("scanGlobalLayerLeftovers", () => {
  // Covers: R6
  it("reporta cada resto con sus pasos", () => {
    expect(scanGlobalLayerLeftovers({ home, claudeDir })).toEqual([]);
    const cases = [
      ["manifest", "manifest", manifest],
      ["plugin", "plugin", plugin],
      ["hook", "legacy-hook", hook],
      ["plist", "launch-agent", plist],
    ] as const;
    const td = tc("en").doctor;
    for (const [seedKind, kind, path] of cases) {
      seed(seedKind);
      const found = scanGlobalLayerLeftovers({ home, claudeDir });
      expect(found).toEqual([{ kind, path: path() }]);
      expect(globalLayerLeftoversMessage(found, join(claudeDir, "settings.json"), td)).toContain(
        path(),
      );
      rmSync(path(), { recursive: true, force: true });
    }
    for (const [seedKind] of cases) seed(seedKind);
    const all = scanGlobalLayerLeftovers({ home, claudeDir });
    expect(all.map((l) => l.kind).sort()).toEqual(
      ["launch-agent", "legacy-hook", "manifest", "plugin"].sort(),
    );
    const msg = globalLayerLeftoversMessage(all, join(claudeDir, "settings.json"), td);
    const order = ["1. launchctl", "2. in", "3. delete", "4. delete"].map((s) => msg.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(msg).not.toContain("~/.claude");
    expect(msg).toContain(join(claudeDir, "settings.json"));
    // Only the steps that apply: a lone manifest has no launchctl or file-removal step.
    const lone = globalLayerLeftoversMessage(
      [{ kind: "manifest", path: manifest() }],
      join(claudeDir, "settings.json"),
      td,
    );
    expect(lone).not.toContain("launchctl");
    expect(lone).not.toContain("3. delete");
  });

  // Covers: R7
  it("no escribe fuera del repo", () => {
    seed("manifest");
    seed("plugin");
    seed("hook");
    seed("plist");
    // A broken symlink still counts as a leftover.
    rmSync(hook());
    symlinkSync(join(home, "missing"), hook());
    const before = snapshot(home);
    const found = scanGlobalLayerLeftovers({ home, claudeDir });
    expect(found.map((l) => l.kind)).toContain("legacy-hook");
    expect(snapshot(home)).toEqual(before);
  });

  // Covers: R7
  it("un skills/navori sin plugin.json de navori no es resto", () => {
    mkdirSync(join(claudeDir, "skills", "navori"), { recursive: true });
    expect(scanGlobalLayerLeftovers({ home, claudeDir })).toEqual([]);
    mkdirSync(join(claudeDir, "skills", "navori", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(claudeDir, "skills", "navori", ".claude-plugin", "plugin.json"),
      '{"name":"mine"}',
    );
    expect(scanGlobalLayerLeftovers({ home, claudeDir })).toEqual([]);
  });
});
