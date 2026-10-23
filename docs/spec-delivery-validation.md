# Structural classification and functional deliveries

`navori spec classify` assigns PR units from the declared deliveries and size.
`navori spec check` validates their Markdown structure and requirement coverage.
Both report `validation.scope: "structural"` and
`validation.functionalDelivery: "unverified"`, even when they exit successfully.
Neither executes acceptance commands or establishes that a runtime consumer exists.
`maxPrsPerSpec` is a ceiling; a result of four PRs does not justify four capabilities.

Before splitting, identify each independently usable capability, its runtime entry,
consumer and executable acceptance. Size alone does not justify splitting. Contracts,
schemas and tests that enable a later capability belong in milestones of its PR.
A foundation is an exception only when a real consumer ships in that same PR.

At delivery close, the shared reviewer instructions require a **Functional delivery**
entry in the review report containing:

| Evidence | Required observation |
|---|---|
| Capability | Behavior usable from this delivery without an unshipped integration |
| Runtime path | Entry → consumer → contract, with file and symbol anchors checked against the shipping diff |
| Acceptance | Executed `A<n>` command, actual result and the observable behavior it demonstrates |

An import, declaration, helper-to-helper call, test-only caller, `effect: behavior`,
`[observable]` or `Consumes` line cannot substitute for that evidence. Missing evidence
is `SPEC_MISS`; the publisher returns a closing delivery to review instead of opening
its PR. Milestones remain verification/commit units and `R<n>` test traceability stays
required. No extra full gate per milestone is introduced.

## Regression and comparison

The command regression builds a shared contract with a passing helper test but no
runtime entry. Its spec declares a consumer and passes structural checks; functional
validation stays unverified. It then adds an executable entry that consumes the contract,
checks its real output, and confirms that structural checking still does not attest
that separate behavioral evidence.

```sh
cd packages/cli
bun run test src/commands/__tests__/spec.test.ts src/lib/spec/__tests__/classify.test.ts src/engines/__tests__/functional-delivery.test.ts
```

The engine comparison renders the current checkout's shared assets through both
Claude and Codex adapters and checks planning, reviewer rejection and publication
instructions. It is deterministic and uses no model calls. It establishes equal
instructions on those surfaces, not equal native behavior across host versions.
The original #1312 report does not establish a Codex-exclusive cause; a controlled
native comparison would require separate evidence.

This correction exposes the structural limit and strengthens the existing review
protocol. It does not add a static semantic analyzer or a new authenticated enforcement
boundary. The functional verdict still requires inspecting actual code and acceptance.

Refs [#1312](https://github.com/UlisesCm/navori-harness/issues/1312).
