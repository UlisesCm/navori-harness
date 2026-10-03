import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_PARITY,
  CODEX_VERIFICATIONS,
  CodexParitySchema,
  codexParityIssues,
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

  // Covers: R22, R25
  it("promotes exactly the rows a passing smoke backs", () => {
    const enforcing = Object.entries(CODEX_PARITY)
      .filter(([, row]) => row.state !== "limite-codex" && row.enforcing)
      .map(([key]) => key)
      .sort();
    expect(enforcing).toEqual([
      "flow:nested-agent-dispatch",
      "hook:bash-outcome-watch",
      "hook:general-purpose-confirm",
      "hook:plan-gate",
      "hook:pr-publisher-confirm",
      "hook:role-guard",
      "plugin-script:tgrep/guard-search-routing.sh",
    ]);
    for (const [key, row] of Object.entries(CODEX_PARITY)) {
      if (row.state === "limite-codex") continue;
      expect(codexParityIssues(row), key).toEqual([]);
      if (row.enforcing) {
        expect(CODEX_VERIFICATIONS[row.verification ?? ""]?.smoke, key).toBe("pass");
      }
    }
  });

  // Covers: R22
  it("keeps master-plan-context unpromoted: its evidence is indirect", () => {
    const row = CODEX_PARITY["hook:master-plan-context"];
    expect(row?.state === "equivalente" && row.enforcing).toBe(false);
    expect(row?.state === "equivalente" && row.verification).toBe("S10");
    expect(CODEX_VERIFICATIONS.S10?.smoke).toBeUndefined();
  });

  // Covers: R22, R9
  it("every verification is dated, versioned, officially sourced; spawn ones cover v1 and v2", () => {
    for (const [id, v] of Object.entries(CODEX_VERIFICATIONS)) {
      expect(id, id).toMatch(/^[VS]\d+$/);
      expect(v.codexVersion, id).toBe("0.160.0");
      expect(v.verifiedAt, id).toBe("2026-10-03");
      expect(codexSourceIssue(v.url, v.codexVersion), id).toBeNull();
      if (v.multiAgent !== undefined) expect(v.multiAgent, id).toEqual(["v1", "v2"]);
    }
    expect(CODEX_VERIFICATIONS.S4?.multiAgent).toEqual(["v1", "v2"]);
  });

  // Covers: R22
  it("the research doc has one section per verification id", () => {
    const doc = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../docs/research/codex-paridad-verificacion.md",
    );
    // The doc is written by the scribe from the implementer's markdownRequests;
    // until it exists there is nothing to compare against.
    if (!existsSync(doc)) return;
    const anchors = [...readFileSync(doc, "utf-8").matchAll(/^## ([VS]\d+)\b/gm)].map((m) => m[1]);
    expect(anchors.sort()).toEqual(Object.keys(CODEX_VERIFICATIONS).sort());
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
