//! Spec 0059 T17 (R50): the native wiring of the session hooks in `shadow`, as this repository
//! renders it, against `golden/session-wiring.snap` (reviewed by hand) and against the Rust
//! generator. `golden/wiring.snap` keeps the generic gating example the 0058 suites compare whole.

use std::path::{Path, PathBuf};

use navori_core::manifest::HookMode;
use navori_core::render::native_hook::{NativeEngine, NativeShell, native_runner_shell};

const HOOKS: [&str; 3] = [
    "session-start-context",
    "subagent-stop-handoff",
    "model-advisor",
];
const START: &str = "# navori:native-runtime start\n";
const END: &str = "# navori:native-runtime end";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn block(text: &str) -> Option<&str> {
    let start = text.find(START)?;
    let end = text[start..].find(END)? + start + END.len();
    Some(&text[start..end])
}

/// Every Claude registration of a session hook: `<event> <matcher>` and its command.
fn claude_commands() -> Result<Vec<String>, String> {
    let text =
        std::fs::read_to_string(repo().join(".claude/settings.json")).map_err(|e| e.to_string())?;
    let settings: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (event, groups) in settings["hooks"]
        .as_object()
        .ok_or("settings without hooks")?
    {
        for group in groups.as_array().into_iter().flatten() {
            for hook in group["hooks"].as_array().into_iter().flatten() {
                let command = hook["command"].as_str().unwrap_or_default();
                if HOOKS
                    .iter()
                    .any(|h| command.contains(&format!("/.claude/hooks/{h}.sh")))
                {
                    let matcher = group["matcher"].as_str().unwrap_or("");
                    out.push(format!(
                        "=== claude-command {event} {matcher} ===\n{command}"
                    ));
                }
            }
        }
    }
    Ok(out)
}

// Covers: R50
#[test]
fn hooks_de_sesion_en_shadow() -> Result<(), String> {
    let mut sections = Vec::new();
    let mut failures = Vec::new();
    for hook in HOOKS {
        for (engine, dir) in [
            (NativeEngine::Claude, ".claude"),
            (NativeEngine::Codex, ".codex"),
        ] {
            let path = repo().join(dir).join("hooks").join(format!("{hook}.sh"));
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            if !text.starts_with("# navori:native-hook v=1 file=sha256:") {
                failures.push(format!("{dir}/hooks/{hook}.sh is not signed"));
            }
            let Some(found) = block(&text) else {
                failures.push(format!("{dir}/hooks/{hook}.sh has no native runtime"));
                continue;
            };
            let generated = native_runner_shell(&NativeShell {
                engine,
                hook,
                mode: HookMode::Shadow,
                gating: false,
                invocation: "--via-script \"$0\"",
                args: Some("\"$@\""),
            });
            if found != generated.trim_end_matches('\n') {
                failures.push(format!("{dir}/hooks/{hook}.sh differs from the generator"));
            }
            sections.push(format!("=== {dir} {hook} ===\n{found}"));
        }
    }
    sections.extend(claude_commands()?);
    let actual = format!("{}\n", sections.join("\n\n"));
    let golden = repo().join("crates/navori-hooks/tests/golden/session-wiring.snap");
    if std::env::var_os("NAVORI_UPDATE_GOLDEN").is_some() {
        std::fs::write(&golden, &actual).map_err(|e| e.to_string())?;
    }
    let expected =
        std::fs::read_to_string(&golden).map_err(|e| format!("{}: {e}", golden.display()))?;
    if actual != expected {
        failures.push("the rendered wiring differs from golden/session-wiring.snap".to_owned());
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}
