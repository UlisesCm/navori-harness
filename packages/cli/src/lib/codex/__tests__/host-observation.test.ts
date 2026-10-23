import { describe, expect, it } from "vitest";
import {
  nativeProfileCandidates,
  nativeProfileHookCalls,
  profileSelectionIntent,
  profileProbeHookContext,
} from "../host-observation.ts";
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
  // Covers: R12, R13, R14, R16
  it("preserves fully inherited intent and requires real unchanged parent selection with known defaults", () => {
    const inherited: CodexProfileProjection = {
      ...rows[0]!,
      model: { configured: null, origin: "inherited", wouldRender: null, effectiveObserved: null },
      effort: { configured: null, origin: "inherited", wouldRender: null, effectiveObserved: null },
      rendered: { model: null, effort: null },
    };
    expect(profileSelectionIntent(inherited)).toEqual({
      model: { kind: "inherit" },
      effort: { kind: "inherit" },
    });
    const native = events();
    const call = native[1] as {
      params: {
        item: { model: string | null; reasoningEffort: string | null };
      };
    };
    call.params.item.model = null;
    call.params.item.reasoningEffort = null;
    const parent = {
      context: "principal",
      model: "gpt-6-sol",
      effort: "medium",
      unchanged: true,
      defaultsKnown: true,
    };
    expect(nativeProfileCandidates([inherited], "principal", native, parent)).toMatchObject([
      {
        model: "gpt-6-sol",
        effort: "medium",
        intent: { model: { kind: "inherit" }, effort: { kind: "inherit" } },
      },
    ]);
    expect(inherited.model.wouldRender).toBeNull();
    expect(nativeProfileCandidates([inherited], "principal", native)).toEqual([]);
    for (const changed of [
      { ...parent, context: "foreign" },
      { ...parent, effort: "high" },
      { ...parent, unchanged: false },
      { ...parent, defaultsKnown: false },
      { ...parent, effort: "" },
    ])
      expect(nativeProfileCandidates([inherited], "principal", native, changed)).toEqual([]);
    expect(
      nativeProfileCandidates(
        [{ ...inherited, effort: rows[0]!.effort }],
        "principal",
        native,
        parent,
      ),
    ).toEqual([]);
    expect(() =>
      profileSelectionIntent({ ...inherited, rendered: { model: "override", effort: null } }),
    ).toThrow("ambiguous");
    expect(() =>
      profileSelectionIntent({
        ...inherited,
        model: { ...inherited.model, configured: "conflict" },
      }),
    ).toThrow("ambiguous");
    expect(() =>
      profileSelectionIntent({ ...inherited, diagnostics: ["duplicate native role"] }),
    ).toThrow("ambiguous");
    // A later spawning-turn effort cannot be inferred from the old startup effort.
    const changedActivity = structuredClone(native) as {
      params: { item?: { reasoningEffort: string } };
    }[];
    changedActivity[2]!.params.item!.reasoningEffort = "high";
    expect(nativeProfileCandidates([inherited], "principal", changedActivity, parent)).toEqual([]);
  });
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
  it("joins distinct activity/call IDs by exact child receiver and accepts identical native events", () => {
    const baseline = events();
    const activity = baseline[2] as { params: { item: { id: string } } };
    activity.params.item.id = "unrelated";
    expect(nativeProfileCandidates(rows, "principal", baseline)).toMatchObject([
      { call: "call", activity: "unrelated", context: "child" },
    ]);
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

describe("source-bound profile hook identity candidates", () => {
  const expected = {
    probe: "b771998e-155d-4213-af16-c3ae36ebc49e",
    checkout: "/owned/fixture",
    sourcePath: "/owned/fixture/.codex/config.toml",
    principal: "principal",
  };
  const context = {
    probe: expected.probe,
    checkout: expected.checkout,
    session: expected.principal,
    call: "call",
    role: "role0",
    model: { kind: "set", value: "gpt-6-sol" },
    effort: { kind: "set", value: "medium" },
    catalog: "a".repeat(64),
    configuration: "b".repeat(64),
    inventory: "c".repeat(64),
  };
  const completed = {
    method: "hook/completed",
    params: {
      threadId: expected.principal,
      run: {
        id: "hook-run",
        source: "project",
        sourcePath: expected.sourcePath,
        eventName: "preToolUse",
        handlerType: "command",
        executionMode: "sync",
        status: "completed",
        entries: [
          {
            kind: "context",
            text: `navori-profile-probe:${JSON.stringify(context)}`,
          },
        ],
      },
    },
  };
  const v2Activity = {
    method: "item/started",
    params: {
      threadId: "principal",
      turnId: "parent-turn",
      item: {
        type: "subAgentActivity",
        id: "call",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/task",
        model: "gpt-6-sol",
        reasoningEffort: "medium",
      },
    },
  };
  const v2Parent = {
    context: "principal",
    model: "gpt-6-sol",
    effort: "medium",
    unchanged: true,
    defaultsKnown: true,
    v2: {
      turn: "parent-turn",
      hooks: [profileProbeHookContext.parse(context)],
    },
  };
  // Covers: R12, R13, R14, R16
  it("joins V2 Started directly to the authenticated nested call without restored thread metadata or V1 collab rows", () => {
    expect(nativeProfileCandidates(rows, "principal", [v2Activity], v2Parent)).toMatchObject([
      {
        nativeName: "role0",
        call: "call",
        activity: "call",
        context: "child",
        model: "gpt-6-sol",
        effort: "medium",
      },
    ]);
    expect(
      nativeProfileCandidates(rows, "principal", [v2Activity], {
        ...v2Parent,
        v2: { ...v2Parent.v2, hooks: [] },
      }),
    ).toEqual([]);
    expect(nativeProfileCandidates(rows, "principal", [v2Activity, v2Activity], v2Parent)).toEqual(
      [],
    );
  });
  // Covers: R12, R13, R14, R16
  it.each(["wrapper-call", "parent", "turn", "pair", "role", "intent", "defaults"])(
    "rejects V2 %s without borrowing identity from path or requested values",
    (field: string) => {
      const event = structuredClone(v2Activity);
      const parent = structuredClone(v2Parent);
      if (field === "wrapper-call") event.params.item.id = "wrapper-call";
      if (field === "parent") event.params.threadId = "foreign";
      if (field === "turn") event.params.turnId = "old-turn";
      if (field === "pair") event.params.item.reasoningEffort = "high";
      if (field === "role") parent.v2.hooks[0]!.role = "unknown";
      if (field === "intent") parent.v2.hooks[0]!.model = { kind: "inherit" };
      if (field === "defaults") parent.defaultsKnown = false;
      expect(nativeProfileCandidates(rows, "principal", [event], parent)).toEqual([]);
    },
  );
  // Covers: R13, R16
  it("requires the V2 hook completion on the exact parent turn", () => {
    expect(nativeProfileHookCalls([completed], { ...expected, turn: "parent-turn" })).toEqual([]);
    expect(
      nativeProfileHookCalls(
        [
          {
            ...completed,
            params: { ...completed.params, turnId: "parent-turn" },
          },
        ],
        { ...expected, turn: "parent-turn" },
      ),
    ).toEqual([context]);
  });
  // Covers: R13, R16, R18
  it("requires native hook completion and exact source/nonce/call context", () => {
    expect(nativeProfileHookCalls([completed], expected)).toEqual([context]);
    expect(nativeProfileHookCalls([context], expected)).toEqual([]);
    for (const changed of [
      { ...expected, probe: "c771998e-155d-4213-af16-c3ae36ebc49e" },
      { ...expected, checkout: "/foreign" },
      { ...expected, sourcePath: "/foreign/.codex/config.toml" },
      { ...expected, principal: "foreign" },
    ])
      expect(nativeProfileHookCalls([completed], changed)).toEqual([]);
  });
  // Covers: R13, R18
  it.each(["source", "eventName", "handlerType", "executionMode", "status"])(
    "rejects foreign %s",
    (field: string) => {
      const message = structuredClone(completed);
      Object.assign(message.params.run, { [field]: "foreign" });
      expect(nativeProfileHookCalls([message], expected)).toEqual([]);
    },
  );
  // Covers: R13, R18
  it("rejects missing context, wrong output kind, duplicate and conflicting call consumers", () => {
    const missing = structuredClone(completed);
    missing.params.run.entries = [];
    expect(nativeProfileHookCalls([missing], expected)).toEqual([]);
    missing.params.run.entries = [
      { kind: "feedback", text: completed.params.run.entries[0]!.text },
    ];
    expect(nativeProfileHookCalls([missing], expected)).toEqual([]);
    expect(nativeProfileHookCalls([completed, completed], expected)).toEqual([]);
    const conflict = structuredClone(completed);
    conflict.params.run.id = "other-run";
    conflict.params.run.entries[0]!.text = `navori-profile-probe:${JSON.stringify({ ...context, role: "role1" })}`;
    expect(nativeProfileHookCalls([completed, conflict], expected)).toEqual([]);
    expect(nativeProfileHookCalls([conflict, completed], expected)).toEqual([]);
  });
});
