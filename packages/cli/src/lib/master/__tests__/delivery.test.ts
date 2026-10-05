import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "citty";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveDeliveryBaseline, authorizeDeliveryQueue } from "../delivery.ts";
import { contractDigest } from "../delivery-checks.ts";
import type { DeliveryParts } from "../delivery-schema.ts";
import { masterCommand } from "../../../commands/master.ts";
import { readMasterStatus } from "../status.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { cwd: string; stage: string; parts: DeliveryParts } {
  const cwd = mkdtempSync(join(tmpdir(), "navori-d2-state-"));
  dirs.push(cwd);
  const stage = join(cwd, "specs", "_master", "01-demo");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "MASTER.md"), "Operator-reviewed delivery scope\n");
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom", sdd: { enabled: true } }),
  );
  writeFileSync(
    join(cwd, "specs", "_master", "index.json"),
    JSON.stringify({
      version: 2,
      stages: [
        {
          number: 1,
          slug: "demo",
          dir: "01-demo",
          state: "activa",
          openedAt: "2026-01-01",
          closedAt: null,
          spec: null,
          workflow: "deliveries",
        },
      ],
    }),
  );
  writeFileSync(
    join(stage, "state.json"),
    JSON.stringify({
      version: 2,
      workflow: "deliveries",
      phase: "context",
      mode: null,
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      history: [],
    }),
  );
  const text = "RN-1\n";
  writeFileSync(join(cwd, "source.txt"), text);
  const parts: DeliveryParts = {
    version: 2,
    workflow: "deliveries",
    revision: 1,
    digest: "0".repeat(64),
    sources: [
      {
        id: "source",
        path: "source.txt",
        digest: createHash("sha256").update(text).digest("hex"),
        locator: "RN-1",
        requirements: ["RN-1"],
        uiBearing: false,
      },
    ],
    requirements: [{ id: "RN-1", sourceId: "source", disposition: "in-scope", reason: null }],
    design: { ui: "none", reason: "CLI only" },
    deliveries: [
      {
        id: "E1",
        title: "One",
        outcome: "Done",
        partIds: ["P1"],
        dependsOn: [],
        git: { branch: "feat/one", base: "main", integrationTarget: "dev", prTarget: "dev" },
      },
    ],
    parts: [
      {
        id: "P1",
        deliveryId: "E1",
        title: "Part",
        objective: "Build",
        scope: ["CLI"],
        outOfScope: [],
        dependsOn: [],
        sourceIds: ["source"],
        requirementIds: ["RN-1"],
        spec: null,
        foundation: false,
        acceptance: [
          {
            id: "A1",
            method: "command",
            description: "check",
            command: "bun test",
            expected: "exit 0",
          },
        ],
        questions: [],
      },
    ],
  };
  parts.digest = contractDigest(parts);
  writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
  return { cwd, stage, parts };
}

describe("delivery authority", () => {
  it("rejects a missing operator MASTER before granting baseline authority", () => {
    const { cwd, stage } = fixture();
    unlinkSync(join(stage, "MASTER.md"));
    const before = readFileSync(join(stage, "state.json"), "utf8");
    expect(() => approveDeliveryBaseline(cwd, "user")).toThrow(/MASTER/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });
  it("rejects an escaping operator MASTER before granting baseline or queue authority", () => {
    const { cwd, stage } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "navori-d2-master-outside-"));
    dirs.push(outside);
    const text = "External operator scope must not be read or overwritten\n";
    writeFileSync(join(outside, "operator.txt"), text);
    unlinkSync(join(stage, "MASTER.md"));
    symlinkSync(join(outside, "operator.txt"), join(stage, "MASTER.md"));
    const before = readFileSync(join(stage, "state.json"), "utf8");
    expect(() => approveDeliveryBaseline(cwd, "user")).toThrow(/MASTER.*outside/);
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P1"], "user")).toThrow(/MASTER.*outside/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
    expect(readFileSync(join(outside, "operator.txt"), "utf8")).toBe(text);
  });
  it("binds operator MASTER bytes and rejects stale baseline and queue without rewriting text", () => {
    const { cwd, stage } = fixture();
    const path = join(stage, "MASTER.md");
    const original = readFileSync(path, "utf8");
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    expect(readFileSync(path, "utf8")).toBe(original);
    // Baseline approval is not technical completion: this fixture has no git provenance.
    expect(readMasterStatus(cwd).blockers).toEqual(["not a readable git checkout"]);
    expect(readMasterStatus(cwd).closable).toBe(false);
    const before = readFileSync(join(stage, "state.json"), "utf8");
    const state = JSON.parse(before) as { baseline: { masterDigest: string } };
    expect(state.baseline.masterDigest).toBe(createHash("sha256").update(original).digest("hex"));
    const changed = `${original}Operator changed the manual scope\n`;
    writeFileSync(path, changed);
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P1"], "user")).toThrow(/baseline.*stale/);
    expect(() => approveDeliveryBaseline(cwd, "user")).toThrow(/queue revision/);
    expect(readMasterStatus(cwd).blockers).toContain("baseline is missing or stale");
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
    expect(readFileSync(path, "utf8")).toBe(changed);
  });
  it.each(["missing", "escaping", "edited"] as const)(
    "delivery CLI rejects %s operator MASTER without mutating approval or operator bytes",
    async (kind: "missing" | "escaping" | "edited") => {
      const { cwd, stage } = fixture();
      const path = join(stage, "MASTER.md");
      approveDeliveryBaseline(cwd, "user");
      authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
      const before = readFileSync(join(stage, "state.json"), "utf8");
      let text: string | null = null;
      if (kind === "missing") unlinkSync(path);
      else if (kind === "escaping") {
        const outside = mkdtempSync(join(tmpdir(), "navori-d2-cli-master-"));
        dirs.push(outside);
        text = "External scope\n";
        writeFileSync(join(outside, "operator.txt"), text);
        unlinkSync(path);
        symlinkSync(join(outside, "operator.txt"), path);
      } else {
        text = "Edited operator scope\n";
        writeFileSync(path, text);
      }
      const savedCode = process.exitCode;
      const savedErr = process.stderr.write;
      let error = "";
      process.stderr.write = ((chunk: string) => {
        error += chunk;
        return true;
      }) as typeof process.stderr.write;
      try {
        for (const args of [
          ["delivery-baseline", "--approved-by", "user"],
          ["delivery-queue", "--delivery", "E1", "--parts", "P1", "--approved-by", "user"],
        ]) {
          process.exitCode = undefined;
          await runCommand(masterCommand, { rawArgs: [...args, "--cwd", cwd] });
          expect(process.exitCode).toBe(1);
        }
      } finally {
        process.stderr.write = savedErr;
        process.exitCode = savedCode;
      }
      expect(error).toMatch(kind === "edited" ? /queue revision|baseline.*stale/ : /MASTER/);
      expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
      if (text !== null) expect(readFileSync(path, "utf8")).toBe(text);
    },
  );
  it("requires explicit user consent, binds identities and replays idempotently", () => {
    const { cwd, stage } = fixture();
    const statePath = join(stage, "state.json");
    const before = readFileSync(statePath, "utf8");
    expect(() => approveDeliveryBaseline(cwd, "agent")).toThrow(/approved-by user/);
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P1"], "user")).toThrow(/baseline/);
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(approveDeliveryBaseline(cwd, "user").unchanged).toBe(false);
    const after = readFileSync(statePath, "utf8");
    expect(approveDeliveryBaseline(cwd, "user").unchanged).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(after);
    expect(authorizeDeliveryQueue(cwd, "E1", ["P1"], "user").unchanged).toBe(false);
    const queued = readFileSync(statePath, "utf8");
    expect(authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation").unchanged).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(queued);
  });
  it("rejects source drift before replacing approval", () => {
    const { cwd, stage } = fixture();
    approveDeliveryBaseline(cwd, "user");
    const before = readFileSync(join(stage, "state.json"), "utf8");
    writeFileSync(join(cwd, "source.txt"), "RN-1 changed");
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P1"], "user")).toThrow(/digest changed/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });
  it("authorizes only the new-UI foundation until implementation evidence exists", () => {
    const { cwd, stage, parts } = fixture();
    for (const name of ["architecture.txt", "flow.txt", "system.txt"])
      writeFileSync(join(cwd, name), "Reviewed design");
    parts.sources[0]!.uiBearing = true;
    parts.design = {
      ui: "new",
      architecture: "architecture.txt",
      flow: "flow.txt",
      system: "system.txt",
      reviewedRevision: "r1",
      foundationPartId: "P1",
    };
    parts.parts[0]!.foundation = true;
    parts.deliveries[0]!.partIds.push("P2");
    parts.parts.push({
      ...parts.parts[0]!,
      id: "P2",
      title: "Product",
      objective: "Product flow",
      scope: ["product"],
      dependsOn: ["P1"],
      foundation: false,
    });
    parts.digest = contractDigest(parts);
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    approveDeliveryBaseline(cwd, "user");
    const before = readFileSync(join(stage, "state.json"), "utf8");
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P2"], "user")).toThrow(/product slices await/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
    expect(authorizeDeliveryQueue(cwd, "E1", ["P1"], "user").unchanged).toBe(false);
  });
});
