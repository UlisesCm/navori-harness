# Shared "the host cancelled this hook" recorder — inlined into the three gate
# hooks at render time (see the include directive in the source scripts +
# lib/hook-includes.ts).
#
# WHY (#797): a `command` hook that reaches its host timeout is CANCELLED, and
# bash still runs the EXIT trap on the way out with `$?` == 0 — the last
# COMPLETED command was the `trap` builtin itself. So the recorder's "exit code
# is zero" branch recorded a gate aborted after 3 seconds of a 20-second run as
# `allow`, "gate ejecutado y verde". Reproduced end to end on the RENDERED hook;
# the only trace of the truth was an `ms` nobody reads.
#
# That false green is worse than the absence it replaced: `quality-gate-aborted`
# only fires on a `gate-started` with NO terminal record, so the fake `allow`
# satisfied the detector and disarmed it. The signal itself is therefore the
# witness — recorded here, before the process dies, under its own verdict
# (`gate-killed`): never `allow`, never `block`. Nothing was validated, and the
# host had already discarded this hook's output when it sent the signal.
#
# The docs do not say WHICH signal the host uses to cancel, so this covers the
# handled ones (TERM/INT/HUP) while `gate-started` keeps covering SIGKILL, which
# no handler can ever observe. Both halves are needed: either one alone detects
# a scenario that may not be the one that happens.
#
# FAIL-OPEN like everything else in the recorder: the handler records, re-raises
# the ORIGINAL signal with its default disposition — so the process still dies
# from what it was sent instead of continuing as if nothing happened — and never
# changes what the host does with the tool call. It is deliberately NOT a
# process-tree kill: the gate's own child (`pnpm lint`, `semgrep`, `jscpd`)
# already outlives the hook today, and killing someone else's build from an
# observer is a decision of its own (#797, residue 3).
#
# SIGNAL DEFERRAL, so the recorded `ms` is not read as a second lie: bash does
# not run a trap while it waits for a foreground command, so under bash the
# record lands when the gate command FINISHES, not when the signal arrived. The
# verdict is the same either way and the host is long gone by then; only the
# instant differs.
#
# `navori_audit_signal` is what keeps the two recorders from both writing: the
# EXIT trap runs after this one and must stay quiet, since its `$?` is exactly
# the value that cannot be trusted here.
navori_audit_signal=""
navori_audit_on_signal() {
  navori_audit_signal=$1
  navori_audit_log "gate-killed" "cancelado por SIG$1: nada quedo validado" || true
  # `|| true` on both: a recorder may never become the reason a hook fails, and
  # `set -e` is on in every script that includes this.
  trap - "$1" 2>/dev/null || true
  kill -s "$1" "$$" 2>/dev/null || true
  return 0
}
trap 'navori_audit_on_signal TERM' TERM
trap 'navori_audit_on_signal INT' INT
trap 'navori_audit_on_signal HUP' HUP
