//! Whether an audit session could receive a CLI event (`lib/audit/cli-event.ts`).

/// The environment variables `contextFromEnv` and `auditTarget` read (`lib/audit/cli-event.ts`).
const AUDIT_VARS: [&str; 5] = [
    "NAVORI_AUDIT_HOST",
    "NAVORI_AUDIT_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
];

/// Whether `appendCliEvent` could find an audit session to write to.
pub(crate) fn audit_may_write() -> bool {
    AUDIT_VARS
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}
