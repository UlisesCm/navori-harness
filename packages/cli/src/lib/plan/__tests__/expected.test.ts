import { describe, expect, it } from "vitest";
import {
  expectedEvidenceProblem,
  parseExpected,
  type ExpectedObservation,
  type ExpectedSpec,
} from "../expected.ts";

describe("structured expected predicates", () => {
  // Covers: R17 (0045)
  it.each<{ text: string; spec: ExpectedSpec }>([
    { text: "exit 0", spec: { kind: "exit", code: 0 } },
    { text: "exit 255", spec: { kind: "exit", code: 255 } },
    { text: "contains: café", spec: { kind: "contains", text: "café" } },
    { text: "contains: /literal/", spec: { kind: "contains", text: "/literal/" } },
    { text: "matches: /^ready$/im", spec: { kind: "matches", source: "^ready$", flags: "im" } },
    { text: "matches: /a/b/u", spec: { kind: "matches", source: "a/b", flags: "u" } },
    { text: "exit0", spec: { kind: "free" } },
    { text: "exit 0, 0 failed", spec: { kind: "free" } },
    { text: "pass", spec: { kind: "free" } },
    { text: "The output contains: ready", spec: { kind: "free" } },
  ])(
    "parses the complete form $text",
    ({ text, spec }: { text: string; spec: ExpectedSpec }): void => {
      expect(parseExpected(text)).toEqual(spec);
    },
  );

  // Covers: R17 (0045)
  it.each([
    "exit 256",
    "exit 00",
    "contains:",
    "contains: value\n",
    "contains: a\nb",
    "matches: /[/",
    "matches: /x/g",
    "matches: /x/ii",
    "matches: /x/\n",
  ])("rejects malformed structured syntax %j", (text: string): void => {
    expect(parseExpected(text)).toMatchObject({ kind: "invalid" });
  });
});

describe("expected evidence validation", () => {
  // Covers: R19 (0045)
  it.each<{ expected: string; observation: ExpectedObservation }>([
    { expected: "pass", observation: {} },
    { expected: "exit 0", observation: {} },
    {
      expected: "contains: ready",
      observation: { expected: "contains: ready", exit: 0, outcome: "pass" },
    },
    {
      expected: "matches: /ready/i",
      observation: { expected: "matches: /ready/i", exit: 0, outcome: "pass" },
    },
    { expected: "exit 2", observation: { expected: "exit 2", exit: 2, outcome: "pass" } },
  ])(
    "accepts a supported observation %#",
    ({ expected, observation }: { expected: string; observation: ExpectedObservation }): void => {
      expect(expectedEvidenceProblem(expected, observation)).toBeUndefined();
    },
  );

  // Covers: R19 (0045)
  it.each<{ expected: string; observation: ExpectedObservation }>([
    { expected: "contains: ready", observation: {} },
    { expected: "exit 2", observation: {} },
    { expected: "exit 2", observation: { expected: "exit 2", exit: 0, outcome: "pass" } },
    {
      expected: "contains: ready",
      observation: { expected: "contains: ready", exit: 2, outcome: "pass" },
    },
    {
      expected: "contains: ready",
      observation: { expected: "contains: different", exit: 0, outcome: "pass" },
    },
    {
      expected: "contains: ready",
      observation: { expected: "contains: ready", exit: 0, outcome: "fail" },
    },
    {
      expected: "contains: ready",
      observation: { expected: "contains: ready", exit: 0, outcome: "unevaluated" },
    },
    { expected: "contains: ready", observation: { expected: "contains: ready", outcome: "pass" } },
    { expected: "pass", observation: { exit: 2 } },
    { expected: "pass", observation: { exit: -1 } },
    { expected: "pass", observation: { exit: 0, outcome: "fail" } },
    { expected: "matches: /[/", observation: {} },
  ])(
    "rejects an unproved or failed observation %#",
    ({ expected, observation }: { expected: string; observation: ExpectedObservation }): void => {
      expect(expectedEvidenceProblem(expected, observation)).toEqual(expect.any(String));
    },
  );
});
