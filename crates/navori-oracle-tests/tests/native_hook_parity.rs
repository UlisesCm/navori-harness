//! `navori_core::render::native_hook` and the native arm of `claude_hook_command` (spec 0058 T15,
//! R42): against `crates/navori-hooks/tests/golden/wiring.snap` and against the real
//! `nativeRunnerShell`, `claudeHookCommand`, `signNativeScript` and `nativeDependencyPath` over
//! hook ids, events, plain and shell-expanding args, `shadow`/`active` and gating.

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;

use navori_core::manifest::{Hook, HookMode};
use navori_core::render::claude_settings::claude_hook_command;
use navori_core::render::native_hook::{
    NativeEngine, NativeShell, native_dependency_path, native_runner_shell, sign_native_script,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const n = await import({:?});\nconst s = await import({:?});\nconst path = await import('node:path');",
        cli_module("lib/render/native-hook.ts"),
        cli_module("engines/claude/build-settings.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const d = { mode: request.mode, gating: request.gating, blocks: {}, deps: {}, impl: request.impl };\n\
     const deps = request.deps.map((t) => Buffer.from(t));\n\
     const dep = n.nativeDependencyPath('/r', request.engine, request.dep);\n\
     return {\n\
       shell: n.nativeRunnerShell({ engine: request.engine, hook: request.hook, descriptor: d, invocation: request.invocation, args: request.args ?? undefined }),\n\
       command: s.claudeHookCommand(request.event, request.script, request.args ?? undefined, request.native ? d : undefined),\n\
       signed: n.signNativeScript(request.body, request.impl, deps),\n\
       dep: dep === null ? null : path.relative('/r', dep),\n\
     };",
);

fn engine(name: &str) -> NativeEngine {
    match name {
        "codex" => NativeEngine::Codex,
        "pi" => NativeEngine::Pi,
        _ => NativeEngine::Claude,
    }
}

fn descriptor(mode: HookMode, gating: bool, implementation: &str) -> Hook {
    Hook {
        mode,
        gating,
        blocks: BTreeMap::new(),
        deps: BTreeMap::new(),
        r#impl: implementation.to_owned(),
        divergences: Vec::new(),
    }
}

// Covers: R42
#[test]
fn wiring_matches_the_golden() -> Result<(), String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../navori-hooks/tests/golden/wiring.snap");
    let expected =
        std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let scripts: Vec<String> = ["claude", "codex", "pi"]
        .iter()
        .map(|name| {
            format!(
                "=== {name}-script ===\n{}",
                native_runner_shell(&NativeShell {
                    engine: engine(name),
                    hook: "example",
                    mode: HookMode::Shadow,
                    gating: true,
                    invocation: "--via-script \"$0\"",
                    args: Some("\"$@\""),
                })
            )
        })
        .collect();
    let entry = descriptor(
        HookMode::Shadow,
        true,
        &format!("sha256:{}", "a".repeat(64)),
    );
    let actual = format!(
        "{}\n\n=== claude-command ===\n{}\n",
        scripts.join("\n\n"),
        claude_hook_command(
            "PreToolUse",
            ".claude/hooks/example.sh",
            Some("first"),
            Some(&entry)
        )
    );
    if actual == expected {
        Ok(())
    } else {
        Err(format!("wiring differs:\n{actual}"))
    }
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R42
    #[test]
    fn native_pieces_match(
        engine_name in pick(&["claude", "codex", "pi"]),
        hook in pick(&["example", "subagent-no-background", "o'brien"]),
        mode in prop::sample::select(vec![HookMode::Shadow, HookMode::Active]),
        gating in any::<bool>(),
        invocation in pick(&["--via-script \"$0\"", "--via-command 'Stop' \"$f\""]),
        args in prop::option::of(pick(&["", "first", "a b/c.d", "a  b", " a", "\"$@\"", "\"$(cat)\"", "x; y", "--fast"])),
        event in pick(&["PreToolUse", "Stop", "Pre'Tool"]),
        script in pick(&[".claude/hooks/example.sh", ".claude/hooks/sub/x.sh", "hooks/plain"]),
        native in any::<bool>(),
        body in pick(&["", "#!/bin/bash\necho hi\n", "x# navori:native-hook v=1 file=sha256:\n"]),
        deps in prop::collection::vec(pick(&["", "dep-a", "dep\nb"]), 0..3),
        dep in pick(&["scripts/a.sh", "scripts/x/y-z_1.sh", "scripts/", "scripts//a", "scripts/./a", "scripts/../a", "other/a", "scripts/a b", "scripts/é"]),
    ) {
        let implementation = format!("sha256:{}", "b".repeat(64));
        let ts = NODE
            .ask(&json!({
                "engine": engine_name, "hook": hook, "mode": if mode == HookMode::Shadow { "shadow" } else { "active" },
                "gating": gating, "invocation": invocation, "args": args, "event": event, "script": script,
                "native": native, "body": body, "impl": implementation, "deps": deps, "dep": dep,
            }))
            .map_err(TestCaseError::fail)?;
        let entry = descriptor(mode, gating, &implementation);
        let dep_bytes: Vec<&[u8]> = deps.iter().map(String::as_bytes).collect();
        let rust = json!({
            "shell": native_runner_shell(&NativeShell {
                engine: engine(&engine_name), hook: &hook, mode, gating, invocation: &invocation, args: args.as_deref(),
            }),
            "command": claude_hook_command(&event, &script, args.as_deref(), native.then_some(&entry)),
            "signed": sign_native_script(&body, &implementation, &dep_bytes),
            "dep": native_dependency_path(engine(&engine_name), &dep),
        });
        prop_assert!(ts == rust, "ts {ts}\nrust {rust}");
    }
}
