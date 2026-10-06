# Dual-workflow delivery pilot: protocol and evidence status

> **Status: four negative probes observed on 2026-10-06; comparative pilot deferred to separate research; not a completed-pilot report.** This document separates installed-adapter fixture results from host-live probes and comparative pilot measurements. It does not change doctrine, gates, global configuration, or permission policy.

## Evidence status for this cut

| Evidence layer | Status | What it establishes |
|---|---|---|
| Installed-adapter fixtures | **Measured** | The exact combined A4 command passed 193/193 tests across 6/6 files in 11.78 seconds (exit 0) over the approved combined working tree at base HEAD `502634ee1628b0ffe29d5d50287ea2d9af412e7e`, with approved dirty source edits present but not committed. This is an aggregate runner result, not a per-file count. The parity fixture rendered installed Claude and Codex adapters in disposable test directories. Its matrix contains 18 consent-command fixtures and 14 non-consent command fixtures, plus registration, raw-payload, and inventory checks; matrix enumeration is not a separate runner count. For supported Bash / `tool_input.command` fixtures across available shells, Claude emitted ask and Codex deny-as-confirmation for sensitive commands, while opt-in toggles retained the legacy plan-gate. Commands were hook payload data, not CLI approvals executed by the test. Assertions cover cooperative review/capture consent, accepted/declined/deferred/discarded decisions, publication without deployment, revocation, manual criteria, explicit slice refresh, and existing baseline/queue/legacy approval behavior. |
| Local runtime CLI | **Measured; host-live pending** | In a disposable repository, `master init` generated a delivery stage (exit 0); `status` returned the stage (exit 0); repeat `init` exited 0 with unchanged state. Missing `parts.json`, `delivery-baseline` without `--approved-by user`, and `delivery-queue` without `--approved-by user` each exited 1 with unchanged state. This establishes local CLI behavior only, not host interception or real operator approval. The rebuilt local CLI also resolved the historical 19-current vs 18-stale-global hook-inventory discrepancy without changing global policy. |
| Raw-payload limitation | **Observed in fixture** | The raw Codex `exec_command`/`cmd` fixture emitted no interception output. This does not establish host normalization, interception, or live hook correlation. |
| Inventory | **Unverified; non-enforcing** | The inventory remains equivalent and non-enforcing without verification; no live verification is claimed. |
| Negative probes (A5) | **Observed** | Four negative probes were run on 2026-10-06 in a disposable repository with an isolated HOME, using the CLI from source at main `0551a5df` and Claude Code in auto mode with the hook provided by global navori 0.11.2. Limits: one host, no Codex host-live, a single operator, no authenticated reviewer identity, no client acceptance, deployment or publication, and no interruption/resumption. See "Observed negative probes". |
| Comparative pilot | **Deferred to separate research** | No matched pilot metrics were measured. The user approved this scope: the comparison is needed only before proposing deliveries as the default, and no savings are claimed. Actual operator/client attestations, deployment/publication, paid-model live pilot, and comparative metrics remain outstanding. The A4 fixtures did not run or establish the global quality gate or a fresh receipt; the final PR result is recorded independently. |

The combined A4 result is fixture evidence only; it is not evidence of authenticated reviewer identity, operator consent, client acceptance, or live host-hook correlation. The earlier focused 19/19 result (one file, 2.73 seconds) is historical evidence from the earlier D5 worktree, not the current combined run. The historical PR1225 CI success is separate from this change's fresh shipping gate, which remains pending review. The operator's copyable setup and probe checklist is recorded in the local-only `manualChecklist` field of `.navori/state/handoffs/impl_dual-workflow-a5.json`; that ignored handoff file is retained locally and is not distributed. It is not an attestation that those steps ran.

## Observed negative probes

**Setup.** Disposable repository, isolated HOME, CLI run from source at main `0551a5df`, Claude Code in auto mode with the hook provided by global navori 0.11.2.

1. **Stale criterion.** After a tracked file changed and was committed, `delivery-review` for P1 was refused with `P1.A1: tree changed since the run (uncommitted changes)`, and re-recording via `delivery-criterion` was refused with `current host provenance required: tree changed since the run (uncommitted changes)`. Limitation: the wording says "uncommitted" even for committed drift; the refusal itself is correct.
2. **Unauthorized part.** `delivery-slice --part P2` and `delivery-criterion --part P2 --criterion A1` were both refused with `part is not in the current authorized queue`.
3. **Out-of-repository path.** `delivery-review --report` with a relative traversal path and with an absolute path were both refused with `invalid state artifact name`; a symlink inside the repo pointing outside was refused with `state artifact escapes checkout`.
4. **Consent denied.** Run by the user as operator in Claude Code in `auto` permission mode; the hook was routed through the globally installed navori 0.11.2, while the scripted probes used the CLI from source.
   - Positive control: the user approved the confirmation and the command executed. 0.11.2 lacks `delivery-queue`, so it printed usage, and state did not change for that reason.
   - Denial: the user rejected, the host returned "The tool use was rejected", no navori output appeared, and `state.json` stayed identical, with authorization still P1 only.

The three scripted probes each recorded the command, exit code, stderr and SHA-256 of 10 files before and after; each exited 1 with all hashes unchanged. The consent probe was verified from the host transcript and a `state.json` comparison.

**Limits.** One host; no Codex host-live; a single operator; no authenticated reviewer identity; no client acceptance, deployment or publication; no interruption/resumption; no comparative metrics.

## Pilot boundary

The pilot boundary and metrics below remain protocol for the deferred research. The pilot should compare two matched workflows without changing the existing brownfield baseline:

- **Brownfield baseline:** complete a pending ticket or spec using the existing delivery workflow, without opting into the delivery protocol.
- **Opt-in greenfield delivery:** use the delivery protocol for a bounded queue, with the same task class and comparable scope. Opt-in does not replace the legacy plan-gate.

Keep host, CLI, model, configuration, task prompt and checkout/commit context fixed within each comparison where feasible. Record deviations rather than silently treating unmatched runs as a comparison. Do not infer customer acceptance, deployment, publication, or paid-model execution from local implementation or fixtures.

## Bounded workflow and negative cases

Use a small queue with explicit completion criteria. Interrupt it at a recorded point, then resume from the recorded state; check that completed work is not duplicated and unfinished work is not treated as complete. Record each case as passed, failed, or not run:

1. Normal bounded-queue completion and interruption/resumption.
2. Consent denied: the action stops; for Codex, the operator must explicitly execute the denied-attestation command where required. An agent must not simulate real operator consent.
3. Stale criterion: the workflow refuses to proceed on stale evidence.
4. Unauthorized part: work outside the approved part is refused.
5. Out-of-repository path: the workflow refuses work outside the intended repository.

These are pilot criteria, not claims that host-live behavior has already been verified. Keep the brownfield ticket/spec unchanged; the opt-in greenfield run is a separate bounded delivery exercise.

## Record for every observed probe

For reproducibility, record the exact host and version, CLI version, model and configuration, action attempted, and a redacted observed outcome. Include the probe criterion and whether it passed, failed, or was unavailable. Do not include raw private user data or transcripts.

Measure only observed values:

| Metric | Recording rule |
|---|---|
| Time to first verified outcome | Record elapsed time and the outcome used to verify it. |
| Total time and wait time | Record separately, with the start/end points used. |
| Retries, defects, and handoffs | Count observed occurrences and identify their redacted outcome. |
| Tokens, cache, cost, and billing | Record only when the host exposes them. Otherwise mark **unavailable** or **pending**; do not estimate or fabricate values. |

Do not claim savings from unavailable token, cache, cost, or billing data. If runs are not matched or a probe cannot be performed, disclose that limitation and leave the comparative conclusion pending.

## Completion boundary

A5 closes with the negative probes only. This document records combined fixture and local runtime CLI evidence, the four observed negative probes, and a protocol for the deferred comparative measurement. Still not claimed: a final quality gate or fresh receipt, Codex host-live behavior, client consent, authenticated reviewer identity, interruption/resumption, deployment/publication, comparative metrics or savings, and a completed pilot. It does not authorize a doctrine, gate, configuration, or permission-policy change.
