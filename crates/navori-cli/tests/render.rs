//! Native `render` (spec 0058 E3 M6): what runs natively and what is handed to the TS (R39).
//! `ENTRY` is the entry `crates/ported.json` lists (T17).

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use navori_cli::render::{RenderArgs, admit, colorless, parse_args, registry_needs_refresh};
use navori_cli::{dispatch, parser};
use navori_core::manifest::{Command, Manifest};

type TestResult = Result<(), Box<dyn Error>>;

const ENTRY: &str = r#"{"schema":2,"commands":[
    {"path":["render"],"flags":["cwd","dry-run","json","apply","force"],"when":{"engines":["claude","agents-md","cursor","copilot","codex","pi"]}}
]}"#;

fn manifest() -> Result<Manifest, Box<dyn Error>> {
    Ok(Manifest::parse(ENTRY)?)
}

fn entry(manifest: &Manifest) -> Result<&Command, Box<dyn Error>> {
    manifest.commands.first().ok_or_else(|| "no entry".into())
}

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

/// A fresh scratch directory under cargo's per-target tmp dir.
fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("render-{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

// Covers: R39
#[test]
fn only_the_declared_flags_in_their_plain_form_are_native() -> TestResult {
    let m = manifest()?;
    let e = entry(&m)?;
    let base = Path::new("/repo/sub");
    let parsed = |args: &[&str]| parse_args(&argv(args), e, base);
    assert_eq!(
        parsed(&["render"]),
        Some(RenderArgs {
            cwd: base.to_path_buf(),
            dry_run: false,
            json: false,
            apply: false,
            force: false,
        })
    );
    assert_eq!(
        parsed(&["render", "--cwd", "../other/./x", "--dry-run", "--json"]),
        Some(RenderArgs {
            cwd: PathBuf::from("/repo/other/x"),
            dry_run: true,
            json: true,
            apply: false,
            force: false,
        })
    );
    // `--apply` writes; `--dry-run` wins over it, as in the TS.
    let apply = parsed(&["render", "--apply"]).ok_or("apply")?;
    assert!(apply.apply && !apply.preview());
    let both = parsed(&["render", "--apply", "--dry-run"]).ok_or("both")?;
    assert!(both.preview());
    assert!(parsed(&["render"]).ok_or("plain")?.preview());
    let forced = parsed(&["render", "--force", "--apply"]).ok_or("force")?;
    assert!(forced.force && !forced.preview());
    assert_eq!(
        parsed(&["render", "--cwd=/abs"]).map(|a| a.cwd),
        Some(PathBuf::from("/abs"))
    );
    for args in [
        &["render", "--apply=yes"][..],
        &["render", "--apply", "--apply"],
        &["render", "--force=1"],
        &["render", "--all"],
        &["render", "--prune"],
        &["render", "--verbose"],
        &["render", "--workspace", "web"],
        &["render", "--no-json"],
        &["render", "--json=true"],
        &["render", "--json", "--json"],
        &["render", "--cwd", "a", "--cwd", "b"],
        &["render", "--cwd"],
        &["render", "--cwd", ""],
        &["render", "--cwd", "--json"],
        &["render", "-j"],
        &["render", "extra"],
        &["render", "--", "--json"],
        &["sync"],
        &[],
    ] {
        assert_eq!(parsed(args), None, "{args:?}");
    }
    // A flag the entry does not declare is delegated even if the command knows it.
    let narrow =
        Manifest::parse(r#"{"schema":2,"commands":[{"path":["render"],"flags":["cwd"]}]}"#)?;
    assert_eq!(
        parse_args(&argv(&["render", "--json"]), entry(&narrow)?, base),
        None
    );
    Ok(())
}

// Covers: R39
#[test]
fn the_config_decides_before_any_output() -> TestResult {
    let m = manifest()?;
    let e = entry(&m)?;
    let dir = scratch("admit")?;
    let args = || RenderArgs {
        cwd: dir.clone(),
        dry_run: false,
        json: false,
        apply: false,
        force: false,
    };
    // No config, or one readConfig rejects: the TS reports it.
    assert!(admit(args(), e).is_none());
    let write = |body: &str| fs::write(dir.join("navori.config.json"), body);
    for (body, native) in [
        // `engines` is required and non-empty in the schema.
        (r#"{"name":"demo","preset":"custom"}"#, false),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"]}"#,
            true,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude","codex"]}"#,
            true,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["pi"]}"#,
            true,
        ),
        // Spec 0059 T19, T20: every engine, alone or beside Claude.
        (
            r#"{"name":"demo","preset":"custom","engines":["agents-md","cursor","copilot"]}"#,
            true,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude","agents-md"]}"#,
            true,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["agents-md","codex"]}"#,
            true,
        ),
        (r#"{"name":"demo","preset":"custom","engines":[]}"#, false),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"],"monorepo":{"enabled":true,"workspaces":[{"name":"web","path":"apps/web"}]}}"#,
            false,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"],"monorepo":{"enabled":false,"workspaces":[{"name":"web","path":"apps/web"}]}}"#,
            true,
        ),
        ("{not json", false),
        (
            r#"{"name":"demo","preset":"custom","engines":"claude"}"#,
            false,
        ),
    ] {
        write(body)?;
        assert_eq!(admit(args(), e).is_some(), native, "{body}");
    }
    let missing = RenderArgs {
        cwd: dir.join("missing"),
        dry_run: false,
        json: false,
        apply: false,
        force: false,
    };
    assert!(admit(missing, e).is_none());
    Ok(())
}

// Covers: R7, R39
#[test]
fn render_is_dispatched_only_when_an_entry_lists_it() -> TestResult {
    let m = manifest()?;
    let inv = parser::parse(&argv(&["render", "--json"]));
    assert!(dispatch(&m, &inv).is_some());
    let embedded = Manifest::embedded()?;
    let (_, selected) = dispatch(&embedded, &inv).ok_or("embedded manifest lacks render")?;
    assert_eq!(selected, entry(&m)?);
    let prune = parser::parse(&argv(&["render", "--prune"]));
    assert!(dispatch(&m, &prune).is_none());
    assert!(dispatch(&embedded, &prune).is_none());
    Ok(())
}

// Covers: R39
#[test]
fn only_a_colorless_human_report_is_native() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    };
    // A pipe without color variables: picocolors and styleText are both off.
    assert!(colorless(env(&[]), false));
    assert!(colorless(env(&[("NO_COLOR", "1")]), false));
    assert!(colorless(env(&[("CI", "")]), false));
    assert!(colorless(env(&[("CI", "1"), ("NO_COLOR", "1")]), false));
    // A terminal, FORCE_COLOR (any value) or a non-empty CI color the TS report.
    assert!(!colorless(env(&[]), true));
    assert!(!colorless(env(&[("NO_COLOR", "1")]), true));
    assert!(!colorless(env(&[("FORCE_COLOR", "0")]), false));
    assert!(!colorless(
        env(&[("FORCE_COLOR", ""), ("NO_COLOR", "1")]),
        false
    ));
    assert!(!colorless(env(&[("CI", "true")]), false));
    assert!(!colorless(env(&[("CI", "true"), ("NO_COLOR", "")]), false));
}

/// Relative path \u{2192} (mode, mtime in ns, content).
type Tree = BTreeMap<PathBuf, (u32, i64, Vec<u8>)>;

/// Every file and directory under `root`.
fn snapshot(root: &Path) -> Result<Tree, Box<dyn Error>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            let content = if meta.is_file() {
                fs::read(&path)?
            } else {
                Vec::new()
            };
            if meta.is_dir() {
                stack.push(path.clone());
            }
            out.insert(
                path.strip_prefix(root)?.to_path_buf(),
                (
                    meta.mode(),
                    meta.mtime_nsec() + meta.mtime() * 1_000_000_000,
                    content,
                ),
            );
        }
    }
    Ok(out)
}

/// The preview runs natively (the TS CLI does not exist, so a delegation would fail) and leaves
/// the repo, the home (`~/.navori`) and `NAVORI_BACKUP_ROOT` exactly as they were.
// Covers: R40
#[test]
fn render_without_apply_performs_no_real_operation() -> TestResult {
    let dir = scratch("preview")?;
    let repo = dir.join("repo");
    let home = dir.join("home");
    let backups = dir.join("backups");
    for path in [&repo, &home.join(".navori"), &backups] {
        fs::create_dir_all(path)?;
    }
    fs::write(
        repo.join("navori.config.json"),
        r#"{"name":"demo","preset":"custom","engines":["claude"],"language":"en","gitignoreHarness":"full","unknownKey":1}"#,
    )?;
    fs::write(
        repo.join("package.json"),
        r#"{"scripts":{"fmt":"prettier --write ."}}"#,
    )?;
    fs::write(repo.join(".gitignore"), "node_modules/\n")?;
    fs::write(
        home.join(".navori/registry.json"),
        r#"{"repos":[{"path":"/elsewhere","name":"old"}]}"#,
    )?;
    let before = [snapshot(&repo)?, snapshot(&home)?, snapshot(&backups)?];
    let run = |args: &[&str]| {
        Process::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(args)
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("NAVORI_BACKUP_ROOT", &backups)
            .env("NAVORI_TS_CLI", dir.join("missing/index.js"))
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .output()
    };
    for args in [
        &["render"][..],
        &["render", "--dry-run"],
        &["render", "--json"],
        &["render", "--apply", "--dry-run"],
    ] {
        let out = run(args)?;
        let stdout = String::from_utf8(out.stdout)?;
        assert_eq!(out.status.code(), Some(0), "{args:?}: {stdout}");
        assert!(stdout.contains("(embedded)"), "{args:?}: {stdout}");
        assert!(stdout.contains(".prettierignore"), "{args:?}: {stdout}");
        // `readConfig` runs twice in the TS command, and warns on each read.
        let stderr = String::from_utf8(out.stderr)?;
        assert_eq!(stderr.matches("unknownKey").count(), 2, "{stderr}");
    }
    let after = [snapshot(&repo)?, snapshot(&home)?, snapshot(&backups)?];
    assert_eq!(before, after);

    // With the registry name in step, the apply is native and writes the repo and its backups
    // only.
    let canonical = fs::canonicalize(&repo)?;
    let registry = |name: &str| {
        fs::write(
            home.join(".navori/registry.json"),
            format!(r#"{{"repos":[{{"path":{canonical:?},"name":"{name}"}}]}}"#),
        )
    };
    registry("demo")?;
    let home_before = snapshot(&home)?;
    let out = run(&["render", "--apply"])?;
    let stdout = String::from_utf8(out.stdout)?;
    assert_eq!(out.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("core: (embedded)"), "{stdout}");
    assert!(stdout.contains("Done"), "{stdout}");
    assert!(repo.join("CLAUDE.md").is_file());
    assert!(
        !snapshot(&backups)?.is_empty(),
        "the hand-written .gitignore is backed up"
    );
    assert_eq!(home_before, snapshot(&home)?);

    // Under another name `refreshRepoName` would rewrite the registry: the apply goes to the TS
    // (this checkout's `dist`, when built), never native.
    registry("old")?;
    let out = run(&["render", "--apply"])?;
    assert!(!String::from_utf8(out.stdout)?.contains("core: (embedded)"));
    Ok(())
}

/// With `claude` among the engines, `render`, `sync --dry-run` and `remove` stay native: the
/// decoy TS CLI (exit 97, writes a marker) never runs.
#[test]
fn claude_commands_never_hand_the_run_to_the_ts() -> TestResult {
    let dir = scratch("claude-native")?;
    let decoy = dir.join("decoy.sh");
    fs::write(&decoy, "#!/bin/sh\necho hit > \"$MARKER\"\nexit 97\n")?;
    fs::set_permissions(&decoy, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    for (label, args) in [
        ("render", &["render"][..]),
        ("sync", &["sync", "--dry-run"]),
        ("remove", &["remove", "tgrep", "--yes"]),
    ] {
        let case = dir.join(label);
        let repo = case.join("repo");
        let home = case.join("home");
        let backups = case.join("backups");
        let marker = case.join("marker");
        for path in [&repo, &home.join(".navori"), &backups] {
            fs::create_dir_all(path)?;
        }
        fs::write(
            repo.join("navori.config.json"),
            r#"{"name":"demo","preset":"custom","engines":["claude"],"language":"en","plugins":{"tgrep":{"enabled":true}}}"#,
        )?;
        let canonical = fs::canonicalize(&repo)?;
        fs::write(
            home.join(".navori/registry.json"),
            format!(r#"{{"repos":[{{"path":{canonical:?},"name":"demo"}}]}}"#),
        )?;
        let out = Process::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(args)
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("NAVORI_BACKUP_ROOT", &backups)
            .env("NAVORI_TS_CLI", &decoy)
            .env("MARKER", &marker)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .output()?;
        let stdout = String::from_utf8(out.stdout)?;
        assert_eq!(out.status.code(), Some(0), "{label}: {stdout}");
        assert!(!marker.exists(), "{label} handed the run to the TS");
    }
    Ok(())
}

/// `refreshRepoName`'s pre-check: only an entry for this very repo under another name rewrites
/// the registry; an absent, foreign or malformed registry never does.
// Covers: R47
#[test]
fn only_a_stale_name_in_the_registry_needs_a_refresh() -> TestResult {
    let dir = scratch("registry")?;
    let repo = dir.join("repo");
    let home = dir.join("home");
    fs::create_dir_all(&repo)?;
    fs::create_dir_all(home.join(".navori"))?;
    let path = fs::canonicalize(&repo)?;
    let needs = |body: Option<String>| -> Result<bool, Box<dyn Error>> {
        let file = home.join(".navori/registry.json");
        match body {
            Some(text) => fs::write(&file, text)?,
            None => {
                let _ = fs::remove_file(&file);
            }
        }
        Ok(registry_needs_refresh(&home, &repo, Some("demo")))
    };
    let entry = |name: &str| format!(r#"{{"repos":[{{"path":{path:?}{name}}}]}}"#);
    assert!(!needs(None)?);
    assert!(!needs(Some(entry(r#","name":"demo""#)))?);
    assert!(needs(Some(entry(r#","name":"old""#)))?);
    assert!(needs(Some(entry("")))?);
    assert!(!needs(Some(
        r#"{"repos":[{"path":"/elsewhere","name":"old"}]}"#.to_owned()
    ))?);
    // `RegistrySchema` rejects the whole file, which then reads as empty.
    assert!(!needs(Some(entry(r#","name":null"#)))?);
    assert!(!needs(Some("not json".to_owned()))?);
    assert!(!needs(Some(r#"{"repos":{}}"#.to_owned()))?);
    Ok(())
}

/// A skill trigger cut at `TRIGGER_MAX - 1` UTF-16 units lands inside a surrogate pair. The prose
/// engines write U+FFFD there, so the second `render --apply` finds every file as it left it: no
/// write, no backup, an up-to-date summary. The TS reports the same files as `updated` on every
/// render (#1750, a known difference of the oracle with Rust as the correct side).
#[test]
fn a_trigger_cut_inside_a_surrogate_pair_renders_unchanged_the_second_time() -> TestResult {
    let dir = scratch("surrogate-cut")?;
    let repo = dir.join("repo");
    let home = dir.join("home");
    let backups = dir.join("backups");
    let skills = repo.join(".navori/presets/emoji/skills");
    for path in [&skills, &home.join(".navori"), &backups] {
        fs::create_dir_all(path)?;
    }
    fs::write(
        repo.join("navori.config.json"),
        r#"{"name":"demo","preset":"emoji","engines":["agents-md","cursor","copilot"],"language":"en","gitignoreHarness":"full"}"#,
    )?;
    fs::write(
        repo.join(".navori/presets/emoji/emoji.json"),
        r#"{"id":"emoji","displayName":"Emoji","extends":"core","extras":{"managed":[],"agents":[],"skills":[{"id":"emoji-skill","relPath":"skills/emoji-skill.md","destRelPath":".claude/skills/emoji-skill/SKILL.md"}],"hooks":[]}}"#,
    )?;
    let lead = "a".repeat(118);
    fs::write(
        skills.join("emoji-skill.md"),
        format!("---\nname: emoji-skill\ndescription: {lead}\u{1F600}\u{1F600}\n---\n\nBody.\n"),
    )?;
    let run = || {
        Process::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(["render", "--apply"])
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("NAVORI_BACKUP_ROOT", &backups)
            .env("NAVORI_TS_CLI", dir.join("missing/index.js"))
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .output()
    };
    let first = run()?;
    let stdout = String::from_utf8(first.stdout)?;
    assert_eq!(first.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("core: (embedded)"), "{stdout}");
    let agents = fs::read_to_string(repo.join("AGENTS.md"))?;
    assert!(
        agents.contains(&format!("· {lead}\u{FFFD}\u{2026}")),
        "{agents}"
    );

    let before = [snapshot(&repo)?, snapshot(&backups)?];
    let second = run()?;
    let stdout = String::from_utf8(second.stdout)?;
    assert_eq!(second.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("core: (embedded)"), "{stdout}");
    assert!(!stdout.contains("(updated)"), "{stdout}");
    assert!(!stdout.contains("Backup:"), "{stdout}");
    assert_eq!(before, [snapshot(&repo)?, snapshot(&backups)?]);
    Ok(())
}

/// A rendered `claude` repo (with `tgrep`, so `.claude/hooks` has files) next to a home whose
/// registry is in step and a decoy TS CLI that records any invocation in `marker`.
struct Fixture {
    repo: PathBuf,
    home: PathBuf,
    backups: PathBuf,
    decoy: PathBuf,
    marker: PathBuf,
}

impl Fixture {
    fn rendered(name: &str) -> Result<Self, Box<dyn Error>> {
        let dir = scratch(name)?;
        let fixture = Self {
            repo: dir.join("repo"),
            home: dir.join("home"),
            backups: dir.join("backups"),
            decoy: dir.join("decoy.sh"),
            marker: dir.join("marker"),
        };
        for path in [
            &fixture.repo,
            &fixture.home.join(".navori"),
            &fixture.backups,
        ] {
            fs::create_dir_all(path)?;
        }
        fs::write(
            &fixture.decoy,
            "#!/bin/sh\necho hit > \"$MARKER\"\nexit 97\n",
        )?;
        fs::set_permissions(
            &fixture.decoy,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )?;
        fs::write(
            fixture.repo.join("navori.config.json"),
            r#"{"name":"demo","preset":"custom","engines":["claude"],"language":"en","plugins":{"tgrep":{"enabled":true}}}"#,
        )?;
        let canonical = fs::canonicalize(&fixture.repo)?;
        fs::write(
            fixture.home.join(".navori/registry.json"),
            format!(r#"{{"repos":[{{"path":{canonical:?},"name":"demo"}}]}}"#),
        )?;
        let out = fixture.run(&["render", "--apply"], &[("NO_COLOR", "1")])?;
        assert_eq!(out.status.code(), Some(0), "setup render failed");
        assert!(!fixture.marker.exists(), "setup handed the run to the TS");
        Ok(fixture)
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> std::io::Result<std::process::Output> {
        Process::new(env!("CARGO_BIN_EXE_navori-rust"))
            .args(args)
            .current_dir(&self.repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("NAVORI_BACKUP_ROOT", &self.backups)
            .env("NAVORI_TS_CLI", &self.decoy)
            .env("MARKER", &self.marker)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .output()
    }

    /// Wraps `rel`'s content (or `content` when given) in a conflict triple.
    fn conflict(&self, rel: &str, content: Option<&str>) -> TestResult {
        let path = self.repo.join(rel);
        let body = match content {
            Some(text) => text.to_owned(),
            None => fs::read_to_string(&path)?,
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            path,
            format!("<<<<<<< HEAD\n{body}\n=======\ntheirs\n>>>>>>> branch\n"),
        )?;
        Ok(())
    }

    /// Repo, home and backups together.
    fn state(&self) -> Result<[Tree; 3], Box<dyn Error>> {
        Ok([
            snapshot(&self.repo)?,
            snapshot(&self.home)?,
            snapshot(&self.backups)?,
        ])
    }

    /// Asserts the refusal of #1660: exit 1, nothing written, no TS, and returns stdout.
    fn assert_refused(
        &self,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<String, Box<dyn Error>> {
        let before = self.state()?;
        let out = self.run(args, env)?;
        let stdout = String::from_utf8(out.stdout)?;
        assert_eq!(out.status.code(), Some(1), "{args:?}: {stdout}");
        assert_eq!(before, self.state()?, "{args:?} wrote something");
        assert!(!self.marker.exists(), "{args:?} handed the run to the TS");
        Ok(stdout)
    }
}

/// A conflict in a rendered native hook is refused by every mode, `--force` and a colored
/// (TTY-like) run included; the JSON names the file and its line.
// Covers: #1660
#[test]
fn conflict_markers_refuse_render_before_any_write() -> TestResult {
    let fixture = Fixture::rendered("conflict-hook")?;
    let hook = fs::read_dir(fixture.repo.join(".claude/hooks"))?
        .filter_map(Result::ok)
        .find(|entry| entry.path().is_file())
        .ok_or("no rendered hook")?
        .file_name();
    let rel = format!(".claude/hooks/{}", hook.to_string_lossy());
    fixture.conflict(&rel, None)?;

    let stdout = fixture.assert_refused(&["render", "--json"], &[])?;
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    let parsed = navori_core::js_json::parse(stdout.trim()).ok_or("not JSON")?;
    let navori_core::js_json::JsValue::Object(root) = parsed else {
        return Err("not an object".into());
    };
    let text = |key: &str| match root.get(key) {
        Some(navori_core::js_json::JsValue::String(s)) => s.to_rust(),
        _ => None,
    };
    assert_eq!(text("command").as_deref(), Some("render"));
    assert_eq!(text("reason").as_deref(), Some("conflict-markers"));
    assert!(text("detail").is_some_and(|d| d.contains("rebase-rerender")));
    assert!(stdout.contains(r#""ok":false"#), "{stdout}");
    assert!(
        stdout.contains(&format!(r#""files":[{{"path":"{rel}","line":1}}]"#)),
        "{stdout}"
    );

    for args in [
        &["render", "--apply"][..],
        &["render", "--apply", "--force"],
        &["render"],
    ] {
        let stdout = fixture.assert_refused(args, &[("NO_COLOR", "1")])?;
        assert!(stdout.contains(&format!("{rel}:1")), "{args:?}: {stdout}");
        assert!(stdout.contains("rebase-rerender"), "{stdout}");
    }
    // A terminal or FORCE_COLOR used to delegate to the TS: now it is refused first.
    fixture.assert_refused(&["render", "--apply"], &[("FORCE_COLOR", "1")])?;
    fixture.assert_refused(
        &["render", "--json", "--apply", "--force"],
        &[("FORCE_COLOR", "1")],
    )?;
    Ok(())
}

/// Outside a managed block (CLAUDE.md) and in an ignore file the triple is refused too.
#[test]
fn conflict_markers_in_user_text_and_ignore_files_are_refused() -> TestResult {
    for (label, rel, content) in [
        ("user-text", "CLAUDE.md", None),
        ("ignore", ".gitignore", Some("node_modules/")),
    ] {
        let fixture = Fixture::rendered(&format!("conflict-{label}"))?;
        fixture.conflict(rel, content)?;
        let stdout = fixture.assert_refused(&["render", "--apply"], &[("NO_COLOR", "1")])?;
        assert!(stdout.contains(&format!("{rel}:1")), "{label}: {stdout}");
    }
    Ok(())
}

/// A clean rendered repo keeps its behavior: preview and apply are native and exit 0.
#[test]
fn conflict_markers_absent_leaves_render_unchanged() -> TestResult {
    let fixture = Fixture::rendered("conflict-clean")?;
    for args in [
        &["render"][..],
        &["render", "--json"],
        &["render", "--apply"],
    ] {
        let out = fixture.run(args, &[("NO_COLOR", "1")])?;
        assert_eq!(out.status.code(), Some(0), "{args:?}");
    }
    assert!(!fixture.marker.exists());
    Ok(())
}

/// A6: `.claude/settings.json` and `.mcp.json` are scanned. Before the fix the base `render` never
/// looked at them: a triple inside either was kept as user data (or handed to the TS) and the run
/// exited 0 / delegated; now both are refused like any managed file.
#[test]
fn conflict_markers_json() -> TestResult {
    for rel in [".claude/settings.json", ".mcp.json"] {
        let fixture = Fixture::rendered(&format!("conflict-json{}", rel.replace(['/', '.'], "-")))?;
        fixture.conflict(rel, Some("{}"))?;
        let stdout = fixture.assert_refused(&["render", "--json"], &[])?;
        assert!(
            stdout.contains(r#""reason":"conflict-markers""#),
            "{stdout}"
        );
        assert!(
            stdout.contains(&format!(r#""path":"{rel}","line":1"#)),
            "{stdout}"
        );
        fixture.assert_refused(&["render", "--apply", "--force"], &[("NO_COLOR", "1")])?;
    }
    Ok(())
}
