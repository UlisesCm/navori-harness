import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runRender } from "./render.ts";
import { brand, dim, color } from "../lib/style.ts";

/**
 * `bench` — spec 0003 §3.5.4. Runs render (in preview/dry-run mode, so it
 * never writes) N times and reports min / p50 / p95 / max, to catch a local
 * performance regression before committing. Complements `NAVORI_BENCH=1`,
 * which times a single run.
 */
export const benchCommand = defineCommand({
  meta: {
    name: "bench",
    description: "Benchmark render over N runs and report p50/p95 (spots local regressions)",
  },
  args: {
    cwd: { type: "string", description: "Directory to benchmark (default: cwd)" },
    runs: { type: "string", description: "Number of iterations (default: 20)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    p.intro(brand("bench"));

    if (!existsSync(`${cwd}/navori.config.json`)) {
      p.cancel(`No navori.config.json at ${cwd}. Run 'navori init' first.`);
      process.exit(1);
    }

    const runs = Math.max(1, Math.floor(Number(args.runs) || 20));

    // Warm-up so module/asset caches don't skew the first sample.
    runRender(cwd, { dryRun: true });

    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      runRender(cwd, { dryRun: true });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);

    const at = (q: number): number =>
      samples[
        Math.min(samples.length - 1, Math.max(0, Math.ceil((q / 100) * samples.length) - 1))
      ]!;
    const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;

    p.note(
      [
        `runs   ${runs}`,
        `min    ${fmt(samples[0]!)}`,
        `p50    ${fmt(at(50))}`,
        `p95    ${fmt(at(95))}`,
        `max    ${fmt(samples[samples.length - 1]!)}`,
      ].join("\n"),
      `render (dry-run) · ${dim(cwd)}`,
    );
    p.outro(color.green("Done"));
  },
});
