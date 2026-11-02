//! `navori_core::plan::evidence` against the real `lib/plan/evidence.ts` (spec 0060 T10/T11):
//! the tree fingerprint and HEAD of generated git checkouts, and the pure-runner predicate.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use navori_core::plan::evidence::{
    Fingerprint, FingerprintOptions, Git, fingerprint_tree, is_pure_evidence_runner, process_env,
    read_head,
};
use navori_core::process::RealRunner;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?});",
        cli_module("lib/plan/evidence.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.command !== undefined) return e.isPureEvidenceRunner(request.command); \
     return { fp: e.fingerprintTree(request.tree, request.stagePath ? { stagePath: request.stagePath } : undefined, { legacy: request.legacy }), \
              head: e.readHead(request.tree) };",
);

/// One generated file: path segments, contents, executable bit, symlink, staged.
#[derive(Debug, Clone)]
struct File {
    path: String,
    body: String,
    exec: bool,
    link: bool,
    staged: bool,
}

fn file() -> impl Strategy<Value = File> {
    let segment = prop_oneof![
        4 => "[a-c]{1,2}",
        1 => prop_oneof![
            Just("progress"), Just(".navori"), Just("state"), Just(".claude"), Just("worktrees"),
            Just("a-b"), Just("a.b"), Just("é"), Just("ignored"),
        ].prop_map(str::to_owned),
    ];
    (
        prop::collection::vec(segment, 1..4),
        "[a-z\n]{0,12}",
        any::<bool>(),
        prop::bool::weighted(0.1),
        any::<bool>(),
    )
        .prop_map(|(parts, body, exec, link, staged)| File {
            path: parts.join("/"),
            body,
            exec,
            link,
            staged,
        })
}

struct Repo(PathBuf);
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<(), TestCaseError> {
    let status = Command::new("git")
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
        .map_err(|e| TestCaseError::fail(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(TestCaseError::fail(format!("git {args:?}")))
    }
}

fn repo(files: &[File], commit: bool) -> Result<Repo, TestCaseError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("navori-evidence-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| TestCaseError::fail(e.to_string()))?;
    let dir = std::fs::canonicalize(&dir).map_err(|e| TestCaseError::fail(e.to_string()))?;
    let repo = Repo(dir.clone());
    git(&dir, &["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join(".gitignore"), "ignored\n")
        .map_err(|e| TestCaseError::fail(e.to_string()))?;
    for f in files {
        let path = dir.join(&f.path);
        if let Some(parent) = path.parent()
            && std::fs::create_dir_all(parent).is_err()
        {
            continue; // a file already sits where a directory is wanted
        }
        if path.exists() {
            continue;
        }
        let made = if f.link {
            std::os::unix::fs::symlink(&f.body, &path)
        } else {
            std::fs::write(&path, &f.body).and_then(|()| {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(
                    &path,
                    std::fs::Permissions::from_mode(if f.exec { 0o755 } else { 0o644 }),
                )
            })
        };
        if made.is_ok() && f.staged {
            let _ = Command::new("git")
                .args(["add", "-f", "--", &f.path])
                .current_dir(&dir)
                .status();
        }
    }
    if commit {
        git(&dir, &["commit", "-q", "--allow-empty", "-m", "x"])?;
    }
    Ok(repo)
}

fn shape(fp: &Fingerprint) -> Value {
    match fp {
        Fingerprint::Ok(tree) => json!({ "ok": true, "tree": tree }),
        Fingerprint::Failed(reason) => json!({ "ok": false, "reason": reason }),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    // Covers: R73, R74
    #[test]
    fn fingerprint_and_head_match_evidence_ts(
        files in prop::collection::vec(file(), 0..10),
        commit in any::<bool>(),
        legacy in any::<bool>(),
    ) {
        let repo = repo(&files, commit)?;
        let tree = repo.0.to_string_lossy().into_owned();
        let reply = NODE.ask(&json!({ "tree": tree, "legacy": legacy })).map_err(TestCaseError::fail)?;
        let env = process_env();
        let g = Git { runner: &RealRunner, env: &env, deadline: None };
        let fp = fingerprint_tree(&g, &repo.0, FingerprintOptions { stage_path: None, legacy });
        prop_assert_eq!(&reply["fp"], &shape(&fp), "{:?}", files);
        prop_assert_eq!(&reply["head"], &json!(read_head(&g, &repo.0)));
    }

    // Covers: R73
    #[test]
    fn pure_runner_matches_evidence_ts(command in prop::collection::vec(prop_oneof![
        Just("bun run test"), Just("bun x vitest run"), Just("bun run test:golden"), Just("cd a"),
        Just("cd /a"), Just("cd ../a"), Just(" && "), Just("&&"), Just(" "), Just("\t"), Just("&"),
        Just(";"), Just("|"), Just("$x"), Just("src/a.test.ts"), Just("--run"), Just("é"),
        Just("\u{a0}"), Just("npm test"), Just("cd a/./b"), Just("cd\ta"),
    ], 0..6).prop_map(|p| p.concat())) {
        let reply = NODE.ask(&json!({ "command": command })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!(is_pure_evidence_runner(&command)), "{:?}", command);
    }
}

/// A delivery binding excludes the stage lifecycle files and refuses an uncontained stage.
// Covers: R74
#[test]
fn delivery_stage_binding_matches_evidence_ts() -> Result<(), TestCaseError> {
    let files = vec![
        File {
            path: "specs/_master/01/state.json".into(),
            body: "{}".into(),
            exec: false,
            link: false,
            staged: true,
        },
        File {
            path: "specs/_master/01/STATUS.md".into(),
            body: "s".into(),
            exec: false,
            link: false,
            staged: true,
        },
        File {
            path: "src/a.ts".into(),
            body: "a".into(),
            exec: false,
            link: false,
            staged: true,
        },
    ];
    let repo = repo(&files, true)?;
    let env = process_env();
    let g = Git {
        runner: &RealRunner,
        env: &env,
        deadline: None,
    };
    for stage in [
        "specs/_master/01",
        "specs/_master/02",
        "../x",
        "a//b",
        "specs\\x",
    ] {
        let reply = NODE
            .ask(&json!({ "tree": repo.0.to_string_lossy(), "stagePath": stage, "legacy": false }))
            .map_err(TestCaseError::fail)?;
        let fp = fingerprint_tree(
            &g,
            &repo.0,
            FingerprintOptions {
                stage_path: Some(stage),
                legacy: false,
            },
        );
        prop_assert_eq!(&reply["fp"], &shape(&fp), "{}", stage);
    }
    Ok(())
}
