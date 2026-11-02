//! `navori_core::handoff::review_check::check_review_handoff` against the real
//! `checkReviewHandoff` (spec 0060 T10): reviews sealed by the real `beginReview`/`sealReview`,
//! then edited, re-dated or left unsealed, must give the same status and failures.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::handoff::review_check::{ReviewCheck, check_review_handoff};
use navori_core::handoff::review_evidence::EvidenceOptions;
use navori_core::plan::evidence::process_env;
use navori_core::state_files::resolve_state_root;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";
const GATES: [&str; 2] = ["", "make check"];

fn prelude() -> String {
    format!(
        "const c = await import({:?}); const v = await import({:?}); const fs = await import('node:fs');",
        cli_module("lib/handoff/review-check.ts"),
        cli_module("lib/handoff/review-evidence.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const cwd = request.tree; \
     const o = { cwd, feature: 'feat', dir: '.navori/state/handoffs', target: 'main', gate: request.gate }; \
     if (request.op === 'seal') { const b = v.beginReview(o); if (b.status !== 'begun') return b; \
       fs.writeFileSync(cwd + '/.navori/state/handoffs/review_feat.json', JSON.stringify(request.sidecar)); \
       return v.sealReview({ ...o, nonce: b.nonce }).status; } \
     const r = c.checkReviewHandoff({ cwd, dir: o.dir, feature: 'feat', evidenceOptions: o, \
       ...(request.since ? { since: request.since } : {}) }); \
     return { status: r.status, failures: r.failures };",
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

#[derive(Debug, Clone)]
struct Case {
    /// 0 absent, 1 with a verdict, 2 without one.
    md: usize,
    /// 0 absent, 1 sealed APPROVED, 2 sealed CHANGES_REQUESTED, 3 unsealed, 4 sealed then
    /// relabeled to another feature.
    sidecar: usize,
    gate: usize,
    check_gate: usize,
    edit_after: bool,
    /// 0 none, 1 before the review, 2 after it, 3 exactly its start.
    since: usize,
}

fn case() -> impl Strategy<Value = Case> {
    (
        prop_oneof![1 => Just(0usize), 4 => Just(1usize), 1 => Just(2usize)],
        prop_oneof![1 => Just(0usize), 4 => Just(1usize), 1 => Just(2usize), 1 => Just(3usize), 1 => Just(4usize)],
        0..2usize,
        prop::bool::weighted(0.8),
        prop::bool::weighted(0.25),
        0..4usize,
    )
        .prop_map(|(md, sidecar, gate, same, edit_after, since)| Case {
            md,
            sidecar,
            gate,
            check_gate: if same { gate } else { 1 - gate },
            edit_after,
            since,
        })
}

fn compare(c: &Case) -> Result<Value, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-revcheck-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(DIR)).map_err(fail)?;
    let dir = std::fs::canonicalize(&dir).map_err(fail)?;
    let repo = Repo(dir.clone());
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("a.txt"), "a").map_err(fail)?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    git(&dir, &["checkout", "-q", "-b", "feat"])?;
    std::fs::write(dir.join("b.txt"), "b").map_err(fail)?;
    let handoffs = dir.join(DIR);
    let tree = repo.0.to_string_lossy().into_owned();
    match c.md {
        1 => std::fs::write(
            handoffs.join("review_feat.md"),
            "**Final verdict:** APPROVED\n",
        ),
        2 => std::fs::write(handoffs.join("review_feat.md"), "pending\n"),
        _ => Ok(()),
    }
    .map_err(fail)?;
    let verdict = if c.sidecar == 2 {
        "CHANGES_REQUESTED"
    } else {
        "APPROVED"
    };
    let sidecar = json!({ "feature": "feat", "verdict": verdict, "findings": [] });
    let path = handoffs.join("review_feat.json");
    match c.sidecar {
        0 => {}
        3 => std::fs::write(&path, sidecar.to_string()).map_err(fail)?,
        _ => {
            let sealed = NODE
                .ask(&json!({ "op": "seal", "tree": tree, "gate": GATES[c.gate], "sidecar": sidecar }))
                .map_err(TestCaseError::fail)?;
            prop_assert_eq!(&sealed, "validated");
            if c.sidecar == 4 {
                let text = std::fs::read_to_string(&path).map_err(fail)?;
                std::fs::write(&path, text.replacen("\"feat\"", "\"other\"", 1)).map_err(fail)?;
            }
        }
    }
    if c.edit_after {
        std::fs::write(dir.join("a.txt"), "a2").map_err(fail)?;
    }
    let started = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["evidence"]["startedAt"].as_str().map(str::to_owned));
    let since = match (c.since, &started) {
        (1, _) => Some("2020-01-01T00:00:00Z".to_owned()),
        (2, _) => Some("2999-01-01T00:00:00.5Z".to_owned()),
        (3, Some(started)) => Some(started.clone()),
        _ => None,
    };
    let gate = GATES[c.check_gate];
    let reply = NODE
        .ask(&json!({ "op": "check", "tree": tree, "gate": gate, "since": since }))
        .map_err(TestCaseError::fail)?;
    let root =
        resolve_state_root(&tree, &tree, "feat", Some(DIR)).map_err(|_| fail("state root"))?;
    let evidence = EvidenceOptions {
        target: "main",
        gate,
        current_content: None,
        timeout: None,
    };
    let env = process_env();
    let checked = check_review_handoff(&root, "feat", since.as_deref(), &evidence, &env)
        .map_err(|_| fail(format!("delegated: {c:?}")))?;
    let rust = match checked {
        ReviewCheck::Error(detail) => {
            json!({ "status": "error", "failures": [{ "check": "exists", "detail": detail }] })
        }
        ReviewCheck::Failures(failures) => json!({
            "status": if failures.is_empty() { "ok" } else { "findings" },
            "failures": failures.iter().map(|(check, detail)| json!({ "check": check, "detail": detail })).collect::<Vec<_>>(),
        }),
    };
    prop_assert_eq!(&reply, &rust, "{:?}", c);
    Ok(rust)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // Covers: R73, R74
    #[test]
    fn check_review_handoff_matches_review_check_ts(c in case()) {
        compare(&c)?;
    }
}

/// A current, sealed and correlated approval passes, also with `since` at its exact start; a
/// `since` after it marks a stale round.
// Covers: R73, R74
#[test]
fn a_current_sealed_review_passes_like_the_ts() -> Result<(), TestCaseError> {
    let base = Case {
        md: 1,
        sidecar: 1,
        gate: 1,
        check_gate: 1,
        edit_after: false,
        since: 0,
    };
    for since in [0, 3] {
        let rust = compare(&Case {
            since,
            ..base.clone()
        })?;
        prop_assert_eq!(&rust["status"], "ok", "{}", rust);
    }
    let rust = compare(&Case { since: 2, ..base })?;
    prop_assert_eq!(&rust["failures"][0]["check"], "fresh", "{}", rust);
    Ok(())
}
