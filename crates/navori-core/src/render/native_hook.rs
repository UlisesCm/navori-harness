//! The shell pieces of the native hook wiring (spec 0058 T15, `lib/render/native-hook.ts`): the
//! runtime arm a wrapped hook script or a Claude hook command runs first, its fixed failure
//! verdict, and the integrity signature of a wrapped script.

use sha2::{Digest, Sha256};

use crate::js_json::JsValue;
use crate::manifest::HookMode;

/// `NATIVE_HOOK_BIN`.
pub const NATIVE_HOOK_BIN: &str = "navori-rust";

/// `INTEGRITY_PREFIX`.
pub const INTEGRITY_PREFIX: &str = "# navori:native-hook v=1 file=sha256:";

const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// `NativeEngine`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeEngine {
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
    /// Pi.
    Pi,
}

impl NativeEngine {
    /// The engine's directory, relative to the repo root.
    #[must_use]
    pub const fn root(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
            Self::Pi => ".pi/navori",
        }
    }
}

/// The shell's single quoting: `'…'` with every `'` closed, escaped and reopened.
#[must_use]
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `sha256(bytes)`: `sha256:<hex>`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

/// `nativeSafeFailure(engine, hook, gating)`: what the wrapper emits when the binary cannot
/// answer.
#[must_use]
pub fn native_safe_failure(engine: NativeEngine, hook: &str, gating: bool) -> String {
    let reason = format!(
        "navori: {hook} could not evaluate this call (native runtime failed); confirm it manually"
    );
    if gating && engine == NativeEngine::Claude {
        let mut output = crate::js_json::JsObject::new();
        output.insert("hookEventName", JsValue::string("PreToolUse"));
        output.insert("permissionDecision", JsValue::string("ask"));
        output.insert("permissionDecisionReason", JsValue::string(&reason));
        let mut verdict = crate::js_json::JsObject::new();
        verdict.insert("hookSpecificOutput", JsValue::Object(output));
        let verdict = JsValue::Object(verdict).stringify(None).unwrap_or_default();
        return format!("printf '%s\\n' {} >&1 || exit 2; exit 0", quote(&verdict));
    }
    format!(
        "printf '%s\\n' {} >&2 || :; exit {}",
        quote(&reason),
        if gating { 2 } else { 1 }
    )
}

/// `NativeShellOptions` minus the descriptor fields the shell does not read.
#[derive(Debug, Clone, Copy)]
pub struct NativeShell<'a> {
    /// The engine.
    pub engine: NativeEngine,
    /// The hook id.
    pub hook: &'a str,
    /// `descriptor.mode`.
    pub mode: HookMode,
    /// `descriptor.gating`.
    pub gating: bool,
    /// Shell words produced by the renderer.
    pub invocation: &'a str,
    /// Extra shell words, if any.
    pub args: Option<&'a str>,
}

/// `nativeRunnerShell(options)`.
#[must_use]
pub fn native_runner_shell(options: &NativeShell<'_>) -> String {
    let NativeShell {
        engine,
        hook,
        mode,
        gating,
        invocation,
        args,
    } = *options;
    let forced = format!(
        "printf '%s\\n' {} >&2; exit 1",
        quote(&format!(
            "navori: {hook} native runtime unavailable or deferred"
        ))
    );
    let failed = native_safe_failure(engine, hook, gating);
    let shadow = if mode == HookMode::Shadow {
        " --shadow"
    } else {
        ""
    };
    let args = args
        .filter(|a| !a.is_empty())
        .map(|a| format!(" {a}"))
        .unwrap_or_default();
    let fail_status = if gating { 2 } else { 1 };
    [
        "# navori:native-runtime start".to_owned(),
        "if [ \"${NAVORI_HOOK_IMPL:-}\" != shell ]; then".to_owned(),
        format!("  if nv_native=$(command -v {NATIVE_HOOK_BIN} 2>/dev/null); then"),
        format!(
            "    nv_out=$(if \"$nv_native\" hook {invocation}{shadow}{args}; then nv_status=0; else nv_status=$?; fi; printf '.%s' \"$nv_status\")"
        ),
        "    nv_rc=${nv_out##*.}; nv_out=${nv_out%.*}".to_owned(),
        "    case \"$nv_rc\" in".to_owned(),
        format!(
            "      0|1|2) printf '%s' \"$nv_out\" >&1 || exit {fail_status}; exit \"$nv_rc\" ;;"
        ),
        format!("      3|126|127) if [ \"${{NAVORI_HOOK_IMPL:-}}\" = rust ]; then {forced}; fi ;;"),
        format!("      *) {failed} ;;"),
        "    esac".to_owned(),
        format!("  elif [ \"${{NAVORI_HOOK_IMPL:-}}\" = rust ]; then {forced}; fi"),
        "fi".to_owned(),
        "# navori:native-runtime end".to_owned(),
    ]
    .join("\n")
}

/// `signNativeScript(script, implementation, deps)`: the signature header, whose `file=` hashes
/// the script with its own digits zeroed, then every dependency in order.
#[must_use]
pub fn sign_native_script(script: &str, implementation: &str, deps: &[&[u8]]) -> String {
    let unsigned = format!("{INTEGRITY_PREFIX}{ZERO} impl={implementation}\n{script}");
    let mut digest = Sha256::new();
    digest.update(unsigned.as_bytes());
    for dep in deps {
        digest.update(dep);
    }
    let hex: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    unsigned.replacen(
        &format!("{INTEGRITY_PREFIX}{ZERO}"),
        &format!("{INTEGRITY_PREFIX}{hex}"),
        1,
    )
}

/// `nativeDependencyPath(cwd, engine, path)`, relative to the repo root: `None` unless `path` is
/// a plain `scripts/…` path inside the engine directory.
#[must_use]
pub fn native_dependency_path(engine: NativeEngine, path: &str) -> Option<String> {
    let rest = path.strip_prefix("scripts/")?;
    let charset = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-');
    if rest.is_empty()
        || !rest.chars().all(charset)
        || path.split('/').any(|part| matches!(part, ".." | "." | ""))
    {
        return None;
    }
    Some(format!("{}/{path}", engine.root()))
}
