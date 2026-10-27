import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readConfig } from "../lib/config/config.ts";
import { renderManagedFile } from "../engines/shared/render-managed-file.ts";
import { finalizeNativeHooks } from "../lib/render/native-hook-render.ts";
import {
  loadNativeHooks,
  sha256,
  type NativeEngine,
  type NativeHook,
} from "../lib/render/native-hook.ts";
import {
  computeManagedHash,
  readMarkerAttrs,
  setMarkerFloorVersion,
} from "../lib/render/marker.ts";
import { readCliVersion } from "../lib/render/bundled-assets.ts";
import type { HookExtensionPending } from "../engines/shared/hook-extension.ts";
import { loadEnabledPlugins } from "../lib/config/plugins.ts";
import { injectManagedSection } from "../lib/render/marker.ts";
import { applyNativeClaudeSettings, claudeHookCommand } from "../engines/claude/build-settings.ts";
import { mergeCoexistSettings } from "../engines/claude/coexist-settings.ts";
import { planStampedJson } from "../lib/primitives/json-ownership.ts";
import { pluginScriptManagedId } from "../engines/shared/plugin-scripts.ts";

const dirs: string[] = [];
afterEach((): void => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const config = readConfig(
  resolve(
    import.meta.dirname,
    "../../../../scripts/js/rust-oracle/fixtures/fresh-init/navori.config.json",
  ),
);
const source = "#!/bin/sh\nprintf 'shell'\n# navori:user-section\n# user default\n";
const descriptor = (): NativeHook => ({
  mode: "shadow",
  gating: true,
  blocks: { "example-base": sha256(source) },
  deps: {},
  impl: `sha256:${"a".repeat(64)}`,
});

function fixture(engine: NativeEngine): {
  cwd: string;
  assetPath: string;
  target: string;
  content: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), "native-hook-"));
  dirs.push(cwd);
  const assetPath = join(cwd, "asset.sh");
  writeFileSync(assetPath, source);
  const target = engine === "pi" ? ".pi/navori/hooks/example.sh" : `.${engine}/hooks/example.sh`;
  mkdirSync(join(cwd, target, ".."), { recursive: true });
  const content = renderManagedFile({
    assetPath,
    existingContent: null,
    managedId: "example-base",
    meta: { source: "@navori/core", version: readCliVersion() },
    config,
    engine,
  }).content;
  return { cwd, assetPath, target, content };
}

describe("native hook rendering", (): void => {
  // Covers: R13
  it("envuelve un bloque antiguo con versión actual aunque el floor ya sea actual", (): void => {
    const currentVersion = readCliVersion();
    setMarkerFloorVersion(currentVersion);
    try {
      for (const engine of ["claude", "codex", "pi"] as const) {
        const f = fixture(engine);
        const legacy = f.content.replace(`version="${currentVersion}"`, 'version="0.11.0"');
        expect(readMarkerAttrs(legacy, "example-base", "shell")?.existingVersion).toBe("0.11.0");
        writeFileSync(join(f.cwd, f.target), legacy);
        const pending: HookExtensionPending[] = [];
        const input = {
          ...f,
          config: { ...config, harnessVersion: currentVersion },
          engine,
          pending,
          hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
          plugins: [],
          manifest: { example: descriptor() },
        };
        expect(finalizeNativeHooks(input).has(f.target)).toBe(true);
        const signed = pending[0]?.content ?? "";
        expect(signed).toContain("native-runtime start");
        const attrs = readMarkerAttrs(signed, "example-base", "shell");
        expect(attrs?.existingVersion).toBe(currentVersion);
        const start = signed.indexOf("\n", signed.indexOf("# navori:managed start")) + 1;
        const end = signed.indexOf('# navori:managed end id="example-base"');
        expect(end).toBeGreaterThan(start);
        expect(attrs?.existingHash).toBe(computeManagedHash(signed.slice(start, end)));
        writeFileSync(join(f.cwd, f.target), signed);
        pending.splice(0);
        expect(finalizeNativeHooks(input).has(f.target)).toBe(true);
        expect(pending).toEqual([]);
        expect(readFileSync(join(f.cwd, f.target), "utf8")).toBe(signed);
      }
    } finally {
      setMarkerFloorVersion(undefined);
    }
  });

  // Covers: R13
  it("un noop de settings no autoriza cambiar una versión o floor más nuevos", (): void => {
    const f = fixture("claude");
    for (const [version, floor] of [
      ["99.0.0", readCliVersion()],
      [readCliVersion(), "99.0.0"],
    ]) {
      const settings = {
        $navori: { managed: true, version: readCliVersion() },
        hooks: {
          PreToolUse: [{ hooks: [{ command: claudeHookCommand("PreToolUse", f.target) }] }],
        },
      };
      const desired = JSON.stringify(settings, null, 2) + "\n";
      settings.$navori.version = version ?? "99.0.0";
      const current = JSON.stringify(settings, null, 2) + "\n";
      expect(planStampedJson(current, desired, readCliVersion(), floor).kind).toBe("noop");
      const path = join(f.cwd, ".claude/settings.json");
      writeFileSync(path, current);
      const pending: HookExtensionPending[] = [];
      applyNativeClaudeSettings(f.cwd, pending, new Map([[f.target, descriptor()]]), "noop", floor);
      expect(pending).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(current);
    }
  });

  // Covers: R13
  it("no reabre un marker firmado alterado ni normaliza sus bytes para volverlo conforme", (): void => {
    const f = fixture("codex");
    const pending: HookExtensionPending[] = [
      { path: join(f.cwd, f.target), content: f.content, status: "created" },
    ];
    const input = {
      ...f,
      config,
      engine: "codex" as const,
      pending,
      hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
      plugins: [],
      manifest: { example: descriptor() },
    };
    finalizeNativeHooks(input);
    const signed = pending[0]?.content ?? "";
    for (const tampered of [
      signed.replace(/hash="[a-f0-9]{8}"/, 'hash="00000000"'),
      signed.replace("printf 'shell'", "printf 'shell' "),
      signed.replace(/\n/g, "\r\n"),
    ]) {
      pending.splice(0);
      writeFileSync(join(f.cwd, f.target), tampered);
      expect(finalizeNativeHooks(input).size).toBe(0);
      expect(pending).toEqual([]);
      expect(readFileSync(join(f.cwd, f.target), "utf8")).toBe(tampered);
    }
  });
  // Covers: R13
  it("respeta settings omitidos por el plan y enlaces de su directorio", (): void => {
    const f = fixture("claude");
    const path = join(f.cwd, ".claude/settings.json");
    const content = JSON.stringify({
      $navori: { managed: true, version: "99.0.0" },
      hooks: { PreToolUse: [{ hooks: [{ command: claudeHookCommand("PreToolUse", f.target) }] }] },
    });
    writeFileSync(path, content);
    const pending: HookExtensionPending[] = [];
    applyNativeClaudeSettings(f.cwd, pending, new Map([[f.target, descriptor()]]), "skip");
    expect(pending).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(content);
    rmSync(path);
    symlinkSync(join(f.cwd, "asset.sh"), path);
    applyNativeClaudeSettings(f.cwd, pending, new Map([[f.target, descriptor()]]), "noop");
    expect(pending).toEqual([]);
    expect(readFileSync(f.assetPath, "utf8")).toBe(source);
  });

  // Covers: R13
  it("tracking coexist sigue el comando nativo y lo retira al deshabilitarlo", (): void => {
    const f = fixture("claude");
    const legacy = claudeHookCommand("PreToolUse", f.target);
    const current = mergeCoexistSettings(
      { custom: "keep" },
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: legacy }] }] } },
    );
    const pending: HookExtensionPending[] = [
      {
        path: join(f.cwd, ".claude/settings.json"),
        content: JSON.stringify(current, null, 2) + "\n",
        status: "created",
      },
    ];
    applyNativeClaudeSettings(f.cwd, pending, new Map([[f.target, descriptor()]]), "write");
    const native = JSON.parse(pending[0]?.content ?? "{}") as Record<string, unknown>;
    expect(native.$navori).toMatchObject({
      managedHooks: [claudeHookCommand("PreToolUse", f.target, undefined, descriptor())],
    });
    const disabled = mergeCoexistSettings(native, { hooks: {} });
    expect(disabled.custom).toBe("keep");
    expect(JSON.stringify(disabled)).not.toContain("native-runtime start");
    expect(JSON.stringify(disabled)).not.toContain("example.sh");
  });
  // Covers: R13
  it("incluye cada bloque de plugin y cada dependencia en la conformidad", (): void => {
    const f = fixture("codex");
    const base = loadEnabledPlugins({ tgrep: { enabled: true } }).loaded[0];
    if (!base) throw new Error("tgrep fixture unavailable");
    const body = "printf 'extension'\n";
    const asset = join(f.cwd, "extension.sh");
    writeFileSync(asset, body);
    const depSource = join(f.cwd, "dep-source.sh");
    writeFileSync(depSource, "dep\n");
    const plugin = {
      ...base,
      scriptAssets: [{ src: depSource, dest: "dep.sh", exec: true }],
      hookExtensionAssets: [{ id: "extra", target: ".claude/hooks/example.sh", absPath: asset }],
    };
    const content = injectManagedSection(
      f.content,
      "extra",
      body,
      { source: "@navori/plugin-tgrep", version: readCliVersion() },
      "shell",
    ).output;
    // The deployed script is the plugin's managed render of its source; `deps` pins the source.
    const dep = join(f.cwd, ".codex/scripts/dep.sh");
    mkdirSync(join(dep, ".."), { recursive: true });
    const deployed = renderManagedFile({
      assetPath: depSource,
      existingContent: null,
      managedId: pluginScriptManagedId("tgrep", "dep.sh"),
      meta: { source: "@navori/plugin-tgrep", version: "0.11.3" },
      config,
      engine: "codex",
      commentStyle: "shell",
    }).content;
    writeFileSync(dep, deployed);
    const hook = {
      ...descriptor(),
      blocks: { ...descriptor().blocks, extra: sha256(body) },
      deps: { "scripts/dep.sh": sha256("dep\n") },
    };
    const pending: HookExtensionPending[] = [
      { path: join(f.cwd, f.target), content, status: "created" },
    ];
    const input = {
      ...f,
      config,
      engine: "codex" as const,
      pending,
      hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
      plugins: [plugin],
      manifest: { example: hook },
    };
    expect(finalizeNativeHooks(input).has(f.target)).toBe(true);
    const signed = pending[0]?.content ?? "";
    const declared = /^# navori:native-hook v=1 file=(sha256:[a-f0-9]{64})/.exec(signed)?.[1];
    const zeroed = signed.replace(/file=sha256:[a-f0-9]{64}/, `file=sha256:${"0".repeat(64)}`);
    expect(sha256(Buffer.concat([Buffer.from(zeroed), Buffer.from(deployed)]))).toBe(declared);
    for (const [path, edit] of [
      [dep, deployed.replace("dep\n", "changed\n")],
      [dep, "dep\n"],
      [depSource, "changed\n"],
      [asset, body + "# changed\n"],
    ] as const) {
      const original = readFileSync(path, "utf8");
      pending[0] = { path: join(f.cwd, f.target), content, status: "created" };
      writeFileSync(path, edit);
      expect(finalizeNativeHooks(input).size, `${path}: ${edit}`).toBe(0);
      writeFileSync(path, original);
    }
  });

  // Covers: R13
  it("la referencia usa los extraVars finales de la colocación, como el render real", (): void => {
    const templated = "#!/bin/sh\nowned={{shq:navoriOwnedPaths}}\n# navori:user-section\n";
    const f = fixture("claude");
    writeFileSync(f.assetPath, templated);
    const vars = { navoriOwnedPaths: "CLAUDE.md\nAGENTS.md" };
    const content = renderManagedFile({
      assetPath: f.assetPath,
      existingContent: null,
      managedId: "example-base",
      meta: { source: "@navori/core", version: readCliVersion() },
      config,
      extraVars: vars,
      engine: "claude",
    }).content;
    expect(content).toContain("owned='CLAUDE.md\nAGENTS.md'");
    const input = (renderVars?: ReadonlyMap<string, Record<string, string>>) => ({
      ...f,
      config,
      engine: "claude" as const,
      pending: [{ path: join(f.cwd, f.target), content, status: "created" as const }],
      hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
      plugins: [],
      manifest: { example: { ...descriptor(), blocks: { "example-base": sha256(templated) } } },
      renderVars,
    });
    // Without the placement's variables the fresh reference holds the default and differs.
    expect(finalizeNativeHooks(input()).size).toBe(0);
    expect(finalizeNativeHooks(input(new Map([[f.target, { navoriOwnedPaths: "-" }]]))).size).toBe(
      0,
    );
    expect(finalizeNativeHooks(input(new Map([[f.target, vars]]))).has(f.target)).toBe(true);
  });

  // Covers: R13
  it("una raíz hooks enlazada a otro proyecto del mismo engine nunca se firma", (): void => {
    const f = fixture("claude");
    const outside = mkdtempSync(join(tmpdir(), "native-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "example.sh"), f.content);
    rmSync(join(f.cwd, ".claude/hooks"), { recursive: true });
    symlinkSync(outside, join(f.cwd, ".claude/hooks"), "dir");
    const pending: HookExtensionPending[] = [];
    expect(
      finalizeNativeHooks({
        ...f,
        config,
        engine: "claude",
        pending,
        hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
        plugins: [],
        manifest: { example: descriptor() },
      }).size,
    ).toBe(0);
    expect(pending).toEqual([]);
    expect(readFileSync(join(outside, "example.sh"), "utf8")).toBe(f.content);
  });
  // Covers: R13
  it("manifiesto sin hooks renderiza igual que dev", (): void => {
    for (const engine of ["claude", "codex", "pi"] as const) {
      const f = fixture(engine);
      const pending: HookExtensionPending[] = [
        { path: join(f.cwd, f.target), content: f.content, status: "created" },
      ];
      expect(
        finalizeNativeHooks({
          ...f,
          config,
          engine,
          pending,
          hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
          plugins: [],
          manifest: {},
        }).size,
      ).toBe(0);
      expect(pending[0]?.content).toBe(f.content);
    }
  });

  // Covers: R11, R13
  it("firma fuera del marker y conserva su hash canónico sin ciclos", (): void => {
    for (const engine of ["claude", "codex", "pi"] as const) {
      const f = fixture(engine);
      const pending: HookExtensionPending[] = [
        { path: join(f.cwd, f.target), content: f.content, status: "created" },
      ];
      const input = {
        ...f,
        config,
        engine,
        pending,
        hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
        plugins: [],
        manifest: { example: descriptor() },
      };
      expect(finalizeNativeHooks(input).has(f.target)).toBe(true);
      const signed = pending[0]?.content ?? "";
      expect(signed).toMatch(
        /^# navori:native-hook v=1 file=sha256:[a-f0-9]{64} impl=sha256:a{64}\n# navori:managed/,
      );
      const start = signed.indexOf("\n", signed.indexOf("# navori:managed start")) + 1;
      const end = signed.indexOf('# navori:managed end id="example-base"');
      expect(readMarkerAttrs(signed, "example-base", "shell")?.existingHash).toBe(
        computeManagedHash(signed.slice(start, end)),
      );
      const hash = /^# navori:native-hook v=1 file=(sha256:[a-f0-9]{64})/.exec(signed)?.[1];
      expect(
        sha256(signed.replace(/file=sha256:[a-f0-9]{64}/, `file=sha256:${"0".repeat(64)}`)),
      ).toBe(hash);
      writeFileSync(join(f.cwd, f.target), signed);
      pending.splice(0);
      expect(finalizeNativeHooks(input).has(f.target)).toBe(true);
      expect(pending).toEqual([]);
    }
  });

  // Covers: R13
  it("una edición de usuario, bloque ajeno, asset viejo o versión más nueva difiere al shell", (): void => {
    const f = fixture("codex");
    for (const content of [
      f.content + "# user change\n",
      f.content.replace("shell", "SHELL"),
      f.content.replace(/version="[^"]+"/, 'version="99.0.0"'),
      f.content + '# navori:managed start id="foreign"\nx\n# navori:managed end id="foreign"\n',
    ]) {
      const pending: HookExtensionPending[] = [
        { path: join(f.cwd, f.target), content, status: "created" },
      ];
      expect(
        finalizeNativeHooks({
          ...f,
          config,
          engine: "codex",
          pending,
          hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
          plugins: [],
          manifest: { example: descriptor() },
        }).size,
      ).toBe(0);
      expect(pending[0]?.content).toBe(content);
    }
    writeFileSync(f.assetPath, source + "# changed source\n");
    const pending: HookExtensionPending[] = [
      { path: join(f.cwd, f.target), content: f.content, status: "created" },
    ];
    expect(
      finalizeNativeHooks({
        ...f,
        config,
        engine: "codex",
        pending,
        hooks: [{ id: "example", assetPath: f.assetPath, managedId: "example-base" }],
        plugins: [],
        manifest: { example: descriptor() },
      }).size,
    ).toBe(0);
  });

  // Covers: R13
  it("el loader falla al shell ante un manifiesto ausente o con hash incompleto", (): void => {
    const f = fixture("claude");
    expect(loadNativeHooks(join(f.cwd, "missing.json"))).toEqual({});
    const path = join(f.cwd, "ported.json");
    writeFileSync(
      path,
      JSON.stringify({ schema: 1, hooks: { example: { ...descriptor(), impl: "sha256:short" } } }),
    );
    expect(loadNativeHooks(path)).toEqual({});
  });

  // Covers: R13
  it("actualiza solo comandos Claude generados y retira el brazo cuando deja de ser conforme", (): void => {
    const f = fixture("claude");
    const legacy = claudeHookCommand("PreToolUse", f.target);
    const custom = 'echo "custom"';
    const settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: legacy },
              { type: "command", command: custom },
            ],
          },
        ],
      },
    };
    const path = join(f.cwd, ".claude/settings.json");
    const pending: HookExtensionPending[] = [
      { path, content: JSON.stringify(settings, null, 2) + "\n", status: "created" },
    ];
    applyNativeClaudeSettings(f.cwd, pending, new Map([[f.target, descriptor()]]), "write");
    expect(pending[0]?.content).toContain("native-runtime start");
    expect(pending[0]?.content).toContain(custom.replaceAll('"', '\\"'));
    const signed = pending[0]?.content ?? "";
    writeFileSync(path, signed);
    pending.splice(0);
    applyNativeClaudeSettings(f.cwd, pending, new Map(), "noop");
    expect(pending[0]?.content).toBe(JSON.stringify(settings, null, 2) + "\n");
    expect(readFileSync(path, "utf8")).toBe(signed);
  });
});
