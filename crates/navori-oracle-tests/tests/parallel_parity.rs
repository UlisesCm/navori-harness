//! `navori_core::handoff::parallel` against the real `lib/handoff/parallel.ts` (spec 0060 T10):
//! the whole flow (prepare, both begins and completions, render, finalize, and `checkParallel`
//! between steps) with generated perturbations. Each step snapshots the state directory, runs
//! the TS, restores the snapshot and runs Rust with the TS's `runId` and timestamp; the result and
//! every file written must be identical.

mod support;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::handoff::parallel::{self, Context, Planned};
use navori_core::plan::check::{Checked, ProjectContext, check_workplan};
use navori_core::plan::evidence::process_env;
use navori_core::process::RealRunner;
use navori_core::state_files::{StateRoot, resolve_state_root};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";
const FEATURE: &str = "demo-e1";
const IMPLEMENTER: &str = "0123abcd-0000-4000-8000-0000000000a1";
const SCRIBE: &str = "0123abcd-0000-4000-8000-0000000000a2";
const ROOT: &str = "0123abcd-0000-4000-8000-0000000000bb";
const PARENT: &str = "0123abcd-0000-4000-8000-0000000000cc";

fn prelude() -> String {
    format!(
        "const p = await import({:?});",
        cli_module("lib/handoff/parallel.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.thread) process.env.CODEX_THREAD_ID = request.thread; else delete process.env.CODEX_THREAD_ID; \
     process.env.CODEX_HOME = request.home; process.chdir(request.tree); \
     const o = { cwd: request.tree, feature: 'demo-e1', target: request.target, dir: '.navori/state/handoffs' }; \
     switch (request.op) { \
       case 'prepare': return await p.prepareParallel({ ...o, request: request.request, supersede: request.supersede ?? undefined }); \
       case 'check': return p.checkParallel(o); \
       case 'begin': return p.beginParallel({ ...o, runId: request.run }); \
       case 'complete': return p.completeParallel({ ...o, runId: request.run, status: request.status, reason: request.reason ?? undefined }); \
       default: return p.finalizeParallel(o); }",
);

struct Repo(PathBuf);
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fail(e: impl ToString) -> TestCaseError {
    TestCaseError::fail(e.to_string())
}

fn git(dir: &Path, args: &[&str]) -> Result<(), TestCaseError> {
    let ok = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .status()
        .map_err(fail)?
        .success();
    if ok {
        Ok(())
    } else {
        Err(fail(format!("git {args:?}")))
    }
}

fn write(path: &Path, text: &str) -> Result<(), TestCaseError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    std::fs::write(path, text).map_err(fail)
}

const TASKS: &str = "# Tasks\n\n## E1 — Core (foundation)\nEstimated LOC: 1,200\n\n### M1 — Parser\n- **Consumes:** `bun run x` → reads the parser\n- **A1** [observable] — parses the file · `bun test parser` → exit 0\n- [x] **T1** (R1) — parser · effect: behavior · test: `src/a.test.ts`::\"parses\" · more\n- [ ] **T2** (R2, R1) — docs · effect: docs · test: `README.md`::\"Parser\"\n\n## E2: Command\n**Estimated LOC:** ~300\n\n### M2 Command\n- **A2** — the command answers\n  `navori x --json`\n  → `{\"ok\":true}` on stdout\n- [ ] **T3** (R3) — command\n  effect: Behavior\n  test: `src/b.test.ts`::\"answers\"\n";
const REQUIREMENTS: &str = "# Requirements\n\n- **R1** — WHEN a THEN b.\n- **R2** — WHEN c THEN d.\n* **R3** — the system SHALL e.\n";

fn request() -> Value {
    json!({ "spec": "demo", "delivery": "E1", "milestone": "M1",
            "implementerPaths": ["src/impl.ts"],
            "markdownRequests": [{ "path": "docs/guide.md", "intent": "i", "evidence": "e" }],
            "derivedPaths": ["AGENTS.md"] })
}

fn session(home: &Path, tree: &str, thread: &str, role: &str) -> Result<(), TestCaseError> {
    let header = json!({ "type": "session_meta", "payload": { "id": thread, "session_id": ROOT,
        "parent_thread_id": PARENT, "cli_version": "0.162.1", "cwd": tree, "agent_role": role,
        "source": { "subagent": { "thread_spawn": { "parent_thread_id": PARENT, "agent_role": role } } } } });
    write(
        &home.join(format!("sessions/2026/11/01/rollout-{thread}.jsonl")),
        &format!("{header}\n"),
    )
}

fn checkout() -> Result<(Repo, PathBuf, PathBuf), TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!("navori-parallel-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("repo")).map_err(fail)?;
    let base = std::fs::canonicalize(&base).map_err(fail)?;
    let dir = base.join("repo");
    let home = base.join("codex");
    let config = json!({ "name": "x", "version": "1.0.0", "harnessVersion": "0.12.2",
        "engines": ["claude"], "preset": "custom", "language": "es", "branchBase": "main",
        "gitignoreHarness": "off", "commits": "conventional-es", "harness": { "scribeOwnsMarkdown": true } });
    write(&dir.join("navori.config.json"), &config.to_string())?;
    write(&dir.join("specs/demo/requirements.md"), REQUIREMENTS)?;
    write(&dir.join("specs/demo/design.md"), "# Design\n\nd\n")?;
    write(&dir.join("specs/demo/tasks.md"), TASKS)?;
    write(&dir.join("src/impl.ts"), "export const a = 1;\n")?;
    write(&dir.join("src/other.ts"), "export const o = 1;\n")?;
    write(&dir.join("AGENTS.md"), "# Agents\n")?;
    git(&dir, &["init", "-q", "-b", "main"])?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    git(&dir, &["checkout", "-q", "-b", "feat"])?;
    let plan = json!({ "feature": FEATURE, "level": 3,
        "classification": { "score": 0, "level": 0, "signals": [] }, "objective": "o",
        "acceptance": [{ "id": "A1", "description": "d", "command": "bun x", "expected": "exit 0" }],
        "files": [{ "path": "src/impl.ts", "new": false }, { "path": "docs/guide.md", "new": true },
                  { "path": "AGENTS.md", "new": false }],
        "progress": { "A1": "pendiente" }, "solution": { "path": "s.md", "verdict": "READY" },
        "phases": [{ "name": "M1", "acceptance": ["A1"] }], "risks": [{ "risk": "r", "rollback": "b" }] });
    write(
        &dir.join(DIR).join(format!("workplan_{FEATURE}.json")),
        &plan.to_string(),
    )?;
    let tree = dir.to_string_lossy().into_owned();
    session(&home, &tree, IMPLEMENTER, "implementer")?;
    session(&home, &tree, SCRIBE, "scribe")?;
    Ok((Repo(base), dir, home))
}

fn snapshot(dir: &Path) -> Result<BTreeMap<String, Vec<u8>>, TestCaseError> {
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(dir.join(DIR)).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        if entry.file_type().map_err(fail)?.is_file() {
            out.insert(
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read(entry.path()).map_err(fail)?,
            );
        }
    }
    Ok(out)
}

fn restore(dir: &Path, before: &BTreeMap<String, Vec<u8>>) -> Result<(), TestCaseError> {
    let state = dir.join(DIR);
    for name in snapshot(dir)?.keys() {
        if !before.contains_key(name) {
            std::fs::remove_file(state.join(name)).map_err(fail)?;
        }
    }
    for (name, bytes) in before {
        std::fs::write(state.join(name), bytes).map_err(fail)?;
    }
    Ok(())
}

/// What a step changed in the state directory.
fn written(
    before: &BTreeMap<String, Vec<u8>>,
    after: &BTreeMap<String, Vec<u8>>,
) -> BTreeMap<String, String> {
    after
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .map(|(k, v)| (k.clone(), String::from_utf8_lossy(v).into_owned()))
        .collect()
}

#[derive(Debug, Clone)]
struct Step {
    op: &'static str,
    thread: Option<&'static str>,
    status: &'static str,
    reason: Option<&'static str>,
    wrong_run: bool,
    target: &'static str,
}

impl Step {
    fn new(op: &'static str, thread: Option<&'static str>) -> Self {
        Self {
            op,
            thread,
            status: "DONE",
            reason: None,
            wrong_run: false,
            target: "main",
        }
    }
}

/// Runs one step on both sides and returns the TS reply.
fn step(dir: &Path, home: &Path, s: &Step, run: &str) -> Result<Value, TestCaseError> {
    let tree = dir.to_string_lossy().into_owned();
    let run = if s.wrong_run { PARENT } else { run };
    let before = snapshot(dir)?;
    let reply = NODE
        .ask(
            &json!({ "op": s.op, "tree": tree, "home": home, "thread": s.thread, "target": s.target,
                      "request": request(), "run": run, "status": s.status, "reason": s.reason }),
        )
        .map_err(TestCaseError::fail)?;
    let ts_files = written(&before, &snapshot(dir)?);
    let key = match s.op {
        "prepare" => "preparedAt",
        "begin" => "startedAt",
        "complete" => "completedAt",
        _ => "finalizedAt",
    };
    let now = ts_files
        .values()
        .filter_map(|t| serde_json::from_str::<Value>(t).ok())
        .find_map(|v| v[key].as_str().map(str::to_owned))
        .unwrap_or_else(|| "2026-11-01T00:00:00.000Z".to_owned());
    let uuid = reply["runId"]
        .as_str()
        .unwrap_or("00000000-0000-0000-0000-000000000000")
        .to_owned();
    restore(dir, &before)?;

    let mut env: Vec<(OsString, OsString)> = process_env()
        .into_iter()
        .filter(|(k, _)| k != "CODEX_THREAD_ID" && k != "CODEX_HOME")
        .collect();
    if let Some(thread) = s.thread {
        env.push(("CODEX_THREAD_ID".into(), thread.into()));
    }
    env.push(("CODEX_HOME".into(), home.into()));
    let root: StateRoot =
        resolve_state_root(&tree, &tree, FEATURE, Some(DIR)).map_err(|_| fail("root"))?;
    let config =
        navori_core::config::read(&std::fs::read(dir.join("navori.config.json")).map_err(fail)?)
            .map_err(|_| fail("config"))?;
    let ctx = Context {
        root: &root,
        feature: FEATURE,
        target: s.target,
        process_cwd: &tree,
        env: &env,
        runner: &RealRunner,
        config: &config.data,
        uuid: &uuid,
        now: &now,
    };
    let planned = match s.op {
        "prepare" => {
            let plan_text =
                std::fs::read_to_string(dir.join(DIR).join(format!("workplan_{FEATURE}.json")))
                    .map_err(fail)?;
            let raw = navori_core::js_json::parse(&plan_text).ok_or_else(|| fail("plan json"))?;
            let ok = matches!(
                check_workplan(&raw, FEATURE, &ProjectContext::default()),
                Checked::Ok { .. }
            );
            let request =
                navori_core::js_json::parse(&request().to_string()).ok_or_else(|| fail("json"))?;
            parallel::prepare(&ctx, &request, None, ok.then_some(true))
        }
        "check" => parallel::check(&ctx),
        "begin" => parallel::begin(&ctx, run),
        "complete" => parallel::complete(&ctx, run, s.status, s.reason),
        _ => parallel::finalize(&ctx),
    }
    .ok_or_else(|| fail(format!("delegated: {s:?}")))?;
    let rust = match planned {
        Planned::Error(message) => json!({ "status": "error", "message": message }),
        Planned::Done {
            status,
            run_id,
            writes,
        } => match parallel::apply(&mut navori_core::fs::RealFs::default(), &root, &writes) {
            Ok(()) => json!({ "status": status, "runId": run_id }),
            Err(message) => json!({ "status": "error", "message": message }),
        },
    };
    let rust_files = written(&before, &snapshot(dir)?);
    prop_assert_eq!(&reply, &rust, "{:?}", s);
    prop_assert_eq!(&ts_files, &rust_files, "{:?}", s);
    Ok(reply)
}

/// A perturbation applied before one of the steps.
#[derive(Debug, Clone, Copy)]
enum Perturbation {
    None,
    Stage,
    EscapeDiff,
    WrongRun,
    WrongTarget,
    Blocked,
    BeginTwice,
    TickTask,
    EditSpec,
    EarlyRender,
    ScribeTouchesCode,
    NoHandoff,
}

fn perturbation() -> impl Strategy<Value = (Perturbation, usize)> {
    (
        prop::sample::select(vec![
            Perturbation::None,
            Perturbation::Stage,
            Perturbation::EscapeDiff,
            Perturbation::WrongRun,
            Perturbation::WrongTarget,
            Perturbation::Blocked,
            Perturbation::BeginTwice,
            Perturbation::TickTask,
            Perturbation::EditSpec,
            Perturbation::EarlyRender,
            Perturbation::ScribeTouchesCode,
            Perturbation::NoHandoff,
        ]),
        0..9usize,
    )
}

fn flow(perturb: Perturbation, at: usize) -> Result<Vec<Value>, TestCaseError> {
    let (_guard, dir, home) = checkout()?;
    let mut replies = Vec::new();
    let mut run = String::new();
    let steps: Vec<Step> = vec![
        Step::new("prepare", None),
        Step::new("check", None),
        Step::new("begin", Some(IMPLEMENTER)),
        Step::new("begin", Some(SCRIBE)),
        Step::new("complete", Some(IMPLEMENTER)),
        Step::new("complete", Some(SCRIBE)),
        Step::new("check", None),
        Step::new("finalize", Some(IMPLEMENTER)),
        Step::new("check", None),
    ];
    for (i, mut s) in steps.into_iter().enumerate() {
        match s.op {
            "complete" if s.thread == Some(IMPLEMENTER) => {
                write(&dir.join("src/impl.ts"), "export const a = 2;\n")?;
            }
            "complete" => write(&dir.join("docs/guide.md"), "# Guide\n")?,
            "finalize" => {
                write(&dir.join("AGENTS.md"), "# Agents\n\nrendered\n")?;
                if !matches!((perturb, at == i), (Perturbation::NoHandoff, true)) {
                    let head = String::from_utf8(
                        Command::new("git")
                            .args(["rev-parse", "HEAD"])
                            .current_dir(&dir)
                            .output()
                            .map_err(fail)?
                            .stdout,
                    )
                    .map_err(fail)?;
                    let handoff = json!({ "feature": FEATURE, "status": "DONE", "worktree": dir,
                        "branch": "feat", "head": head.trim(), "commits": [], "filesTouched": ["src/impl.ts"],
                        "verification": { "command": "c", "exitCode": 0, "summary": "s" },
                        "markdownRequests": [{ "path": "docs/guide.md", "intent": "i", "evidence": "e" }] });
                    write(
                        &dir.join(DIR).join(format!("impl_{FEATURE}.json")),
                        &handoff.to_string(),
                    )?;
                }
            }
            _ => {}
        }
        if at == i {
            match perturb {
                Perturbation::Stage => git(&dir, &["add", "src/other.ts"]).and_then(|()| {
                    write(&dir.join("src/other.ts"), "staged\n")?;
                    git(&dir, &["add", "src/other.ts"])
                })?,
                Perturbation::EscapeDiff => write(&dir.join("src/other.ts"), "changed\n")?,
                Perturbation::WrongRun => s.wrong_run = true,
                Perturbation::WrongTarget => s.target = "dev",
                Perturbation::Blocked => {
                    s.status = "BLOCKED";
                    s.reason = Some("  waiting on input  ");
                }
                Perturbation::BeginTwice if s.op == "begin" => {
                    step(&dir, &home, &s, &run)?;
                }
                Perturbation::TickTask => {
                    write(
                        &dir.join("specs/demo/tasks.md"),
                        &TASKS.replace("- [ ] **T2**", "- [x] **T2**"),
                    )?;
                }
                Perturbation::EditSpec => {
                    write(&dir.join("specs/demo/design.md"), "# Design\n\nchanged\n")?
                }
                Perturbation::EarlyRender => write(&dir.join("AGENTS.md"), "# Agents\n\nearly\n")?,
                Perturbation::ScribeTouchesCode if s.thread == Some(SCRIBE) => {
                    write(&dir.join("src/impl.ts"), "export const a = 3;\n")?;
                }
                _ => {}
            }
        }
        let reply = step(&dir, &home, &s, &run)?;
        if s.op == "prepare"
            && let Some(id) = reply["runId"].as_str()
        {
            run = id.to_owned();
        }
        replies.push(reply);
    }
    Ok(replies)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    // Covers: R73, R74
    #[test]
    fn the_parallel_flow_matches_parallel_ts((perturb, at) in perturbation()) {
        flow(perturb, at)?;
    }
}

/// The refusals the generator reaches least, each at the step that exposes it: a second begin
/// (`EEXIST`), a render before both completions, a ticked task checkbox (allowed bookkeeping),
/// an edited spec, a blocked implementer, a scribe that touches code and a missing handoff.
// Covers: R73, R74
#[test]
fn targeted_refusals_match_parallel_ts() -> Result<(), TestCaseError> {
    for (perturb, at) in [
        (Perturbation::BeginTwice, 2),
        (Perturbation::EarlyRender, 4),
        (Perturbation::TickTask, 6),
        (Perturbation::EditSpec, 6),
        (Perturbation::Blocked, 4),
        (Perturbation::ScribeTouchesCode, 5),
        (Perturbation::NoHandoff, 7),
        (Perturbation::WrongTarget, 7),
    ] {
        flow(perturb, at)?;
    }
    Ok(())
}

/// The accepted flow end to end: every producer step succeeds on both sides and writes the same
/// files.
// Covers: R73, R74
#[test]
fn an_unperturbed_parallel_delivery_finalizes_like_the_ts() -> Result<(), TestCaseError> {
    let replies = flow(Perturbation::None, usize::MAX)?;
    let statuses: Vec<&str> = replies
        .iter()
        .filter_map(|r| r["status"].as_str())
        .collect();
    // After the render, the pre-render barrier refuses `checkParallel`, as in the TS.
    prop_assert_eq!(
        statuses,
        vec![
            "prepared",
            "ok",
            "ok",
            "ok",
            "completed",
            "completed",
            "ok",
            "finalized",
            "error"
        ],
        "{:?}",
        replies
    );
    Ok(())
}
