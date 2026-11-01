//! `navori_core::plan::resume::resume_plans` against the real `resumePlans` (spec 0060 T11):
//! generated checkouts with workplans, acceptance evidence, receipts signed by the real
//! `signReceipt` and reviews sealed by the real `beginReview`/`sealReview` must resume the same.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use navori_core::js_json::JsValue;
use navori_core::plan::evidence::{
    Fingerprint, FingerprintOptions, Git, fingerprint_tree, process_env, read_head,
};
use navori_core::plan::resume::{ConfigFacts, ResumeInput, resume_plans};
use navori_core::process::RealRunner;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";

fn prelude() -> String {
    format!(
        "const p = await import({:?}); const r = await import({:?}); const v = await import({:?}); \
         const fs = await import('node:fs');",
        cli_module("lib/plan/resume.ts"),
        cli_module("lib/diagnose/receipt.ts"),
        cli_module("lib/handoff/review-evidence.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const cwd = request.tree; \
     const o = { cwd, feature: request.feature, dir: '.navori/state/handoffs', target: 'main', gate: request.gate }; \
     if (request.op === 'sign') return r.signReceipt(o).exitCode; \
     if (request.op === 'seal') { const b = v.beginReview(o); if (b.status !== 'begun') return b; \
       fs.writeFileSync(cwd + '/.navori/state/handoffs/review_' + request.feature + '.json', JSON.stringify(request.sidecar)); \
       return v.sealReview({ ...o, nonce: b.nonce }).status; } \
     return p.resumePlans(cwd);",
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

const FEATURES: [&str; 3] = ["alpha", "beta", "gamma"];
const GATES: [&str; 2] = ["", "make check"];

#[derive(Debug, Clone)]
struct PlanCase {
    /// Which of `FEATURES`.
    feature: usize,
    /// Named for another feature: an invalid binding.
    misnamed: bool,
    /// Per criterion A1, A2: 0 no evidence, 1 current, 2 stale tree.
    evidence: [usize; 2],
    index: bool,
    /// 0 none, 1 sealed APPROVED, 2 sealed CHANGES_REQUESTED, 3 unsealed APPROVED.
    review: usize,
    receipt: bool,
    ownership: bool,
}

#[derive(Debug, Clone)]
struct Case {
    config: Option<usize>,
    current: usize,
    feature_branch: bool,
    change: bool,
    edit_after: bool,
    plans: Vec<PlanCase>,
}

fn plan_case() -> impl Strategy<Value = PlanCase> {
    (
        0..3usize,
        prop::bool::weighted(0.05),
        [0..3usize, 0..3usize],
        any::<bool>(),
        prop_oneof![3 => Just(0usize), 3 => Just(1usize), 1 => Just(2usize), 1 => Just(3usize)],
        prop::bool::weighted(0.6),
        prop::bool::weighted(0.1),
    )
        .prop_map(
            |(feature, misnamed, evidence, index, review, receipt, ownership)| PlanCase {
                feature,
                misnamed,
                evidence,
                index,
                review,
                receipt,
                ownership,
            },
        )
}

fn case() -> impl Strategy<Value = Case> {
    (
        prop_oneof![1 => Just(None), 6 => (0..2usize).prop_map(Some)],
        0..3usize,
        prop::bool::weighted(0.8),
        any::<bool>(),
        prop::bool::weighted(0.2),
        prop::collection::vec(plan_case(), 0..3),
    )
        .prop_map(
            |(config, current, feature_branch, change, edit_after, plans)| Case {
                config,
                current,
                feature_branch,
                change,
                edit_after,
                plans,
            },
        )
}

fn workplan(feature: &str) -> String {
    json!({ "feature": feature, "level": 1,
            "classification": { "score": 0, "level": 0, "signals": [] }, "objective": "o",
            "acceptance": [
                { "id": "A1", "description": "d", "command": "bun run test", "expected": "exit 0" },
                { "id": "A2", "description": "d", "command": "make check", "expected": "exit 0" } ] })
    .to_string()
}

fn build(c: &Case) -> Result<Repo, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-resume-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(fail)?;
    let dir = std::fs::canonicalize(&dir).map_err(fail)?;
    let repo = Repo(dir.clone());
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("a.txt"), "a").map_err(fail)?;
    if let Some(gate) = c.config {
        let mut config = json!({ "name": "x", "version": "1.0.0", "harnessVersion": "0.12.2",
            "engines": ["claude"], "preset": "custom", "language": "es", "branchBase": "main",
            "gitignoreHarness": "off", "commits": "conventional-es" });
        if !GATES[gate].is_empty() {
            config["qualityGate"] = json!({ "fast": "bun run fast", "full": GATES[gate] });
        }
        std::fs::write(dir.join("navori.config.json"), config.to_string()).map_err(fail)?;
    }
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    if c.feature_branch {
        git(&dir, &["checkout", "-q", "-b", "feat"])?;
    }
    if c.change {
        std::fs::write(dir.join("b.txt"), "b").map_err(fail)?;
    }
    match c.current {
        1 => {
            std::fs::create_dir_all(dir.join("progress")).map_err(fail)?;
            std::fs::write(dir.join("progress/current.md"), "# now\n\"next\"\n").map_err(fail)?;
        }
        2 => {
            std::fs::create_dir_all(dir.join(".claude/progress")).map_err(fail)?;
            std::fs::write(dir.join(".claude/progress/current.md"), "legacy\n").map_err(fail)?;
        }
        _ => {}
    }
    let handoffs = dir.join(DIR);
    std::fs::create_dir_all(&handoffs).map_err(fail)?;
    let tree = dir.to_string_lossy().into_owned();
    let gate = GATES[c.config.unwrap_or(0)];
    for p in &c.plans {
        let feature = FEATURES[p.feature];
        let name = if p.misnamed { "zzz" } else { feature };
        std::fs::write(
            handoffs.join(format!("workplan_{name}.json")),
            workplan(feature),
        )
        .map_err(fail)?;
        if p.ownership {
            let actor = json!({ "host": "codex", "thread": "01234567-89ab-cdef-0123-456789abcdef",
                "root": "01234567-89ab-cdef-0123-456789abcdef", "parent": "01234567-89ab-cdef-0123-456789abcdef",
                "role": "implementer", "version": "0.162.1", "sourceCwd": "/x", "sourceHash": "h" });
            let record = json!({ "feature": feature, "cwd": "/x", "target": "release", "head": "h",
                "base": null, "fingerprint": "f", "handoff": "d", "actors": [actor], "files": {} });
            std::fs::write(
                handoffs.join(format!("ownership_{feature}.json")),
                record.to_string(),
            )
            .map_err(fail)?;
        }
        if p.review > 0 {
            let verdict = if p.review == 2 {
                "CHANGES_REQUESTED"
            } else {
                "APPROVED"
            };
            let sidecar = json!({ "feature": feature, "verdict": verdict, "findings": [] });
            if p.review == 3 {
                std::fs::write(
                    handoffs.join(format!("review_{feature}.json")),
                    sidecar.to_string(),
                )
                .map_err(fail)?;
            } else {
                let sealed = NODE
                    .ask(&json!({ "op": "seal", "tree": tree, "feature": feature, "gate": gate, "sidecar": sidecar }))
                    .map_err(TestCaseError::fail)?;
                prop_assert_eq!(&sealed, "validated");
            }
        }
        if p.receipt {
            NODE.ask(&json!({ "op": "sign", "tree": tree, "feature": feature, "gate": gate }))
                .map_err(TestCaseError::fail)?;
        }
    }
    if c.edit_after {
        std::fs::write(dir.join("a.txt"), "a2").map_err(fail)?;
    }
    let env = process_env();
    let g = Git {
        runner: &RealRunner,
        env: &env,
        deadline: None,
    };
    let head = read_head(&g, &dir);
    let Fingerprint::Ok(current) = fingerprint_tree(&g, &dir, FingerprintOptions::default()) else {
        return Err(fail("fingerprint"));
    };
    let mut index = String::new();
    for p in &c.plans {
        let feature = FEATURES[p.feature];
        let mut log = String::new();
        for (id, kind) in ["A1", "A2"].iter().zip(p.evidence) {
            if kind == 0 {
                continue;
            }
            let command = if *id == "A1" {
                "bun run test"
            } else {
                "make check"
            };
            let fingerprint = if kind == 1 {
                current.as_str()
            } else {
                "deadbeef"
            };
            let line = json!({ "ts": "2026-11-01T00:00:00Z", "feature": feature, "id": id,
                "command": command, "tree": tree, "cwd": tree, "head": head,
                "worktreeTree": fingerprint, "fp": 2, "dirty": false });
            log.push_str(&format!("{line}\n"));
        }
        if !log.is_empty() {
            std::fs::write(
                handoffs.join(format!("workplan_{feature}.evidence.jsonl")),
                log,
            )
            .map_err(fail)?;
        }
        if p.index {
            index.push_str(&format!("x\t{feature}\tA1\nx\t{feature}\tA2\n"));
        }
    }
    if !index.is_empty() {
        std::fs::write(handoffs.join("acceptance-index"), index).map_err(fail)?;
    }
    Ok(repo)
}

fn config_facts(root: &str) -> Option<ConfigFacts> {
    let path = format!("{root}/navori.config.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return Some(ConfigFacts::Thrown(format!(
            "Cannot read {path}: ENOENT: no such file or directory, open '{path}'"
        )));
    };
    let config = navori_core::config::read(&bytes).ok()?;
    let JsValue::Object(data) = &config.data else {
        return None;
    };
    let target = match data.get("prTarget").or_else(|| data.get("branchBase")) {
        Some(JsValue::String(t)) => t.to_rust()?,
        _ => return None,
    };
    let gate = match data.get("qualityGate") {
        Some(JsValue::Object(q)) => match q.get("full") {
            Some(JsValue::String(t)) => t.to_rust()?,
            None | Some(JsValue::Undefined | JsValue::Null) => String::new(),
            Some(_) => return None,
        },
        _ => String::new(),
    };
    Some(ConfigFacts::Values { target, gate })
}

fn compare(c: &Case) -> Result<Value, TestCaseError> {
    let repo = build(c)?;
    let tree = repo.0.to_string_lossy().into_owned();
    let reply = NODE
        .ask(&json!({ "op": "resume", "tree": tree }))
        .map_err(TestCaseError::fail)?;
    let env = process_env();
    let rust = resume_plans(&ResumeInput {
        cwd: &tree,
        runner: &RealRunner,
        env: &env,
        budget: Duration::from_secs(5),
        config: &config_facts,
    })
    .ok_or_else(|| fail(format!("delegated: {c:?}")))?;
    let rust: Value =
        serde_json::from_str(&rust.stringify(None).unwrap_or_default()).map_err(fail)?;
    prop_assert_eq!(&reply, &rust, "{:?}", c);
    Ok(rust)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    // Covers: R73, R74
    #[test]
    fn resume_plans_matches_resume_ts(c in case()) {
        compare(&c)?;
    }
}

/// Every guarantee carried and current: evidence on the current tree, a correlated approval and
/// a fresh receipt all pass.
// Covers: R73, R74
#[test]
fn a_current_plan_resumes_with_every_guarantee_passed() -> Result<(), TestCaseError> {
    let plan = PlanCase {
        feature: 0,
        misnamed: false,
        evidence: [1, 1],
        index: true,
        review: 1,
        receipt: true,
        ownership: false,
    };
    let c = Case {
        config: Some(1),
        current: 1,
        feature_branch: true,
        change: true,
        edit_after: false,
        plans: vec![plan],
    };
    let rust = compare(&c)?;
    let passed = json!({ "status": "passed" });
    let alpha = &rust["plans"][0];
    prop_assert_eq!(&alpha["acceptance"]["A1"], &passed, "{}", rust);
    prop_assert_eq!(&alpha["review"], &passed, "{}", rust);
    prop_assert_eq!(&alpha["receipt"], &passed, "{}", rust);
    Ok(())
}
