//! subagent-stop-handoff.sh (spec 0059 T15). So far only its mode table.

use std::ffi::OsString;

/// `navori_audit_phase` (`PostToolUse` in every registration) for the arguments the hosts pass:
/// none under Claude, `codex` for Codex `SubagentStop`. `None` defers to the shell before
/// stdin: `codex capture-start` registers the start of a Codex child capture (spec 0042), which
/// this phase does not port (D31), and any other shape is never guessed.
#[must_use]
pub fn phase(args: &[OsString]) -> Option<&'static str> {
    match args {
        [] => Some("PostToolUse"),
        [mode] if mode == "codex" => Some("PostToolUse"),
        _ => None,
    }
}
