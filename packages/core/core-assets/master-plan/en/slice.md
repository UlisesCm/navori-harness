# Part template (`navori master template slice`)

## Identity and outcome

ID: <P<n>>
Delivery: <E<n>>
Title: <title>
Observable outcome: <outcome of this part>

## Scope

- In scope: <items>
- Out of scope: <explicit items>
- Dependencies: <P<n> or []>
- Sources: <S<n>, with verified path, locator, and digest>
- Covered requirements: <RN-n / RF-n / RNF-n>

## Proposed acceptance criteria

Store these canonical criteria in `parts.json` as `acceptance`; use `A<n>` IDs (shown as P<n>.A<n>).

| ID | Method | Observable description | Evidence / expected condition |
|---|---|---|---|
| P<n>.A<n> | test | <observable result> | command and expected result |
| P<n>.A<n> | command | <observable result> | command and expected result |
| P<n>.A<n> | manual | <what to inspect> | artifact at a repository-relative path |

Do not invent executed results: technical evidence is recorded only after running or inspecting. A manual criterion does not imply operator confirmation.

## Design and review

Spec: <existing relative path or null>
Shared design: <none, reuse, or new as declared in the contract>
Architecture / flow / system: <corresponding existing paths, if applicable>
Design review: <recorded revision or pending>
Foundation part: <true/false; must agree with the contract>

## Questions

| Question | Blocks preparation | Owning part |
|---|---|---|
| <text> | <true/false> | <P<n> or null only when blocking> |

Non-blocking future questions require a valid owning part. Resolving a question is a separate decision; do not mark it resolved by omission.

## Operator approval and evidence status

Baseline approval: **pending**. Record only after the user's explicit approval of the exact contract identity and its sources/design.

Queue authorization: **pending**. Record only after the user's explicit approval of this part within a bounded queue for one delivery, with prerequisites included. Authorization enables only that queue; it is not evidence of start, execution, completion, review, acceptance, publication, or deployment.

Technical evidence: <pending; add only a verifiable command/test result or inspected artifact, with path and revision>
