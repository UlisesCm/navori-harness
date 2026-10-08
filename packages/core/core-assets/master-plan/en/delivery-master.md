# Deliveries contract template (`navori master template delivery-master`)

This human-authored document describes intent and decisions. Canonical facts, IDs, paths, digests, assignments, and criteria belong in `parts.json` (contract v2); do not copy values without verifying them. Complete placeholders before requesting approval. Technical preparation is not user approval, client acceptance, publication, or deployment.

## Metadata

Project: <name>
Stage: <NN-slug>
Contract revision: <revision>
Consolidated sources: <S<n>: path, locator, and SHA-256 digest>

## Outcome and context

<Desired outcome and why. Reference sources by S<n>; identify requirements as RN-<n>, RF-<n>, or RNF-<n>.>

## Sources and requirement coverage

Record each source in `parts.json` with `id`, repository-relative path, SHA-256 `digest` of its bytes, literal `locator`, and declared requirements. Set `uiBearing` according to the actual content. Link every RN/RF/RNF to its `sourceId` and assign disposition `in-scope`, `excluded`, or `deferred`; exclusions and deferrals require a reason. Every in-scope requirement must be covered by parts.

## Shared architecture and design

Choose `design.ui`: `none` only when no source is UI-bearing, with an explanatory `reason`; `reuse` when existing design is reused; `new` when new design is needed. For `reuse`/`new`, record existing, repository-contained paths for architecture, flow, and system, plus `reviewedRevision`. For `new`, identify a `foundationPartId` marked `foundation: true`. Filling these fields does not claim the review is complete.

## Deliveries and Git policy

In `parts.json`, define each E<n> with outcome, assigned parts, dependencies, and Git fields `branch`, `base`, `integrationTarget`, and `prTarget`. Each `E<n>` in the spec `tasks.md` must declare the same id as the delivery in `parts.json`, and the PR unit is the complete delivery. Define each P<n> with delivery, objective, scope, out of scope, dependencies, sources, and covered RN/RF/RNF. Dependencies must be acyclic and assignments must agree in both directions.

| Delivery | Outcome | Parts | Depends on | Branch / base / integration / PR target |
|---|---|---|---|---|
| E<n> | <outcome> | P<n> | <E<n> or []> | <explicit values> |

## Criteria and questions

Every part requires `A<n>` criteria with method `test`, `command`, or `manual`. For test/command, record `description`, command, and expected result; for manual, record `description`, what to inspect, and a repository-relative artifact path. These are proposed criteria, not evidence of execution or acceptance.

Store questions on their part: `blocking: true` blocks preparation until resolved; a non-blocking future question must have a valid `assignedPartId`. Do not turn an unresolved question into an implicit decision.

## Baseline and queue authorization

Before preparing a baseline, verify sources, bytes/digests, locators, coverage, design paths, dependencies, and criteria using the read-only preparation check. The baseline requires explicit user approval of the exact contract and source/design set; record that decision in state rather than inferring it from this document.

Queue authorization requires explicit user approval for a bounded set of parts from one delivery. A dependent delivery waits for completion evidence in D3. With `new` design, only the foundation part may be authorized until there is evidence it has been implemented. Authorization does not assert that work started or finished.

## Open items and limits

- Blocking questions: <none or list with owner>
- Deferred decisions and owning part: <none or list>
- Baseline approval: <pending; record only after the user's explicit decision>
- Queue approval: <pending; record only after the user's explicit decision>
- Client acceptance, publication, and deployment: <do not claim without independent evidence>

D3/D4 are not enabled by this template or by queue authorization.
