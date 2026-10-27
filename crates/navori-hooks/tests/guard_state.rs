//! Spec 0057 T28 (R11): rules 6c (the Pi arm) and 7 (discards of uncommitted work) against the
//! rendered guard-destructive.sh copies, run as the hosts run them, over real git repositories.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_hooks::hooks::guard_destructive::repo::{Repo, System};
use navori_hooks::hooks::guard_destructive::{Host, Rendered, ask_answer, decide};
use navori_hooks::runner::Engine;
use navori_hooks::shell::Locale;

type TestResult = Result<(), Box<dyn Error>>;

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

/// Locales the shell runs under on this platform, with the model that describes them.
fn locales() -> Vec<(&'static str, Locale)> {
    let utf8 = if cfg!(target_os = "macos") {
        ("en_US.UTF-8", Locale::Utf8)
    } else {
        ("C.UTF-8", Locale::GnuUtf8)
    };
    vec![utf8, ("C", Locale::C)]
}

/// One scratch tree: the hook copy installed where its engine expects it, a work directory
/// with repositories in every state rule 7 distinguishes, and an empty home.
struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        let root = std::env::temp_dir().join(format!("navori-{name}-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: fs::canonicalize(&root)?,
        })
    }

    fn path(&self, rel: &str) -> String {
        self.root.join(rel).to_string_lossy().into_owned()
    }

    /// Install a guard copy and the search-routing script its tgrep block sources from
    /// `../scripts/`.
    fn install_guard(&self, source: &str, dest: &str) -> Result<String, Box<dyn Error>> {
        let routing = |hook: &str| {
            hook.replace(
                "hooks/guard-destructive.sh",
                "scripts/guard-search-routing.sh",
            )
        };
        self.install(&routing(source), &routing(dest))?;
        self.install(source, dest)
    }

    fn install(&self, source: &str, dest: &str) -> Result<String, Box<dyn Error>> {
        let dest = self.root.join(dest);
        fs::create_dir_all(dest.parent().ok_or("parent")?)?;
        fs::copy(workspace().join(source), &dest)?;
        Ok(dest.to_string_lossy().into_owned())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> TestResult {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?} failed").into())
    }
}

/// `work/{clean,tracked,untracked,ignored}` repositories and a `plain` directory.
fn repositories(work: &Path) -> TestResult {
    fs::create_dir_all(work.join("plain"))?;
    for name in ["clean", "tracked", "untracked", "ignored"] {
        let repo = work.join(name);
        fs::create_dir_all(&repo)?;
        git(&repo, &["init", "-q"])?;
        fs::write(repo.join(".gitignore"), "zz-navori-ignored\n")?;
        fs::write(repo.join("zz-navori-file"), "one\n")?;
        git(&repo, &["add", "-A"])?;
        git(&repo, &["commit", "-q", "-m", "init"])?;
    }
    fs::write(work.join("tracked/zz-navori-file"), "two\n")?;
    fs::write(work.join("untracked/zz-navori-new"), "new\n")?;
    fs::write(work.join("ignored/zz-navori-ignored"), "ignored\n")?;
    Ok(())
}

struct Run {
    status: i32,
    stdout: String,
    stderr: String,
}

fn run_hook(
    script: &str,
    cmd: &str,
    cwd: &str,
    env: &[(&str, &str)],
    lc_all: &str,
) -> Result<Run, Box<dyn Error>> {
    let payload = serde_json::json!({
        "cwd": cwd,
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": cmd },
    });
    let mut child = Command::new("bash")
        .arg(script)
        .env_remove("CLAUDE_PROJECT_DIR")
        .env("LC_ALL", lc_all)
        .env("PWD", cwd)
        .envs(env.iter().copied())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(payload.to_string().as_bytes())?;
    let output = child.wait_with_output()?;
    Ok(Run {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8(output.stdout)?,
        stderr: String::from_utf8(output.stderr)?,
    })
}

/// Deterministic token soup over `vocab`, one to `max` tokens per command.
fn soup(vocab: &[&str], count: usize, max: usize, seed: u64) -> Vec<String> {
    let mut seed = seed;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        usize::try_from(seed >> 33).unwrap_or(0)
    };
    (0..count)
        .map(|_| {
            let len = 1 + next() % max;
            (0..len)
                .map(|_| vocab[next() % vocab.len()])
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

/// Compare every command; returns the outcome labels seen.
fn compare(
    script: &str,
    engine: Engine,
    host: &Host,
    env: &[(&str, &str)],
    commands: &[String],
    locales: &[(&str, Locale)],
) -> Result<Vec<String>, Box<dyn Error>> {
    // The model reads the command as jq does; extract-cmd's sed fallback reads escaped quotes
    // differently, so a host without jq would compare two different commands.
    let jq = Command::new("jq").arg("--version").output();
    if !jq.is_ok_and(|output| output.status.success()) {
        return Err("jq is required to run the rendered hooks as the hosts do".into());
    }
    let rendered =
        Rendered::from_script(&fs::read_to_string(script)?).ok_or("rendered assignments")?;
    // The search lane looks tgrep up in the PATH the shell runs with.
    let mut host = host.clone();
    if host.path.is_none() {
        host.path = env
            .iter()
            .find(|(name, _)| *name == "PATH")
            .map(|(_, value)| (*value).to_owned())
            .or_else(|| std::env::var("PATH").ok());
    }
    let mut labels = Vec::new();
    let mut mismatches = Vec::new();
    for &(lc_all, locale) in locales {
        for cmd in commands {
            let decision = decide(cmd, &rendered, engine, &host, &System, locale)?;
            let want = Run {
                status: decision.status,
                stdout: decision.stdout.clone(),
                stderr: String::from_utf8(decision.stderr.clone())?,
            };
            let same = |got: &Run| {
                got.status == want.status && got.stdout == want.stdout && got.stderr == want.stderr
            };
            let mut got = run_hook(script, cmd, &host.cwd, env, lc_all)?;
            // Under heavy parallel load a starved `jq` fails silently inside extract-cmd and the
            // script sees an empty command (exit 0, no output). That is the oracle's noise, not
            // a verdict: a disagreeing case is rerun, and reported only if the shell insists.
            for _ in 0..2 {
                if same(&got) {
                    break;
                }
                got = run_hook(script, cmd, &host.cwd, env, lc_all)?;
            }
            if !same(&got) {
                mismatches.push(format!(
                    "{lc_all} {cmd:?}\n  shell: {} {:?} {:?}\n  rust:  {} {:?} {:?}",
                    got.status, got.stdout, got.stderr, want.status, want.stdout, want.stderr
                ));
            }
            labels.push(match decision.verdict {
                "block" if want.stderr.starts_with("[navori] Commit BLOCKED") => {
                    "ratchet".to_owned()
                }
                "block" => format!("block/{}", decision.reason),
                verdict => verdict.to_owned(),
            });
        }
    }
    if !mismatches.is_empty() {
        return Err(format!(
            "{} mismatches:\n{}",
            mismatches.len(),
            mismatches.join("\n")
        )
        .into());
    }
    Ok(labels)
}

// Covers: R11
#[test]
fn ask_text_drops_what_the_trap_tr_drops() -> TestResult {
    let prefix = "git \"push\" \\ \t-f\u{1}\u{7f}\u{85}\u{ad}\u{200b}\u{a0}\u{e9}\u{fffa}x";
    for (lc_all, locale) in locales() {
        let output = Command::new("bash")
            .args([
                "-c",
                r#"printf '%s' "$1" | tr -d '"\\[:cntrl:]'"#,
                "tr",
                prefix,
            ])
            .env("LC_ALL", lc_all)
            .output()?;
        let text = String::from_utf8(output.stdout)?;
        assert_eq!(
            ask_answer(prefix, locale).1,
            format!("shared permission ask rule '{text}'"),
            "{lc_all}"
        );
    }
    Ok(())
}

// Covers: R11
#[test]
fn pi_arm_matches_the_rendered_pi_copy() -> TestResult {
    let scratch = Scratch::new("guard-pi")?;
    let script = scratch.install_guard(
        ".pi/navori/hooks/guard-destructive.sh",
        "proj/.pi/navori/hooks/guard-destructive.sh",
    )?;
    let work = scratch.path("work");
    repositories(Path::new(&work))?;
    let home = scratch.path("home");
    fs::create_dir_all(&home)?;
    let mut commands: Vec<String> = [
        "cat .pi/navori.json",
        "ls .pi/extensions",
        "rm .pi/navori.json",
        "echo x > .pi/settings.json",
        "echo x >> ./.pi/extensions/navori.ts",
        "echo x >| \"$PWD\"/.pi/navori/hooks/a.sh",
        "TOUCH .PI/SETTINGS.JSON",
        "sed -i s/a/b/ .pi/navori/hooks/x.sh",
        "sed -n p .pi/navori/hooks/x.sh",
        "python3 -c 'open(\".pi/navori.json\",\"w\")'",
        "node -e x .pi/extensions/a.js",
        "git checkout .pi/navori/hooks/x.sh",
        "git restore .pi/extensions",
        "cp .pi/navori.json /tmp/x",
        "cat .pi/navorix",
        "pi --no-extensions",
        "pi -ne",
        "npx pi --no-extensions",
        "/usr/bin/pi -p x --no-extensions=1",
        "pi --help",
        "engram delete x",
        "engram deletex",
        "sudo rm -rf /x",
        "mkfs /dev/sda",
        "mkfs.ext4 /dev/sda",
        "rm -rf build",
        "rm  -rf   build",
        "rm '-rf' build",
        "rm\t-r\tbuild",
        "rm -rf build && sudo rm x",
        "git push --force origin feat",
        "git reset --hard",
        "echo ok && git clean -fd",
        "git checkout -- .",
        "gh issue create --title x",
        "navori master init",
        "echo engram delete",
        "git stash drop; engram delete z",
        "chmod -R 755 x",
        "git branch -D old",
        "rm -rf x; git reset --hard",
        "git branch -D a && rm -r b && engram import",
        "cp a b",
        "pi",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    commands.extend(soup(
        &[
            "rm",
            "-rf",
            "-r",
            "sudo",
            "engram",
            "delete",
            "mkfs",
            "pi",
            "--no-extensions",
            "-ne",
            "git",
            "reset",
            "--hard",
            "push",
            "--force",
            "clean",
            "-f",
            "checkout",
            "--",
            ".",
            "cp",
            "mv",
            "tee",
            ">",
            ">>",
            ".pi/navori.json",
            ".PI/Extensions/x",
            ".pi/settings.json",
            "python",
            "-c",
            "cat",
            "chmod",
            "-R",
            "navori",
            "master",
            "init",
            "x",
            "'a b'",
            "\"",
            ";",
            "&&",
            "|",
            "\t",
        ],
        100,
        6,
        0x5eed_6c00,
    ));
    let host = Host {
        project_dir: work.clone(),
        cwd: work.clone(),
        pwd: work.clone(),
        home: Some(home.clone()),
        ..Host::default()
    };
    let labels = compare(
        &script,
        Engine::Pi,
        &host,
        &[("HOME", &home)],
        &commands,
        &locales(),
    )?;
    for label in ["block/managed-rewrite", "block/unspecified", "ask", "allow"] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}

// Covers: R11
#[test]
fn discards_match_the_rendered_claude_copy_over_real_repositories() -> TestResult {
    let scratch = Scratch::new("guard-discard")?;
    let script = scratch.install_guard(
        ".claude/hooks/guard-destructive.sh",
        "proj/.claude/hooks/guard-destructive.sh",
    )?;
    let work = scratch.path("work");
    repositories(Path::new(&work))?;
    let home = scratch.path("home");
    fs::create_dir_all(&home)?;
    let mut commands: Vec<String> = [
        "git reset --hard",
        "cd tracked && git reset --hard",
        "cd clean && git reset --hard",
        "cd plain && git reset --hard",
        "git -C tracked reset --hard",
        "git -C tracked reset --ha",
        "git -C tracked reset --soft",
        "git -C untracked clean -fd",
        "git -C ignored clean -fd",
        "git -C ignored clean -fdx",
        "git -C ignored clean -X --force",
        "git -C untracked clean -n -f",
        "git -C untracked clean -f --dry-run",
        "git -C tracked checkout -f",
        "git -C tracked checkout -- .",
        "git -C tracked checkout :/",
        "git -C tracked checkout zz-navori-file",
        "git -C tracked restore zz-navori-file",
        "git -C tracked restore --staged zz-navori-file",
        "git -C tracked restore -SW zz-navori-file",
        "git -C tracked restore --staged --worktree zz-navori-file",
        "git -C $D reset --hard",
        "git -C missing reset --hard",
        "git -C $(pwd)/tracked reset --hard",
        "git --git-dir=x reset --hard",
        "git --work-tree tracked reset --hard",
        "git -c a=b -C tracked reset --hard",
        "git --no-pager -C tracked reset --hard",
        "git -C tracked stash",
        "cd - && git reset --hard",
        "cd && git reset --hard",
        "cd ~ && git reset --hard",
        "cd ~/../work/tracked && git reset --hard",
        "cd tracked; cd ..; git reset --hard",
        "cd \"tracked\" && git reset --hard",
        "(cd tracked && git reset --hard)",
        "cd -P tracked && git reset --hard",
        "cd   tracked   && git -C . clean -f",
        "cd $HOME && git reset --hard",
        "cd untracked && git clean -f",
        "echo git reset --hard",
        "git status && git -C tracked reset --hard",
        "git -C clean reset --hard; git -C tracked checkout .",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    commands.push(
        std::iter::repeat_n("git -C clean reset --hard", 17)
            .collect::<Vec<_>>()
            .join("; "),
    );
    commands.extend(soup(
        &[
            "cd",
            "tracked",
            "clean",
            "untracked",
            "ignored",
            "plain",
            "missing",
            "..",
            "~",
            "-",
            "git",
            "git",
            "git",
            "-C",
            "reset",
            "--hard",
            "checkout",
            "-f",
            "--",
            ".",
            "restore",
            "--staged",
            "--worktree",
            "-W",
            "clean",
            "-fd",
            "-x",
            "-n",
            "&&",
            ";",
            "$X",
            "--git-dir=x",
            "-c",
            "k=v",
            "status",
        ],
        100,
        7,
        0x5eed_7000,
    ));
    let host = Host {
        project_dir: scratch.path("proj"),
        cwd: work.clone(),
        pwd: work.clone(),
        home: Some(home.clone()),
        ..Host::default()
    };
    let project = scratch.path("proj");
    let env = [
        ("HOME", home.as_str()),
        ("CLAUDE_PROJECT_DIR", project.as_str()),
    ];
    let labels = compare(&script, Engine::Claude, &host, &env, &commands, &locales())?;
    for label in ["block/unspecified", "block/oversize", "allow"] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}

/// A `tgrep` on its own PATH entry that prints `status` and exits with `code`; `None` installs
/// none. jq is linked next to it, so the PATH needs nothing but the system directories.
fn tool_path(
    scratch: &Scratch,
    name: &str,
    status: Option<(&str, i32)>,
) -> Result<String, Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;
    let bin = scratch.root.join("bin").join(name);
    fs::create_dir_all(&bin)?;
    if let Some((text, code)) = status {
        let tgrep = bin.join("tgrep");
        fs::write(
            &tgrep,
            format!("#!/bin/sh\nprintf '%s\\n' '{text}'\nexit {code}\n"),
        )?;
        fs::set_permissions(&tgrep, fs::Permissions::from_mode(0o755))?;
    }
    let jq = Command::new("bash")
        .args(["-c", "command -v jq"])
        .output()?;
    let jq = String::from_utf8(jq.stdout)?.trim().to_owned();
    let tools = scratch.root.join("tools");
    if !tools.join("jq").exists() {
        fs::create_dir_all(&tools)?;
        std::os::unix::fs::symlink(&jq, tools.join("jq"))?;
    }
    Ok(format!(
        "{}:{}:/usr/bin:/bin",
        bin.display(),
        tools.display()
    ))
}

/// Searches the lane routes, extractions it lets through and shapes it cannot parse.
fn search_commands(proj: &str) -> Vec<String> {
    let mut commands: Vec<String> = [
        "grep -rn foo src/",
        "grep -r foo .",
        "grep -rn foo src/a.ts",
        "grep -rn foo bin/deploy",
        "grep -rn foo src",
        "grep -rn foo Makefile",
        "grep -rn foo docs/CODEOWNERS",
        "grep -R foo",
        "grep --recursive foo src",
        "grep --recursive=yes foo src",
        "grep -n foo src/a.ts",
        "grep -n foo src",
        "egrep -r x src",
        "fgrep -ri x src",
        "rg foo",
        "rg foo src",
        "rg foo src/a.ts",
        "rg foo a.ts",
        "rg foo docs/x.yaml",
        "rg foo docs/x.json5x",
        "rg foo docs/.c",
        "rg --files",
        "rg --version",
        "rg -l foo ~/x",
        "rg foo ~",
        "rg foo /tmp",
        "cat x | grep -r foo src",
        "cat x | rg foo",
        "ls; grep -r foo src",
        "ls || rg foo",
        "ls && rg foo",
        "LC_ALL=C grep -rn foo src/",
        "X=1 Y=2 rg foo",
        "X=1",
        "git grep foo",
        "echo 'a ; rg foo'",
        "echo \"x\" && rg foo",
        "rg 'a|b' src",
        "rg \"*.ts\" src",
        "grep -rn foo 'src/a.ts'",
        "rg foo src/*.ts",
        "rg foo -- src",
        "rg -e foo src",
        "grep -r --include=*.ts foo src",
        "cargo build",
        "cp cargo.toml x",
        "rg foo <<EOF\nx\nEOF",
        "echo a\nrg foo",
        "rg foo \\\n src",
        "  rg foo",
        "@C@rg foo",
        "rg foo \"unterminated ; rg bar",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    commands.push(format!("rg foo {proj}/src"));
    commands.push(format!("rg foo {proj}"));
    commands.push(format!("rg foo {proj}x/src"));
    commands.push(format!("grep -r foo {proj}/src/a.ts"));
    commands
}

// Covers: R11
#[test]
fn search_lane_matches_the_rendered_copy_for_every_tgrep_state() -> TestResult {
    let scratch = Scratch::new("guard-search")?;
    let script = scratch.install_guard(
        ".claude/hooks/guard-destructive.sh",
        "proj/.claude/hooks/guard-destructive.sh",
    )?;
    let proj = scratch.path("proj");
    for (path, bytes) in [("src/a.ts", 3), ("bin/deploy", 3), ("Makefile", 3)] {
        fill(Path::new(&proj), path, bytes)?;
    }
    let home = scratch.path("home");
    fs::create_dir_all(&home)?;
    let states = [
        ("none", None),
        ("noindex", Some(("No index found at x", 0))),
        ("stopped", Some(("Index: ok Server: not running", 0))),
        ("running", Some(("Index: ok Server: running", 0))),
        ("failing", Some(("boom", 1))),
    ];
    let mut jobs = Vec::new();
    for (name, status) in states {
        jobs.push((tool_path(&scratch, name, status)?, proj.clone(), false));
    }
    // Relative operands are read from the hook's working directory.
    jobs.push((
        tool_path(&scratch, "running", None)?,
        format!("{proj}/src"),
        true,
    ));
    let commands = search_commands(&proj);
    let runs: Vec<Result<Vec<String>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs
            .iter()
            .map(|(path, cwd, both)| {
                let (script, proj, home, commands) = (&script, &proj, &home, &commands);
                scope.spawn(move || {
                    let host = Host {
                        project_dir: proj.clone(),
                        cwd: cwd.clone(),
                        pwd: cwd.clone(),
                        home: Some(home.clone()),
                        claude_project_dir: Some(proj.clone()),
                        hook_path: script.clone(),
                        path: Some(path.clone()),
                        ..Host::default()
                    };
                    let env = [
                        ("HOME", home.as_str()),
                        ("CLAUDE_PROJECT_DIR", proj.as_str()),
                        ("PATH", path.as_str()),
                    ];
                    let all = locales();
                    let locales = if *both { &all[..] } else { &all[..1] };
                    compare(script, Engine::Claude, &host, &env, commands, locales)
                        .map_err(|e| format!("{path} in {cwd}: {e}"))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or_else(|_| Err("panicked".to_owned())))
            .collect()
    });
    let mut labels = Vec::new();
    for run in runs {
        labels.extend(run?);
    }
    for label in [
        "block/content search routed to the index",
        "fail-open",
        "allow",
        "skip",
    ] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}

/// A rendered copy with the progress lane switched on, as a render without
/// `qualityGate.fast` writes it.
fn install_with_lane(
    scratch: &Scratch,
    source: &str,
    dest: &str,
) -> Result<String, Box<dyn Error>> {
    let path = scratch.install_guard(source, dest)?;
    let text = fs::read_to_string(&path)?;
    let lane = text.replacen("\nnavori_pg_lane=0\n", "\nnavori_pg_lane=1\n", 1);
    assert_ne!(lane, text, "{source} assigns navori_pg_lane=0");
    fs::write(&path, lane)?;
    Ok(path)
}

/// Write `bytes` bytes to `<repo>/<path>`.
fn fill(repo: &Path, path: &str, bytes: usize) -> TestResult {
    let file = repo.join(path);
    fs::create_dir_all(file.parent().ok_or("parent")?)?;
    fs::write(file, "x".repeat(bytes))?;
    Ok(())
}

/// Repositories in every state the ratchet and the landing distinguish, as siblings:
/// `proj` (grown past the ceiling), its linked worktree `proj-wt` (small), `other` (grown, a
/// different repository), `small` (small, with `other` as submodule `sm`), `staged` (grown only
/// in the index), `untracked` (a new grown file), `ignored` (grown but ignored) and `plain`.
fn ratchet_layout(root: &Path) -> TestResult {
    const PROGRESS: &str = "progress/current.md";
    fs::create_dir_all(root.join("plain"))?;
    for name in ["proj", "other", "small", "staged", "untracked", "ignored"] {
        let repo = root.join(name);
        fs::create_dir_all(repo.join("sub"))?;
        git(&repo, &["init", "-q", "-b", "main"])?;
        fs::write(repo.join("sub/keep"), "keep\n")?;
        if name == "ignored" {
            fs::write(repo.join(".gitignore"), "progress/\n")?;
        } else if name != "untracked" {
            fill(&repo, PROGRESS, 100)?;
        }
        git(&repo, &["add", "-A"])?;
        git(&repo, &["commit", "-q", "-m", "init"])?;
    }
    git(
        &root.join("proj"),
        &["worktree", "add", "-q", "../proj-wt", "-b", "wt"],
    )?;
    for name in ["proj", "other", "ignored", "untracked"] {
        fill(&root.join(name), PROGRESS, 9000)?;
    }
    fill(&root.join("untracked"), ".claude/progress/current.md", 9000)?;
    fill(&root.join("staged"), PROGRESS, 9200)?;
    git(&root.join("staged"), &["add", PROGRESS])?;
    fill(&root.join("staged"), PROGRESS, 100)?;
    git(
        &root.join("small"),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            "../other",
            "sm",
        ],
    )?;
    git(&root.join("small"), &["commit", "-q", "-m", "sm"])?;
    fill(&root.join("small/sm"), PROGRESS, 9000)?;
    Ok(())
}

/// Commits whose landing, worktree and ratchet verdicts differ across the layout.
fn ratchet_commands() -> Vec<String> {
    [
        "git commit -m x",
        "git commit -am 'msg && more'",
        "git status && git commit -m x",
        "cd ../other && git commit -m x",
        "cd ../other/ && git commit -m x",
        "cd \"../other\" && git commit -m x",
        "cd ../small && git commit -m x",
        "cd ../staged && git commit -m x",
        "cd ../untracked && git commit -m x",
        "cd ../ignored && git commit -m x",
        "cd ../plain && git commit -m x",
        "cd ../proj-wt && git commit -m x",
        "cd ../proj/sub && git commit -m x",
        "cd ../small/sm && git commit -m x",
        "git -C ../other commit -m x",
        "git -C ../proj commit -m x",
        "git -C ../proj-wt commit -m x",
        "git -C ../small/sm commit -m x",
        "git -C ../missing commit -m x",
        "git -C sub commit -m x",
        "git -c a=b -C ../other commit -m x",
        "git --no-pager -C ../other commit -m x",
        "git -C ../other -C ../small commit -m x",
        "cd ../other && git commit -m x && git push",
        "cd ../other && git commit -m x && git status",
        "cd ../other && git commit -m x && npm test",
        "cd ../other && git commit -m 'x; cd y'",
        "git -C ../other commit -m a && git -C ../other commit -m b",
        "git -C ../other commit -m a && git -C ../small commit -m b",
        "git -C ../other commit -m a && git commit -m b",
        "cd ../other; git commit -m x",
        "cd ../other && cd ../small && git commit -m x",
        "cd ~/x && git commit -m x",
        "cd $D && git commit -m x",
        "env X=1 git commit -m x",
        "X=1 git commit -m x",
        "echo git -C ../other && git commit -m x",
        "git -C ../other log && git commit -m x",
        "cd ../other && git commit -m \"$(cat <<'TAG'\nmsg\ngit commit\nTAG\n)\"",
        "cd ../other && git commit -F - <<TAG\ncd ..\nTAG",
        "cd ../other && bash <<TAG\ngit commit -m x\nTAG",
        "git commit --no-verify -m x",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

// Covers: R11
#[test]
fn progress_ratchet_matches_the_rendered_copies_over_real_repositories() -> TestResult {
    let scratch = Scratch::new("guard-ratchet")?;
    ratchet_layout(&scratch.root)?;
    let home = scratch.path("home");
    fs::create_dir_all(&home)?;
    let claude = install_with_lane(
        &scratch,
        ".claude/hooks/guard-destructive.sh",
        "proj/.claude/hooks/guard-destructive.sh",
    )?;
    let codex = install_with_lane(
        &scratch,
        ".codex/hooks/guard-destructive.sh",
        "codexhost/.codex/hooks/guard-destructive.sh",
    )?;
    let proj = scratch.path("proj");
    let commands = ratchet_commands();
    let utf8 = [locales()[0]];
    // Claude with its home known: the session in the home repo, in another repo, outside any
    // repo and in the linked worktree. Codex with no home: the payload cwd decides, widened by
    // a leaked CLAUDE_PROJECT_DIR; a session inside `staged`, `untracked` and `ignored` is the
    // only way their own trees get measured.
    let configurations = [
        ("proj", Engine::Claude, true),
        ("other", Engine::Claude, true),
        ("plain", Engine::Claude, true),
        ("proj-wt", Engine::Claude, true),
        ("proj", Engine::Codex, false),
        ("other", Engine::Codex, false),
        ("other", Engine::Codex, true),
        ("staged", Engine::Codex, false),
        ("untracked", Engine::Codex, false),
        ("ignored", Engine::Codex, false),
    ];
    let runs: Vec<Result<Vec<String>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = configurations
            .iter()
            .map(|&(cwd, engine, leaked)| {
                let (script, proj, home, commands) = (&claude, &proj, &home, &commands);
                let (codex, utf8, cwd) = (&codex, &utf8, scratch.path(cwd));
                scope.spawn(move || {
                    // hook-input.sh: Codex reads the git toplevel of the payload's cwd.
                    let (script, project_dir) = if engine == Engine::Claude {
                        (script, proj.clone())
                    } else {
                        (codex, System.toplevel(&cwd).unwrap_or_else(|| cwd.clone()))
                    };
                    let host = Host {
                        project_dir,
                        cwd: cwd.clone(),
                        pwd: cwd.clone(),
                        home: Some(home.clone()),
                        claude_project_dir: leaked.then(|| proj.clone()),
                        cdpath: None,
                        hook_path: script.clone(),
                        path: None,
                    };
                    let mut env = vec![("HOME", home.as_str())];
                    if leaked {
                        env.push(("CLAUDE_PROJECT_DIR", proj.as_str()));
                    }
                    compare(script, engine, &host, &env, commands, utf8)
                        .map_err(|e| format!("{engine:?} in {cwd}: {e}"))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or_else(|_| Err("panicked".to_owned())))
            .collect()
    });
    let mut labels = Vec::new();
    for run in runs {
        labels.extend(run?);
    }
    for label in ["ratchet", "allow", "block/no-verify"] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}
