import { describe, expect, it } from "vitest";
import { nativeProfileCandidates } from "../host-observation.ts";
import { isOwnedNativeObservation } from "../native-integration.ts";
import { projectCodexProfiles, type CodexProfileProjection } from "../../assets/model-profile.ts";
import { NavoriConfigSchema } from "../../config/schema.ts";

const principal = projectCodexProfiles(
  process.cwd(),
  NavoriConfigSchema.parse({
    name: "fixture",
    preset: "custom",
    engines: ["codex"],
    models: { orchestrator: "opus" },
    effort: { orchestrator: "medium" },
  }),
  { catalogPath: null, plannedAgents: [] },
)[0]!;
const rows: CodexProfileProjection[] = ["core", "extra", "local"].map((origin, index) => ({
  ...principal,
  scope: "subagent",
  origin: origin as "core" | "extra" | "local",
  nativeName: `role${index}`,
  diagnostics: [],
}));

function events(
  role = "role0",
  model = "gpt-6-sol",
  effort = "medium",
  parent = "principal",
): unknown[] {
  return [
    {
      method: "thread/started",
      params: { thread: { id: "child", agentRole: role, parentThreadId: parent } },
    },
    {
      method: "item/completed",
      params: {
        threadId: parent,
        item: {
          type: "collabAgentToolCall",
          id: "call",
          tool: "spawnAgent",
          senderThreadId: parent,
          receiverThreadIds: ["child"],
          model,
          reasoningEffort: effort,
          status: "completed",
        },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: parent,
        item: {
          type: "subAgentActivity",
          id: "call",
          kind: "started",
          agentThreadId: "child",
          agentPath: "principal/child",
          model,
          reasoningEffort: effort,
        },
      },
    },
  ];
}

describe("native profile joins are source-unverified candidates", () => {
  // Covers: R13, R14, R18
  it.each(["thread", "call", "activity"])(
    "rejects conflicting duplicate %s identities in both orders",
    (kind: string) => {
      const baseline = events();
      const index = kind === "thread" ? 0 : kind === "call" ? 1 : 2;
      const conflicting = structuredClone(baseline[index]) as {
        params: { thread?: { agentRole: string }; item?: { model: string } };
      };
      if (conflicting.params.thread) conflicting.params.thread.agentRole = "role1";
      if (conflicting.params.item) conflicting.params.item.model = "other";
      expect(nativeProfileCandidates(rows, "principal", [...baseline, conflicting])).toEqual([]);
      expect(nativeProfileCandidates(rows, "principal", [conflicting, ...baseline])).toEqual([]);
    },
  );
  // Covers: R13, R14
  it("requires the activity call ID and accepts identical duplicate native events", () => {
    const baseline = events();
    const activity = baseline[2] as { params: { item: { id: string } } };
    activity.params.item.id = "unrelated";
    expect(nativeProfileCandidates(rows, "principal", baseline)).toEqual([]);
    expect(nativeProfileCandidates(rows, "principal", [...events(), ...events()])).toHaveLength(1);
  });
  // Covers: R12, R14
  it.each(["role0", "role1", "role2"])(
    "joins exact core/extra/local role %s independently of prompt labels",
    (role: string) => {
      expect(nativeProfileCandidates(rows, "principal", events(role))).toMatchObject([
        {
          nativeName: role,
          context: "child",
          call: "call",
          activity: "call",
          model: "gpt-6-sol",
          effort: "medium",
        },
      ]);
    },
  );
  // Covers: R14
  it.each(["unrelated", "orchestrator", ""])(
    "keeps unknown/native top-level role %j pending",
    (role: string) => {
      expect(nativeProfileCandidates(rows, "principal", events(role))).toEqual([]);
    },
  );
  // Covers: R14, R18
  it.each(
    [
      events("role0", "gpt-6-luna"),
      events("role0", "gpt-6-sol", "low"),
      events("role0", "gpt-6-sol", "medium", "other"),
      events().slice(1),
      events().slice(0, 2),
    ].map((input: unknown[]) => ({ input })),
  )("rejects incomplete/mismatched creation lineage", ({ input }: { input: unknown[] }) => {
    expect(nativeProfileCandidates(rows, "principal", input)).toEqual([]);
  });
  // Covers: R14, R16
  it("keeps observedfalse after caller JSON, duplicate ambiguous calls or reroute", () => {
    const baseline = events();
    expect(
      isOwnedNativeObservation({
        observed: true,
        children: nativeProfileCandidates(rows, "principal", baseline),
      }),
    ).toBe(false);
    const reroute = {
      method: "item/started",
      params: {
        threadId: "principal",
        item: {
          type: "subAgentActivity",
          kind: "interacted",
          agentThreadId: "child",
          model: "different",
        },
      },
    };
    expect(nativeProfileCandidates(rows, "principal", [...baseline, reroute])).toEqual([]);
    const anotherCall = {
      method: "item/completed",
      params: {
        threadId: "principal",
        item: {
          type: "collabAgentToolCall",
          id: "another",
          tool: "spawnAgent",
          senderThreadId: "principal",
          receiverThreadIds: ["child"],
          model: "gpt-6-sol",
          reasoningEffort: "medium",
          status: "completed",
        },
      },
    };
    expect(nativeProfileCandidates(rows, "principal", [...baseline, anotherCall])).toEqual([]);
  });
});
