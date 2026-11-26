//! `navori_core::handoff::ownership::read_ownership` against the real `readOwnership` (spec 0060
//! T10/T11): generated `ownership_<feature>.json` documents must read the same.

mod support;

use std::path::PathBuf;
use std::process::Command;

use navori_core::handoff::ownership::{Ownership, read_ownership};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

const DIR: &str = ".navori/state/handoffs";

fn prelude() -> String {
    format!(
        "const a = await import({:?});",
        cli_module("lib/handoff/actor-provenance.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return a.readOwnership(request.tree, 'feat', '.navori/state/handoffs') ?? null;",
);

fn fail(e: impl ToString) -> TestCaseError {
    TestCaseError::fail(e.to_string())
}

struct Repo(PathBuf);
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn checkout() -> Result<Repo, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-ownership-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(DIR)).map_err(fail)?;
    let dir = std::fs::canonicalize(&dir).map_err(fail)?;
    let ok = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&dir)
        .status()
        .map_err(fail)?
        .success();
    if !ok {
        return Err(fail("git init"));
    }
    Ok(Repo(dir))
}

const ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

fn actor() -> Value {
    json!({ "host": "codex", "thread": ID, "root": ID, "parent": ID, "role": "implementer",
            "version": "0.162.1", "sourceCwd": "/x", "sourceHash": "h" })
}

fn document() -> Value {
    json!({ "feature": "feat", "cwd": "/x", "target": "main", "head": "h", "base": null,
            "fingerprint": "f", "handoff": "d", "actors": [actor()], "files": { "a.txt": "x" } })
}

/// One edit to the valid document, or none.
fn edit() -> impl Strategy<Value = (usize, usize)> {
    (0..14usize, 0..9usize)
}

const KEYS: [&str; 9] = [
    "feature",
    "cwd",
    "target",
    "head",
    "base",
    "fingerprint",
    "handoff",
    "actors",
    "files",
];
const ACTOR_KEYS: [&str; 8] = [
    "host",
    "thread",
    "root",
    "parent",
    "role",
    "version",
    "sourceCwd",
    "sourceHash",
];

fn apply(doc: &mut Value, (kind, at): (usize, usize)) {
    let key = KEYS[at % KEYS.len()];
    let actor_key = ACTOR_KEYS[at % ACTOR_KEYS.len()];
    let has_actor = doc["actors"].get(0).is_some_and(Value::is_object);
    if (6..=12).contains(&kind) && kind != 9 && !has_actor {
        return;
    }
    if kind == 9 && !doc["files"].is_object() {
        return;
    }
    match kind {
        0 => {}
        1 => {
            doc.as_object_mut().map(|o| o.remove(key));
        }
        2 => doc["extra"] = json!(1),
        3 => doc[key] = json!(7),
        4 => doc["base"] = json!("b"),
        5 => doc["actors"] = json!([]),
        6 => doc["actors"][0][actor_key] = json!("other"),
        7 => {
            doc["actors"][0]
                .as_object_mut()
                .map(|o| o.remove(actor_key));
        }
        8 => doc["actors"][0]["extra"] = json!(1),
        9 => doc["files"]["b"] = json!(1),
        10 => doc["actors"][0]["role"] = json!("reviewer"),
        11 => doc["actors"][0]["version"] = json!("0.163.0"),
        12 => doc["actors"][0]["thread"] = json!("0123456789abcdef0123456789abcdef----"),
        _ => doc["files"] = json!({}),
    }
}

fn to_json(o: &Ownership) -> Value {
    let actors: Vec<Value> = o
        .actors
        .iter()
        .map(|a| {
            json!({ "host": a.host, "thread": a.thread, "root": a.root, "parent": a.parent,
                    "role": a.role, "version": a.version, "sourceCwd": a.source_cwd,
                    "sourceHash": a.source_hash })
        })
        .collect();
    json!({ "feature": o.feature, "cwd": o.cwd, "target": o.target, "head": o.head,
            "base": o.base, "fingerprint": o.fingerprint, "handoff": o.handoff,
            "actors": actors, "files": o.files })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    // Covers: R73, R74
    #[test]
    fn read_ownership_matches_actor_provenance_ts(edits in prop::collection::vec(edit(), 0..3)) {
        let repo = checkout()?;
        let mut doc = document();
        for e in &edits {
            apply(&mut doc, *e);
        }
        std::fs::write(repo.0.join(DIR).join("ownership_feat.json"), doc.to_string()).map_err(fail)?;
        let tree = repo.0.to_string_lossy().into_owned();
        let reply = NODE.ask(&json!({ "tree": tree })).map_err(TestCaseError::fail)?;
        let rust = read_ownership(&tree, "feat", Some(DIR)).map_err(|_| fail("delegated"))?;
        prop_assert_eq!(reply, rust.as_ref().map_or(Value::Null, to_json), "{}", doc);
    }
}

/// A missing record and a directory in its place read as no ownership.
// Covers: R73, R74
#[test]
fn an_absent_or_unreadable_record_is_no_ownership() -> Result<(), TestCaseError> {
    let repo = checkout()?;
    let tree = repo.0.to_string_lossy().into_owned();
    for step in 0..2 {
        if step == 1 {
            std::fs::create_dir_all(repo.0.join(DIR).join("ownership_feat.json")).map_err(fail)?;
        }
        let reply = NODE
            .ask(&json!({ "tree": tree }))
            .map_err(TestCaseError::fail)?;
        let rust = read_ownership(&tree, "feat", Some(DIR)).map_err(|_| fail("delegated"))?;
        prop_assert_eq!(reply, Value::Null);
        prop_assert!(rust.is_none());
    }
    Ok(())
}
