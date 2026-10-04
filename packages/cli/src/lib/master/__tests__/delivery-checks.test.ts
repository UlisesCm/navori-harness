import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeliveryPreparation, contractDigest } from "../delivery-checks.ts";
import type { DeliveryParts } from "../delivery-schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(ui: "none" | "reuse" | "new" = "reuse"): { cwd: string; parts: DeliveryParts } {
  const cwd = mkdtempSync(join(tmpdir(), "navori-d2-check-"));
  dirs.push(cwd);
  const source = "Login flow\nRN-1\nRF-2\n";
  writeFileSync(join(cwd, "requirements.txt"), source);
  for (const name of ["architecture.txt", "flow.txt", "system.txt"])
    writeFileSync(join(cwd, name), "Reviewed design");
  const digest = createHash("sha256").update(source).digest("hex");
  const design =
    ui === "none"
      ? { ui, reason: "No interface is in scope" }
      : ui === "new"
        ? {
            ui,
            architecture: "architecture.txt",
            flow: "flow.txt",
            system: "system.txt",
            reviewedRevision: "r1",
            foundationPartId: "P1",
          }
        : {
            ui,
            architecture: "architecture.txt",
            flow: "flow.txt",
            system: "system.txt",
            reviewedRevision: "r1",
          };
  const parts: DeliveryParts = {
    version: 2,
    workflow: "deliveries",
    revision: 1,
    digest: "0".repeat(64),
    sources: [
      {
        id: "client",
        path: "requirements.txt",
        digest,
        locator: "Login flow",
        requirements: ["RN-1", "RF-2"],
        uiBearing: ui !== "none",
      },
    ],
    requirements: [
      { id: "RN-1", sourceId: "client", disposition: "in-scope", reason: null },
      { id: "RF-2", sourceId: "client", disposition: "in-scope", reason: null },
    ],
    design,
    deliveries: [
      {
        id: "E1",
        title: "Login",
        outcome: "User can log in",
        partIds: ["P1"],
        dependsOn: [],
        git: { branch: "feat/login", base: "main", integrationTarget: "dev", prTarget: "dev" },
      },
    ],
    parts: [
      {
        id: "P1",
        deliveryId: "E1",
        title: "Login",
        objective: "Sign in",
        scope: ["login"],
        outOfScope: [],
        dependsOn: [],
        sourceIds: ["client"],
        requirementIds: ["RN-1", "RF-2"],
        spec: null,
        foundation: ui === "new",
        acceptance: [
          {
            id: "A1",
            method: "test",
            description: "login",
            command: "bun test login",
            expected: "exit 0",
          },
        ],
        questions: [],
      },
    ],
  };
  parts.digest = contractDigest(parts);
  return { cwd, parts };
}

describe("delivery preparation", () => {
  it("rejects a source requirement omitted from contract dispositions", () => {
    const { cwd, parts } = fixture();
    parts.requirements = parts.requirements.filter((requirement) => requirement.id !== "RF-2");
    parts.parts[0]!.requirementIds = ["RN-1"];
    parts.digest = contractDigest(parts);
    expect(checkDeliveryPreparation(cwd, parts).blockers.join(" ")).toMatch(/RF-2.*disposition/);
  });
  it.each(["excluded", "deferred"] as const)(
    "accepts an explicitly %s source requirement only with a reason and no part coverage",
    (disposition: "excluded" | "deferred") => {
      const { cwd, parts } = fixture();
      const requirement = parts.requirements.find((item) => item.id === "RF-2")!;
      requirement.disposition = disposition;
      requirement.reason = "User agreed to keep this out of the current delivery";
      parts.parts[0]!.requirementIds = ["RN-1"];
      parts.digest = contractDigest(parts);
      expect(checkDeliveryPreparation(cwd, parts).blockers).toEqual([]);
      requirement.reason = null;
      parts.digest = contractDigest(parts);
      expect(checkDeliveryPreparation(cwd, parts).blockers).toContain(
        "RF-2: exclusion/deferral needs reason",
      );
    },
  );
  it("accepts source-backed reuse and no-UI design references", () => {
    for (const ui of ["reuse", "none"] as const) {
      const { cwd, parts } = fixture(ui);
      expect(checkDeliveryPreparation(cwd, parts).blockers).toEqual([]);
    }
  });
  it("requires a foundation for new UI and rejects UI-bearing none", () => {
    const created = fixture("new");
    expect(checkDeliveryPreparation(created.cwd, created.parts).blockers).toEqual([]);
    created.parts.parts[0]!.foundation = false;
    created.parts.digest = contractDigest(created.parts);
    expect(checkDeliveryPreparation(created.cwd, created.parts).blockers).toContain(
      "new UI needs a declared foundation part",
    );
    const noUi = fixture("none");
    noUi.parts.sources[0]!.uiBearing = true;
    noUi.parts.digest = contractDigest(noUi.parts);
    expect(checkDeliveryPreparation(noUi.cwd, noUi.parts).blockers).toContain(
      "UI-bearing source cannot use ui:none",
    );
  });
  it("blocks digest drift, uncovered requirements, cycles and questions", () => {
    const { cwd, parts } = fixture();
    writeFileSync(join(cwd, "requirements.txt"), "changed");
    parts.parts[0]!.requirementIds = ["RN-1"];
    parts.parts[0]!.dependsOn = ["P1"];
    parts.parts[0]!.questions = [{ text: "Who approves?", blocking: true, assignedPartId: null }];
    parts.digest = contractDigest(parts);
    const blockers = checkDeliveryPreparation(cwd, parts).blockers.join("\n");
    expect(blockers).toMatch(/digest changed/);
    expect(blockers).toMatch(/RF-2: uncovered/);
    expect(blockers).toMatch(/cycle/);
    expect(blockers).toMatch(/blocking question/);
  });
  it("rejects scope contradictions and stale design bytes", () => {
    const { cwd, parts } = fixture();
    parts.parts[0]!.outOfScope = ["login"];
    parts.digest = contractDigest(parts);
    expect(checkDeliveryPreparation(cwd, parts).blockers.join(" ")).toMatch(/scope conflicts/);
    parts.parts[0]!.outOfScope = [];
    parts.digest = contractDigest(parts);
    const before = checkDeliveryPreparation(cwd, parts).designDigest;
    writeFileSync(join(cwd, "system.txt"), "Design changed");
    expect(checkDeliveryPreparation(cwd, parts).designDigest).not.toBe(before);
  });
  it("rejects physically escaping source symlinks", () => {
    const { cwd, parts } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "navori-d2-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "source.txt"), "Login flow\nRN-1\nRF-2\n");
    symlinkSync(join(outside, "source.txt"), join(cwd, "link.txt"));
    parts.sources[0]!.path = "link.txt";
    parts.digest = contractDigest(parts);
    expect(checkDeliveryPreparation(cwd, parts).blockers.join(" ")).toMatch(/outside repo/);
  });
});
