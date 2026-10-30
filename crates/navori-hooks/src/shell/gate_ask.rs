//! The `gate-ask` partial (`navori_can_ask`, #1117) and the `jq -cn` answer the gates print when
//! they hand a no-verdict outcome to the user.

/// `navori_can_ask`: the script is not a Codex copy, `jq` exists, the payload is a real
/// `PreToolUse` call and its `permission_mode` is one where the host shows the prompt.
#[must_use]
pub fn can_ask(script: &str, jq: bool, event: &str, permission_mode: &str) -> bool {
    !script.contains(".codex/hooks/")
        && !script.contains(".codex/scripts/")
        && jq
        && event == "PreToolUse"
        && matches!(permission_mode, "default" | "acceptEdits" | "auto")
}

/// `jq -cn --arg reason "$reason" '{hookSpecificOutput:{…permissionDecision:"ask"…}}'`.
#[must_use]
pub fn ask_answer(reason: &str) -> String {
    format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":{}}}}}\n",
        jq_string(reason)
    )
}

/// A JSON string as `jq -c` prints it: `\b \f \n \r \t`, other controls and DEL as `\u00xx`.
#[must_use]
pub fn jq_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::{can_ask, jq_string};

    // Covers: R50
    #[test]
    fn asks_only_where_the_host_shows_the_prompt() {
        assert!(can_ask(".claude/hooks/q.sh", true, "PreToolUse", "default"));
        assert!(!can_ask(
            "/r/.codex/hooks/q.sh",
            true,
            "PreToolUse",
            "default"
        ));
        assert!(!can_ask(".claude/hooks/q.sh", false, "PreToolUse", "auto"));
        assert!(!can_ask(".claude/hooks/q.sh", true, "PreToolUse", "plan"));
        assert!(!can_ask(".claude/hooks/q.sh", true, "", "default"));
        assert_eq!(
            jq_string("a\"\\\u{1}\u{7f}\té"),
            "\"a\\\"\\\\\\u0001\\u007f\\té\""
        );
    }
}
