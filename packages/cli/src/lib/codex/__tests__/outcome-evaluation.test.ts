import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  captureOutcomeObservation,
  validateOutcomeObservations,
  validateOutcomeFile,
  EVALUATION_FIXTURES,
} from "../outcome-evaluation.ts";

const mock = vi.hoisted(() => ({ observe: vi.fn(), owned: vi.fn(() => false) }));
vi.mock(import("../native-integration.ts"), () => ({
  observeNativeProfiles: mock.observe,
  isOwnedNativeObservation: mock.owned,
}));
let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-outcome-controls-")));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, ".gitignore"), ".navori/\n");
  writeFileSync(join(cwd, "fixture.ts"), "export const input=1;\n");
  mock.observe.mockReset();
  mock.observe.mockRejectedValue(new Error("unsupported source"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("strict production evaluation consumer", () => {
  // Covers: R17, R14, R15
  it("required-evidence-per-engine keeps unavailable version/model/effort, duration and consumption explicit", async () => {
    const record = await captureOutcomeObservation(cwd, "bug-regression", "codex");
    expect(record).toMatchObject({
      status: "pending",
      source: "unavailable",
      phase: "observation-only",
      hostVersion: null,
      model: null,
      effort: null,
      consumption: "unavailable",
      independentReview: null,
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.mandatoryControls.every((entry) => entry.state === "pending")).toBe(true);
    expect(validateOutcomeObservations(cwd, [record]).ok).toBe(false);
  });
  // Covers: R17
  it("rejects even eight self-authored fixed combinations rather than crediting copied native-looking JSON", async () => {
    const records = [];
    for (const fixture of EVALUATION_FIXTURES) {
      const candidate = await captureOutcomeObservation(cwd, fixture, "codex");
      records.push(candidate, { ...candidate, id: randomUUID(), engine: "claude" });
    }
    const verdict = validateOutcomeObservations(cwd, records);
    expect(verdict.reasons.some((reason) => reason.includes("eight exact"))).toBe(false);
    expect(
      verdict.reasons.some((reason) => reason.includes("current owned native source unavailable")),
    ).toBe(true);
    expect(verdict.reasons.some((reason) => reason.includes("mandatory controls"))).toBe(true);
    expect(verdict.ok).toBe(false);
  });
  // Covers: R17
  it("preserves a failed attempt and its later observation separately, without rewriting failure evidence", async () => {
    mock.observe.mockImplementationOnce(() => {
      writeFileSync(join(cwd, "fixture.ts"), "export const input=2;\n");
      throw new Error("changed");
    });
    const failed = await captureOutcomeObservation(cwd, "resume-after-state-change", "codex");
    const retained = readFileSync(
      join(cwd, ".navori/state/handoffs", `outcome-${failed.id}.json`),
      "utf8",
    );
    const next = await captureOutcomeObservation(cwd, "resume-after-state-change", "codex");
    expect(failed.status).toBe("failed");
    expect(next.id).not.toBe(failed.id);
    expect(
      readFileSync(join(cwd, ".navori/state/handoffs", `outcome-${failed.id}.json`), "utf8"),
    ).toBe(retained);
    expect(failed.attempts[0]?.reason).toBe("inputs-changed-during-observation");
  });
  // Covers: R6, R17
  it("rejects asserted approval/control fields and arbitrary fixture/engine selectors", async () => {
    const record = await captureOutcomeObservation(cwd, "subagent-approval-route", "codex");
    expect(validateOutcomeObservations(cwd, [{ ...record, approved: true }]).reasons).toEqual([
      "malformed or caller-asserted outcome/source/control evidence",
    ]);
    await expect(captureOutcomeObservation(cwd, "arbitrary-command", "codex")).rejects.toThrow();
    await expect(
      captureOutcomeObservation(cwd, "bug-regression", "untrusted-engine"),
    ).rejects.toThrow();
    expect(validateOutcomeFile(cwd, "../outside.json").ok).toBe(false);
  });
});
