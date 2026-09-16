import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * search-v2 §8.2 — single controlled fixture, byte-for-byte as the plan
 * specifies. Every value the runtime tests assert against is written here so
 * the oracle never depends on tgrep/codegraph output to know its own
 * expected content.
 */

export const SESSION_EXPIRED_MARKER = "SESSION_EXPIRED_V2";
export const BASELINE_REVISION = "BASELINE_V2";
export const UPDATED_REVISION = "UPDATED_V2";
export const TODO_MARKER = "TODO SEARCH_V2_AUTH";
export const HIDDEN_MARKER = "HIDDEN_SEARCH_V2";
export const IGNORED_MARKER = "IGNORED_SEARCH_V2";
export const DATABASE_URL_MARKER = "DATABASE_URL";
export const NEW_FILE_MARKER = "NEW_FILE_V2";

/** `docs/notes.md`, one literal per line, verbatim per §8.2. */
export const NOTES_LINES = ["AuthService", "serve", "a+b[0]", "/legacy-api/", "--literal-v2"];

function sessionSource(revision) {
  return (
    "import { saveSession } from './repository.ts';\n" +
    `export const revision = '${revision}';\n` +
    `// ${TODO_MARKER}\n` +
    "export function createSession(token: string): string {\n" +
    `  if (!token) throw new Error("${SESSION_EXPIRED_MARKER}");\n` +
    "  return saveSession(token);\n" +
    "}\n"
  );
}

/**
 * File map for the §8.2 fixture. `session.ts` is generated with
 * BASELINE_REVISION by default; callers that need UPDATED_REVISION (T05,
 * G07) mutate the file directly with `fs.writeFile` after `writeFixture`.
 */
export function fixtureFiles({ revision = BASELINE_REVISION } = {}) {
  return {
    "src/entry.ts":
      "import { createSession } from './session.ts';\n" +
      "export function handleRequest(token: string): string {\n" +
      "  return createSession(token);\n" +
      "}\n",
    "src/session.ts": sessionSource(revision),
    "src/repository.ts":
      "export function saveSession(token: string): string {\n" +
      "  return `stored:${token}`;\n" +
      "}\n",
    "src/unused.ts": "export function unusedHelper(): string { return 'unused'; }\n",
    "src/types.ts": "export type SessionToken = string;\n",
    "config/app.json": `{ "apiEnvName": "${DATABASE_URL_MARKER}" }\n`,
    "docs/notes.md": NOTES_LINES.join("\n") + "\n",
    "tests/session.test.ts":
      "import assert from 'node:assert/strict';\n" +
      "import test from 'node:test';\n" +
      "import { createSession } from '../src/session.ts';\n" +
      "test('creates a stored session', () => {\n" +
      "  assert.equal(createSession('token'), 'stored:token');\n" +
      "});\n" +
      "test('rejects an empty token', () => {\n" +
      `  assert.throws(() => createSession(''), /${SESSION_EXPIRED_MARKER}/);\n` +
      "});\n",
    ".hidden/config.md": `${HIDDEN_MARKER}\n`,
    "dist/ignored.txt": `${IGNORED_MARKER}\n`,
    ".gitignore": "dist/\nnode_modules/\n.codegraph/\n.tgrep/\n",
    "package.json": '{"private":true,"type":"module"}\n',
  };
}

/**
 * Writes the §8.2 fixture tree under `root` (must already exist). Returns
 * the file map that was written so callers/oracles can assert against exact
 * content without re-deriving it.
 */
export async function writeFixture(root, options = {}) {
  const files = fixtureFiles(options);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }
  return files;
}
