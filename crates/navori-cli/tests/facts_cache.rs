//! Host-fact cache (spec 0057 R17): replay only for an unchanged, private, fresh entry.
use navori_cli::facts_cache::{FactsCache, MAX_AGE_MS, key, lookup, now_ms, stamp};
use navori_cli::hook_facts::collect_cached;
use navori_hooks::hooks::subagent_no_background;
use navori_hooks::hooks::subagent_no_background::prepare::{Facts, Limits, Output, Request};
use navori_hooks::runner::Engine;
use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "facts-cache-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".navori/state"))?;
        Ok(Self(fs::canonicalize(root)?))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn output(stdout: &[u8]) -> Output {
    Output {
        code: Some(0),
        stdout: stdout.to_vec(),
        stderr: Vec::new(),
    }
}

fn facts() -> Facts {
    Facts {
        bootstrap: output(b"5.2\0jq\x001\0\0"),
        system: output(b"Darwin\n"),
        charmap: output(b"UTF-8\n"),
        text: output(&[0, 0xff, b'\n']),
        jq: None,
        node: Some(Output {
            code: None,
            stdout: Vec::new(),
            stderr: b"killed".to_vec(),
        }),
    }
}

fn tools() -> BTreeMap<String, Option<String>> {
    BTreeMap::from([
        ("jq".to_owned(), None),
        ("sed".to_owned(), Some("1:2:3:4.5:6.7".to_owned())),
    ])
}

fn entry(temp: &Temp, key: &str) -> PathBuf {
    temp.0.join(format!(".navori/state/rust-facts/{key}.json"))
}

// Covers: R17
#[test]
fn entries_round_trip_only_while_fresh_and_for_their_own_key() -> TestResult {
    let temp = Temp::new()?;
    let cache = FactsCache::in_project(&temp.0);
    let now = now_ms().ok_or("clock")?;
    cache.store("k1", &facts(), &tools(), now);
    let cached = cache
        .load("k1", now)
        .ok_or("fresh entry was not replayed")?;
    assert_eq!(cached.tools, tools());
    assert_eq!(cached.facts.bootstrap.stdout, facts().bootstrap.stdout);
    assert_eq!(cached.facts.text.stdout, vec![0, 0xff, b'\n']);
    assert!(cached.facts.jq.is_none());
    let node = cached.facts.node.ok_or("node")?;
    assert_eq!((node.code, node.stderr), (None, b"killed".to_vec()));
    let dir = temp.0.join(".navori/state/rust-facts");
    assert_eq!(fs::metadata(&dir)?.permissions().mode() & 0o777, 0o700);
    assert_eq!(
        fs::metadata(entry(&temp, "k1"))?.permissions().mode() & 0o777,
        0o600
    );
    assert!(cache.load("k1", now + MAX_AGE_MS + 1).is_none(), "expired");
    assert!(cache.load("k1", now - 1).is_none(), "written in the future");
    // A file renamed onto another key keeps its own key inside and is refused.
    fs::copy(entry(&temp, "k1"), entry(&temp, "k2"))?;
    fs::set_permissions(entry(&temp, "k2"), fs::Permissions::from_mode(0o600))?;
    assert!(cache.load("k2", now).is_none());
    assert_eq!(
        fs::read_dir(&dir)?.count(),
        2,
        "no temporary file is left behind"
    );
    Ok(())
}

// Covers: R17
#[test]
fn tampered_or_unsafe_locations_are_misses_and_never_written() -> TestResult {
    let now = now_ms().ok_or("clock")?;
    let temp = Temp::new()?;
    let cache = FactsCache::in_project(&temp.0);
    cache.store("k", &facts(), &tools(), now);
    let path = entry(&temp, "k");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o620))?;
    assert!(cache.load("k", now).is_none(), "group-writable entry");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    fs::write(&path, "{not json")?;
    assert!(cache.load("k", now).is_none(), "corrupt entry");
    fs::remove_file(&path)?;
    fs::write(temp.0.join("elsewhere.json"), "{}")?;
    symlink(temp.0.join("elsewhere.json"), &path)?;
    assert!(cache.load("k", now).is_none(), "symlinked entry");

    // A symlinked cache directory is neither read nor written through.
    let other = Temp::new()?;
    let elsewhere = other.0.join("target");
    fs::create_dir(&elsewhere)?;
    symlink(&elsewhere, other.0.join(".navori/state/rust-facts"))?;
    let redirected = FactsCache::in_project(&other.0);
    redirected.store("k", &facts(), &tools(), now);
    assert_eq!(fs::read_dir(&elsewhere)?.count(), 0);
    assert!(redirected.load("k", now).is_none());
    Ok(())
}

// Covers: R17
#[test]
fn the_key_tracks_bash_path_and_locale_and_refuses_relative_path() -> TestResult {
    let bash = lookup(&std::env::var_os("PATH").ok_or("PATH")?, "bash").ok_or("bash")?;
    let bash = bash.canonicalize()?;
    let env = |path: &str, locale: &str| -> Vec<(OsString, OsString)> {
        vec![
            ("PATH".into(), path.into()),
            ("LC_ALL".into(), locale.into()),
            ("SESSION".into(), "volatile".into()),
        ]
    };
    let base = key(&bash, &env("/usr/bin:/bin", "C")).ok_or("key")?;
    assert_eq!(key(&bash, &env("/usr/bin:/bin", "C")), Some(base.clone()));
    assert_ne!(key(&bash, &env("/bin:/usr/bin", "C")), Some(base.clone()));
    assert_ne!(
        key(&bash, &env("/usr/bin:/bin", "en_US.UTF-8")),
        Some(base.clone())
    );
    let mut volatile = env("/usr/bin:/bin", "C");
    volatile[2].1 = "changed".into();
    assert_eq!(key(&bash, &volatile), Some(base));
    assert_eq!(key(&bash, &env("bin:/usr/bin", "C")), None);
    assert!(stamp(&bash).is_some());
    Ok(())
}

fn host_env() -> Result<Vec<(OsString, OsString)>, Box<dyn Error>> {
    Ok(vec![
        ("PATH".into(), std::env::var_os("PATH").ok_or("PATH")?),
        ("LC_ALL".into(), "C".into()),
    ])
}

fn expanded_asset() -> Result<String, Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/core-assets/hooks");
    let mut expanded = String::new();
    for line in fs::read_to_string(root.join("subagent-no-background.sh"))?.lines() {
        if let Some(name) = line.strip_prefix("# navori:include ") {
            expanded.push_str(&fs::read_to_string(
                root.join("_partials").join(format!("{name}.sh")),
            )?);
        } else {
            expanded.push_str(line);
        }
        expanded.push('\n');
    }
    Ok(expanded)
}

fn request<'a>(script: &'a Path, source: &'a str, env: &'a [(OsString, OsString)]) -> Request<'a> {
    Request {
        engine: Engine::Claude,
        engines: &[Engine::Claude, Engine::Pi],
        event: Some("PreToolUse"),
        args: &[],
        script,
        source: source.as_bytes(),
        env,
    }
}

// Covers: R11, R17
#[test]
fn a_cached_eligible_host_skips_every_probe_until_a_tool_changes() -> TestResult {
    let temp = Temp::new()?;
    let cache = FactsCache::in_project(&temp.0);
    let source = expanded_asset()?;
    let script = temp.0.join("hook.sh");
    // An empty directory first in PATH: same key throughout, so only tool resolution can change.
    let shadowing = temp.0.join("bin");
    fs::create_dir(&shadowing)?;
    let mut env = host_env()?;
    let mut path = OsString::from(shadowing.as_os_str());
    path.push(":");
    path.push(&env[0].1);
    env[0].1 = path;
    let request = |env| request(&script, &source, env);
    let probed = collect_cached(request(&env), &temp.0, Limits::default(), Some(&cache))?;
    // One millisecond cannot fit a single probe: success means the facts were replayed.
    let tight = Limits {
        total: Duration::from_millis(1),
    };
    let replayed = collect_cached(request(&env), &temp.0, tight, Some(&cache))?;
    for payload in [
        br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"sleep 1 &"}}"#.as_slice(),
        br#"{"agent_id":"x","tool_name":"Bash","tool_input":{"command":"ls"}}"#.as_slice(),
    ] {
        assert_eq!(
            subagent_no_background::evaluate_prepared(&probed, payload)?,
            subagent_no_background::evaluate_prepared(&replayed, payload)?
        );
    }
    assert!(collect_cached(request(&env), &temp.0, tight, None).is_err());

    // A new `cat` earlier in PATH is a different host under the same key: miss, so probes run.
    let cat = lookup(&std::env::var_os("PATH").ok_or("PATH")?, "cat").ok_or("cat")?;
    fs::copy(&cat, shadowing.join("cat"))?;
    assert!(collect_cached(request(&env), &temp.0, tight, Some(&cache)).is_err());
    fs::remove_file(shadowing.join("cat"))?;
    assert!(collect_cached(request(&env), &temp.0, tight, Some(&cache)).is_ok());
    Ok(())
}

/// A fake `navori` that appends one line to `$COUNT` per run and prints `version` (exit `code`).
fn fake_navori(dir: &Path, version: &str, code: i32) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(dir)?;
    let path = dir.join("navori");
    fs::write(
        &path,
        format!("#!/bin/sh\necho run >> \"$COUNT\"\necho '{version}'\nexit {code}\n"),
    )?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn runs(count: &Path) -> usize {
    fs::read_to_string(count).map_or(0, |text| text.lines().count())
}

// Covers: R53
#[test]
fn la_version_del_navori_de_path_se_sondea_una_vez_por_binario() -> TestResult {
    use navori_cli::hook_facts::navori_cli;
    let temp = Temp::new()?;
    let cache = FactsCache::in_project(&temp.0);
    let bin = temp.0.join("bin");
    let count = temp.0.join("count");
    let env = |path: &Path| -> Vec<(OsString, OsString)> {
        vec![
            ("PATH".into(), path.as_os_str().to_owned()),
            ("COUNT".into(), count.as_os_str().to_owned()),
        ]
    };
    fake_navori(&bin, navori_core::STAMP_VERSION, 0)?;
    let first = navori_cli(&env(&bin), &temp.0, Some(&cache))?;
    assert_eq!(first.path, Some(bin.join("navori")));
    assert_eq!(first.version.as_deref(), Some(navori_core::STAMP_VERSION));
    assert!(first.in_process());
    assert_eq!(navori_cli(&env(&bin), &temp.0, Some(&cache))?, first);
    assert_eq!(runs(&count), 1, "the second call replays the cached probe");

    // Another binary at the same path (new stamp) is probed again, and another version leaves
    // the subcommand to that navori.
    fake_navori(&bin, "0.0.1-other", 0)?;
    let other = navori_cli(&env(&bin), &temp.0, Some(&cache))?;
    assert_eq!(other.version.as_deref(), Some("0.0.1-other"));
    assert!(!other.in_process());
    assert_eq!(runs(&count), 2);

    // A failing probe has no version (never in process), and is cached like any answer.
    fake_navori(&bin, navori_core::STAMP_VERSION, 1)?;
    let failed = navori_cli(&env(&bin), &temp.0, Some(&cache))?;
    assert_eq!(failed.version, None);
    assert!(!failed.in_process());
    assert_eq!(navori_cli(&env(&bin), &temp.0, Some(&cache))?, failed);
    assert_eq!(runs(&count), 3);

    // No navori on PATH: the shell's "not installed" branch, nothing probed.
    let empty = temp.0.join("empty");
    fs::create_dir_all(&empty)?;
    let absent = navori_cli(&env(&empty), &temp.0, Some(&cache))?;
    assert_eq!(absent.path, None);
    assert!(!absent.in_process());
    assert_eq!(runs(&count), 3);

    // A relative PATH entry depends on the working directory: probed every time, never cached.
    fake_navori(&bin, navori_core::STAMP_VERSION, 0)?;
    for _ in 0..2 {
        assert!(navori_cli(&env(Path::new("bin")), &temp.0, Some(&cache))?.in_process());
    }
    assert_eq!(runs(&count), 5);
    Ok(())
}
