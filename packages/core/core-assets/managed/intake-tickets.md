## Tickets: problem first, proposed solution second

A ticket (bug or feature, from any board) describes a SYMPTOM and often ships a proposed solution. Treat them differently:

- **The problem is the contract.** Verify it in the repo with evidence (`file:line`, a repro, a query) before writing code. If you can't confirm it, that's a finding to report — not a reason to implement anyway.
- **The proposed solution is a suggestion, never the spec.** Evaluate it against the verified problem: it may solve it, mask it, or target something else. You have standing to propose a different path — cite why yours beats the ticket's.
- **Not every ticket proceeds.** Legitimate outcomes besides "implement": already solved, can't reproduce, works as intended, needs splitting into N tickets, blocked on missing info. Saying so early — with evidence — beats a polished PR for the wrong fix.
- **Size is measured, not assumed.** Before calling something small, run the command that proves it (call sites, files touched, layers crossed). A one-line description routinely hides a 13-call-site change.

The `ticket-intake` skill runs this as a pipeline; the `ticket-audit` agent produces the verdict with evidence.
