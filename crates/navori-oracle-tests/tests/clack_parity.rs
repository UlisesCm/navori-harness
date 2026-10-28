//! `navori_core::render::report::Clack` against the real `@clack/prompts` (spec 0058 T16): every
//! non-TTY primitive the render report uses, with `NO_COLOR`, over multi-line and empty messages,
//! with the Unicode guide and with the ASCII one `TERM=linux` selects.

mod support;

use navori_core::render::report::Clack;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

/// Loads clack after fixing the environment it reads at import time.
fn prelude(term: &str) -> String {
    format!(
        "process.env.NO_COLOR = '1';\nprocess.env.TERM = {term:?};\n\
         const {{ createRequire }} = await import('node:module');\n\
         const {{ pathToFileURL }} = await import('node:url');\n\
         const p = await import(pathToFileURL(createRequire({:?}).resolve('@clack/prompts')).href);",
        cli_module("index.ts")
    )
}

const HANDLER: &str = "const chunks = [];\n\
     const write = process.stdout.write;\n\
     process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };\n\
     try {\n\
       const [kind, text] = request;\n\
       if (kind === 'intro' || kind === 'outro' || kind === 'cancel') p[kind](text);\n\
       else p.log[kind](text);\n\
     } finally { process.stdout.write = write; }\n\
     return chunks.join('');";

static UNICODE: Shared = Shared::new(|| prelude("xterm-256color"), HANDLER);
static ASCII: Shared = Shared::new(|| prelude("linux"), HANDLER);

fn rust(clack: Clack, kind: &str, text: &str) -> String {
    match kind {
        "intro" => clack.intro(text),
        "outro" => clack.outro(text),
        "cancel" => clack.cancel(text),
        "info" => clack.info(text),
        "warn" => clack.warn(text),
        "success" => clack.success(text),
        "error" => clack.error(text),
        "step" => clack.step(text),
        _ => clack.message(text),
    }
}

fn message() -> BoxedStrategy<String> {
    prop::collection::vec(
        prop::sample::select(vec![
            "",
            "a",
            "  indented",
            "\u{b7} x",
            "core: /x",
            "\u{2192} y",
            " ",
        ]),
        1..5,
    )
    .prop_map(|lines| lines.join("\n"))
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn clack_output_matches(
        kind in prop::sample::select(vec!["intro", "outro", "cancel", "message", "info", "warn", "success", "error", "step"]),
        text in message(),
        unicode in any::<bool>(),
    ) {
        let bridge = if unicode { &UNICODE } else { &ASCII };
        let ts = bridge.ask(&json!([kind, text])).map_err(TestCaseError::fail)?;
        let rust = Value::String(rust(Clack { unicode }, kind, &text));
        prop_assert!(ts == rust, "{kind} {text:?}\nts   {ts}\nrust {rust}");
    }
}
