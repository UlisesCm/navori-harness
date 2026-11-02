//! `navori_core::handoff::attest::plan_attest` against the real `attestHandoff` (spec 0060 T10):
//! generated native Codex sessions, handoffs, workplans and working trees must give the same
//! error or the same `ownership_<feature>.json`, including a scribe over an implementer's record.

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::handoff::attest::{Attest, AttestInput, plan_attest};
use navori_core::plan::evidence::process_env;
use navori_core::process::RealRunner;
use navori_core::state_files::resolve_state_root;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";
const THREAD: &str = "0123abcd-0000-4000-8000-00000000aaaa";
const ROOT: &str = "0123abcd-0000-4000-8000-00000000bbbb";
const PARENT: &str = "0123abcd-0000-4000-8000-00000000cccc";

fn prelude() -> String {
    format!(
        "const a = await import({:?}); const fs = await import('node:fs');",
        cli_module("lib/handoff/actor-provenance.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "process.env.CODEX_THREAD_ID = request.thread; process.env.CODEX_HOME = request.home; \
     process.chdir(request.tree); \
     const path = request.tree + '/.navori/state/handoffs/ownership_wp.json'; \
     const before = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null; \
     const r = a.attestHandoff({ cwd: request.tree, feature: 'wp', target: 'main', dir: '.navori/state/handoffs' }); \
     const after = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null; \
     if (request.restore) { if (before === null) { if (after !== null) fs.rmSync(path); } else fs.writeFileSync(path, before); } \
     return { ...r, record: r.status === 'attested' ? after : null };",
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

const ROLES: [&str; 3] = ["implementer", "scribe", "reviewer"];

#[derive(Debug, Clone)]
struct Case {
    role: usize,
    spawn_role_differs: bool,
    other_thread: bool,
    touched_escapes: bool,
    diff_escapes: bool,
    no_impl: bool,
    parallel: bool,
    /// For a scribe: the implementer attests first, then the tree changes.
    prior: bool,
    /// 0 nothing, 1 the prose file, 2 code.
    scribe_edit: usize,
}

fn case() -> impl Strategy<Value = Case> {
    (
        prop_oneof![4 => Just(0usize), 4 => Just(1usize), 1 => Just(2usize)],
        prop::bool::weighted(0.1),
        prop::bool::weighted(0.1),
        prop::bool::weighted(0.15),
        prop::bool::weighted(0.15),
        prop::bool::weighted(0.05),
        prop::bool::weighted(0.05),
        prop::bool::weighted(0.8),
        0..3usize,
    )
        .prop_map(
            |(
                role,
                spawn_role_differs,
                other_thread,
                touched_escapes,
                diff_escapes,
                no_impl,
                parallel,
                prior,
                scribe_edit,
            )| Case {
                role,
                spawn_role_differs,
                other_thread,
                touched_escapes,
                diff_escapes,
                no_impl,
                parallel,
                prior,
                scribe_edit,
            },
        )
}

fn write_session(
    home: &Path,
    tree: &str,
    role: &str,
    spawn_role: &str,
) -> Result<(), TestCaseError> {
    let dir = home.join("sessions/2026/11/01");
    std::fs::create_dir_all(&dir).map_err(fail)?;
    let header = json!({ "type": "session_meta", "payload": { "id": THREAD, "session_id": ROOT,
        "parent_thread_id": PARENT, "cli_version": "0.162.1", "cwd": tree, "agent_role": role,
        "source": { "subagent": { "thread_spawn": { "parent_thread_id": PARENT, "agent_role": spawn_role } } } } });
    std::fs::write(
        dir.join(format!("rollout-x-{THREAD}.jsonl")),
        format!("{header}\n{{}}\n"),
    )
    .map_err(fail)
}

/// Runs both sides over the same tree: the TS first (restoring the prior record when asked, so
/// the Rust side starts from the same state), then Rust, and compares answer and record.
fn attest_both(
    repo: &Path,
    home: &Path,
    thread: &str,
    restore: bool,
) -> Result<Value, TestCaseError> {
    let tree = repo.to_string_lossy().into_owned();
    let reply = NODE
        .ask(&json!({ "tree": tree, "home": home, "thread": thread, "restore": restore }))
        .map_err(TestCaseError::fail)?;
    let mut env: Vec<(OsString, OsString)> = process_env()
        .into_iter()
        .filter(|(k, _)| k != "CODEX_THREAD_ID" && k != "CODEX_HOME")
        .collect();
    env.push(("CODEX_THREAD_ID".into(), thread.into()));
    env.push(("CODEX_HOME".into(), home.into()));
    let root = resolve_state_root(&tree, &tree, "wp", Some(DIR)).map_err(|_| fail("root"))?;
    let planned = plan_attest(&AttestInput {
        process_cwd: &tree,
        root: &root,
        feature: "wp",
        target: "main",
        env: &env,
        runner: &RealRunner,
    })
    .map_err(|_| fail("delegated"))?;
    let rust = match planned {
        Attest::Error(message) => json!({ "status": "error", "message": message, "record": null }),
        Attest::Write(text) => json!({ "status": "attested", "record": text }),
    };
    prop_assert_eq!(&reply, &rust);
    Ok(rust)
}

fn compare(c: &Case) -> Result<Value, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!("navori-attest-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("repo/src")).map_err(fail)?;
    let base = std::fs::canonicalize(&base).map_err(fail)?;
    let guard = Repo(base.clone());
    let dir = base.join("repo");
    let home = base.join("codex");
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("src/a.ts"), "a").map_err(fail)?;
    git(&dir, &["add", "-A"])?;
    git(&dir, &["commit", "-q", "-m", "x"])?;
    let tree = dir.to_string_lossy().into_owned();
    let handoffs = dir.join(DIR);
    std::fs::create_dir_all(&handoffs).map_err(fail)?;
    let touched = if c.touched_escapes {
        "src/z.ts"
    } else {
        "src/a.ts"
    };
    let handoff = json!({ "feature": "wp", "status": "DONE", "worktree": tree, "branch": "main",
        "commits": [], "filesTouched": [touched], "verification": { "command": "c", "exitCode": 0, "summary": "s" },
        "markdownRequests": [{ "path": "docs/g.md", "intent": "i", "evidence": "e" }] });
    if !c.no_impl {
        std::fs::write(handoffs.join("impl_wp.json"), handoff.to_string()).map_err(fail)?;
    }
    let plan = json!({ "feature": "wp", "level": 1, "classification": { "score": 0, "level": 0, "signals": [] },
        "objective": "o", "acceptance": [{ "id": "A1", "description": "d", "command": "bun x", "expected": "exit 0" }],
        "files": [{ "path": "src/a.ts", "new": false }, { "path": "docs/g.md", "new": true }] });
    std::fs::write(handoffs.join("workplan_wp.json"), plan.to_string()).map_err(fail)?;
    std::fs::write(dir.join("src/a.ts"), "a2").map_err(fail)?;
    if c.diff_escapes {
        std::fs::write(dir.join("src/b.ts"), "b").map_err(fail)?;
    }
    if c.parallel {
        std::fs::write(handoffs.join("parallel_wp.json"), "{}").map_err(fail)?;
    }
    let thread = if c.other_thread { PARENT } else { THREAD };
    let role = ROLES[c.role];
    if role == "scribe" && c.prior {
        write_session(&home, &tree, "implementer", "implementer")?;
        // The implementer's record is written by the TS and kept for both sides.
        // It may fail (an escaping diff): the scribe then has no prior record.
        attest_both(&dir, &home, THREAD, false)?;
        match c.scribe_edit {
            1 => {
                std::fs::create_dir_all(dir.join("docs")).map_err(fail)?;
                std::fs::write(dir.join("docs/g.md"), "# g\n").map_err(fail)?;
            }
            2 => std::fs::write(dir.join("src/a.ts"), "a3").map_err(fail)?,
            _ => {}
        }
    }
    let spawn_role = if c.spawn_role_differs {
        "reviewer"
    } else {
        role
    };
    write_session(&home, &tree, role, spawn_role)?;
    let result = attest_both(&dir, &home, thread, true)?;
    drop(guard);
    Ok(result)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    // Covers: R73, R74
    #[test]
    fn plan_attest_matches_attest_handoff_ts(c in case()) {
        compare(&c)?;
    }
}

/// The accepted paths: an implementer attests, and a scribe that only wrote its prose extends
/// that record.
// Covers: R73, R74
#[test]
fn producers_attest_like_the_ts() -> Result<(), TestCaseError> {
    let base = Case {
        role: 0,
        spawn_role_differs: false,
        other_thread: false,
        touched_escapes: false,
        diff_escapes: false,
        no_impl: false,
        parallel: false,
        prior: false,
        scribe_edit: 0,
    };
    let implementer = compare(&base)?;
    prop_assert_eq!(&implementer["status"], "attested", "{}", implementer);
    let scribe = compare(&Case {
        role: 1,
        prior: true,
        scribe_edit: 1,
        ..base
    })?;
    prop_assert_eq!(&scribe["status"], "attested", "{}", scribe);
    prop_assert!(
        scribe["record"].as_str().is_some_and(
            |r| r.contains("\"role\":\"implementer\"") && r.contains("\"role\":\"scribe\"")
        ),
        "{}",
        scribe
    );
    Ok(())
}
