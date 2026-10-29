//! Delegation to the TS CLI (D3): pass-through, 69/70, resolution order and R7 by construction.
//! The "TS CLI" is a stub script, so nothing here depends on node or on a built `dist/`.

use std::collections::BTreeSet;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use navori_cli::delegate::{self, Locations, NoTs, VersionSource};
use navori_cli::parser::Invocation;
use navori_cli::{NATIVE, NativeCall, Outcome, dispatch};
use navori_core::manifest::Manifest;

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");

type TestResult = Result<(), Box<dyn Error>>;

/// A fresh scratch directory under cargo's per-target tmp dir.
fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn script(path: &Path, body: &str) -> Result<(), Box<dyn Error>> {
    fs::write(path, format!("#!/bin/sh\n{body}\n"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Stub TS CLI: records argv, cwd, pid, env and stdin into `$OUT`, then exits 42.
const RECORDER: &str = r#"{
  echo "argc:$#"
  for a in "$@"; do echo "arg:$a"; done
  echo "cwd:$(pwd -P)"
  echo "pid:$$"
  echo "delegated:$NAVORI_DELEGATED"
  echo "marker:$MARKER"
  echo "stdin:$(cat)"
} > "$OUT"
exit 42"#;

fn run_with_stdin(command: &mut Command, stdin: &str) -> Result<Output, Box<dyn Error>> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("no stdin pipe")?
        .write_all(stdin.as_bytes())?;
    Ok(child.wait_with_output()?)
}

fn line<'a>(record: &'a str, key: &str) -> Option<&'a str> {
    record
        .lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
}

fn manifest(json: &str) -> Result<Manifest, Box<dyn Error>> {
    Ok(Manifest::parse(json)?)
}

// Covers: R5
#[test]
fn argv_stdin_cwd_env_and_exit_code_pass_through() -> TestResult {
    let dir = scratch("passthrough")?;
    let ts = dir.join("ts.sh");
    script(&ts, RECORDER)?;
    let out_file = dir.join("record.txt");
    let cwd = dir.join("work");
    fs::create_dir(&cwd)?;

    let output = run_with_stdin(
        Command::new(BIN)
            .current_dir(&cwd)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("NAVORI_TS_CLI", &ts)
            .env("OUT", &out_file)
            .env("MARKER", "kept as is")
            .args(["render", "--engine=claude", "two words", "--no-color"]),
        "piped input\n",
    )?;

    assert_eq!(output.status.code(), Some(42));
    let record = fs::read_to_string(&out_file)?;
    assert_eq!(line(&record, "argc"), Some("4"));
    assert!(record.contains("arg:render\n"));
    assert!(record.contains("arg:--engine=claude\n"));
    assert!(record.contains("arg:two words\n"));
    assert!(record.contains("arg:--no-color\n"));
    assert_eq!(line(&record, "stdin"), Some("piped input"));
    assert_eq!(line(&record, "marker"), Some("kept as is"));
    assert_eq!(
        line(&record, "cwd").map(PathBuf::from),
        Some(cwd.canonicalize()?)
    );
    // `exec` keeps the pid, and the token is that pid.
    assert_eq!(line(&record, "delegated"), line(&record, "pid"));
    Ok(())
}

// Covers: R5
#[test]
fn a_js_target_runs_through_node_and_warns_once_on_version_mismatch() -> TestResult {
    let dir = scratch("node")?;
    let pkg = dir.join("pkg");
    fs::create_dir_all(pkg.join("dist"))?;
    fs::write(pkg.join("dist/index.js"), "// stub")?;
    fs::write(
        pkg.join("package.json"),
        r#"{"name":"navori","version":"9.9.9"}"#,
    )?;
    let bin = dir.join("bin");
    fs::create_dir(&bin)?;
    let out_file = dir.join("node-args.txt");
    script(&bin.join("node"), r#"printf '%s\n' "$@" > "$OUT"; exit 7"#)?;

    let output = Command::new(BIN)
        .env_clear()
        .env("PATH", &bin)
        .env("NAVORI_TS_CLI", pkg.join("dist/index.js"))
        .env("OUT", &out_file)
        .args(["status", "--json"])
        .output()?;

    assert_eq!(output.status.code(), Some(7));
    let node_args = fs::read_to_string(&out_file)?;
    assert_eq!(
        node_args,
        format!("{}\nstatus\n--json\n", pkg.join("dist/index.js").display())
    );
    let stderr = String::from_utf8(output.stderr)?;
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
    assert!(stderr.contains("9.9.9") && stderr.contains(navori_core::VERSION));
    assert!(stderr.contains(&pkg.join("dist/index.js").display().to_string()));
    Ok(())
}

// Covers: R6
#[test]
fn without_ts_it_exits_69_and_launches_no_process() -> TestResult {
    let dir = scratch("no-ts")?;
    let marker = dir.join("launched");
    let bin = dir.join("bin");
    fs::create_dir(&bin)?;
    // Anything launched would leave this marker behind: a `navori` in PATH is what resolution
    // would run if it ever fell through to it.
    script(
        &bin.join("navori"),
        &format!("/usr/bin/touch {}", marker.display()),
    )?;

    // Nothing resolvable at all.
    let nothing = Locations {
        ts_cli: Some(dir.join("missing.js").into_os_string()),
        checkout_dist: dir.join("no/dist/index.js"),
        path: Some(dir.join("empty").into_os_string()),
        self_exe: None,
    };
    let NoTs { message } = delegate::plan(&nothing, "render")
        .err()
        .ok_or("resolved?")?;
    assert!(message.contains("`render`"), "{message}");
    assert!(message.contains("NAVORI_TS_CLI="), "{message}");
    assert!(message.contains("no/dist/index.js"), "{message}");
    assert!(message.contains("navori in PATH"), "{message}");

    // A `.js` target but no `node` in PATH: the cause names the missing node.
    let js = dir.join("index.js");
    fs::write(&js, "// stub")?;
    let no_node = Locations {
        ts_cli: Some(js.clone().into_os_string()),
        path: Some(bin.clone().into_os_string()),
        ..nothing
    };
    let NoTs { message } = delegate::plan(&no_node, "sync").err().ok_or("resolved?")?;
    assert!(message.contains("`node` is not in PATH"), "{message}");
    assert!(message.contains("`sync`"), "{message}");

    // Same through the binary (whatever `dist/` the checkout has, there is no `node`): exit 69,
    // message on stderr.
    let output = Command::new(BIN)
        .env_clear()
        .env("PATH", dir.join("empty"))
        .env("NAVORI_TS_CLI", dir.join("missing.js"))
        .arg("nonexistent-subcommand")
        .output()?;
    assert_eq!(output.status.code(), Some(69));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr)?;
    assert!(stderr.contains("`nonexistent-subcommand`"), "{stderr}");
    assert!(stderr.contains("NAVORI_TS_CLI="), "{stderr}");
    assert!(!marker.exists(), "a process was launched");
    Ok(())
}

// Covers: R5, R6
#[test]
fn resolution_order_is_env_then_checkout_then_path_without_itself() -> TestResult {
    let dir = scratch("order")?;
    let bin = dir.join("bin");
    let other = dir.join("other");
    fs::create_dir_all(&bin)?;
    fs::create_dir_all(&other)?;
    let me = Path::new(BIN).canonicalize()?;
    // A `navori` that is this very binary (through a symlink) precedes the real one in PATH.
    symlink(&me, bin.join("navori"))?;
    script(&other.join("navori"), "echo 0.0.1")?;
    let path = std::env::join_paths([&bin, &other])?;

    let env_js = dir.join("env.js");
    let dist = dir.join("dist.js");
    fs::write(&env_js, "")?;
    fs::write(&dist, "")?;
    let mut locations = Locations {
        ts_cli: Some(env_js.clone().into_os_string()),
        checkout_dist: dist.clone(),
        path: Some(path.clone()),
        self_exe: Some(me),
    };
    // The node lookup needs a `node`.
    script(&other.join("node"), "exit 0")?;

    assert_eq!(
        delegate::plan(&locations, "x").ok().map(|p| p.target),
        Some(env_js)
    );
    locations.ts_cli = None;
    assert_eq!(
        delegate::plan(&locations, "x").ok().map(|p| p.target),
        Some(dist)
    );
    locations.checkout_dist = dir.join("absent.js");
    let plan = delegate::plan(&locations, "x").ok().ok_or("no plan")?;
    assert_eq!(plan.target, other.join("navori"));
    assert_eq!(plan.version, VersionSource::Probe(other.join("navori")));
    assert_eq!(
        delegate::version_notice(&plan, navori_core::VERSION).map(|n| n.contains("0.0.1")),
        Some(true)
    );

    // Only itself in PATH: nothing to delegate to.
    locations.path = Some(bin.into_os_string());
    let NoTs { message } = delegate::plan(&locations, "x").err().ok_or("resolved?")?;
    assert!(message.contains("excluded"), "{message}");
    Ok(())
}

// Covers: R7
#[test]
fn the_loop_exits_70_only_for_its_own_pid() -> TestResult {
    assert!(delegate::is_loop(Some(std::ffi::OsStr::new("123")), 123));
    assert!(!delegate::is_loop(Some(std::ffi::OsStr::new("124")), 123));
    assert!(!delegate::is_loop(Some(std::ffi::OsStr::new("abc")), 123));
    assert!(!delegate::is_loop(None, 123));

    let dir = scratch("loop")?;
    // A "TS CLI" that `exec`s navori-rust again: same pid, so the token is its own pid.
    let again = dir.join("again.sh");
    script(&again, &format!("exec {BIN:?} \"$@\""))?;
    let output = Command::new(BIN)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("NAVORI_TS_CLI", &again)
        .arg("render")
        .output()?;
    assert_eq!(output.status.code(), Some(70));
    assert!(String::from_utf8(output.stderr)?.contains("delegation loop"));

    // A legitimate descendant (runs navori-rust as a child, so another pid) is delegated.
    let out_file = dir.join("record.txt");
    let recorder = dir.join("recorder.sh");
    script(&recorder, RECORDER)?;
    let child = dir.join("child.sh");
    script(
        &child,
        &format!("NAVORI_TS_CLI={recorder:?} {BIN:?} \"$@\"; exit $?"),
    )?;
    let output = Command::new(BIN)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("OUT", &out_file)
        .env("NAVORI_TS_CLI", &child)
        .arg("render")
        .output()?;
    assert_eq!(output.status.code(), Some(42));
    let record = fs::read_to_string(&out_file)?;
    assert_eq!(line(&record, "delegated"), line(&record, "pid"));
    Ok(())
}

fn invocation(path: &[&str], flags: &[&str]) -> Invocation {
    Invocation {
        path: path.iter().map(|p| (*p).to_owned()).collect(),
        flags: flags
            .iter()
            .map(|f| (*f).to_owned())
            .collect::<BTreeSet<_>>(),
    }
}

// Covers: R7
#[test]
fn every_implementation_without_a_manifest_entry_is_delegated() -> TestResult {
    let embedded = Manifest::embedded()?;
    let empty = manifest(r#"{"schema":2,"commands":[]}"#)?;
    assert!(!NATIVE.is_empty());
    for native in NATIVE {
        let own = embedded.commands.iter().find(|c| {
            native
                .path
                .iter()
                .copied()
                .eq(c.path.iter().map(String::as_str))
        });
        let listed = own.is_some();
        // An entry with `requires` selects only invocations carrying one of its flag sets.
        let required: Vec<&str> = own
            .and_then(|c| c.requires.as_ref())
            .and_then(|alternatives| alternatives.first())
            .map(|flags| flags.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let inv = invocation(native.path, &required);
        // Listed: native. Unlisted (an implementation still in progress): delegated.
        assert_eq!(
            dispatch(&embedded, &inv).is_some(),
            listed,
            "{:?}",
            native.path
        );
        assert!(dispatch(&empty, &inv).is_none(), "{:?}", native.path);
        let others: Vec<String> = embedded
            .commands
            .iter()
            .filter(|c| c.path != native.path)
            .map(|c| format!(r#"{{"path":{:?}}}"#, c.path))
            .collect();
        let without = manifest(&format!(
            r#"{{"schema":2,"commands":[{}]}}"#,
            others.join(",")
        ))?;
        // An ancestor entry may still select it by prefix (`spec` for `spec check`): the
        // ancestor's implementation must then hand it to the TS before any output.
        if let Some((ancestor, entry)) = dispatch(&without, &inv) {
            assert!(
                ancestor.path.len() < native.path.len() && native.path.starts_with(ancestor.path),
                "{:?} selected by {:?}",
                native.path,
                ancestor.path
            );
            let argv: Vec<OsString> = native.path.iter().map(OsString::from).collect();
            let call = NativeCall { args: &argv, entry };
            assert_eq!(
                (ancestor.run)(&call),
                Outcome::Delegate,
                "{:?}",
                native.path
            );
        }
    }
    // Every manifest entry has an implementation, otherwise it would silently delegate.
    for entry in &embedded.commands {
        assert!(
            NATIVE.iter().any(|n| n
                .path
                .iter()
                .copied()
                .eq(entry.path.iter().map(String::as_str))),
            "manifest entry {:?} has no native implementation",
            entry.path
        );
    }
    // A listed command with a flag outside its list is delegated.
    assert!(dispatch(&embedded, &invocation(&["--version"], &["json"])).is_none());
    assert!(dispatch(&embedded, &invocation(&["render"], &[])).is_none());
    Ok(())
}

// Covers: R7
#[test]
fn unlisted_commands_reach_the_ts_cli_not_a_native_stub() -> TestResult {
    let dir = scratch("unlisted")?;
    let ts = dir.join("ts.sh");
    script(&ts, "exit 5")?;
    let output = Command::new(BIN)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("NAVORI_TS_CLI", &ts)
        .args(["--version", "extra"])
        .output()?;
    assert_eq!(output.status.code(), Some(5));
    Ok(())
}
