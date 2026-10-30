//! Spec 0059 T15 (R50, R51): subagent-stop-handoff's decision per branch in Claude and Codex,
//! with a stub host: which handoffs it flags, the message and its channels, the stamp that
//! silences a repeat, the compaction and partial-handoff lanes, and the errors a failed
//! redirection prints. The recorded corpus is replayed byte for byte by
//! `hook-verdict-replay.mjs --impl rust`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use navori_hooks::hooks::subagent_stop_handoff::rendered::Lines;
use navori_hooks::hooks::subagent_stop_handoff::{Context, Host, Rendered, evaluate};
use navori_hooks::runner::Failure;
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};

const STAMP: &str = "/t/navori-handoff-repo-anon";
const MARK: &str = "/t/navori-compact-repo-anon";

#[derive(Default, Clone)]
struct Stub {
    path: BTreeSet<&'static str>,
    dirs: BTreeSet<&'static str>,
    files: BTreeMap<String, Vec<u8>>,
    unreadable: BTreeSet<&'static str>,
    write_error: Option<&'static str>,
}

struct Run {
    stub: Stub,
    log: RefCell<Vec<String>>,
}

impl Host for Run {
    fn on_path(&self, name: &str) -> bool {
        self.stub.path.contains(name)
    }
    fn is_dir(&self, path: &str) -> bool {
        self.stub.dirs.contains(path)
    }
    fn is_file(&self, path: &str) -> bool {
        self.stub.files.contains_key(path)
    }
    fn is_symlink(&self, _: &str) -> bool {
        false
    }
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        if self.stub.unreadable.contains(path) {
            return None;
        }
        self.stub.files.get(path).cloned()
    }
    fn open_error(&self, path: &str) -> Option<String> {
        self.stub
            .unreadable
            .contains(path)
            .then(|| "Permission denied".to_owned())
    }
    fn recent(&self, dir: &str, prefix: &str, suffix: &str) -> Result<Vec<String>, Failure> {
        let start = format!("{dir}/{prefix}");
        let keys = self.stub.files.keys().cloned();
        let unreadable = self.stub.unreadable.iter().map(|s| (*s).to_owned());
        Ok(keys
            .chain(unreadable)
            .filter(|k| k.starts_with(&start) && k.ends_with(suffix))
            .collect())
    }
    fn tail(&self, path: &str, _: u64) -> Option<Vec<u8>> {
        self.read(path)
    }
    fn toplevel(&self, _: &str) -> Option<String> {
        Some("/w/repo".to_owned())
    }
    fn capture_child(&self, child: &str, root: &str, rollout: &str, cwd: &str) {
        self.log
            .borrow_mut()
            .push(format!("capture {child} {root} {rollout} {cwd}"));
    }
    fn write(&self, path: &str, content: &[u8]) -> Option<String> {
        self.log
            .borrow_mut()
            .push(format!("write {path} {}", String::from_utf8_lossy(content)));
        self.stub.write_error.map(str::to_owned)
    }
}

fn context(codex_engine: bool, mode: &str) -> Context<'static> {
    let script = if codex_engine {
        "/r/.codex/hooks/subagent-stop-handoff.sh"
    } else {
        "/r/.claude/hooks/subagent-stop-handoff.sh"
    };
    Context {
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::Utf8,
        },
        capture: CaptureContext {
            shell: ShellDialect::Bash5,
            script: Path::new(script),
            input_line: 1,
            fallback_line: 1,
        },
        rendered: Rendered {
            threshold: 1000,
            lines: Lines {
                input: 1,
                cksum: 70,
                truncate: 80,
                stamp: 90,
                mark_advice: 85,
                mark_dirty: 91,
            },
        },
        script: script.to_owned(),
        mode: mode.to_owned(),
        pwd: "/w/repo".to_owned(),
        tmpdir: "/t".to_owned(),
        claude_project_dir: "/w/repo".to_owned(),
        audits_root: Some("/a".to_owned()),
    }
}

struct Case {
    name: &'static str,
    codex: bool,
    mode: &'static str,
    payload: &'static str,
    stub: Stub,
    verdict: &'static str,
    /// Substrings stdout must hold; empty means no output.
    stdout: &'static [&'static str],
    /// `write <path> …` and `capture …` entries, by prefix, in order.
    log: &'static [&'static str],
    stderr: &'static str,
}

fn stub(f: impl FnOnce(&mut Stub)) -> Stub {
    let mut s = Stub {
        path: ["node"].into_iter().collect(),
        dirs: [".navori/state/handoffs"].into_iter().collect(),
        ..Stub::default()
    };
    f(&mut s);
    s
}

fn put(s: &mut Stub, path: &str, body: &str) {
    s.files.insert(path.to_owned(), body.as_bytes().to_vec());
}

const IMPLEMENTER: &str = r#"{"tool_input":{"subagent_type":"implementer"}}"#;
const FULL: &str = r#"{"feature":"f","status":"DONE","worktree":"w","branch":"b","commits":[],"filesTouched":[],"verification":"v","markdownRequests":[]}"#;

// Covers: R50, R51
#[test]
fn veredictos_del_corpus_en_claude_y_codex() {
    let usage = |n: u64| {
        format!(
            "garbage\n{{\"message\":{{\"usage\":{{\"input_tokens\":{n},\"cache_read_input_tokens\":1}}}}}}\n{{\"x\":1}}\nnot json"
        )
    };
    let cases = vec![
        Case {
            name: "limpio: trunca el sello",
            codex: false,
            mode: "",
            payload: IMPLEMENTER,
            stub: stub(|s| put(s, ".navori/state/handoffs/impl_a.json", FULL)),
            verdict: "clean",
            stdout: &[],
            log: &["write /t/navori-handoff-repo-anon "],
            stderr: "",
        },
        Case {
            name: "implementer: claves faltantes y status inválido",
            codex: false,
            mode: "",
            payload: IMPLEMENTER,
            stub: stub(|s| {
                put(
                    s,
                    ".navori/state/handoffs/impl_a.json",
                    r#"{"feature":"f"}"#,
                );
                put(
                    s,
                    ".navori/state/handoffs/impl_b.json",
                    &FULL.replace("DONE", "WIP"),
                );
                put(s, ".navori/state/handoffs/impl_c.json", "[1");
                put(s, ".navori/state/handoffs/impl_d.json", "\"text\"");
                put(s, ".navori/state/handoffs/impl_e.md", "sin status");
            }),
            verdict: "dirty",
            stdout: &[
                "impl_a.json sin clave 'status,worktree,branch,commits,filesTouched,verification,markdownRequests'",
                "impl_b.json con 'status' inválido (no DONE/BLOCKED)",
                "impl_c.json no parsea como JSON",
                "impl_d.json no parsea como JSON",
                "\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":",
            ],
            log: &[
                "write /t/navori-handoff-repo-anon .navori/state/handoffs/impl_a.json sin clave",
            ],
            stderr: "",
        },
        Case {
            name: "sin node: grep en codex con jq",
            codex: true,
            mode: "codex",
            payload: r#"{"agent_type":"implementer","session_id":"s1","hook_event_name":"SubagentStop","agent_id":"c1","agent_transcript_path":"/x.jsonl","cwd":"/w/repo"}"#,
            stub: stub(|s| {
                s.path = ["jq", "navori"].into_iter().collect();
                put(
                    s,
                    ".navori/state/handoffs/impl_a.json",
                    &FULL.replace("\"DONE\"", "\"done\""),
                );
                put(s, "/a/repo/session-s1.log", "");
            }),
            verdict: "dirty",
            stdout: &[
                "{\n  \"systemMessage\": \"navori: handoff(s) de subagente incompletos — .navori/state/handoffs/impl_a.json con 'status' inválido",
            ],
            log: &[
                "capture c1 s1 /x.jsonl /w/repo",
                "write /t/navori-handoff-repo-s1 ",
            ],
            stderr: "",
        },
        Case {
            name: "scribe y review: Status, veredicto, vacío e ilegible",
            codex: false,
            mode: "",
            payload: r#"{"tool_input":{"subagent_type":"scribe"}}"#,
            stub: stub(|s| {
                s.dirs.insert("progress");
                put(
                    s,
                    ".navori/state/handoffs/impl_ok.md",
                    "texto\n**STATUS:** done\n",
                );
                put(s, ".navori/state/handoffs/impl_x.json", "{}");
                put(s, "progress/review_a.md", "nada");
                put(s, "progress/review_b.md", " \t\n\u{a0}\n");
                put(s, "progress/review_c.md", "**Final verdict:** APPROVED");
                s.unreadable.insert("progress/review_z.md");
            }),
            verdict: "dirty",
            stdout: &[
                "progress/review_a.md sin veredicto (APPROVED/CHANGES_REQUESTED); progress/review_b.md vacío; progress/review_z.md vacío",
            ],
            log: &["write /t/navori-handoff-repo-anon "],
            stderr: "/r/.claude/hooks/subagent-stop-handoff.sh: line 70: progress/review_z.md: Permission denied\n",
        },
        Case {
            name: "consejo de compactación tras el publisher y sello que falla",
            codex: false,
            mode: "",
            payload: r#"{"tool_input":{"subagent_type":"publisher"},"transcript_path":"/tr.jsonl"}"#,
            stub: stub(|s| {
                put(s, "/tr.jsonl", &usage(5000));
                s.write_error = Some("No such file or directory");
            }),
            verdict: "compact-advice",
            stdout: &["el contexto del hilo principal va en 5001 tokens (umbral 1000)"],
            log: &[
                "write /t/navori-handoff-repo-anon ",
                "write /t/navori-compact-repo-anon 1",
            ],
            stderr: "/r/.claude/hooks/subagent-stop-handoff.sh: line 80: /t/navori-handoff-repo-anon: No such file or directory\n/r/.claude/hooks/subagent-stop-handoff.sh: line 85: /t/navori-compact-repo-anon: No such file or directory\n",
        },
        Case {
            name: "compactación ya avisada o bajo el umbral",
            codex: false,
            mode: "",
            payload: r#"{"tool_input":{"subagent_type":"publisher"},"transcript_path":"/tr.jsonl"}"#,
            stub: stub(|s| {
                put(s, "/tr.jsonl", &usage(5000));
                put(s, MARK, "1\n");
            }),
            verdict: "clean",
            stdout: &[],
            log: &["write /t/navori-handoff-repo-anon "],
            stderr: "",
        },
        Case {
            name: "handoff parcial por límite de turnos",
            codex: false,
            mode: "",
            payload: r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"subagent_type":"implementer"},"tool_response":{"content":[{"type":"text","text":"Agent stopped at its 25-turn limit."}]}}"#,
            stub: stub(|_| {}),
            verdict: "partial",
            stdout: &["navori: handoff PARCIAL de implementer — alcanzó su límite de turnos."],
            log: &["write /t/navori-handoff-repo-anon "],
            stderr: "",
        },
        Case {
            name: "en segundo plano no es parcial",
            codex: false,
            mode: "",
            payload: r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{"run_in_background":true},"tool_response":{"content":[{"type":"text","text":"stopped at its 25-turn limit"}]}}"#,
            stub: stub(|_| {}),
            verdict: "clean",
            stdout: &[],
            log: &["write /t/navori-handoff-repo-anon "],
            stderr: "",
        },
    ];
    let mut failures = Vec::new();
    for case in &cases {
        let run = Run {
            stub: case.stub.clone(),
            log: RefCell::new(Vec::new()),
        };
        let evaluation = match evaluate(
            case.payload.as_bytes(),
            &context(case.codex, case.mode),
            &run,
        ) {
            Ok(e) => e,
            Err(error) => {
                failures.push(format!("{}: {error}", case.name));
                continue;
            }
        };
        let stdout = String::from_utf8_lossy(&evaluation.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&evaluation.stderr).into_owned();
        let log = run.log.borrow().clone();
        let verdict = evaluation.audit.as_ref().map_or("", |a| a.verdict);
        let stdout_ok = if case.stdout.is_empty() {
            stdout.is_empty()
        } else {
            case.stdout.iter().all(|s| stdout.contains(s)) && stdout.ends_with('\n')
        };
        let log_ok = log.len() == case.log.len()
            && log
                .iter()
                .zip(case.log)
                .all(|(got, want)| got.starts_with(want));
        if verdict != case.verdict || !stdout_ok || !log_ok || stderr != case.stderr {
            failures.push(format!(
                "{}: verdict {verdict}\n  stdout {stdout:?}\n  stderr {stderr:?}\n  log {log:?}",
                case.name
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// Covers: R50
#[test]
fn el_sello_silencia_la_repeticion_y_un_cambio_vuelve_a_avisar() {
    let base = stub(|s| {
        put(
            s,
            ".navori/state/handoffs/impl_a.json",
            r#"{"feature":"f"}"#,
        )
    });
    let first = Run {
        stub: base.clone(),
        log: RefCell::new(Vec::new()),
    };
    let evaluation = evaluate(IMPLEMENTER.as_bytes(), &context(false, ""), &first);
    assert!(evaluation.is_ok_and(|e| e.audit.is_some_and(|a| a.verdict == "dirty")));
    let written = first.log.borrow()[0]
        .strip_prefix(&format!("write {STAMP} "))
        .unwrap_or_default()
        .to_owned();
    // The signature carries one `cksum` of the flagged file: `<crc>-<size>;`.
    assert!(written.ends_with("-15;\n"), "{written:?}");
    let mut stamped = base.clone();
    put(&mut stamped, STAMP, &written);
    let mut changed = stamped.clone();
    put(
        &mut changed,
        ".navori/state/handoffs/impl_a.json",
        r#"{"feature":"g"}"#,
    );
    for (name, stub, verdict, writes) in [
        ("same", stamped, "repeat", 0),
        ("rewritten", changed, "dirty", 1),
    ] {
        let run = Run {
            stub,
            log: RefCell::new(Vec::new()),
        };
        let evaluation = evaluate(IMPLEMENTER.as_bytes(), &context(false, ""), &run);
        let got = evaluation.ok().and_then(|e| e.audit).map(|a| a.verdict);
        assert_eq!(got, Some(verdict), "{name}");
        assert_eq!(run.log.borrow().len(), writes, "{name}");
    }
}
