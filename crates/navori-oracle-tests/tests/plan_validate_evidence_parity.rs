//! `navori_core::plan::evidence::validate_evidence` against the real `validateEvidence`
//! (spec 0060 T10/T11): generated evidence logs over a real checkout must give the same verdict,
//! reason and fix.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::plan::evidence::{
    Fingerprint, FingerprintOptions, Git, ValidateInput, fingerprint_tree, process_env, read_head,
    validate_evidence,
};
use navori_core::process::RealRunner;
use navori_core::state_files::resolve_state_root;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?}); const s = await import({:?});",
        cli_module("lib/plan/evidence.ts"),
        cli_module("lib/primitives/state-root.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const root = s.resolveStateRoot({ cwd: request.tree, feature: 'feat' }); \
     return e.validateEvidence({ root, feature: 'feat', id: 'A1', command: request.command, expected: request.expected });",
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

fn checkout() -> Result<Repo, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-validate-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).map_err(fail)?;
    let dir = std::fs::canonicalize(&dir).map_err(fail)?;
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("a.txt"), "a").map_err(fail)?;
    std::fs::write(dir.join("sub/b.txt"), "b").map_err(fail)?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    std::fs::create_dir_all(dir.join(".navori/state/handoffs")).map_err(fail)?;
    Ok(Repo(dir))
}

/// One generated evidence line, with each field either the current fact or a variant.
#[derive(Debug, Clone)]
struct Line {
    other_feature: bool,
    other_id: bool,
    command: usize,
    tree: usize,
    cwd: usize,
    head: usize,
    fingerprint: bool,
    fp: Option<Value>,
    exit: Option<Value>,
    expected: Option<Value>,
    outcome: Option<Value>,
    broken: bool,
}

fn opt(values: Vec<Value>) -> impl Strategy<Value = Option<Value>> {
    prop_oneof![3 => Just(None), 2 => prop::sample::select(values).prop_map(Some)]
}

fn line() -> impl Strategy<Value = Line> {
    (
        (
            prop::bool::weighted(0.1),
            prop::bool::weighted(0.1),
            biased(),
            biased(),
            biased(),
            biased(),
        ),
        (
            prop::bool::weighted(0.8),
            opt(vec![json!(2), json!(1)]),
            opt(vec![
                json!(0),
                json!(3),
                json!(300),
                json!("x"),
                Value::Null,
            ]),
            opt(vec![
                json!(""),
                json!("exit 0"),
                json!("exit 3"),
                json!("contains: ok"),
                json!(5),
            ]),
            opt(vec![
                json!("pass"),
                json!("fail"),
                json!("unevaluated"),
                json!("nope"),
            ]),
            prop::bool::weighted(0.05),
        ),
    )
        .prop_map(
            |(
                (other_feature, other_id, command, tree, cwd, head),
                (fingerprint, fp, exit, expected, outcome, broken),
            )| Line {
                other_feature,
                other_id,
                command,
                tree,
                cwd,
                head,
                fingerprint,
                fp,
                exit,
                expected,
                outcome,
                broken,
            },
        )
}

/// Index 0 (the current fact) most of the time, so valid evidence is common.
fn biased() -> impl Strategy<Value = usize> {
    prop_oneof![6 => Just(0usize), 1 => Just(1usize), 1 => Just(2usize)]
}

const COMMANDS: [&str; 3] = ["bun run test", "make check", "cd sub && make check"];

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    // Covers: R73, R74
    #[test]
    fn validate_evidence_matches_evidence_ts(
        lines in prop::collection::vec(line(), 1..5),
        command in biased(),
        expected in prop::sample::select(vec!["", "", "","", "exit 0", "exit 3", "contains: ok", "exit 007"]),
        index in any::<bool>(),
    ) {
        let repo = checkout()?;
        let root_dir = repo.0.to_string_lossy().into_owned();
        let env = process_env();
        let g = Git { runner: &RealRunner, env: &env, deadline: None };
        let head = read_head(&g, &repo.0);
        let current = match fingerprint_tree(&g, &repo.0, FingerprintOptions { stage_path: None, legacy: false }) {
            Fingerprint::Ok(tree) => tree,
            Fingerprint::Failed(reason) => return Err(fail(reason)),
        };
        let legacy = match fingerprint_tree(&g, &repo.0, FingerprintOptions { stage_path: None, legacy: true }) {
            Fingerprint::Ok(tree) => tree,
            Fingerprint::Failed(reason) => return Err(fail(reason)),
        };
        let mut log = String::new();
        for l in &lines {
            if l.broken {
                log.push_str("{not json\n");
                continue;
            }
            let trees = [root_dir.clone(), format!("{root_dir}/missing"), "/tmp".to_owned()];
            let cwds = [root_dir.clone(), format!("{root_dir}/sub"), "/tmp".to_owned()];
            let heads = [head.clone(), "0123456789abcdef".to_owned(), String::new()];
            let legacy_line = l.fp.is_none();
            let mut object = serde_json::Map::new();
            object.insert("ts".into(), json!("2026-11-01T00:00:00Z"));
            object.insert("feature".into(), json!(if l.other_feature { "other" } else { "feat" }));
            object.insert("id".into(), json!(if l.other_id { "A2" } else { "A1" }));
            object.insert("command".into(), json!(COMMANDS[l.command]));
            object.insert("tree".into(), json!(trees[l.tree]));
            object.insert("cwd".into(), json!(cwds[l.cwd]));
            object.insert("head".into(), json!(heads[l.head]));
            let tree_hash = if !l.fingerprint { "deadbeef" } else if legacy_line { &legacy } else { &current };
            object.insert("worktreeTree".into(), json!(tree_hash));
            object.insert("dirty".into(), json!(false));
            for (key, value) in [("fp", &l.fp), ("exit", &l.exit), ("expected", &l.expected), ("outcome", &l.outcome)] {
                if let Some(value) = value {
                    object.insert(key.into(), value.clone());
                }
            }
            log.push_str(&Value::Object(object).to_string());
            log.push('\n');
        }
        let handoffs = repo.0.join(".navori/state/handoffs");
        std::fs::write(handoffs.join("workplan_feat.evidence.jsonl"), &log).map_err(fail)?;
        if index {
            std::fs::write(handoffs.join("acceptance-index"), "x\tfeat\tA1\n").map_err(fail)?;
        }
        let reply = NODE
            .ask(&json!({ "tree": root_dir, "command": COMMANDS[command], "expected": expected }))
            .map_err(TestCaseError::fail)?;
        let root = resolve_state_root(&root_dir, &root_dir, "feat", None).map_err(|_| fail("state root"))?;
        let input = ValidateInput {
            root: &root, feature: "feat", id: "A1", command: COMMANDS[command], expected,
            impl_worktree: None, delivery_binding: None, current: None,
        };
        // A broken line is one js_json cannot read either: the TS skips it, Rust delegates.
        let Some(verdict) = validate_evidence(&g, &input) else {
            prop_assert!(lines.iter().any(|l| l.broken), "unexpected delegation: {}", log);
            return Ok(());
        };
        let rust: Value = serde_json::from_str(&verdict.to_js().stringify(None).unwrap_or_default()).map_err(fail)?;
        prop_assert_eq!(reply, rust, "{}", log);
    }
}

/// The verdict paths the generator reaches least: a current run accepted (with and without host
/// comparison fields, from the root and through a `cd` chain) and a HEAD that moved.
// Covers: R73, R74
#[test]
fn current_runs_are_accepted_like_evidence_ts() -> Result<(), TestCaseError> {
    let repo = checkout()?;
    let root_dir = repo.0.to_string_lossy().into_owned();
    let env = process_env();
    let g = Git {
        runner: &RealRunner,
        env: &env,
        deadline: None,
    };
    let head = read_head(&g, &repo.0);
    let Fingerprint::Ok(tree) = fingerprint_tree(
        &g,
        &repo.0,
        FingerprintOptions {
            stage_path: None,
            legacy: false,
        },
    ) else {
        return Err(fail("fingerprint"));
    };
    let base = |command: &str, cwd: &str, head: &str| {
        json!({ "ts": "2026-11-01T00:00:00Z", "feature": "feat", "id": "A1", "command": command,
                "tree": root_dir, "cwd": cwd, "head": head, "worktreeTree": tree, "fp": 2, "dirty": false })
    };
    let sub = format!("{root_dir}/sub");
    let mut compared = base("make check", &root_dir, &head);
    compared["exit"] = json!(3);
    compared["expected"] = json!("exit 3");
    compared["outcome"] = json!("pass");
    let cases = [
        (base("make check", &root_dir, &head), "make check", ""),
        (compared, "make check", "exit 3"),
        (
            base("cd sub && make check", &sub, &head),
            "cd sub && make check",
            "",
        ),
        (base("make check", &root_dir, "0123456"), "make check", ""),
        (
            base("bun run test", &root_dir, "0123456"),
            "bun run test",
            "",
        ),
    ];
    let root =
        resolve_state_root(&root_dir, &root_dir, "feat", None).map_err(|_| fail("state root"))?;
    for (line, command, expected) in cases {
        std::fs::write(
            repo.0
                .join(".navori/state/handoffs/workplan_feat.evidence.jsonl"),
            format!("{line}\n"),
        )
        .map_err(fail)?;
        let reply = NODE
            .ask(&json!({ "tree": root_dir, "command": command, "expected": expected }))
            .map_err(TestCaseError::fail)?;
        let input = ValidateInput {
            root: &root,
            feature: "feat",
            id: "A1",
            command,
            expected,
            impl_worktree: None,
            delivery_binding: None,
            current: None,
        };
        let verdict = validate_evidence(&g, &input).ok_or_else(|| fail("delegated"))?;
        let rust: Value =
            serde_json::from_str(&verdict.to_js().stringify(None).unwrap_or_default())
                .map_err(fail)?;
        prop_assert_eq!(&reply, &rust, "{}", line);
    }
    Ok(())
}
