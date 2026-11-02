//! `navori_core::diagnose::receipt::check_receipt` (read-only) and
//! `navori_core::handoff::review_evidence::correlate_review` against the real `checkReceipt` and
//! `correlateReview` (spec 0060 T10/T11): generated working trees, receipts and reviews sealed
//! by the real `beginReview`/`sealReview` must give the same result, exit code and correlation.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::diagnose::receipt::{CheckOptions, check_receipt};
use navori_core::handoff::review::parse_sidecar;
use navori_core::handoff::review_evidence::{EvidenceOptions, correlate_review};
use navori_core::plan::evidence::process_env;
use navori_core::process::RealRunner;
use navori_core::state_files::resolve_state_root;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";

fn prelude() -> String {
    format!(
        "const r = await import({:?}); const v = await import({:?}); const sc = await import({:?}); \
         const s = await import({:?}); const fs = await import('node:fs');",
        cli_module("lib/diagnose/receipt.ts"),
        cli_module("lib/handoff/review-evidence.ts"),
        cli_module("lib/handoff/review-schema.ts"),
        cli_module("lib/primitives/state-root.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const cwd = request.tree; const o = { cwd, feature: 'feat', dir: '.navori/state/handoffs', target: 'main', gate: request.gate }; \
     if (request.op === 'identity') return r.evidenceIdentity(cwd, request.gate); \
     const root = s.resolveStateRoot(o); \
     if (request.op === 'seal') { \
       const b = v.beginReview(o); if (b.status !== 'begun') return b; \
       fs.writeFileSync(root.path + '/review_feat.json', JSON.stringify(request.sidecar)); \
       return { ...v.sealReview({ ...o, nonce: b.nonce }), nonce: b.nonce }; } \
     const c = r.checkReceipt({ ...o, includeConsumed: request.includeConsumed, readOnly: true }); \
     let correlation = null; \
     try { const p = sc.ReviewSidecarSchema.safeParse(JSON.parse(fs.readFileSync(root.path + '/review_feat.json', 'utf8'))); \
       if (p.success) correlation = v.correlateReview(root, p.data, o).correlation; } catch {} \
     return { exitCode: c.exitCode, result: c.result, correlation };",
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

fn git(dir: &Path, args: &[&str]) -> Result<String, TestCaseError> {
    let out = Command::new("git")
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
        .output()
        .map_err(fail)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(fail(format!("git {args:?}")))
    }
}

fn checkout() -> Result<Repo, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-receipt-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).map_err(fail)?;
    let dir = std::fs::canonicalize(&dir).map_err(fail)?;
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("a.txt"), "a").map_err(fail)?;
    std::fs::write(dir.join("sub/b.txt"), "b").map_err(fail)?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    git(&dir, &["checkout", "-q", "-b", "feat"])?;
    std::fs::create_dir_all(dir.join(DIR)).map_err(fail)?;
    Ok(Repo(dir))
}

/// What the review state looks like when the receipt is checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Review {
    None,
    Approved,
    ChangesRequested,
    /// Sealed, then the verdict edited by hand.
    Tampered,
    /// Sealed, then the begin stamp deleted.
    NoStamp,
    /// A sidecar that never went through `seal`.
    Unsealed,
}

#[derive(Debug, Clone)]
struct Case {
    commit_on_feat: bool,
    modify_a: bool,
    add_c: bool,
    delete_b: bool,
    lock: bool,
    gate: usize,
    check_gate: usize,
    review: Review,
    edit_after_seal: bool,
    receipt: bool,
    consumed: bool,
    include_consumed: bool,
    version: u8,
    other_feature: bool,
    header_gate: usize,
    header_inputs: bool,
    records: Vec<usize>,
    malformed: bool,
}

const GATES: [&str; 2] = ["", "make check"];
const PATHS: [&str; 6] = ["a.txt", "c.txt", "sub/b.txt", "bun.lock", "d.txt", "../x"];

fn case() -> impl Strategy<Value = Case> {
    let review = prop_oneof![
        3 => Just(Review::None),
        4 => Just(Review::Approved),
        1 => Just(Review::ChangesRequested),
        1 => Just(Review::Tampered),
        1 => Just(Review::NoStamp),
        1 => Just(Review::Unsealed),
    ];
    let record =
        prop_oneof![2 => Just(0usize), 5 => Just(1usize), 1 => Just(2usize), 1 => Just(3usize)];
    (
        (
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            0..2usize,
            prop::bool::weighted(0.8),
            review,
            prop::bool::weighted(0.3),
        ),
        (
            prop::bool::weighted(0.9),
            prop::bool::weighted(0.2),
            any::<bool>(),
            prop_oneof![1 => Just(1u8), 6 => Just(2u8)],
            prop::bool::weighted(0.05),
            prop_oneof![6 => Just(0usize), 1 => Just(1usize), 1 => Just(2usize)],
            prop::bool::weighted(0.85),
            prop::collection::vec(record, PATHS.len()),
            prop::bool::weighted(0.05),
        ),
    )
        .prop_map(
            |(
                (
                    commit_on_feat,
                    modify_a,
                    add_c,
                    delete_b,
                    lock,
                    gate,
                    same_gate,
                    review,
                    edit_after_seal,
                ),
                (
                    receipt,
                    consumed,
                    include_consumed,
                    version,
                    other_feature,
                    header_gate,
                    header_inputs,
                    mut records,
                    malformed,
                ),
            )| {
                // `../x` escapes the repository; keep it rare.
                if records[5] != 0 && !malformed {
                    records[5] = 0;
                }
                Case {
                    commit_on_feat,
                    modify_a,
                    add_c,
                    delete_b,
                    lock,
                    gate,
                    check_gate: if same_gate { gate } else { 1 - gate },
                    review,
                    edit_after_seal,
                    receipt,
                    consumed,
                    include_consumed,
                    version,
                    other_feature,
                    header_gate,
                    header_inputs,
                    records,
                    malformed,
                }
            },
        )
}

fn build(repo: &Repo, c: &Case) -> Result<(), TestCaseError> {
    let dir = &repo.0;
    if c.commit_on_feat {
        std::fs::write(dir.join("e.txt"), "e").map_err(fail)?;
        git(dir, &["add", "e.txt"])?;
        git(dir, &["commit", "-q", "-m", "e"])?;
    }
    if c.modify_a {
        std::fs::write(dir.join("a.txt"), "a2").map_err(fail)?;
    }
    if c.add_c {
        std::fs::write(dir.join("c.txt"), "c").map_err(fail)?;
    }
    if c.delete_b {
        std::fs::remove_file(dir.join("sub/b.txt")).map_err(fail)?;
    }
    if c.lock {
        std::fs::write(dir.join("bun.lock"), "{}").map_err(fail)?;
    }
    let tree = dir.to_string_lossy();
    let handoffs = dir.join(DIR);
    if c.review != Review::None {
        let verdict = if c.review == Review::ChangesRequested {
            "CHANGES_REQUESTED"
        } else {
            "APPROVED"
        };
        let sidecar = json!({ "feature": "feat", "verdict": verdict, "findings": [
            { "category": "x", "severity": "low", "score": 60, "file": "a.txt", "extra": 1 } ] });
        if c.review == Review::Unsealed {
            std::fs::write(handoffs.join("review_feat.json"), sidecar.to_string()).map_err(fail)?;
        } else {
            let sealed = NODE
                .ask(&json!({ "op": "seal", "tree": tree, "gate": GATES[c.gate], "sidecar": sidecar }))
                .map_err(TestCaseError::fail)?;
            prop_assert_eq!(&sealed["status"], "validated", "{}", sealed);
            let nonce = sealed["nonce"].as_str().unwrap_or_default();
            if c.review == Review::Tampered {
                let path = handoffs.join("review_feat.json");
                let text = std::fs::read_to_string(&path).map_err(fail)?;
                std::fs::write(&path, text.replace("\"APPROVED\"", "\"APPROVED \""))
                    .map_err(fail)?;
            }
            if c.review == Review::NoStamp {
                std::fs::remove_file(handoffs.join(format!("review_feat.{nonce}.begin.json")))
                    .map_err(fail)?;
            }
        }
    }
    if c.edit_after_seal {
        std::fs::write(dir.join("a.txt"), "a3").map_err(fail)?;
    }
    if c.receipt {
        let identity = NODE
            .ask(&json!({ "op": "identity", "tree": tree, "gate": GATES[c.check_gate] }))
            .map_err(TestCaseError::fail)?;
        let base = git(dir, &["rev-parse", "main"])?;
        let feature = if c.other_feature { "other" } else { "feat" };
        let gate = match c.header_gate {
            0 => identity["gate"].as_str().unwrap_or_default().to_owned(),
            1 => "0".repeat(64),
            _ => "scoped".to_owned(),
        };
        let inputs = if c.header_inputs {
            identity["inputs"].as_str().unwrap_or_default().to_owned()
        } else {
            "1".repeat(64)
        };
        let mut text = if c.version == 2 {
            format!(
                "# navori-receipt v2 feature={feature} base={base} gate={gate} inputs={inputs}\n"
            )
        } else {
            format!("# navori-receipt v1 feature={feature}\n")
        };
        for (path, record) in PATHS.iter().zip(&c.records) {
            let blob = match record {
                0 => continue,
                1 if dir.join(path).is_file() => {
                    git(dir, &["hash-object", "--no-filters", "--", path])?
                }
                1 | 3 => "deleted".to_owned(),
                _ => "f".repeat(40),
            };
            text.push_str(&format!("{blob}  {path}\n"));
        }
        if c.malformed {
            text.push_str("nonsense line\n");
        }
        let name = if c.consumed {
            "receipt.consumed.txt"
        } else {
            "receipt.txt"
        };
        std::fs::write(handoffs.join(name), text).map_err(fail)?;
    }
    Ok(())
}

fn compare(c: &Case) -> Result<(), TestCaseError> {
    let repo = checkout()?;
    build(&repo, c)?;
    let tree = repo.0.to_string_lossy().into_owned();
    let gate = GATES[c.check_gate];
    let reply = NODE
        .ask(&json!({ "op": "check", "tree": tree, "gate": gate, "includeConsumed": c.include_consumed }))
        .map_err(TestCaseError::fail)?;
    let env = process_env();
    let options = CheckOptions {
        cwd: &tree,
        process_cwd: &tree,
        feature: "feat",
        target: "main",
        dir: DIR,
        gate,
        include_consumed: c.include_consumed,
        deadline: None,
        current_content: None,
        runner: &RealRunner,
        env: &env,
    };
    let result =
        check_receipt(&options).ok_or_else(|| fail(format!("receipt delegated: {c:?}")))?;
    let root =
        resolve_state_root(&tree, &tree, "feat", Some(DIR)).map_err(|_| fail("state root"))?;
    let raw = std::fs::read_to_string(repo.0.join(DIR).join("review_feat.json")).ok();
    let sidecar = raw
        .as_deref()
        .and_then(navori_core::js_json::parse)
        .as_ref()
        .and_then(parse_sidecar);
    let correlation = match sidecar {
        Some(sidecar) => {
            let evidence = EvidenceOptions {
                target: "main",
                gate,
                current_content: None,
                timeout: None,
            };
            let found = correlate_review(&root, &sidecar, Some(&evidence), &env)
                .map_err(|_| fail(format!("correlation delegated: {c:?}")))?;
            json!(found.correlation)
        }
        None => Value::Null,
    };
    let rust_result: Value =
        serde_json::from_str(&result.to_js().stringify(None).unwrap_or_default()).map_err(fail)?;
    let rust = json!({ "exitCode": result.exit_code(), "result": rust_result, "correlation": correlation });
    prop_assert_eq!(reply, rust, "{:?}", c);
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    // Covers: R73, R74
    #[test]
    fn check_receipt_and_correlation_match_the_ts(c in case()) {
        compare(&c)?;
    }
}

/// The paths the generator reaches least: a fresh, complete receipt behind a correlated approval,
/// and the same receipt once the reviewed bytes changed.
// Covers: R73, R74
#[test]
fn a_current_receipt_behind_a_correlated_review_passes_like_the_ts() -> Result<(), TestCaseError> {
    let base = Case {
        commit_on_feat: false,
        modify_a: true,
        add_c: true,
        delete_b: true,
        lock: true,
        gate: 1,
        check_gate: 1,
        review: Review::Approved,
        edit_after_seal: false,
        receipt: true,
        consumed: false,
        include_consumed: false,
        version: 2,
        other_feature: false,
        header_gate: 0,
        header_inputs: true,
        records: vec![1, 1, 3, 1, 0, 0],
        malformed: false,
    };
    compare(&base)?;
    compare(&Case {
        edit_after_seal: true,
        ..base.clone()
    })?;
    compare(&Case {
        consumed: true,
        include_consumed: true,
        ..base
    })
}
