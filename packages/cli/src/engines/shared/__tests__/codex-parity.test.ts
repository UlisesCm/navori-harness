import { describe, expect, it } from "vitest";
import {
  CODEX_PARITY,
  CODEX_VERIFICATIONS,
  CodexParitySchema,
  codexSourceIssue,
  minCodexVersion,
  type CodexParity,
  type CodexVerification,
} from "../codex-parity.ts";

const SOURCE = {
  url: "https://learn.chatgpt.com/docs/hooks",
  codexVersion: "0.160.0",
  verifiedAt: "2026-10-02",
};

const verification = (
  codexVersion: string,
  overrides: Partial<CodexVerification> = {},
): CodexVerification => ({
  capability: "fixture",
  url: "https://learn.chatgpt.com/docs/hooks",
  codexVersion,
  verifiedAt: "2026-10-02",
  probe: "pass",
  ...overrides,
});

describe("CodexParitySchema", () => {
  // Covers: R1
  it("accepts the three states and rejects anything else", () => {
    for (const row of [
      { state: "igual", enforcing: false },
      { state: "equivalente", mechanism: "SubagentStop", enforcing: false },
      { state: "limite-codex", source: SOURCE },
    ]) {
      expect(CodexParitySchema.safeParse(row).success).toBe(true);
    }
    expect(CodexParitySchema.safeParse({ state: "native", enforcing: false }).success).toBe(false);
  });

  // Covers: R1
  it("an equivalente row must name its mechanism, a limite-codex row its source", () => {
    expect(
      CodexParitySchema.safeParse({ state: "equivalente", mechanism: "", enforcing: false })
        .success,
    ).toBe(false);
    expect(CodexParitySchema.safeParse({ state: "limite-codex" }).success).toBe(false);
  });
});

describe("codexSourceIssue", () => {
  // Covers: R2
  it("accepts the three official hosts", () => {
    expect(codexSourceIssue("https://learn.chatgpt.com/docs/hooks", "0.160.0")).toBeNull();
    expect(codexSourceIssue("https://developers.openai.com/codex/hooks", "0.160.0")).toBeNull();
    expect(
      codexSourceIssue(
        "https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/exec_policy.rs",
        "0.160.0",
      ),
    ).toBeNull();
  });

  // Covers: R2
  it("rejects an unparsable url", () => {
    expect(codexSourceIssue("not a url", "0.160.0")).not.toBeNull();
  });
});

describe("the real CODEX_PARITY table", () => {
  // Covers: R1, R2
  it("is structurally valid and every limite-codex row has an official source", () => {
    for (const [key, row] of Object.entries(CODEX_PARITY)) {
      expect(CodexParitySchema.safeParse(row).success, key).toBe(true);
      if (row.state === "limite-codex") {
        expect(codexSourceIssue(row.source.url, row.source.codexVersion), key).toBeNull();
      }
    }
  });

  // Covers: R1
  it("claims no probe-backed guarantee before a verification exists", () => {
    expect(Object.keys(CODEX_VERIFICATIONS)).toEqual([]);
    for (const [key, row] of Object.entries(CODEX_PARITY)) {
      if (row.state !== "limite-codex") expect(row.enforcing, key).toBe(false);
    }
  });
});

describe("minCodexVersion", () => {
  const equal: CodexParity = { state: "igual", enforcing: false, verification: "V1" };
  const equivalent: CodexParity = {
    state: "equivalente",
    mechanism: "m",
    enforcing: false,
    verification: "V2",
  };
  const limit: CodexParity = { state: "limite-codex", source: SOURCE };

  // Covers: R4
  it("returns the highest version verified for an igual or equivalente row", () => {
    expect(
      minCodexVersion(
        { a: equal, b: equivalent },
        { V1: verification("0.150.0"), V2: verification("0.160.0") },
      ),
    ).toBe("0.160.0");
  });

  // Covers: R4
  it("is the same version when one row sets it and a lower one is also verified", () => {
    expect(
      minCodexVersion(
        { a: equal, b: equivalent },
        { V1: verification("0.160.0"), V2: verification("0.160.0") },
      ),
    ).toBe("0.160.0");
    expect(
      minCodexVersion(
        { a: equal, b: equivalent },
        { V1: verification("0.158.0"), V2: verification("0.150.0") },
      ),
    ).toBe("0.158.0");
  });

  // Covers: R4
  it("ignores limite-codex rows, failed probes and unverified rows", () => {
    expect(
      minCodexVersion(
        {
          a: { ...equal, verification: "V1" },
          limit,
          unverified: { state: "igual", enforcing: false },
          failed: { ...equal, verification: "V3" },
        },
        { V1: verification("0.140.0"), V3: verification("0.170.0", { probe: "fail" }) },
      ),
    ).toBe("0.140.0");
    expect(minCodexVersion({ limit }, {})).toBe("0.0.0");
  });
});
