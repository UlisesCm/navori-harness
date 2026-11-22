//! `navori gate foreign` end to end through the real binary: results (exit code, streams, the
//! private log on disk), not recorded process calls. The destination repos are real `git init`
//! checkouts registered in an isolated `HOME`; steps are stub scripts found through `PATH`.

use std::error::Error;
use std::ffi::OsStr;
use std::fs::{self, File, FileTimes};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

use navori_hooks::hooks::quality_gate_pre_commit::{
    Context, Gate, Rendered, Step, after_foreign, evaluate,
};
use navori_hooks::runner::{Engine, Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::hook_input::Host;
use navori_hooks::shell::payload::{Extractor, Profile};
use navori_hooks::shell::repo::{Loss, Repo};

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
const PREFIX: &str = "navori-gate-foreign-";

type TestResult = Result<(), Box<dyn Error>>;

/// An isolated world: `home` (registry), `tmp` (`TMPDIR`), `bin` (stub steps) and repos.
struct World {
    root: PathBuf,
}

impl World {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("gf-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        for dir in ["home", "tmp", "bin", "elsewhere"] {
            fs::create_dir_all(root.join(dir))?;
        }
        let world = Self {
            root: root.canonicalize()?,
        };
        // `qualityGate` steps must start with a package manager: this one runs named scripts.
        world.step(
            "bun",
            r#"case "$1" in
  hello) echo hello;;
  before|after|seq|alt|skip1|skip2) echo "$1";;
  ok) ;;
  fail) exit 1;;
  kill) kill -KILL $$;;
  env) printenv GIT_CONFIG_GLOBAL;;
  *) echo "unknown $1"; exit 9;;
esac"#,
        )?;
        Ok(world)
    }

    fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// A stub step named `name` in the `PATH` directory.
    fn step(&self, name: &str, body: &str) -> TestResult {
        let path = self.root.join("bin").join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    /// `git init` with a committed `navori.config.json` whose `qualityGate.fast` is `fast`.
    fn repo(&self, name: &str, config: &str) -> Result<PathBuf, Box<dyn Error>> {
        let repo = self.root.join(name);
        fs::create_dir_all(&repo)?;
        git(&repo, &["init", "-q"])?;
        fs::write(repo.join("navori.config.json"), config)?;
        git(&repo, &["add", "."])?;
        git(&repo, &["commit", "-q", "-m", "init"])?;
        Ok(repo)
    }

    fn register(&self, path: &Path) -> TestResult {
        let name = format!(
            "ws-{}",
            path.file_name().map_or("x".into(), |n| n.to_string_lossy())
        );
        let dir = self.root.join("home/.navori/workspaces").join(&name);
        fs::create_dir_all(&dir)?;
        let manifest = serde_json::json!({
            "name": name,
            "repos": [{ "name": "repo", "path": path.display().to_string() }],
        });
        fs::write(dir.join("workspace.json"), manifest.to_string())?;
        Ok(())
    }

    fn command(&self) -> Command {
        let mut command = Command::new(BIN);
        command
            .current_dir(self.root.join("elsewhere"))
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("TMPDIR", self.tmp())
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            // CARGO_TARGET_TMPDIR sits under target/, inside the repo checkout in CI: without a
            // ceiling, a directory of this world outside its own repos resolves to that checkout.
            .env("GIT_CEILING_DIRECTORIES", &self.root)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.root.join("bin").display()),
            );
        command
    }

    fn foreign(&self, cwd: &Path) -> Result<Output, Box<dyn Error>> {
        Ok(self
            .command()
            .args(["gate", "foreign", "--cwd"])
            .arg(cwd)
            .output()?)
    }

    /// The private log directories under `tmp` (real directories only).
    fn log_dirs(&self) -> Result<Vec<PathBuf>, Box<dyn Error>> {
        let mut dirs = Vec::new();
        for entry in fs::read_dir(self.tmp())? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(PREFIX)
                && fs::symlink_metadata(entry.path())?.is_dir()
            {
                dirs.push(entry.path());
            }
        }
        Ok(dirs)
    }

    fn only_log(&self) -> Result<String, Box<dyn Error>> {
        let dirs = self.log_dirs()?;
        let [dir] = dirs.as_slice() else {
            return Err(format!("expected one log dir, got {dirs:?}").into());
        };
        let mut files = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        let file = files.pop().ok_or("no log file")?;
        Ok(fs::read_to_string(file.path())?)
    }
}

fn git(cwd: &Path, args: &[&str]) -> TestResult {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?}: {}", String::from_utf8_lossy(&output.stderr)).into())
    }
}

fn config(fast: &str) -> String {
    serde_json::json!({
        "name": "x",
        "version": "1.0.0",
        "engines": ["claude"],
        "preset": "custom",
        "harnessVersion": "0.12.2",
        "language": "es",
        "branchBase": "main",
        "commits": "conventional-es",
        "gitignoreHarness": "off",
        "qualityGate": { "fast": fast, "full": "bun run check" },
    })
    .to_string()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn first_line(output: &Output) -> String {
    text(&output.stdout).lines().next().unwrap_or("").to_owned()
}

// Covers: gate foreign — registered green, private log and its modes
#[test]
fn a_registered_green_run_writes_a_private_log() -> TestResult {
    let world = World::new("modes")?;
    let repo = world.repo("repo", &config("bun hello"))?;
    world.register(&repo)?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert!(first_line(&output).starts_with("navori gate foreign: exit 0 "));
    let [dir] = world.log_dirs()?.try_into().map_err(|_| "one log dir")?;
    assert_eq!(fs::metadata(&dir)?.mode() & 0o777, 0o700);
    let log = fs::read_dir(&dir)?.next().ok_or("no log")??.path();
    assert_eq!(fs::metadata(&log)?.mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(&log)?, "hello\n");
    // The stdout names exactly that log.
    assert!(text(&output.stdout).contains(&log.display().to_string()));
    // Nothing was written into the home registry.
    assert!(!world.root.join("home/.navori/workspaces/ws.json").exists());
    Ok(())
}

// Covers: pruneForeignLogs — keep 20, never follow a symlink, skip non-directories
#[test]
fn old_logs_are_pruned_to_twenty_without_following_symlinks() -> TestResult {
    let world = World::new("prune")?;
    let repo = world.repo("repo", &config("bun ok"))?;
    world.register(&repo)?;
    let now = SystemTime::now();
    let mut made = Vec::new();
    for index in 0..25u64 {
        let dir = world.tmp().join(format!("{PREFIX}old{index:03}"));
        fs::create_dir(&dir)?;
        let age = Duration::from_secs(1000 + (25 - index) * 10);
        File::open(&dir)?.set_times(FileTimes::new().set_modified(now - age))?;
        made.push(dir);
    }
    // A symlink to a directory outside tmp: its target must survive, and it is not a candidate.
    let victim = world.root.join("victim");
    fs::create_dir(&victim)?;
    fs::write(victim.join("keep"), "x")?;
    symlink(&victim, world.tmp().join(format!("{PREFIX}link")))?;
    // A regular file with the prefix is not a directory: left alone.
    fs::write(world.tmp().join(format!("{PREFIX}file")), "x")?;

    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    // Newest 20 of the old ones survive (indexes 5..25), the 5 oldest are gone.
    for (index, dir) in made.iter().enumerate() {
        assert_eq!(dir.exists(), index >= 5, "{}", dir.display());
    }
    assert_eq!(world.log_dirs()?.len(), 21, "20 kept + this run's");
    assert!(
        fs::symlink_metadata(world.tmp().join(format!("{PREFIX}link")))?
            .file_type()
            .is_symlink()
    );
    assert!(world.tmp().join(format!("{PREFIX}file")).is_file());
    Ok(())
}

// Covers: a step killed by a signal — 129 and the note in stdout and in the log
#[test]
fn a_step_killed_by_sigkill_exits_129_and_says_so_in_stdout_and_log() -> TestResult {
    let world = World::new("sigkill")?;
    world.step("doomed", "kill -KILL $$")?;
    let repo = world.repo("repo", &config("bun kill"))?;
    world.register(&repo)?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(129));
    let stdout = text(&output.stdout);
    assert!(
        stdout.starts_with("navori gate foreign: exit 129 "),
        "{stdout}"
    );
    assert!(stdout.contains("killed by SIGKILL"), "{stdout}");
    assert!(world.only_log()?.contains("killed by SIGKILL"));
    Ok(())
}

// Covers: missing binary — 127 like the TS ENOENT path
#[test]
fn a_missing_binary_exits_127() -> TestResult {
    let world = World::new("enoent")?;
    let repo = world.repo("repo", &config("yarn run x"))?;
    world.register(&repo)?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(127));
    assert!(first_line(&output).starts_with("navori gate foreign: exit 127 "));
    Ok(())
}

// Covers: cd emulation — the note lands in order between the steps' output
#[test]
fn a_missing_cd_target_notes_in_order_and_fails_the_step() -> TestResult {
    let world = World::new("cd")?;
    let repo = world.repo("repo", &config("bun before; cd nope; bun after"))?;
    world.register(&repo)?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        world.only_log()?,
        "before\n[navori gate] cd: nope: no such directory\nafter\n"
    );
    let failing = world.repo("repo2", &config("cd nope && bun after"))?;
    world.register(&failing)?;
    let output = world.foreign(&failing)?;
    assert_eq!(output.status.code(), Some(1));
    Ok(())
}

// Covers: the operators decide which steps run
#[test]
fn operators_gate_the_steps() -> TestResult {
    let world = World::new("ops")?;
    let chain = "bun fail && bun skip1; bun seq; bun ok || bun skip2; bun fail || bun alt";
    let repo = world.repo("repo", &config(chain))?;
    world.register(&repo)?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stdout));
    assert_eq!(world.only_log()?, "seq\nalt\n");
    Ok(())
}

// Covers: the step sees the whole environment (only git's own pinning vars are dropped for git)
#[test]
fn steps_see_git_config_global_and_the_rest_of_the_environment() -> TestResult {
    let world = World::new("env")?;
    let repo = world.repo("repo", &config("bun env"))?;
    world.register(&repo)?;
    let output = world
        .command()
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["gate", "foreign", "--cwd"])
        .arg(&repo)
        .output()?;
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert_eq!(world.only_log()?, "/dev/null\n");
    Ok(())
}

// Covers: the registry is checked before the destination's config is parsed
#[test]
fn an_unregistered_checkout_is_refused_even_with_an_invalid_config() -> TestResult {
    let world = World::new("refuse")?;
    let repo = world.repo("repo", "{")?;
    let output = world.foreign(&repo)?;
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    let stderr = text(&output.stderr);
    assert!(
        stderr.starts_with(&format!(
            "navori gate foreign: refused — {} is not registered in any navori workspace;",
            repo.display()
        )),
        "{stderr}"
    );
    // The same through a worktree: its common dir leads to the unregistered main checkout.
    let wt = world.root.join("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            &wt.display().to_string(),
        ],
    )?;
    let output = world.foreign(&wt)?;
    assert_eq!(output.status.code(), Some(64));
    assert!(text(&output.stderr).contains("is not registered in any navori workspace"));
    // Nothing ran, so no log was made.
    assert!(world.log_dirs()?.is_empty());
    Ok(())
}

// Covers: a worktree of a registered checkout is registered
#[test]
fn a_worktree_of_a_registered_checkout_runs() -> TestResult {
    let world = World::new("worktree")?;
    let repo = world.repo("repo", &config("bun ok"))?;
    world.register(&repo)?;
    let wt = world.root.join("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            &wt.display().to_string(),
        ],
    )?;
    let output = world.foreign(&wt)?;
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    Ok(())
}

// Covers: the refusals and the red run the hook acts on
#[test]
fn refusals_and_red_runs_keep_their_exit_codes() -> TestResult {
    let world = World::new("codes")?;
    let outside = world
        .command()
        .args(["gate", "foreign", "--cwd", "../home"])
        .output()?;
    assert_eq!(outside.status.code(), Some(64));
    assert_eq!(
        text(&outside.stderr),
        "navori gate foreign: refused — --cwd is not a Git checkout: ../home\n"
    );
    let repo = world.repo("repo", &config("make test"))?;
    world.register(&repo)?;
    let unsafe_chain = world.foreign(&repo)?;
    assert_eq!(unsafe_chain.status.code(), Some(64));
    assert!(text(&unsafe_chain.stderr).contains("not a plain command chain"));
    let red = world.repo("red", &config("bun fail"))?;
    world.register(&red)?;
    let output = world.foreign(&red)?;
    assert_eq!(output.status.code(), Some(1));
    assert!(first_line(&output).starts_with("navori gate foreign: exit 1 "));
    Ok(())
}

// --- the hook contract: what the quality-gate-pre-commit hook makes of the real output ---

struct NoRepo;

impl Repo for NoRepo {
    fn is_dir(&self, dir: &str) -> bool {
        dir == "/work"
    }
    fn holds(&self, _: &str, _: Loss) -> bool {
        false
    }
    fn toplevel(&self, _: &str) -> Option<String> {
        None
    }
    fn superproject(&self, _: &str) -> Option<String> {
        None
    }
    fn repo_id(&self, _: &str) -> Option<String> {
        None
    }
    fn physical(&self, dir: &str) -> Option<String> {
        Some(dir.to_owned())
    }
    fn ignored(&self, _: &str, _: &str) -> bool {
        false
    }
    fn file_size(&self, _: &str, _: &str) -> u64 {
        0
    }
    fn blob_size(&self, _: &str, _: &str) -> u64 {
        0
    }
    fn is_file(&self, _: &str) -> bool {
        false
    }
    fn tgrep_status(&self, _: Option<&str>) -> Option<String> {
        None
    }
}

struct Present;

impl Gate for Present {
    fn on_path(&self, _: &str, _: &str) -> bool {
        true
    }
    fn probe_hit(&self, _: &str) -> bool {
        false
    }
    fn read(&self, _: &str) -> Option<Vec<u8>> {
        None
    }
    fn cd_error(&self, _: &str) -> Result<Option<&'static str>, String> {
        Ok(None)
    }
}

fn hook_context() -> Context<'static> {
    let script = ".claude/hooks/quality-gate-pre-commit.sh";
    Context {
        engine: Engine::Claude,
        profile: Profile {
            extractor: Extractor::JqAndNode,
            locale: Locale::Utf8,
        },
        capture: CaptureContext {
            shell: ShellDialect::Bash5,
            script: Path::new(script),
            input_line: 1,
            fallback_line: 1,
        },
        rendered: Rendered {
            gate: "pnpm run check".to_owned(),
            native_fast: "{{x}}".to_owned(),
            progress_cap: Some("{{navori.progressHardCapBytes}}".to_owned()),
            cd_line: 1,
            functions: vec!["run_gate".to_owned()],
        },
        host: Host {
            pwd: "/work".to_owned(),
            ..Host::default()
        },
        script: script.to_owned(),
    }
}

fn hook_decision(root: &str, output: &Output) -> Result<Evaluation, Box<dyn Error>> {
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "permission_mode": "default",
        "tool_input": { "command": "git commit -m x" },
    })
    .to_string();
    let Step::Gate(pending, _) = evaluate(payload.as_bytes(), &hook_context(), &NoRepo, &Present)?
    else {
        return Err("expected a gate run".into());
    };
    // `navori gate foreign … 2>&1`: both streams; each test case writes to one of them only.
    let merged = [output.stdout.as_slice(), output.stderr.as_slice()].concat();
    Ok(after_foreign(
        pending,
        root,
        output.status.code().unwrap_or(-1),
        &merged,
    ))
}

fn label(evaluation: &Evaluation) -> (&str, &str) {
    evaluation
        .audit
        .as_ref()
        .map_or(("", ""), |label| (label.verdict, label.reason.as_str()))
}

// Covers: the hook classifies the native output as green, refused and red
#[test]
fn the_hook_classifies_the_real_output() -> TestResult {
    let world = World::new("hook")?;
    let green = world.repo("green", &config("bun ok"))?;
    let red = world.repo("red", &config("bun fail"))?;
    let loose = world.repo("loose", &config("bun ok"))?;
    world.register(&green)?;
    world.register(&red)?;

    let output = world.foreign(&green)?;
    let decision = hook_decision("/dest", &output)?;
    assert_eq!(label(&decision), ("allow", "foreign-gate"));
    assert_eq!(decision.verdict, Verdict::Permit);

    let output = world.foreign(&loose)?;
    let decision = hook_decision("/dest", &output)?;
    assert_eq!(decision.verdict, Verdict::Permit);
    assert!(text(&decision.stderr).contains("The destination's gate was NOT run:"));

    let output = world.foreign(&red)?;
    let decision = hook_decision("/dest", &output)?;
    assert_eq!(decision.verdict, Verdict::Block);
    assert_eq!(label(&decision), ("block", "foreign-gate"));
    Ok(())
}

// --- the version notice exception ---

fn ts_stub(world: &World) -> Result<PathBuf, Box<dyn Error>> {
    let pkg = world.root.join("pkg");
    fs::create_dir_all(pkg.join("dist"))?;
    fs::write(pkg.join("dist/index.js"), "// stub")?;
    fs::write(
        pkg.join("package.json"),
        r#"{"name":"navori","version":"9.9.9"}"#,
    )?;
    world.step("node", "exit 7")?;
    Ok(pkg.join("dist/index.js"))
}

fn delegated(world: &World, ts: &OsStr, args: &[&str]) -> Result<Output, Box<dyn Error>> {
    Ok(Command::new(BIN)
        .env_clear()
        .env("PATH", world.root.join("bin"))
        .env("NAVORI_TS_CLI", ts)
        .args(args)
        .output()?)
}

// Covers: gate foreign delegating prints no version notice; any other command does
#[test]
fn a_delegated_gate_foreign_prints_no_version_notice_but_other_commands_do() -> TestResult {
    let world = World::new("notice")?;
    let ts = ts_stub(&world)?;
    // `--force` is outside the native subset, so this delegates.
    let foreign = delegated(&world, ts.as_os_str(), &["gate", "foreign", "--force"])?;
    assert_eq!(foreign.status.code(), Some(7));
    assert_eq!(text(&foreign.stderr), "");
    let other = delegated(&world, ts.as_os_str(), &["doctor", "--json"])?;
    assert_eq!(other.status.code(), Some(7));
    assert!(text(&other.stderr).contains("warning: delegating to TS navori 9.9.9"));
    Ok(())
}
