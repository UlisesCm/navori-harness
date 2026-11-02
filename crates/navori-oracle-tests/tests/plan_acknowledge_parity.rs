//! `navori_core::plan::gate::acknowledge_front` plus `navori_core::plan::escalation` against the
//! real `acknowledgePlanEscalation` (spec 0060 T11): checkouts whose rejection history,
//! acknowledgements, consumptions and continuations the real `plan gate` and `acknowledge` built
//! must answer and change the same for an acknowledgement, an inspection or a continuation.

mod support;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::fs::RealFs;
use navori_core::plan::escalation::{self, Request, Stop};
use navori_core::plan::gate::{AckFront, Context, acknowledge_front};
use proptest::prelude::*;
use proptest::strategy::ValueTree as _;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";

fn prelude() -> String {
    format!(
        "const g = await import({:?}); const fs = await import('node:fs');",
        cli_module("lib/plan/gate.ts"),
    )
}

/// `prep` builds the history and the escalation state through the TS; `run` measures one call.
static NODE: Shared = Shared::new(
    prelude,
    "const cwd = request.cwd; const c = request.case; \
     const feature = c.level === 3 ? 'demo-e1' : 'demo'; \
     const opening = c.level === 3 ? 'spec: demo E1 M1' : 'workplan: demo'; \
     const dir = cwd + '/.navori/state/handoffs'; \
     const review = dir + '/review_' + feature + '.md'; \
     const ack = (decision, options) => g.acknowledgePlanEscalation(cwd, feature, opening, decision, options); \
     if (request.op === 'run') { \
       try { return { result: ack(request.decision, request.options) }; } \
       catch (error) { return { error: String(error && error.message || error), name: error && error.name || null }; } } \
     const workplan = (objective) => JSON.stringify({ feature, level: c.level, \
       classification: { score: c.level === 1 ? 2 : 8, level: c.level === 1 ? 1 : 2, signals: [] }, \
       objective, files: [], \
       acceptance: [{ id: 'A1', description: 'check', command: 'bun test', expected: 'exit0' }], \
       progress: { A1: 'pendiente' }, decisions: [], outOfScope: [], \
       solution: { path: 'solution_demo.md', verdict: 'CONCERNS' }, \
       phases: [{ name: 'one', acceptance: ['A1'] }], risks: [{ risk: 'replay', rollback: 'deny' }] }); \
     fs.mkdirSync(dir, { recursive: true }); \
     fs.writeFileSync(cwd + '/navori.config.json', JSON.stringify({ name: 'demo', preset: 'custom', \
       engines: ['codex'], harness: { planTiers: c.tiers } })); \
     fs.writeFileSync(dir + '/workplan_' + feature + '.json', workplan('Recover workflow')); \
     if (c.level === 3) { fs.mkdirSync(cwd + '/specs/demo', { recursive: true }); \
       fs.writeFileSync(cwd + '/specs/demo/tasks.md', '## E1 — Delivery\\n### M1 — Milestone\\n### M2 — Another\\n'); } \
     const lines = c.history.map((kind, i) => kind === 1 \
       ? JSON.stringify({ ts: '2026-10-2' + i + 'T00:00:00Z', kind: 'reset', approvedBy: 'user', reason: 'again', rejectionsBefore: 2 }) \
       : JSON.stringify({ ts: kind === 2 ? '2026-10-1' + i + 'T00:00:00.5+02:00' : '2026-10-1' + i + 'T00:00:00Z', \
           reviewHash: 'abcdef'[i].repeat(64), verdict: 'CHANGES_REQUESTED' })); \
     if (lines.length > 0) fs.writeFileSync(dir + '/workplan_' + feature + '.gate.jsonl', lines.join('\\n') + '\\n'); \
     if (c.review === 1) fs.writeFileSync(review, '**Final verdict:** APPROVED\\n'); \
     if (c.review === 2) fs.writeFileSync(review, '**Final verdict:** CHANGES_REQUESTED\\nfirst\\n'); \
     if (c.solution) { fs.writeFileSync(dir + '/solution_' + feature + '.md', 's'); \
       fs.writeFileSync(dir + '/solution_review_' + feature + '.md', 'r'); } \
     for (const [i, step] of c.steps.entries()) { try { \
       if (step === 0) ack('decision ' + i); \
       else if (step === 1) g.evaluatePlanGate({ cwd, tool_input: { subagent_type: 'implementer', prompt: opening } }); \
       else if (step === 2) { const s = ack('', { inspect: true }); if (s.eligiblePredecessor) \
         ack('more ' + i, { continuation: { continueAfter: s.eligiblePredecessor, authorizationId: 'id' + i, snapshot: s.currentSnapshot } }); } \
       else if (step === 3) fs.writeFileSync(dir + '/workplan_' + feature + '.json', workplan('edit ' + i)); \
       else if (step === 4) fs.writeFileSync(review, '**Final verdict:** CHANGES_REQUESTED\\nstep ' + i + '\\n'); \
       else if (step === 5) fs.writeFileSync(review, '**Final verdict:** APPROVED\\n'); \
     } catch {} } \
     let s = null; try { s = ack('', { inspect: true }); } catch {} \
     return { feature, opening, eligible: s ? s.eligiblePredecessor || null : null, current: s ? s.currentSnapshot : null };",
);

struct Repo(PathBuf);
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _ = std::fs::remove_dir_all(self.0.with_extension("bak"));
    }
}

fn fail(e: impl ToString) -> TestCaseError {
    TestCaseError::fail(e.to_string())
}

#[derive(Debug, Clone)]
struct Case {
    level: u8,
    tiers: bool,
    /// 0 a UTC rejection, 1 a reset, 2 a rejection with an offset.
    history: Vec<u8>,
    /// 0 none, 1 APPROVED, 2 CHANGES_REQUESTED.
    review: u8,
    solution: bool,
    /// 0 acknowledge, 1 gate dispatch, 2 continue, 3 edit the workplan, 4 a new rejection,
    /// 5 an approval.
    steps: Vec<u8>,
    /// 0 acknowledge, 1 inspect, 2 continue.
    last: u8,
    decision: u8,
    /// 0 the eligible predecessor, 1 an unknown grant, 2 an invalid reference.
    after: u8,
    /// 0 fresh, 1 an identifier `prep` may have used, 2 invalid.
    id: u8,
    /// 0 the current snapshot, 1 another hash.
    snapshot: u8,
}

fn case() -> impl Strategy<Value = Case> {
    (
        (
            prop_oneof![1 => Just(1u8), 4 => Just(2u8), 2 => Just(3u8)],
            prop::bool::weighted(0.95),
            prop::collection::vec(prop_oneof![6 => Just(0u8), 1 => Just(1u8), 2 => Just(2u8)], 1..5),
            0..3u8,
            prop::bool::weighted(0.3),
        ),
        (
            prop::collection::vec(prop_oneof![4 => Just(0u8), 4 => Just(1u8), 3 => Just(2u8), 1 => Just(3u8), 2 => Just(4u8), 1 => Just(5u8)], 0..7),
            0..3u8,
            0..3u8,
            prop_oneof![6 => Just(0u8), 1 => Just(1u8), 1 => Just(2u8)],
            prop_oneof![6 => Just(0u8), 2 => Just(1u8), 1 => Just(2u8)],
            prop_oneof![6 => Just(0u8), 1 => Just(1u8)],
        ),
    )
        .prop_map(
            |((level, tiers, history, review, solution), (steps, last, decision, after, id, snapshot))| Case {
                level,
                tiers,
                history,
                review,
                solution,
                steps,
                last,
                decision,
                after,
                id,
                snapshot,
            },
        )
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    std::fs::set_permissions(to, std::fs::metadata(from)?.permissions())?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Every path under the checkout but `.git`: type, mode and bytes.
fn snapshot(root: &Path) -> Result<Vec<(String, u32, Vec<u8>)>, TestCaseError> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u32, Vec<u8>)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .display()
                .to_string();
            let mode = meta.permissions().mode();
            if meta.is_dir() {
                out.push((format!("{name}/"), mode, Vec::new()));
                walk(root, &path, out)?;
            } else {
                out.push((name, mode, std::fs::read(&path)?));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, root, &mut out).map_err(fail)?;
    out.sort();
    Ok(out)
}

/// The timestamp of the line the TS appended to the gate log, if any.
fn appended_ts(before: Option<&[u8]>, after: Option<&[u8]>) -> Option<String> {
    let (before, after) = (before.unwrap_or_default(), after?);
    let tail = after.strip_prefix(before)?;
    let line: Value = serde_json::from_slice(tail.strip_suffix(b"\n")?).ok()?;
    line["ts"].as_str().map(str::to_owned)
}

const DECISIONS: [&str; 3] = ["User explicitly authorizes continuation", "  padded  ", " "];

/// `Some(reply)` when Rust answers natively, `None` where it hands the call to the TS.
fn rust_run(
    cwd: &Path,
    feature: &str,
    opening: &str,
    decision: &str,
    inspect: bool,
    continuation: Option<(&str, &str, &str)>,
    now: &str,
) -> Result<Option<Value>, TestCaseError> {
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let ctx = Context {
        process_cwd: cwd,
        env: &env,
        now_ms: 0.0,
        pid: std::process::id(),
    };
    let cwd = cwd.to_string_lossy();
    let scope = match acknowledge_front(&cwd, feature, opening, &ctx) {
        AckFront::Delegate => return Ok(None),
        AckFront::Deny(error) => return Ok(Some(json!({ "error": error }))),
        AckFront::Scope(scope) => scope,
    };
    let request = Request {
        feature,
        opening,
        decision,
        inspect,
        continuation,
        now,
    };
    let outcome = match escalation::acknowledge(&scope, &request) {
        Ok(outcome) => outcome,
        Err(Stop::Unmodeled) => return Ok(None),
        Err(Stop::Message(m)) => return Err(fail(format!("a message escaped: {m}"))),
    };
    if let Err(error) = escalation::apply(&mut RealFs::default(), &outcome.writes) {
        return Ok(Some(json!({ "error": error })));
    }
    Ok(Some(match outcome.result {
        Ok(value) => {
            json!({ "result": serde_json::from_str::<Value>(&value.stringify(None).ok_or_else(|| fail("stringify"))?).map_err(fail)? })
        }
        Err(error) => json!({ "error": error }),
    }))
}

/// Whether the call ran natively, after comparing it.
fn check(c: &Case) -> Result<bool, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().canonicalize().map_err(fail)?;
    let dir = base.join(format!("navori-ack-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(fail)?;
    let repo = Repo(dir.clone());
    let status = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&dir)
        .status()
        .map_err(fail)?;
    prop_assert!(status.success());
    let cwd = dir.to_string_lossy().into_owned();
    let case = json!({ "level": c.level, "tiers": c.tiers, "history": c.history,
        "review": c.review, "solution": c.solution, "steps": c.steps });
    let prep = NODE
        .ask(&json!({ "op": "prep", "cwd": cwd, "case": case }))
        .map_err(TestCaseError::fail)?;
    let feature = prep["feature"].as_str().unwrap_or_default().to_owned();
    let opening = prep["opening"].as_str().unwrap_or_default().to_owned();
    let decision = if c.last == 1 {
        ""
    } else {
        DECISIONS[usize::from(c.decision)]
    };
    let after = match (c.after, prep["eligible"].as_str()) {
        (0, Some(eligible)) => eligible.to_owned(),
        (0 | 1, _) => format!("grant:{}", "c".repeat(64)),
        _ => "grant:nope".to_owned(),
    };
    let id = ["fresh", "id1", "bad id"][usize::from(c.id)];
    let current = match (c.snapshot, prep["current"].as_str()) {
        (0, Some(current)) => current.to_owned(),
        _ => "d".repeat(64),
    };
    let continuation = (c.last == 2).then_some((after.as_str(), id, current.as_str()));
    let mut options = json!({});
    if c.last == 1 {
        options["inspect"] = json!(true);
    }
    if let Some((after, id, snapshot)) = continuation {
        options["continuation"] =
            json!({ "continueAfter": after, "authorizationId": id, "snapshot": snapshot });
    }
    let backup = dir.with_extension("bak");
    let _ = std::fs::remove_dir_all(&backup);
    copy_tree(&dir, &backup).map_err(fail)?;
    let log = Path::new(DIR).join(format!("workplan_{feature}.gate.jsonl"));
    let log_before = std::fs::read(dir.join(&log)).ok();
    let ts = NODE
        .ask(&json!({ "op": "run", "cwd": cwd, "case": case, "decision": decision, "options": options }))
        .map_err(TestCaseError::fail)?;
    let ts_tree = snapshot(&dir)?;
    let now = appended_ts(
        log_before.as_deref(),
        std::fs::read(dir.join(&log)).ok().as_deref(),
    )
    .unwrap_or_else(|| "2026-11-01T00:00:00.000Z".to_owned());
    std::fs::remove_dir_all(&dir).map_err(fail)?;
    copy_tree(&backup, &dir).map_err(fail)?;
    let rust = rust_run(
        &dir,
        &feature,
        &opening,
        decision,
        c.last == 1,
        continuation,
        &now,
    )?;
    let Some(rust) = rust else {
        drop(repo);
        return Ok(false);
    };
    let ts_reply = match &ts["error"] {
        Value::String(error) => json!({ "error": error }),
        _ => json!({ "result": ts["result"] }),
    };
    prop_assert_eq!(
        &ts_reply,
        &rust,
        "case {:?}, TS error type {}",
        c,
        ts["name"]
    );
    let rust_tree = snapshot(&dir)?;
    prop_assert_eq!(ts_tree, rust_tree, "tree after {:?}", c);
    drop(repo);
    Ok(true)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(160))]

    // Covers: R73
    #[test]
    fn acknowledge_matches_the_ts(c in case()) {
        check(&c)?;
    }
}

// Covers: R73
#[test]
fn most_generated_calls_run_natively() -> Result<(), String> {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let (mut native, total) = (0, 80);
    for _ in 0..total {
        let c = case()
            .new_tree(&mut runner)
            .map_err(|e| e.to_string())?
            .current();
        native += usize::from(check(&c).map_err(|e| e.to_string())?);
    }
    assert!(
        native * 2 >= total,
        "only {native} of {total} calls ran natively"
    );
    Ok(())
}
