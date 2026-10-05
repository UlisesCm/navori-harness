import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
const vitestBin = join(
  dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);
const setupPath = join(cliRoot, "vitest.setup.ts");
const lifecyclePath = join(cliRoot, "vitest.tempLifecycle.ts");

interface Fixture {
  root: string;
  log: string;
  spec: string;
  config: string;
}
interface RecordLine {
  root: string;
  fixture: string;
  childTmp: string;
  home: string;
}
interface Running {
  child: ChildProcess;
  closed: Promise<number | null>;
  output(): string;
}

/** Build a minimal real Vitest project; intentionally no production dist build/lock. */
function fixture(globalSetup = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-integration-"));
  const log = join(root, "records.jsonl");
  const spec = join(root, "fixture.test.ts");
  const config = join(root, "vitest.config.mjs");
  writeFileSync(
    join(root, "global.ts"),
    `import {createTempRun} from ${JSON.stringify(lifecyclePath)};
import type {TestProject} from ${JSON.stringify(import.meta.resolve("vitest/node"))};
export default function setup(project: TestProject): () => void {
 const run = createTempRun(${JSON.stringify(root)});
 project.provide('navoriTempRunRoot', run.root);
 return () => run.dispose();
}`,
  );
  writeFileSync(
    config,
    `import {defineConfig} from ${JSON.stringify(import.meta.resolve("vitest/config"))};
export default defineConfig({test:{root:${JSON.stringify(root)},include:['fixture.test.ts'],globalSetup:${globalSetup ? "['./global.ts']" : "[]"},setupFiles:[${JSON.stringify(setupPath)}],pool:'forks',maxWorkers:1,watchExclude:[],testTimeout:10000}});`,
  );
  return { root, log, spec, config };
}

/** Spec import-time allocation plus inherited asynchronous child and local teardown. */
function specSource(f: Fixture, fail: boolean, revision = 0): string {
  return `import {it,expect,afterAll} from ${JSON.stringify(import.meta.resolve("vitest"))};
import {mkdtempSync,appendFileSync,writeFileSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const root=tmpdir(); const fixture=mkdtempSync(join(root,'import-fixture-'));
writeFileSync(join(fixture,'payload'),'revision ${revision}');
it('routes import and child',async()=>{
 const child=spawn(process.execPath,['-e',"process.stdout.write(require('node:os').tmpdir())"]);
 let childTmp=''; child.stdout.on('data',(chunk: Buffer)=>childTmp+=chunk);
 await new Promise<void>((done,fail)=>{child.once('error',fail);child.once('close',()=>done())});
 expect(childTmp).toBe(root); expect(homedir().startsWith(root)).toBe(true);
 appendFileSync(${JSON.stringify(f.log)},JSON.stringify({root,fixture,childTmp,home:homedir()})+'\\n');
 expect(${fail}).toBe(false);
});
afterAll(()=>writeFileSync(join(fixture,'local-teardown'),'completed'));
`;
}

/** Spawn standard direct Vitest with bounded output capture, rather than a mocked runner. */
function start(f: Fixture, watch = false, extraEnv: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(
    process.execPath,
    [
      vitestBin,
      ...(watch ? ["--watch"] : ["run"]),
      "--config",
      f.config,
      "--reporter=dot",
      "--no-color",
    ],
    {
      cwd: f.root,
      env: { ...process.env, NAVORI_KEEP_TEST_ARTIFACTS: "", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-30_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const closed = new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  return { child, closed, output: () => output };
}

/** Poll only exact fixture evidence, with a finite deadline and actionable output. */
async function until(
  predicate: () => boolean,
  output: () => string,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`fixture deadline exceeded\n${output()}`);
    await new Promise<void>((done) => setTimeout(done, 40));
  }
}

function records(f: Fixture): RecordLine[] {
  if (!existsSync(f.log)) return [];
  return readFileSync(f.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as RecordLine);
}

/** Stop and join the exact child before disposing its fixture project. */
async function stop(run: Running): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.closed,
      new Promise<never>((_, fail) => {
        timeout = setTimeout(
          () => fail(new Error(`child did not shut down\n${run.output()}`)),
          6_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("real Vitest temporary lifecycle", () => {
  it("isolates concurrent real runs and caller-owned sentinels", async () => {
    const first = fixture();
    const second = fixture();
    const sentinel = join(second.root, "caller-owned");
    writeFileSync(sentinel, "untouched");
    writeFileSync(first.spec, specSource(first, false));
    writeFileSync(second.spec, specSource(second, false));
    const a = start(first);
    const b = start(second);
    try {
      await Promise.all([
        until(() => a.child.exitCode !== null, a.output),
        until(() => b.child.exitCode !== null, b.output),
      ]);
      expect(await a.closed, a.output()).toBe(0);
      expect(await b.closed, b.output()).toBe(0);
      expect(records(first)[0]!.root).not.toBe(records(second)[0]!.root);
      expect(existsSync(records(first)[0]!.root)).toBe(false);
      expect(existsSync(records(second)[0]!.root)).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    } finally {
      await Promise.all([stop(a), stop(b)]);
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  }, 25_000);

  it("cleans the per-file fallback when custom config omits globalSetup", async () => {
    const f = fixture(false);
    writeFileSync(f.spec, specSource(f, false));
    const run = start(f);
    try {
      await until(() => run.child.exitCode !== null, run.output);
      expect(await run.closed, run.output()).toBe(0);
      expect(existsSync(records(f)[0]!.root)).toBe(false);
    } finally {
      await stop(run);
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 25_000);

  it.each([false, true])(
    "cleans three ordinary completed runs, failing=%s",
    async (fail) => {
      const f = fixture();
      try {
        writeFileSync(f.spec, specSource(f, fail));
        for (let i = 0; i < 3; i++) {
          const run = start(f);
          try {
            await until(() => run.child.exitCode !== null, run.output);
            expect(await run.closed, run.output()).toBe(fail ? 1 : 0);
            const record = records(f).at(-1)!;
            expect(record.root.startsWith(f.root)).toBe(true);
            expect(existsSync(record.fixture)).toBe(false);
            expect(existsSync(record.root)).toBe(false);
            expect(
              readdirSync(f.root).filter((name) => name.startsWith("navori-test-run-")),
            ).toEqual([]);
          } finally {
            await stop(run);
          }
        }
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
    50_000,
  );

  it("disposes file roots between actual watch reruns", async () => {
    const f = fixture();
    writeFileSync(f.spec, specSource(f, false));
    const run = start(f, true);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        if (cycle) writeFileSync(f.spec, specSource(f, false, cycle));
        await until(() => records(f).length >= cycle + 1, run.output);
        const record = records(f)[cycle]!;
        await until(() => !existsSync(record.root), run.output);
        expect(existsSync(record.fixture)).toBe(false);
      }
    } finally {
      await stop(run);
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 50_000);

  it("preserves explicit diagnostics and diagnosed HOME evidence", async () => {
    const f = fixture();
    try {
      writeFileSync(f.spec, specSource(f, false));
      const run = start(f, false, { NAVORI_KEEP_TEST_ARTIFACTS: "1" });
      try {
        await until(() => run.child.exitCode !== null, run.output);
        expect(await run.closed, run.output()).toBe(0);
        expect(existsSync(records(f)[0]!.fixture)).toBe(true);
        expect(run.output()).toContain("NAVORI_KEEP_TEST_ARTIFACTS=1");
      } finally {
        await stop(run);
      }
      writeFileSync(
        f.spec,
        specSource(f, false) +
          `import {mkdirSync} from 'node:fs'; mkdirSync(join(homedir(),'.navori')); writeFileSync(join(homedir(),'.navori','registry.json'),'{}');`,
      );
      const leaking = start(f);
      try {
        await until(() => leaking.child.exitCode !== null, leaking.output);
        expect(await leaking.closed, leaking.output()).toBe(1);
        const record = records(f).at(-1)!;
        expect(existsSync(join(record.home, ".navori", "registry.json"))).toBe(true);
        expect(leaking.output()).toContain("HOME isolation evidence");
      } finally {
        await stop(leaking);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 35_000);

  it("gives slow exact-root removal a teardown budget separate from tests", async () => {
    const f = fixture();
    const preload = join(f.root, "slow-removal.ts");
    const marker = join(f.root, "removal.json");
    writeFileSync(
      preload,
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.rmSync;
fs.rmSync=(...args:Parameters<typeof fs.rmSync>):ReturnType<typeof fs.rmSync>=>{
 if(String(args[0])!==process.env.TMPDIR)return original(...args);
 const started=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,11000);
 original(...args);
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({root:String(args[0]),ms:performance.now()-started}));
};syncBuiltinESMExports();`,
    );
    writeFileSync(
      f.config,
      readFileSync(f.config, "utf8").replace(
        "setupFiles:[",
        `setupFiles:[${JSON.stringify(preload)},`,
      ),
    );
    writeFileSync(f.spec, specSource(f, false));
    const run = start(f);
    try {
      await until(() => run.child.exitCode !== null, run.output, 45_000);
      expect(await run.closed, run.output()).toBe(0);
      const removal = JSON.parse(readFileSync(marker, "utf8")) as { root: string; ms: number };
      expect(removal.root).toBe(records(f)[0]!.root);
      expect(removal.ms).toBeGreaterThanOrEqual(11_000);
      expect(existsSync(removal.root)).toBe(false);
      expect(run.output()).not.toContain("Hook timed out");
    } finally {
      await stop(run);
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([false, true])(
    "joins a late direct child before the final HOME guard, writes=%s",
    async (writes) => {
      const f = fixture();
      const childSource = `const fs=require('node:fs');const path=require('node:path');const home=require('node:os').homedir();process.stdout.write('ready');setTimeout(()=>{${writes ? "fs.mkdirSync(path.join(home,'.navori'),{recursive:true});fs.writeFileSync(path.join(home,'.navori','registry.json'),'{}');" : ""}},200);`;
      writeFileSync(
        f.spec,
        `import {it} from ${JSON.stringify(import.meta.resolve("vitest"))};
import {appendFileSync} from 'node:fs';import {tmpdir,homedir} from 'node:os';import {spawn} from 'node:child_process';
it('leaves a supported child running',async()=>{
 const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}]);
 await new Promise<void>((done,fail)=>{child.once('error',fail);child.stdout.once('data',()=>done());});
 appendFileSync(${JSON.stringify(f.log)},JSON.stringify({root:tmpdir(),home:homedir()})+'\\n');
});`,
      );
      const run = start(f);
      try {
        await until(() => run.child.exitCode !== null, run.output);
        expect(await run.closed, run.output()).toBe(writes ? 1 : 0);
        const record = records(f)[0]!;
        expect(existsSync(record.root)).toBe(writes);
        if (writes) {
          expect(readFileSync(join(record.home, ".navori", "registry.json"), "utf8")).toBe("{}");
          expect(run.output()).toContain("HOME isolation evidence");
        }
      } finally {
        await stop(run);
        rmSync(f.root, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it("keeps exact roots on interruption while an inheriting child finishes writing", async () => {
    const f = fixture();
    const ready = join(f.root, "ready");
    const done = join(f.root, "child-done");
    const childSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},require('node:os').tmpdir());setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'done');},2200);`;
    writeFileSync(
      f.spec,
      `import {it} from ${JSON.stringify(import.meta.resolve("vitest"))};import {spawn} from 'node:child_process';it('waits for a child',async()=>{const c=spawn(process.execPath,['-e',${JSON.stringify(childSource)}]);await new Promise<void>(done=>c.once('close',()=>done()));});`,
    );
    const run = start(f);
    try {
      await until(() => existsSync(ready), run.output);
      const childRoot = readFileSync(ready, "utf8");
      run.child.kill("SIGINT");
      await until(() => run.child.exitCode !== null || run.child.signalCode !== null, run.output);
      await run.closed;
      expect(existsSync(childRoot), run.output()).toBe(true);
      expect(run.output()).toContain("retained");
      await until(() => existsSync(done), run.output);
      expect(existsSync(childRoot)).toBe(true);
    } finally {
      await stop(run);
      // The child completion sentinel proves this fixture's writer has finished.
      if (existsSync(done)) rmSync(f.root, { recursive: true, force: true });
    }
  }, 25_000);
});
