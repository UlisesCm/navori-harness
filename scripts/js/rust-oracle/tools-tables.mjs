import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tc } from "../../../packages/cli/src/lib/i18n.ts";
import { readEntry } from "../../../packages/cli/src/lib/workspace/dominio.ts";
import { WorkspaceConfigSchema } from "../../../packages/cli/src/lib/workspace/workspace.ts";

/**
 * Spec 0059 T13: the TS answers for the pure helpers of `dominio inject`, `tools notice` and
 * `tools session-context`, written as a table the Rust tests replay
 * (`crates/navori-core/tests/tools_tables.rs`).
 *
 * Usage: node scripts/js/rust-oracle/tools-tables.mjs [--check]
 *   --check exits 1 when the committed table differs from a fresh one.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TABLE = join(REPO_ROOT, "crates", "navori-core", "tests", "fixtures", "tools_tables.json");

/** Deterministic xorshift, so the table is stable across runs. */
function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** `localeCompare` under CLDR root: the order `listEntries` gets in an `en`/`es`/C locale. */
function collation() {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  const order = [...printable].sort((a, b) => a.localeCompare(b, "und"));
  const next = rng(59);
  const alphabet = "aAbBzZ09 -_.,:()'\"`~$";
  const word = () =>
    Array.from({ length: Math.floor(next() * 5) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
  const pairs = Array.from({ length: 600 }, () => {
    const a = word();
    const b = next() < 0.2 ? a.toUpperCase() : word();
    return { a, b, sign: Math.sign(a.localeCompare(b, "und")) };
  });
  return { order: order.join(""), pairs };
}

const ENTRIES = [
  "",
  "no frontmatter\n",
  "---\ntitle: Usuarios\nstatus: canonical\n---\n# Modelo de usuario\n\nresto\n",
  "---\ntitle: '  Quoted  '\napplies-to: [api, \"web\", 'cli']\nstatus: deprecated\n---\n\n- **Regla** de negocio\n",
  "---\ntitle:\napplies-to: all\nstatus: weird\n---\n\n   \n## \n**bold**\n",
  "---\ntitle: x\napplies-to: [ALL]\n---\nbody\r\nsecond\r\n",
  "---\ntitle: x\napplies-to: a,,b\nstatus: superseded\nsupersedes: [y]\n---\n" + "z".repeat(150) + "\n",
  "---\ntitle: emoji\n---\n" + "e".repeat(138) + "😀tail\n",
  "---\ntitle: tabs\n---\n#\tTitle with tab\n*\tstar item\n",
  "--- \ntitle: not frontmatter\n---\nbody\n",
];

function entries() {
  const dir = mkdtempSync(join(tmpdir(), "tools-tables-"));
  try {
    return ENTRIES.map((raw, i) => {
      const path = join(dir, `entry-${i}.md`);
      writeFileSync(path, raw);
      const e = readEntry(path);
      // A summary cut through a surrogate pair holds a lone surrogate; stdout writes it as U+FFFD.
      const summary = Buffer.from(e.summary, "utf8").toString("utf8");
      return { id: e.id, raw, title: e.title, appliesTo: e.appliesTo, status: e.status, summary };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WORKSPACES = [
  {},
  [],
  { name: "ok" },
  { name: "Bad" },
  { name: "ok", repos: [{ name: "api", path: "/r/api" }, { name: "web", path: "rel/web", stack: "ts" }] },
  { name: "ok", repos: [{ name: "api", path: "" }] },
  { name: "ok", repos: [{ name: "API", path: "/r" }] },
  { name: "ok", repos: [{ name: "api", path: "/r", stack: null }] },
  { name: "ok", repos: {} },
  { name: "ok", defaults: { language: "en" } },
  { name: "ok", defaults: { language: "fr" } },
  { name: "ok", defaults: { commits: "free", engines: ["claude"], plugins: { x: { enabled: true } } } },
  { name: "ok", defaults: { plugins: { x: { enabled: "yes" } } } },
  { name: "ok", defaults: { engines: [1] } },
  { name: "ok", defaults: null },
  { name: "ok", ticketsDir: "a/b" },
  { name: "ok", ticketsDir: "a/../b" },
  { name: "ok", ticketsDir: "/abs" },
  { name: "ok", $schema: 1 },
  { name: "ok", description: "d", extra: true },
];

function workspaces() {
  return WORKSPACES.map((input) => {
    const result = WorkspaceConfigSchema.safeParse(input);
    return {
      input,
      valid: result.success,
      language: result.success ? (result.data.defaults.language ?? null) : null,
      repoPaths: result.success ? result.data.repos.map((r) => r.path) : [],
    };
  });
}

function table() {
  return {
    collation: collation(),
    entries: entries(),
    workspaces: workspaces(),
    inject: ["es", "en"].map((lang) => ({
      lang,
      header: tc(lang).dominio.injectHeader("ws-name"),
      hint: tc(lang).dominio.injectHint,
    })),
  };
}

const fresh = `${JSON.stringify(table(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const committed = readFileSync(TABLE, "utf8");
  if (committed !== fresh) {
    process.stderr.write(`tools-tables: ${TABLE} is stale; regenerate it without --check\n`);
    process.exit(1);
  }
  process.stdout.write("tools-tables: up to date\n");
} else {
  writeFileSync(TABLE, fresh);
  process.stdout.write(`tools-tables: wrote ${TABLE}\n`);
}
