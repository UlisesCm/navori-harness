# Codex plan-gate probe (#1082)

## Result

The plan-gate remains unsupported/advisory for Codex. A real-host probe against
Codex CLI **0.158.0**, run on 2026-09-28, showed that a selective gate cannot
reliably identify an implementer delegation before the child starts. This is a
version-scoped observation, not a claim about every Codex release.

## Probe and observed payload

The probe used a disposable checkout with an isolated Codex home and trust
state. Hook trust was not bypassed, and the global Codex configuration was not
changed. The raw prompt was not stored. The relevant `PreToolUse` event was
`collaborationspawn_agent`; its `tool_input` contained `message` and `task_name`,
and the event carried a tool-use id. It did not expose `agent_type` or
`subagent_type`.

The probe used a synthetic message marker to test whether the hook could inspect
the message. The marker was not readable in the observed hook payload. This
result does **not** establish that the message is encrypted; it only records
that the probe could not read the marker there.

## Controls and limitation

The attempted-call-linked blanket-deny control denied the collaboration spawn
and observed zero child starts. The allow control observed one child start. A
spawn whose `task_name` was `implementer` produced a default-role child; the
task name did not prove the child's typed role. Therefore blanket denial can
stop delegation, but it cannot selectively enforce the implementer workplan
precondition while allowing other collaborations. The probe was not viable for
selective gating.

## Decision and upgrade criteria

Keep Codex plan-gate unsupported/advisory; do not register a hook that suggests
it enforces a condition it cannot observe. Revisit after a Codex upgrade only
when a live probe demonstrates a readable, typed agent role and verifiably
readable workplan-opening data in the pre-spawn event. Require both negative
and positive live controls: the negative control must deny an implementer
spawn without starting a child, and the positive control must allow a compliant
implementer plus a non-implementer collaboration. Repeat in isolated trust
state without changing global configuration.

## Evidence and scope

The redacted record is `.codex/progress/probe_1082.json`; implementation
capability and hook-registration rationale are in
`packages/cli/src/engines/shared/engine-capabilities.ts` and
`packages/cli/src/engines/codex/hook-registrations.ts`. The payload details are
internal behavior observed in the pinned 0.158.0 binary and are not presented
as a documented stable interface. Consult the [official Codex hooks
documentation](https://learn.chatgpt.com/docs/hooks) for current documented
behavior; documentation may evolve independently of this probe.
