//! model-advisor.sh (spec 0059 T16). So far only its mode table: the script's `case "$mode"`.

use std::ffi::OsString;

/// `navori_audit_phase` for the mode in `$1`, or `None` when the call must defer to the shell
/// before stdin: `codex-pretool-profile` runs `navori codex profile hook`, which this phase does
/// not port (D31), and an unknown mode is never guessed.
#[must_use]
pub fn phase(args: &[OsString]) -> Option<&'static str> {
    let [mode] = args else {
        return None;
    };
    match mode.to_str()? {
        "claude-session-start" | "codex-session-start" => Some("SessionStart"),
        "claude-post-model-switch" => Some("PostModelSwitch"),
        "claude-stop" => Some("Stop"),
        _ => None,
    }
}
