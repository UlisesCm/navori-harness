import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(import.meta.dirname, "../../../../.github/workflows/ci.yml"),
  "utf8",
);

/** Text of one top-level job: from `  <name>:` to the next two-space key. No YAML dependency exists. */
function job(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[\w-]+:/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

const stepRuns = (body: string): string[] =>
  [...body.matchAll(/^ {8}run: (.+)$/gm)].map((m) => (m[1] as string).trim());

describe("ci workflow", () => {
  // Covers: R18
  it("quality corre hacia dev y main y compila una vez", () => {
    const quality = job("quality");
    const condition = /^ {4}if: (.+)$/m.exec(quality)?.[1] ?? "";
    for (const ref of [
      "refs/heads/main",
      "refs/heads/dev",
      "base_ref == 'main'",
      "base_ref == 'dev'",
    ]) {
      expect(condition).toContain(ref);
    }

    const runs = stepRuns(quality);
    // One build step, the sealed one; check:render and the suite reuse it via the seal.
    const builds = runs.filter((r) => /ensure-dist|\bbuild\b/.test(r) && !r.includes("website"));
    expect(builds).toEqual(["bun run ensure-dist"]);
    const iBuild = runs.indexOf(builds[0] as string);
    expect(iBuild).toBeLessThan(runs.indexOf("bun run check:render"));
    expect(iBuild).toBeLessThan(runs.indexOf("bun run --filter navori test:coverage"));

    // `fast` no longer claims dev: it is for every other base.
    const fast = /^ {4}if: (.+)$/m.exec(job("fast"))?.[1] ?? "";
    expect(fast).toContain("refs/heads/dev");
    expect(fast).toContain("base_ref != 'dev'");
  });
});
