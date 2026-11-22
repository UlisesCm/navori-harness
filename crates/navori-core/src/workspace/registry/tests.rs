//! `git_out`, `find_for_path` and `is_registered_checkout` over real git repos in a tempdir.
#![allow(clippy::expect_used, reason = "test assertions")]

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use super::{Stop, find_for_path, git_out, is_registered_checkout};
use crate::process::RealRunner;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("navori-reg-{label}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(fs::canonicalize(dir).expect("canonical temp dir"))
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    fn text(&self, rel: &str) -> String {
        self.path(rel).to_string_lossy().into_owned()
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn os(key: &str, value: &str) -> (OsString, OsString) {
    (OsString::from(key), OsString::from(value))
}

/// A hermetic environment: the real `PATH` (for git), an isolated `HOME`, no user git config.
fn env_for(home: &Path) -> Vec<(OsString, OsString)> {
    let path = std::env::var("PATH").unwrap_or_default();
    vec![
        os("PATH", &path),
        os("HOME", &home.to_string_lossy()),
        os("GIT_CONFIG_GLOBAL", "/dev/null"),
        os("GIT_CONFIG_NOSYSTEM", "1"),
    ]
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed");
}

fn init_repo(dir: &Path) {
    fs::create_dir_all(dir).expect("create repo dir");
    git(dir, &["init", "-q"]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "x"]);
}

fn register(home: &Path, name: &str, repos: &[(&str, &str)]) {
    let dir = home.join(".navori/workspaces").join(name);
    fs::create_dir_all(&dir).expect("create workspace dir");
    let repos: Vec<String> = repos
        .iter()
        .map(|(n, p)| format!("{{\"name\":\"{n}\",\"path\":\"{p}\"}}"))
        .collect();
    fs::write(
        dir.join("workspace.json"),
        format!("{{\"name\":\"{name}\",\"repos\":[{}]}}", repos.join(",")),
    )
    .expect("write workspace");
}

#[test]
fn git_out_keeps_the_environment_but_the_pinning_variables() {
    let temp = Temp::new("gitenv");
    let stubs = temp.path("bin");
    fs::create_dir_all(&stubs).expect("bin dir");
    let stub = stubs.join("git");
    fs::write(
        &stub,
        "#!/bin/sh\necho \"cfg=$GIT_CONFIG_GLOBAL dir=$GIT_DIR wt=$GIT_WORK_TREE common=$GIT_COMMON_DIR idx=$GIT_INDEX_FILE\"\n",
    )
    .expect("write stub");
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).expect("chmod");
    let env = vec![
        os("PATH", &stubs.to_string_lossy()),
        os("GIT_CONFIG_GLOBAL", "kept"),
        os("GIT_DIR", "x"),
        os("GIT_WORK_TREE", "x"),
        os("GIT_COMMON_DIR", "x"),
        os("GIT_INDEX_FILE", "x"),
    ];
    let out = git_out(&RealRunner, &temp.0, &["anything"], &env).expect("ok");
    assert_eq!(out.as_deref(), Some("cfg=kept dir= wt= common= idx=\n"));
}

#[test]
fn git_out_is_none_on_failure() {
    let temp = Temp::new("gitfail");
    let env = env_for(&temp.0);
    // Not a repository: git exits non-zero.
    assert_eq!(
        git_out(
            &RealRunner,
            &temp.0,
            &["rev-parse", "--show-toplevel"],
            &env
        ),
        Ok(None)
    );
    // Missing cwd: the spawn fails.
    assert_eq!(
        git_out(&RealRunner, &temp.path("missing"), &["status"], &env),
        Ok(None)
    );
}

#[test]
fn find_for_path_matches_by_canonical_equality_and_skips_broken_workspaces() {
    let temp = Temp::new("find");
    let home = temp.path("home");
    let repo = temp.path("repo");
    fs::create_dir_all(&repo).expect("repo");
    fs::create_dir_all(repo.join("sub")).expect("sub");
    fs::create_dir_all(&home).expect("home");
    fs::create_dir_all(home.join(".navori/workspaces/aaa-broken")).expect("broken");
    fs::write(
        home.join(".navori/workspaces/aaa-broken/workspace.json"),
        "{\"name\":3}",
    )
    .expect("write broken");
    // The registered path goes through a symlink; equality is on the canonical path.
    std::os::unix::fs::symlink(&repo, temp.path("link")).expect("symlink");
    register(&home, "ws", &[("repo", &temp.text("link"))]);
    let env = env_for(&home);
    let cwd = temp.text("");
    assert_eq!(
        find_for_path(&env, &cwd, &temp.text("repo")),
        Ok(vec!["ws".to_owned()])
    );
    // Containment is not equality.
    assert_eq!(
        find_for_path(&env, &cwd, &temp.text("repo/sub")),
        Ok(vec![])
    );
}

#[test]
fn relative_registry_paths_resolve_against_the_process_cwd() {
    let temp = Temp::new("rel");
    let home = temp.path("home");
    fs::create_dir_all(temp.path("repo")).expect("repo");
    fs::create_dir_all(temp.path("other")).expect("other");
    fs::create_dir_all(&home).expect("home");
    register(&home, "ws", &[("repo", "repo")]);
    let env = env_for(&home);
    let repo = temp.text("repo");
    assert_eq!(
        find_for_path(&env, &temp.text(""), &repo),
        Ok(vec!["ws".to_owned()])
    );
    assert_eq!(find_for_path(&env, &temp.text("other"), &repo), Ok(vec![]));
}

#[test]
fn find_for_path_propagates_a_legacy_layout() {
    let temp = Temp::new("legacy");
    let home = temp.path("home");
    fs::create_dir_all(home.join(".navori/workspaces")).expect("root");
    fs::write(home.join(".navori/workspaces/ws.json"), "{}").expect("legacy");
    let env = env_for(&home);
    assert!(matches!(
        find_for_path(&env, &temp.text(""), &temp.text("")),
        Err(Stop::Delegate(_))
    ));
}

#[test]
fn registered_checkout_is_trusted() {
    let temp = Temp::new("registered");
    let home = temp.path("home");
    let repo = temp.path("repo");
    init_repo(&repo);
    fs::create_dir_all(&home).expect("home");
    register(&home, "ws", &[("repo", &temp.text("repo"))]);
    let env = env_for(&home);
    let cwd = temp.text("");
    assert_eq!(
        is_registered_checkout(&env, &cwd, &temp.text("repo"), &RealRunner),
        Ok(true)
    );
    let stranger = temp.path("stranger");
    init_repo(&stranger);
    assert_eq!(
        is_registered_checkout(&env, &cwd, &temp.text("stranger"), &RealRunner),
        Ok(false)
    );
}

#[test]
fn a_worktree_with_a_back_link_is_trusted() {
    let temp = Temp::new("worktree");
    let home = temp.path("home");
    let repo = temp.path("repo");
    init_repo(&repo);
    git(&repo, &["worktree", "add", "-q", "-b", "feat", "../wt"]);
    fs::create_dir_all(&home).expect("home");
    register(&home, "ws", &[("repo", &temp.text("repo"))]);
    let env = env_for(&home);
    assert_eq!(
        is_registered_checkout(&env, &temp.text(""), &temp.text("wt"), &RealRunner),
        Ok(true)
    );
}

#[test]
fn a_forged_commondir_does_not_lend_trust() {
    let temp = Temp::new("forged");
    let home = temp.path("home");
    let repo = temp.path("repo");
    init_repo(&repo);
    let evil = temp.path("evil");
    init_repo(&evil);
    fs::write(
        evil.join(".git/commondir"),
        format!("{}\n", temp.text("repo/.git")),
    )
    .expect("forge");
    fs::create_dir_all(&home).expect("home");
    register(&home, "ws", &[("repo", &temp.text("repo"))]);
    let env = env_for(&home);
    assert_eq!(
        is_registered_checkout(&env, &temp.text(""), &temp.text("evil"), &RealRunner),
        Ok(false)
    );
}
