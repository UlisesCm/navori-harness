//! The chain runner, the private log and `prepare_foreign`, with shell stubs on a temporary
//! `PATH` and real git repos in a tempdir.
#![allow(clippy::expect_used, reason = "test assertions")]

use std::ffi::OsString;
use std::fs::{self, File};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use super::{
    ChainOp, ChainResult, FOREIGN_LOG_PREFIX, Prepared, parse_chain, prepare_foreign, private_log,
    prune_foreign_logs, run_chain, run_foreign, signal_name, timestamp, tmpdir,
};
use crate::process::RealRunner;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("navori-run-{label}-{}-{n}", std::process::id()));
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

fn stub(dir: &Path, name: &str, body: &str) {
    fs::create_dir_all(dir).expect("stub dir");
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
}

/// A stub `PATH` first, then the system's, so `sh` and `git` still resolve.
fn stub_env(bin: &Path) -> Vec<(OsString, OsString)> {
    let system = std::env::var("PATH").unwrap_or_default();
    vec![os("PATH", &format!("{}:{system}", bin.display()))]
}

fn log_file(temp: &Temp) -> (File, PathBuf) {
    let path = temp.path("chain.log");
    (File::create(&path).expect("create log"), path)
}

fn run(temp: &Temp, gate: &str) -> (ChainResult, String) {
    let (log, path) = log_file(temp);
    let env = stub_env(&temp.path("bin"));
    let result = run_chain(gate, &temp.text(""), &log, &env);
    (result, fs::read_to_string(path).expect("read log"))
}

#[test]
fn parse_chain_keeps_the_operator_before_each_step() {
    let steps = parse_chain("  a x ;b&&  c ||d  ");
    let got: Vec<(ChainOp, &str)> = steps.iter().map(|s| (s.op, s.text.as_str())).collect();
    assert_eq!(
        got,
        vec![
            (ChainOp::Seq, "a x"),
            (ChainOp::Seq, "b"),
            (ChainOp::And, "c"),
            (ChainOp::Or, "d"),
        ]
    );
    assert_eq!(parse_chain("one").len(), 1);
}

#[test]
fn chain_operators_follow_the_shell_semantics() {
    let temp = Temp::new("ops");
    let bin = temp.path("bin");
    for name in ["bad", "one", "two", "three", "four"] {
        stub(&bin, name, &format!("echo {name}"));
    }
    stub(&bin, "bad", "echo bad; exit 3");
    let (result, log) = run(&temp, "bad && one ; two || three ; bad || four");
    assert_eq!(log, "bad\ntwo\nbad\nfour\n");
    assert_eq!(
        result,
        ChainResult {
            code: 0,
            signal: None
        }
    );
    let (result, _) = run(&temp, "one && bad");
    assert_eq!(result.exit_code(), 3);
}

#[test]
fn a_missing_cd_target_is_noted_in_order_and_fails_the_step() {
    let temp = Temp::new("cd");
    let bin = temp.path("bin");
    stub(&bin, "one", "echo one");
    stub(&bin, "two", "echo two");
    stub(&bin, "where", "pwd -P");
    fs::create_dir_all(temp.path("sub")).expect("sub");
    let (result, log) = run(&temp, "one; cd nodir; two");
    assert_eq!(
        log,
        "one\n[navori gate] cd: nodir: no such directory\ntwo\n"
    );
    assert_eq!(result.code, 0);
    let (result, _) = run(&temp, "cd nodir");
    assert_eq!(result.code, 1);
    let (result, log) = run(&temp, "cd nodir && two");
    assert_eq!((result.code, log.contains("two")), (1, false));
    let (_, log) = run(&temp, "cd sub && where");
    assert_eq!(log, format!("{}\n", temp.text("sub")));
}

#[test]
fn a_missing_binary_is_127() {
    let temp = Temp::new("missing");
    fs::create_dir_all(temp.path("bin")).expect("bin");
    let (result, _) = run(&temp, "no-such-binary-xyz arg");
    assert_eq!(
        result,
        ChainResult {
            code: 127,
            signal: None
        }
    );
}

#[test]
fn a_step_killed_by_sigkill_is_129_and_stops_the_chain() {
    let temp = Temp::new("kill");
    let bin = temp.path("bin");
    stub(&bin, "die", "echo dying; kill -KILL $$");
    stub(&bin, "after", "echo after");
    let (result, log) = run(&temp, "die; after");
    assert_eq!(result.signal, Some("SIGKILL"));
    assert_eq!(result.exit_code(), 129);
    assert_eq!(log, "dying\n");
}

#[test]
fn run_foreign_reports_the_signal_in_stdout_and_in_the_log() {
    let temp = Temp::new("foreign-kill");
    let bin = temp.path("bin");
    stub(&bin, "die", "kill -KILL $$");
    let log = private_log(&temp.0, jiff::Timestamp::UNIX_EPOCH).expect("log");
    let path = log.path.clone();
    let env = stub_env(&bin);
    let verdict = run_foreign("die", &temp.text(""), log, &env);
    assert_eq!(verdict.exit_code, 129);
    assert_eq!(
        verdict.stdout,
        format!(
            "navori gate foreign: exit 129 — log {}\nkilled by SIGKILL",
            path.display()
        )
    );
    assert!(
        fs::read_to_string(&path)
            .expect("read log")
            .ends_with("\n[navori gate] killed by SIGKILL\n")
    );
}

#[test]
fn signal_exit_codes_and_names_follow_node() {
    let exit = |signal| ChainResult { code: 1, signal }.exit_code();
    assert_eq!(exit(Some("SIGINT")), 130);
    assert_eq!(exit(Some("SIGTERM")), 143);
    assert_eq!(exit(Some("SIGKILL")), 129);
    assert_eq!(exit(Some("")), 129);
    assert_eq!(exit(None), 1);
    assert_eq!(signal_name(9), Some("SIGKILL"));
    assert_eq!(signal_name(2), Some("SIGINT"));
    assert_eq!(signal_name(15), Some("SIGTERM"));
    // No name in Node's table: the signal is still a signal, with an empty name (DV8: Node
    // itself reports such a child as `close(0, null)`; Rust fails closed instead).
    assert_eq!(signal_name(40), None);
    assert_eq!(signal_name(0), None);
}

#[test]
fn a_signal_without_a_name_gives_an_empty_one() {
    let temp = Temp::new("rtsig");
    stub(
        &temp.path("bin"),
        "rt",
        "kill -s 40 $$ 2>/dev/null || kill -40 $$",
    );
    let (result, log) = run(&temp, "rt");
    if result.signal.is_some() {
        assert_eq!(result.signal, Some(""));
        assert_eq!(result.exit_code(), 129);
    } else {
        // The shell cannot raise signal 40 here; the table test above covers the mapping.
        eprintln!("shell cannot raise signal 40: {log:?}");
    }
}

#[test]
fn steps_see_the_whole_environment_they_are_given() {
    let temp = Temp::new("env");
    let bin = temp.path("bin");
    stub(&bin, "show", "echo \"cfg=$GIT_CONFIG_GLOBAL home=$HOME\"");
    let (log, path) = log_file(&temp);
    let mut env = stub_env(&bin);
    env.push(os("GIT_CONFIG_GLOBAL", "/dev/null"));
    let result = run_chain("show", &temp.text(""), &log, &env);
    assert_eq!(result.code, 0);
    // `HOME` was not handed over, so the step does not have it either.
    assert_eq!(
        fs::read_to_string(path).expect("read"),
        "cfg=/dev/null home=\n"
    );
}

#[test]
fn tmpdir_follows_os_tmpdir() {
    let tmp = |vars: &[(&str, &str)]| {
        let env: Vec<_> = vars.iter().map(|(k, v)| os(k, v)).collect();
        tmpdir(&env)
    };
    assert_eq!(tmp(&[]), PathBuf::from("/tmp"));
    assert_eq!(tmp(&[("TMPDIR", "/var/x/")]), PathBuf::from("/var/x"));
    assert_eq!(tmp(&[("TMPDIR", "/tmp//")]), PathBuf::from("/tmp/"));
    assert_eq!(tmp(&[("TMPDIR", "/")]), PathBuf::from("/"));
    assert_eq!(tmp(&[("TMPDIR", ""), ("TMP", "/a")]), PathBuf::from("/a"));
    assert_eq!(tmp(&[("TMP", "/a"), ("TEMP", "/b")]), PathBuf::from("/a"));
    assert_eq!(tmp(&[("TEMP", "/b/")]), PathBuf::from("/b"));
    assert_eq!(tmp(&[("TMPDIR", "/t"), ("TMP", "/a")]), PathBuf::from("/t"));
}

#[test]
fn timestamp_is_to_iso_string_without_separators() {
    let now: jiff::Timestamp = "2026-01-02T03:04:05.678Z".parse().expect("parse");
    assert_eq!(timestamp(now), "20260102T030405678Z");
    assert_eq!(
        timestamp(jiff::Timestamp::UNIX_EPOCH),
        "19700101T000000000Z"
    );
}

#[test]
fn the_private_log_is_0700_and_0600_with_a_random_suffix() {
    let temp = Temp::new("private");
    let now: jiff::Timestamp = "2026-01-02T03:04:05.678Z".parse().expect("parse");
    let first = private_log(&temp.0, now).expect("log");
    let second = private_log(&temp.0, now).expect("log");
    assert_ne!(first.dir, second.dir);
    let name = first
        .dir
        .file_name()
        .expect("name")
        .to_string_lossy()
        .into_owned();
    let suffix = name.strip_prefix(FOREIGN_LOG_PREFIX).expect("prefix");
    assert_eq!(suffix.len(), 6);
    assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
    assert_eq!(first.path, first.dir.join("fast-20260102T030405678Z.log"));
    let mode = |path: &Path| fs::metadata(path).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode(&first.dir), 0o700);
    assert_eq!(mode(&first.path), 0o600);
}

fn set_age(path: &Path, age_secs: u64) {
    let file = File::open(path).expect("open dir");
    file.set_modified(SystemTime::now() - Duration::from_secs(age_secs))
        .expect("mtime");
}

#[test]
fn prune_keeps_the_newest_twenty_own_directories() {
    let temp = Temp::new("prune");
    let uid = fs::metadata(&temp.0).expect("meta").uid();
    for n in 0..23u64 {
        let dir = temp.path(&format!("{FOREIGN_LOG_PREFIX}d{n:05}"));
        fs::create_dir(&dir).expect("dir");
        fs::write(dir.join("fast.log"), "x").expect("file");
        set_age(&dir, 1000 + n * 10); // d00000 is the newest
    }
    let stranger = temp.path("other-dir");
    fs::create_dir(&stranger).expect("other");
    set_age(&stranger, 99_999);
    let outside = temp.path("outside");
    fs::create_dir(&outside).expect("outside");
    fs::write(outside.join("keep"), "x").expect("keep");
    let link = temp.path(&format!("{FOREIGN_LOG_PREFIX}link"));
    std::os::unix::fs::symlink(&outside, &link).expect("symlink");
    let file = temp.path(&format!("{FOREIGN_LOG_PREFIX}file"));
    fs::write(&file, "x").expect("file");
    let skip = temp.path(&format!("{FOREIGN_LOG_PREFIX}skipped"));
    fs::create_dir(&skip).expect("skip");
    set_age(&skip, 500_000);

    prune_foreign_logs(&temp.0, 20, uid, &skip);

    let alive = |n: u64| temp.path(&format!("{FOREIGN_LOG_PREFIX}d{n:05}")).exists();
    assert!((0..20).all(alive), "the 20 newest stay");
    assert!((20..23).all(|n| !alive(n)), "the 3 oldest go");
    assert!(stranger.exists() && skip.exists() && file.exists());
    assert!(fs::symlink_metadata(&link).is_ok());
    assert!(outside.join("keep").exists(), "a symlink is not followed");
}

#[test]
fn prune_ignores_directories_of_other_owners() {
    let temp = Temp::new("prune-uid");
    let uid = fs::metadata(&temp.0).expect("meta").uid();
    for n in 0..3 {
        fs::create_dir(temp.path(&format!("{FOREIGN_LOG_PREFIX}{n}"))).expect("dir");
    }
    prune_foreign_logs(&temp.0, 0, uid.wrapping_add(1), &temp.path("none"));
    assert!((0..3).all(|n| temp.path(&format!("{FOREIGN_LOG_PREFIX}{n}")).exists()));
    prune_foreign_logs(&temp.0, 0, uid, &temp.path("none"));
    assert!((0..3).all(|n| !temp.path(&format!("{FOREIGN_LOG_PREFIX}{n}")).exists()));
}

// ---- prepare_foreign ----

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

fn init_repo(dir: &Path, config: &str) {
    fs::create_dir_all(dir).expect("repo dir");
    git(dir, &["init", "-q"]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "x"]);
    fs::write(dir.join("navori.config.json"), config).expect("config");
}

fn register(home: &Path, repo: &str) {
    let dir = home.join(".navori/workspaces/ws");
    fs::create_dir_all(&dir).expect("workspace dir");
    fs::write(
        dir.join("workspace.json"),
        format!("{{\"name\":\"ws\",\"repos\":[{{\"name\":\"repo\",\"path\":\"{repo}\"}}]}}"),
    )
    .expect("write workspace");
}

struct World {
    temp: Temp,
    env: Vec<(OsString, OsString)>,
}

impl World {
    fn new(label: &str) -> Self {
        let temp = Temp::new(label);
        fs::create_dir_all(temp.path("home")).expect("home");
        fs::create_dir_all(temp.path("tmp")).expect("tmp");
        let bin = temp.path("bin");
        stub(&bin, "npm", "echo ran npm $*");
        let mut env = stub_env(&bin);
        env.push(os("HOME", &temp.text("home")));
        env.push(os("TMPDIR", &temp.text("tmp")));
        env.push(os("GIT_CONFIG_GLOBAL", "/dev/null"));
        env.push(os("GIT_CONFIG_NOSYSTEM", "1"));
        Self { temp, env }
    }

    fn prepare(&self, cwd: &str) -> Prepared {
        prepare_foreign(
            &self.env,
            &self.temp.text(""),
            cwd,
            jiff::Timestamp::UNIX_EPOCH,
            &RealRunner,
        )
    }
}

const BASE: &str = r#""$schema":"https://ulisescm.github.io/navori-harness/schema/navori.config.v1.json","name":"x","version":"1.0.0","harnessVersion":"0.12.2","engines":["claude"],"preset":"custom","language":"es","branchBase":"main","gitignoreHarness":"off","commits":"conventional-es""#;

/// A schema-valid config with the given `qualityGate` body (none when empty).
fn config(quality: &str) -> String {
    if quality.is_empty() {
        format!("{{{BASE}}}")
    } else {
        format!("{{{BASE},\"qualityGate\":{{{quality}}}}}")
    }
}

const OK: &str = r#""fast":"npm run fast","full":"npm run full""#;

fn refusal(prepared: Prepared) -> String {
    match prepared {
        Prepared::Refuse { message, .. } => message,
        other => format!("not a refusal: {other:?}"),
    }
}

#[test]
fn an_unregistered_checkout_is_refused_before_its_config_is_read() {
    let world = World::new("unreg");
    init_repo(&world.temp.path("repo"), "{");
    let message = refusal(world.prepare("repo"));
    assert!(
        message.starts_with("navori gate foreign: refused — "),
        "{message}"
    );
    assert!(
        message.contains("is not registered in any navori workspace"),
        "{message}"
    );
    assert!(
        message.contains(&format!("--cwd {}' to opt in", world.temp.text("repo"))),
        "{message}"
    );
}

#[test]
fn an_unregistered_worktree_with_an_invalid_config_is_refused_as_unregistered() {
    let world = World::new("unreg-wt");
    let repo = world.temp.path("repo");
    init_repo(&repo, &config(OK));
    git(&repo, &["worktree", "add", "-q", "-b", "feat", "../wt"]);
    fs::write(world.temp.path("wt/navori.config.json"), "{").expect("config");
    let message = refusal(world.prepare("wt"));
    assert!(
        message.contains("is not registered in any navori workspace"),
        "{message}"
    );
}

#[test]
fn a_forged_commondir_is_refused_as_unregistered() {
    let world = World::new("forged");
    init_repo(&world.temp.path("repo"), &config(OK));
    register(&world.temp.path("home"), &world.temp.text("repo"));
    init_repo(&world.temp.path("evil"), "{");
    fs::write(
        world.temp.path("evil/.git/commondir"),
        format!("{}\n", world.temp.text("repo/.git")),
    )
    .expect("forge");
    let message = refusal(world.prepare("evil"));
    assert!(message.contains("is not registered"), "{message}");
}

#[test]
fn a_registered_checkout_with_an_invalid_config_delegates() {
    let world = World::new("invalid");
    init_repo(&world.temp.path("repo"), "{");
    register(&world.temp.path("home"), &world.temp.text("repo"));
    assert!(matches!(world.prepare("repo"), Prepared::Delegate(_)));
}

#[test]
fn a_directory_outside_git_is_refused_with_the_cwd_as_given() {
    let world = World::new("nogit");
    let message = refusal(world.prepare("home"));
    assert_eq!(
        message,
        "navori gate foreign: refused — --cwd is not a Git checkout: home"
    );
}

#[test]
fn the_refusals_follow_the_ts_order() {
    let world = World::new("order");
    let home = world.temp.path("home");
    let repo = world.temp.path("repo");
    register(&home, &world.temp.text("repo"));
    let cases = [
        (
            config(r#""fast":"  ","full":"x","nativeHooks":true"#),
            "qualityGate.fast is not set",
        ),
        (config(""), "qualityGate.fast is not set"),
        (
            config(r#""fast":"npm run fast","full":"ok","nativeHooks":true"#),
            "qualityGate.nativeHooks is true",
        ),
        (
            config(r#""fast":"make test","full":"ok","nativeHooks":false"#),
            "is not a plain command chain; run it by hand in the destination: make test",
        ),
    ];
    init_repo(&repo, "{}");
    for (config, expected) in cases {
        fs::write(repo.join("navori.config.json"), &config).expect("config");
        let message = refusal(world.prepare("repo"));
        assert!(message.contains(expected), "{config}: {message}");
    }
}

#[test]
fn a_registered_checkout_runs_its_chain_and_leaves_a_private_log() {
    let world = World::new("ready");
    init_repo(&world.temp.path("repo"), &config(OK));
    register(&world.temp.path("home"), &world.temp.text("repo"));
    let prepared = world.prepare("repo");
    let Prepared::Ready {
        warnings,
        gate,
        top,
        log,
    } = prepared
    else {
        panic!("not ready: {prepared:?}");
    };
    assert!(warnings.is_empty());
    assert_eq!(gate, "npm run fast");
    assert_eq!(top, world.temp.text("repo"));
    assert!(log.dir.starts_with(world.temp.path("tmp")));
    let verdict = run_foreign(&gate, &top, log, &world.env);
    assert_eq!(verdict.exit_code, 0);
    assert!(
        verdict
            .stdout
            .starts_with("navori gate foreign: exit 0 — log "),
        "{}",
        verdict.stdout
    );
    assert!(
        verdict.stdout.contains("ran npm run fast"),
        "{}",
        verdict.stdout
    );
}

#[test]
fn a_worktree_of_a_registered_repo_is_ready() {
    let world = World::new("ready-wt");
    let repo = world.temp.path("repo");
    init_repo(&repo, &config(OK));
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "config"]);
    git(&repo, &["worktree", "add", "-q", "-b", "feat", "../wt"]);
    register(&world.temp.path("home"), &world.temp.text("repo"));
    let prepared = world.prepare("wt");
    let Prepared::Ready { top, .. } = prepared else {
        panic!("not ready: {prepared:?}");
    };
    assert_eq!(top, world.temp.text("wt"));
}
