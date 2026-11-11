import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

interface Manifest {
  commands: { path: string[] }[];
  hooks: Record<
    string,
    { mode?: string; blocks: Record<string, string>; deps?: Record<string, string>; impl: string }
  >;
}
interface CommandEntry {
  path: string[];
  flags?: string[];
  requires?: string[][];
  when?: { engines?: string[] };
}
interface CommandManifest {
  schema: number;
  commands: CommandEntry[];
}
interface ManifestCheck {
  checkHistory: (
    before: Manifest,
    after: Manifest,
    previous: string,
    current: string,
    now?: number,
  ) => string[];
  checkHashes: (root: string, manifest: Manifest) => void;
  checkCommands: (manifest: CommandManifest) => void;
  implementationHash: (root: string, id: string) => string;
}
const checks = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/rust-manifest-check.mjs")).href
)) as ManifestCheck;
const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const manifest = (commands: string[]): Manifest => ({
  commands: commands.map((id: string): { path: string[] } => ({ path: id.split(" ") })),
  hooks: {},
});
const event = (op: string, id = "render"): string =>
  JSON.stringify({ date: "2026-01-01", op, id, reason: "parity gap", pr: 1 });

// Covers: R10
it("quitar una entrada sin unport falla, incluso con un registro antiguo", (): void => {
  const before = manifest(["render"]);
  const after = manifest([]);
  const unport = event("unport");
  expect((): string[] => checks.checkHistory(before, after, "", "")).toThrow("unport");
  expect((): string[] => checks.checkHistory(before, after, unport, unport)).toThrow("new unport");
  expect(checks.checkHistory(before, after, "", unport, Date.parse("2026-01-16"))).toEqual([
    "render has been unported for more than 14 days",
  ]);
  expect((): string[] => checks.checkHistory(before, after, event("port"), unport)).toThrow(
    "append-only",
  );
  expect((): string[] =>
    checks.checkHistory(before, after, "", `${unport}\n${event("port")}`),
  ).toThrow("unport");
  expect(checks.checkHistory(after, before, unport, `${unport}\n${event("port")}`)).toEqual([]);
});

// Covers: R10
it("un unport con delegación permanente no avisa a los 14 días; uno temporal sí", (): void => {
  const ids = ["master ux", "role-guard", "render"];
  const before: Manifest = {
    commands: manifest(["master ux", "render"]).commands,
    hooks: { "role-guard": { blocks: {}, impl: "sha256:0" } },
  };
  const unports = ids.map((id: string): string => event("unport", id)).join("\n");
  expect(checks.checkHistory(before, manifest([]), "", unports, Date.parse("2026-01-16"))).toEqual([
    "render has been unported for more than 14 days",
  ]);
});

const withMode = (mode: string | undefined): Manifest => ({
  commands: [],
  hooks: mode === undefined ? {} : { example: { mode, blocks: {}, impl: "sha256:0" } },
});

// Covers: R79, R80
it("activar sin línea activate o sin sombra previa falla", (): void => {
  const port = event("port", "example");
  const activate = event("activate", "example");
  const deactivate = event("deactivate", "example");
  const run = (before: Manifest, after: Manifest, added: string[]): string[] =>
    checks.checkHistory(before, after, port, [port, ...added].join("\n"));
  const shadow = withMode("shadow");
  const active = withMode("active");
  expect((): string[] => run(shadow, active, [])).toThrow("without a new activate");
  expect((): string[] => run(withMode(undefined), active, [activate])).toThrow(
    "without shadow in the merge-base",
  );
  expect(run(shadow, active, [activate])).toEqual([]);
  expect((): string[] => run(active, shadow, [])).toThrow("without a new deactivate");
  expect(run(active, shadow, [deactivate])).toEqual([]);
  expect((): string[] => run(shadow, shadow, [activate])).toThrow("without a shadow to active");
  expect((): string[] => run(active, active, [deactivate])).toThrow("without an active to shadow");
  expect(run(active, active, [])).toEqual([]);
});

// Covers: R10
it("recalcula los hashes de assets, deps y fuentes Rust compartidos", (): void => {
  const root = mkdtempSync(join(tmpdir(), "rust-manifest-"));
  dirs.push(root);
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const hash = (body: string): string =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`;
  mkdirSync(join(root, "packages/plugins"), { recursive: true });
  write("packages/core/core-assets/hooks/example.sh", "body\n");
  write("packages/core/core-assets/scripts/dep.sh", "dep\n");
  write("crates/navori-hooks/src/hooks/example/mod.rs", "hook\n");
  write("crates/navori-hooks/src/runner.rs", "runner\n");
  const m: Manifest = {
    commands: [],
    hooks: {
      example: {
        blocks: { "example-base": hash("body\n") },
        deps: { "scripts/dep.sh": hash("dep\n") },
        impl: checks.implementationHash(root, "example"),
      },
    },
  };
  expect((): void => checks.checkHashes(root, m)).not.toThrow();
  write("packages/core/core-assets/hooks/example.sh", "body \n");
  expect((): void => checks.checkHashes(root, m)).toThrow("blocks.example-base");
  write("packages/core/core-assets/hooks/example.sh", "body\n");
  write("packages/core/core-assets/scripts/dep.sh", "dep\r\n");
  expect((): void => checks.checkHashes(root, m)).toThrow("deps.scripts/dep.sh");
  write("packages/core/core-assets/scripts/dep.sh", "dep\n");
  write("crates/navori-hooks/src/runner.rs", "new runner\n");
  expect((): void => checks.checkHashes(root, m)).toThrow("impl");
});

// Covers: R48
it("valida schema 2, requires y varias entradas por ruta como manifest.rs", (): void => {
  const sync = (requires?: string[][]): CommandEntry => ({
    path: ["sync"],
    flags: ["apply", "yes"],
    ...(requires === undefined ? {} : { requires }),
  });
  const check = (commands: CommandEntry[], schema = 2): void => {
    checks.checkCommands({ schema, commands });
  };
  expect((): void => check([], 1)).toThrow("unsupported schema 1");
  expect((): void => check([sync([])])).toThrow("at least one alternative");
  expect((): void => check([sync([[]])])).toThrow("non-empty");
  expect((): void => check([sync([["apply", "apply"]])])).toThrow("without repeats");
  expect((): void => check([sync([["force"]])])).toThrow("not in flags");
  expect((): void =>
    check([
      sync([
        ["apply", "yes"],
        ["yes", "apply"],
      ]),
    ]),
  ).toThrow("duplicate requires");
  expect((): void => check([sync(), sync()])).toThrow("duplicate path");
  expect((): void => check([sync([["apply"], ["yes"]]), sync([["yes"], ["apply"]])])).toThrow(
    "duplicate path",
  );
  expect((): void => check([{ path: ["sync"], flags: ["--apply"] }])).toThrow("not normalized");
  expect((): void => check([{ path: ["sync"], when: { engines: [] } }])).toThrow("when.engines");
  expect((): void =>
    check([sync(), sync([["apply"]]), sync([["apply", "yes"]]), { path: ["remove"] }]),
  ).not.toThrow();
});
