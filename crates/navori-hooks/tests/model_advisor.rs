//! Spec 0059 T16 (R50, R51): model-advisor's four ported modes with a stub host: the advice it
//! prints, the scratchpad state and sentinels it leaves, and the shell guards that stop before
//! `node`. The recorded corpus is replayed byte for byte by `hook-verdict-replay.mjs --impl rust`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use navori_hooks::hooks::model_advisor::{Context, Host, evaluate};
use navori_hooks::runner::Failure;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};

#[derive(Default, Clone)]
struct Stub {
    files: BTreeMap<String, String>,
}

struct Run {
    stub: Stub,
    log: RefCell<Vec<String>>,
}

impl Host for Run {
    fn is_file(&self, path: &str) -> bool {
        self.log.borrow_mut().push(format!("test {path}"));
        self.stub.files.contains_key(path)
    }
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        self.stub.files.get(path).map(|s| s.as_bytes().to_vec())
    }
    fn write_state(&self, _: &str, path: &str, content: &str) -> Result<(), Failure> {
        self.log
            .borrow_mut()
            .push(format!("state {path} {content}"));
        Ok(())
    }
    fn sentinel(&self, _: &str, name: Option<&str>) -> Result<(), Failure> {
        self.log
            .borrow_mut()
            .push(format!("sentinel {}", name.unwrap_or("none")));
        Ok(())
    }
}

fn context(mode: &str, effort: Option<&str>) -> Context<'static> {
    Context {
        capture: CaptureContext {
            shell: ShellDialect::Bash5,
            script: Path::new("/r/.claude/hooks/model-advisor.sh"),
            input_line: 8,
            fallback_line: 1,
        },
        mode: mode.to_owned(),
        effort: effort.map(str::to_owned),
    }
}

struct Case {
    name: &'static str,
    mode: &'static str,
    effort: Option<&'static str>,
    payload: &'static [u8],
    files: &'static [(&'static str, &'static str)],
    /// A substring of the advice, or `None` for no output.
    advice: Option<&'static str>,
    log: &'static [&'static str],
    stderr: &'static str,
}

const OPUS: &str = r#"{"model":"claude-opus-4","notified":false,"extra":1}"#;

// Covers: R50, R51
#[test]
fn veredictos_del_corpus_por_modo() {
    let cases = [
        Case {
            name: "codex astra",
            mode: "codex-session-start",
            effort: None,
            payload: br#"{"model":"gpt-6-astra"}"#,
            files: &[],
            advice: Some("Estás usando `gpt-6-astra`"),
            log: &[],
            stderr: "",
        },
        Case {
            name: "codex otro modelo",
            mode: "codex-session-start",
            effort: None,
            payload: br#"{"model":"gpt-5"}"#,
            files: &[],
            advice: None,
            log: &[],
            stderr: "",
        },
        Case {
            name: "subagente: guard del shell",
            mode: "claude-stop",
            effort: None,
            payload: br#"{"agent_id":"x","scratchpad_dir":"/s"}"#,
            files: &[],
            advice: None,
            log: &[],
            stderr: "",
        },
        Case {
            name: "inicio con opus deja gated",
            mode: "claude-session-start",
            effort: None,
            payload: br#"{"model":"claude-opus-4","scratchpad_dir":"/s//x/"}"#,
            files: &[],
            advice: None,
            log: &[
                r#"state /s/x/navori-model-advisor.json {"model":"claude-opus-4","notified":false}"#,
                "sentinel navori-model-advisor.effort-gated",
            ],
            stderr: "",
        },
        Case {
            name: "cambio a fable conserva notified",
            mode: "claude-post-model-switch",
            effort: None,
            payload: br#"{"to_model":"claude-fable-5","scratchpad_dir":"/s"}"#,
            files: &[(
                "/s/navori-model-advisor.json",
                r#"{"model":"m","notified":true}"#,
            )],
            advice: None,
            log: &[
                r#"state /s/navori-model-advisor.json {"model":"claude-fable-5","notified":true}"#,
                "sentinel navori-model-advisor.skip",
            ],
            stderr: "",
        },
        Case {
            name: "cambio a fable sin aviso previo",
            mode: "claude-post-model-switch",
            effort: None,
            payload: br#"{"to_model":"claude-fable-5","scratchpad_dir":"/s"}"#,
            files: &[],
            advice: None,
            log: &[
                r#"state /s/navori-model-advisor.json {"model":"claude-fable-5","notified":false}"#,
                "sentinel none",
            ],
            stderr: "",
        },
        Case {
            name: "stop opus high por payload",
            mode: "claude-stop",
            effort: Some("medium"),
            payload: br#"{"scratchpad_dir":"/s","effort":{"level":"high"}}"#,
            files: &[("/s/navori-model-advisor.json", OPUS)],
            advice: Some("Estás usando `claude-opus-4/high`"),
            log: &[
                "test /s/navori-model-advisor.skip",
                "test /s/navori-model-advisor.effort-gated",
                r#"state /s/navori-model-advisor.json {"model":"claude-opus-4","notified":true,"extra":1}"#,
                "sentinel navori-model-advisor.skip",
            ],
            stderr: "",
        },
        Case {
            name: "stop opus por CLAUDE_EFFORT",
            mode: "claude-stop",
            effort: Some("xhigh"),
            payload: br#"{"scratchpad_dir":"/s","effort":{"level":5}}"#,
            files: &[("/s/navori-model-advisor.json", OPUS)],
            advice: Some("`claude-opus-4/xhigh`"),
            log: &[
                "test /s/navori-model-advisor.skip",
                "test /s/navori-model-advisor.effort-gated",
                r#"state /s/navori-model-advisor.json {"model":"claude-opus-4","notified":true,"extra":1}"#,
                "sentinel navori-model-advisor.skip",
            ],
            stderr: "",
        },
        Case {
            name: "stop opus medium no avisa",
            mode: "claude-stop",
            effort: None,
            payload: br#"{"scratchpad_dir":"/s","effort":{"level":"medium"}}"#,
            files: &[("/s/navori-model-advisor.json", OPUS)],
            advice: None,
            log: &[
                "test /s/navori-model-advisor.skip",
                "test /s/navori-model-advisor.effort-gated",
            ],
            stderr: "",
        },
        Case {
            name: "sentinela skip: sale antes de node",
            mode: "claude-stop",
            effort: None,
            payload: br#"{"scratchpad_dir":"/s"}"#,
            files: &[
                ("/s/navori-model-advisor.skip", ""),
                ("/s/navori-model-advisor.json", OPUS),
            ],
            advice: None,
            log: &["test /s/navori-model-advisor.skip"],
            stderr: "",
        },
        Case {
            name: "gated con effort medio: sale antes de node",
            mode: "claude-stop",
            effort: Some("medium"),
            payload: br#"{"scratchpad_dir":"/s","effort":{"level":"high"}}"#,
            files: &[
                ("/s/navori-model-advisor.effort-gated", ""),
                ("/s/navori-model-advisor.json", OPUS),
            ],
            advice: None,
            log: &[
                "test /s/navori-model-advisor.skip",
                "test /s/navori-model-advisor.effort-gated",
            ],
            stderr: "",
        },
        Case {
            name: "JSON inválido y NUL avisado por Bash 5",
            mode: "claude-session-start",
            effort: None,
            payload: b"{\0nope\n\n",
            files: &[],
            advice: None,
            log: &[],
            stderr: "/r/.claude/hooks/model-advisor.sh: line 8: warning: command substitution: ignored null byte in input\n",
        },
    ];
    let mut failures = Vec::new();
    for case in &cases {
        let run = Run {
            stub: Stub {
                files: case
                    .files
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
            },
            log: RefCell::new(Vec::new()),
        };
        let result = evaluate(case.payload, &context(case.mode, case.effort), &run);
        let Ok(evaluation) = result else {
            failures.push(format!("{}: {result:?}", case.name));
            continue;
        };
        let stdout = String::from_utf8_lossy(&evaluation.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&evaluation.stderr).into_owned();
        let advice_ok = match case.advice {
            None => stdout.is_empty(),
            Some(text) => {
                stdout.starts_with("{\"systemMessage\":\"### Modelo recomendado disponible\\n")
                    && stdout.contains(text)
                    && stdout.ends_with("\"}\n")
            }
        };
        let log = run.log.borrow().clone();
        let skip = evaluation
            .audit
            .as_ref()
            .is_some_and(|a| a.verdict == "skip" && a.reason.is_empty());
        if !advice_ok || log != case.log || stderr != case.stderr || !skip {
            failures.push(format!(
                "{}:\n  stdout {stdout:?}\n  stderr {stderr:?}\n  log {log:?}",
                case.name
            ));
        }
    }
    let null = Run {
        stub: Stub::default(),
        log: RefCell::new(Vec::new()),
    };
    if evaluate(b"null", &context("claude-session-start", None), &null).is_ok() {
        failures.push("a null payload must not be modeled (node throws)".to_owned());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
