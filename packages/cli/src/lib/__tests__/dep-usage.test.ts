import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDepImports } from "../dep-usage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-depusage-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("countDepImports", () => {
  it("counts one file per dep, across import / require / dynamic-import forms", () => {
    const dir = makeRepo({
      "src/a.ts": `import axios from 'axios';\n`,
      "src/b.tsx": `import { get } from "axios";\n`,
      "src/c.js": `const axios = require('axios');\n`,
      "src/d.ts": `const mod = await import('axios');\n`,
      "src/e.ts": `import { x } from './local';\n`, // no tracked dep
    });
    const counts = countDepImports(dir, ["axios"]);
    expect(counts.get("axios")).toBe(4);
  });

  it("matches subpath imports but not sibling packages with a shared prefix", () => {
    const dir = makeRepo({
      "src/router.ts": `import { useNavigate } from 'react-router-dom';\n`,
      "src/subpath.ts": `import x from "@mantine/form/dist/y";\n`,
      "src/sibling.ts": `import 'axios-retry';\nimport ReactDOM from 'react-dom';\n`,
    });
    const counts = countDepImports(dir, [
      "react-router-dom",
      "@mantine/form",
      "axios",
      "react-dom",
    ]);
    expect(counts.get("react-router-dom")).toBe(1);
    expect(counts.get("@mantine/form")).toBe(1);
    expect(counts.get("axios")).toBe(0); // 'axios-retry' must NOT match 'axios'
    expect(counts.get("react-dom")).toBe(1);
  });

  it("skips vendored/build dirs and dotfolders", () => {
    const dir = makeRepo({
      "src/app.ts": `import axios from 'axios';\n`,
      "node_modules/pkg/index.js": `require('axios');\n`,
      "dist/bundle.js": `require('axios');\n`,
      ".cache/x.ts": `import 'axios';\n`,
    });
    const counts = countDepImports(dir, ["axios"]);
    expect(counts.get("axios")).toBe(1);
  });

  it("returns a zeroed map for deps with no imports, and an empty map for no deps", () => {
    const dir = makeRepo({ "src/a.ts": `export const x = 1;\n` });
    expect(countDepImports(dir, ["axios"]).get("axios")).toBe(0);
    expect(countDepImports(dir, []).size).toBe(0);
  });

  it("ignores non-source extensions", () => {
    const dir = makeRepo({
      "README.md": `import axios from 'axios'\n`,
      "data.json": `{ "x": "axios" }\n`,
    });
    expect(countDepImports(dir, ["axios"]).get("axios")).toBe(0);
  });
});
