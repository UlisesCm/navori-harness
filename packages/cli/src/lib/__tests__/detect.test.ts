import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject, isPlaceholderName } from "../detect.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "navori-detect-"));
}

describe("detectProject — name detection", () => {
  it("detects name from package.json", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-cool-app" }));
      const d = detectProject(dir);
      expect(d.name).toBe("my-cool-app");
      expect(d.sources.name).toBe("package.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not crash when package.json name is not a string", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: { value: "object-name" } }));
      // Must not throw; should fall back to directory name.
      const d = detectProject(dir);
      expect(d.name).not.toBeNull();
      expect(d.name).not.toContain("object");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reads package.json with UTF-8 BOM at the start", () => {
    const dir = makeTmp();
    try {
      const content = "﻿" + JSON.stringify({ name: "bom-app" });
      writeFileSync(join(dir, "package.json"), content);
      const d = detectProject(dir);
      expect(d.name).toBe("bom-app");
      expect(d.sources.name).toBe("package.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("strips npm scope from package name", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bonum/dashboard" }));
      const d = detectProject(dir);
      expect(d.name).toBe("dashboard");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to pyproject.toml when no package.json", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "pyproject.toml"),
        '[project]\nname = "my-python-app"\nversion = "0.1.0"\n',
      );
      const d = detectProject(dir);
      expect(d.name).toBe("my-python-app");
      expect(d.sources.name).toBe("pyproject.toml");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to Cargo.toml when no package.json or pyproject", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "Cargo.toml"),
        '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n',
      );
      const d = detectProject(dir);
      expect(d.name).toBe("my-rust-app");
      expect(d.sources.name).toBe("Cargo.toml");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — Python without pyproject.toml (#70)", () => {
  it("detects Python + framework + ruff/pytest gate from requirements.txt", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "requirements.txt"),
        "fastapi==0.110\nuvicorn\npytest>=8\n# a comment\n-e .\n",
      );
      const d = detectProject(dir);
      expect(d.stack.language).toBe("python");
      expect(d.stack.framework).toBe("fastapi");
      // navori ships no python preset, so the candidate gaps down to the custom
      // baseline — but the ruff/pytest quality gate (the real win) still fires.
      expect(d.suggestedPreset).toBe("custom");
      expect(d.qualityGate).toEqual({ fast: "ruff check .", full: "ruff check . && pytest" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects Python from a loose .py script with no manifest (reports-server case)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "report.py"), "print('pdf')\n");
      const d = detectProject(dir);
      expect(d.stack.language).toBe("python");
      // no manifest/deps → custom baseline, but ruff gate still fires (was
      // language:"unknown" with no gate at all before #70).
      expect(d.suggestedPreset).toBe("custom");
      expect(d.qualityGate?.fast).toBe("ruff check .");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects Python deps from Pipfile", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "Pipfile"),
        '[packages]\ndjango = "*"\ncelery = "*"\n\n[dev-packages]\npytest = "*"\n',
      );
      const d = detectProject(dir);
      expect(d.stack.language).toBe("python");
      expect(d.stack.framework).toBe("django");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("express WITHOUT mongoose picks the neutral 'express' preset (#70)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "streaming", dependencies: { express: "^4", "socket.io": "^4" } }),
      );
      const d = detectProject(dir);
      expect(d.stack.framework).toBe("express");
      expect(d.suggestedPreset).toBe("express");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("React+Vite WITHOUT Mantine picks the 'vite-react-ts' preset (#70)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "webmentoring",
          dependencies: { react: "^18", "react-dom": "^18" },
          devDependencies: { vite: "^5" },
        }),
      );
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("vite-react-ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("React+Vite WITH Mantine stays on 'vite-react-ts-mantine' (#70)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "webapp",
          dependencies: { react: "^18", "@mantine/core": "^7" },
          devDependencies: { vite: "^5" },
        }),
      );
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("vite-react-ts-mantine");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("express WITH mongoose stays on 'express-mongoose' (#70)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "api", dependencies: { express: "^4", mongoose: "^8" } }),
      );
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("express-mongoose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT misclassify a JS repo that has an incidental requirements.txt", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "web", dependencies: { react: "^18", vite: "^5" } }),
      );
      writeFileSync(join(dir, "requirements.txt"), "boto3\n");
      const d = detectProject(dir);
      expect(d.stack.language).not.toBe("python");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to directory name when no manifest exists", () => {
    const parent = makeTmp();
    const target = join(parent, "my-Repo-Name");
    mkdirSync(target);
    try {
      const d = detectProject(target);
      expect(d.name).toBe("my-repo-name");
      expect(d.sources.name).toBe("directory name");
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("normalizes uppercase / spaces / special chars to kebab-case", () => {
    const parent = makeTmp();
    const target = join(parent, "My Cool App!!!");
    mkdirSync(target);
    try {
      const d = detectProject(target);
      expect(d.name).toBe("my-cool-app");
    } finally {
      rmSync(parent, { recursive: true });
    }
  });
});

describe("detectProject — engines detection", () => {
  it("returns empty when no engine artifacts exist", () => {
    const dir = makeTmp();
    try {
      const d = detectProject(dir);
      expect(d.existingEngines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects .claude/ directory", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".claude"));
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("claude");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects AGENTS.md", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects .cursor/ directory", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".cursor"));
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("cursor");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects copilot instructions", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github", "copilot-instructions.md"), "# instr\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("copilot");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects multiple engines at once", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("claude");
      expect(d.existingEngines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — branchBase detection", () => {
  it("returns null when not a git repo", () => {
    const dir = makeTmp();
    try {
      const d = detectProject(dir);
      expect(d.branchBase).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — package manager detection (#88)", () => {
  const cases: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, expected] of cases) {
    it(`detects ${expected} from ${lockfile}`, () => {
      const dir = makeTmp();
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
        writeFileSync(join(dir, lockfile), "");
        const d = detectProject(dir);
        expect(d.packageManager).toBe(expected);
        expect(d.sources.packageManager).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  }

  it("prefers the packageManager field over a conflicting lockfile", () => {
    const dir = makeTmp();
    try {
      // A pnpm lockfile is present, but the project declares bun explicitly.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "demo", packageManager: "bun@1.3.9" }),
      );
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectProject(dir).packageManager).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns null when no lockfile or packageManager field is present", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
      expect(detectProject(dir).packageManager).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — suggested preset never points to a phantom (F1)", () => {
  it("suggests the shipped 'monorepo-turbopnpm' preset for a turbo+pnpm monorepo", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono" }));
      writeFileSync(join(dir, "turbo.json"), "{}");
      writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
      const d = detectProject(dir);
      // The monorepo-turbopnpm preset now ships, so the root gets a real preset
      // (no phantom fallback, no "not found" warning).
      expect(d.suggestedPreset).toBe("monorepo-turbopnpm");
      expect(d.suggestedPresetGap).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT suggest the pnpm preset for a turbo+npm monorepo (wrong workflow)", () => {
    const dir = makeTmp();
    try {
      // turbo.json + npm workspaces + package-lock.json → tool 'turbo' but NOT
      // pnpm. The monorepo-turbopnpm preset teaches pnpm-only commands, so this
      // repo must fall back to the neutral baseline instead.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
      );
      writeFileSync(join(dir, "turbo.json"), "{}");
      writeFileSync(join(dir, "package-lock.json"), "{}");
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("custom");
      expect(d.suggestedPresetGap).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("still suggests a real preset when one ships (nextjs)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "web", dependencies: { next: "^15" } }),
      );
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("nextjs");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("suggests react-native-expo for an Expo app (ships, so no gap)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", dependencies: { expo: "~54", "react-native": "0.81.5" } }),
      );
      const d = detectProject(dir);
      expect(d.stack.framework).toBe("expo");
      expect(d.suggestedPreset).toBe("react-native-expo");
      expect(d.suggestedPresetGap).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("suggests bun-keystone for a Keystone 6 backend (ships, so no gap)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "api",
          packageManager: "bun@1.3.9",
          dependencies: { "@keystone-6/core": "^6", "@prisma/client": "^6", zod: "^4" },
        }),
      );
      const d = detectProject(dir);
      // Keystone wins the framework race (detect.ts precedence) and bun-keystone
      // now ships on disk → real preset, no honest-gap.
      expect(d.stack.framework).toBe("@keystone-6/core");
      expect(d.suggestedPreset).toBe("bun-keystone");
      expect(d.suggestedPresetGap).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not treat a pnpm-workspace.yaml with no packages as a monorepo", () => {
    const dir = makeTmp();
    try {
      // Single-package repo that ships pnpm-workspace.yaml only for build
      // config (no `packages:`). Must fall through to the framework preset.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      );
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - esbuild\n");
      const d = detectProject(dir);
      expect(d.monorepo).toBeNull();
      // express without mongoose → the neutral express preset (#70)
      expect(d.suggestedPreset).toBe("express");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not treat an empty packages list as a monorepo", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "svc", dependencies: { "@nestjs/core": "^10" } }),
      );
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
      const d = detectProject(dir);
      expect(d.monorepo).toBeNull();
      expect(d.suggestedPreset).toBe("nestjs");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("still detects a real pnpm monorepo when packages are declared", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono" }));
      writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
      const d = detectProject(dir);
      expect(d.monorepo).not.toBeNull();
      expect(d.monorepo?.tool).toBe("pnpm");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — background worker detection", () => {
  const withDeps = (deps: Record<string, string>): string => {
    const dir = makeTmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "svc", dependencies: deps }));
    return dir;
  };

  it("detects the worker dep", () => {
    const dir = withDeps({ express: "^4", amqplib: "^0.10", agenda: "^5" });
    try {
      expect(detectProject(dir).stack.worker).toBe("agenda");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("express + jobs WITHOUT mongoose is a background-worker (native mongodb driver)", () => {
    // notifications--server: express healthcheck + agenda/amqplib + mongodb native.
    const dir = withDeps({ express: "^4", mongodb: "^6", amqplib: "^0.10", agenda: "^5" });
    try {
      expect(detectProject(dir).suggestedPreset).toBe("background-worker");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("express + jobs WITH mongoose stays express-mongoose (a data-API that also runs jobs)", () => {
    // services--evaluations: a real Express API with mongoose models that also
    // schedules jobs (agenda/amqplib). mongoose ⇒ data-API, not a pure worker.
    const dir = withDeps({ express: "^4", mongoose: "^8", amqplib: "^0.10", agenda: "^5" });
    try {
      expect(detectProject(dir).suggestedPreset).toBe("express-mongoose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("suggests background-worker for a queue/scheduler with no HTTP framework", () => {
    const dir = withDeps({ mongodb: "^6", agenda: "^5" });
    try {
      expect(detectProject(dir).suggestedPreset).toBe("background-worker");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT hijack a Nest API that also runs jobs", () => {
    const dir = withDeps({ "@nestjs/core": "^10", bullmq: "^5" });
    try {
      expect(detectProject(dir).suggestedPreset).toBe("nestjs");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("plain express without a worker dep stays express-mongoose", () => {
    const dir = withDeps({ express: "^4", mongoose: "^8" });
    try {
      expect(detectProject(dir).stack.worker).toBeNull();
      expect(detectProject(dir).suggestedPreset).toBe("express-mongoose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — library skill detection", () => {
  const withDeps = (deps: Record<string, string>): string => {
    const dir = makeTmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "svc", dependencies: deps }));
    return dir;
  };

  it("flags every library skill whose dep is present, cross-preset (express + socket.io)", () => {
    const dir = withDeps({ express: "^4", mongoose: "^8", "socket.io": "^4" });
    try {
      expect(detectProject(dir).libraries).toEqual(["socketio", "mongoose"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("activates mongoose via @nestjs/mongoose on a Nest API", () => {
    const dir = withDeps({ "@nestjs/core": "^10", "@nestjs/mongoose": "^10" });
    try {
      expect(detectProject(dir).libraries).toEqual(["mongoose"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("is empty when no library dep is present", () => {
    const dir = withDeps({ express: "^4" });
    try {
      expect(detectProject(dir).libraries).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // End-to-end adoption/dominance gating: a repo whose source actually imports
  // the tracked deps, so `detectProject` scans the tree and weighs by use (#86).
  const withDepsAndSources = (deps: Record<string, string>, sources: Record<string, string>) => {
    const dir = makeTmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "svc", dependencies: deps }));
    for (const [rel, content] of Object.entries(sources)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return dir;
  };

  it("keeps a library skill regardless of how few files import the dep (presence-only, #92)", () => {
    // react-hook-form imported in only 2 files still earns its skill — usage
    // counts weigh migrations, not whether a lib is worth teaching.
    const dir = withDepsAndSources(
      { "react-hook-form": "^7" },
      {
        "src/FormA.tsx": `import { useForm } from 'react-hook-form';\n`,
        "src/FormB.tsx": `import { useForm } from 'react-hook-form';\n`,
      },
    );
    try {
      expect(detectProject(dir).libraries).toContain("react-hook-form");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT flag a migration whose preferred side is an incidental peer dep (#86)", () => {
    // moment used widely, dayjs barely (peer of a date picker) → no rule.
    const sources: Record<string, string> = {
      "src/d1.ts": `import dayjs from 'dayjs';\n`,
    };
    for (let i = 0; i < 10; i++) sources[`src/m${i}.ts`] = `import moment from 'moment';\n`;
    const dir = withDepsAndSources({ moment: "^2", dayjs: "^1" }, sources);
    try {
      expect(detectProject(dir).migrations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — qualityGate only references scripts that exist (F-gate)", () => {
  it("returns null when there is no usable script", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { start: "node ." } }),
      );
      expect(detectProject(dir).qualityGate).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("pairs umbrella 'validate' (full) with a real typecheck (fast)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { validate: "tsc && eslint .", typecheck: "tsc --noEmit" },
        }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run typecheck",
        full: "npm run validate",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT invent a typecheck script when only 'validate' exists", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { validate: "tsc && eslint ." } }),
      );
      const gate = detectProject(dir).qualityGate;
      expect(gate?.fast).toBe("npm run validate");
      expect(gate?.fast).not.toContain("typecheck");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("uses 'check:all' (full) with an existing 'type-check' (fast)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { "check:all": "tsc && lint", "type-check": "tsc --noEmit" },
        }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run type-check",
        full: "npm run check:all",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("composes fast+full from the individual scripts that exist", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" },
        }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run typecheck",
        full: "npm run typecheck && npm run lint && npm run test",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls fast back to an existing step when no typecheck script exists", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
      );
      // no typecheck/lint — fast must be a real script (test), never "npm run lint"
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run test",
        full: "npm run test",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("isPlaceholderName", () => {
  it("flags obvious scaffold placeholders", () => {
    for (const n of ["temp-app", "my-app", "my-project", "changeme", "untitled", "project-name"]) {
      expect(isPlaceholderName(n), n).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isPlaceholderName("TEMP-APP")).toBe(true);
    expect(isPlaceholderName("  my-app  ")).toBe(true);
  });

  it("does not flag real project names", () => {
    for (const n of ["bonum-webapp", "services-users-bonum", "navori", "checkout-service"]) {
      expect(isPlaceholderName(n), n).toBe(false);
    }
  });

  it("is conservative — does not flag bare generics like 'app' or 'demo'", () => {
    expect(isPlaceholderName("app")).toBe(false);
    expect(isPlaceholderName("demo")).toBe(false);
    expect(isPlaceholderName("test")).toBe(false);
  });
});

describe("detectProject — library skills are workspace-scoped in a monorepo (#80, anti-spray)", () => {
  it("keeps the root scan root-only — a workspace-only dep does NOT spray to the root", () => {
    const dir = makeTmp();
    try {
      // Root declares the monorepo but has no mongoose itself.
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono-root" }));
      // Only the backend workspace depends on mongoose.
      mkdirSync(join(dir, "packages/backend"), { recursive: true });
      writeFileSync(
        join(dir, "packages/backend/package.json"),
        JSON.stringify({ name: "backend", dependencies: { mongoose: "^8" } }),
      );

      // The workspace-only dep is surfaced per-workspace (scan.ts), not merged
      // into the root array — so the root CLAUDE.md never materializes a skill
      // for a lib no root code imports.
      const d = detectProject(dir);
      expect(d.libraries).not.toContain("mongoose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("root libraries reflect only the root package's own deps", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "mono", dependencies: { zod: "^3" } }),
      );
      mkdirSync(join(dir, "apps/api"), { recursive: true });
      writeFileSync(
        join(dir, "apps/api/package.json"),
        JSON.stringify({ name: "api", dependencies: { "socket.io": "^4" } }),
      );

      const d = detectProject(dir);
      // Root ships zod → gets zod-validation. The api workspace's socket.io is
      // NOT in the root list (it belongs to that workspace's own harness).
      expect(d.libraries).toContain("zod-validation");
      expect(d.libraries).not.toContain("socketio");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
