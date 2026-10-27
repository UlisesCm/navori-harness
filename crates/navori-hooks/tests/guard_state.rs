//! Spec 0057 T28 (R11): rules 6c (the Pi arm) and 7 (discards of uncommitted work) against the
//! rendered guard-destructive.sh copies, run as the hosts run them, over real git repositories.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_hooks::hooks::guard_destructive::discard::System;
use navori_hooks::hooks::guard_destructive::{
    Host, Outcome, Rendered, ask_answer, block_stderr, evaluate,
};
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

/// What the shell printed and exited with, predicted from the Rust outcome.
fn predicted(cmd: &str, outcome: &Outcome, locale: Locale) -> Result<Run, Box<dyn Error>> {
    Ok(match outcome {
        Outcome::Block { message, route, .. } => Run {
            status: 2,
            stdout: String::new(),
            stderr: String::from_utf8(block_stderr(cmd, message, *route, locale))?,
        },
        Outcome::Skip { .. } | Outcome::Allow { ask: None, .. } => Run {
            status: 0,
            stdout: String::new(),
            stderr: String::new(),
        },
        Outcome::Allow {
            ask: Some(prefix), ..
        } => Run {
            status: 0,
            stdout: ask_answer(prefix, locale).0,
            stderr: String::new(),
        },
        Outcome::ProgressLane => return Err("progress lane is off in rendered copies".into()),
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
) -> Result<Vec<String>, Box<dyn Error>> {
    // The model reads the command as jq does; extract-cmd's sed fallback reads escaped quotes
    // differently, so a host without jq would compare two different commands.
    let jq = Command::new("jq").arg("--version").output();
    if !jq.is_ok_and(|output| output.status.success()) {
        return Err("jq is required to run the rendered hooks as the hosts do".into());
    }
    let rendered =
        Rendered::from_script(&fs::read_to_string(script)?).ok_or("rendered assignments")?;
    let mut labels = Vec::new();
    let mut mismatches = Vec::new();
    for (lc_all, locale) in locales() {
        for cmd in commands {
            let outcome = evaluate(cmd, &rendered, engine, host, &System, locale)?;
            let want = predicted(cmd, &outcome, locale)?;
            let got = run_hook(script, cmd, &host.cwd, env, lc_all)?;
            if got.status != want.status || got.stdout != want.stdout || got.stderr != want.stderr {
                mismatches.push(format!(
                    "{lc_all} {cmd:?}\n  shell: {} {:?} {:?}\n  rust:  {} {:?} {:?}",
                    got.status, got.stdout, got.stderr, want.status, want.stdout, want.stderr
                ));
            }
            labels.push(match &outcome {
                Outcome::Block { reason, .. } => format!("block/{reason}"),
                Outcome::Allow { ask: Some(_), .. } => "ask".to_owned(),
                Outcome::Allow { .. } => "allow".to_owned(),
                Outcome::Skip { .. } => "skip".to_owned(),
                Outcome::ProgressLane => "progress".to_owned(),
            });
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
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
    let script = scratch.install(
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
    };
    let labels = compare(&script, Engine::Pi, &host, &[("HOME", &home)], &commands)?;
    for label in ["block/managed-rewrite", "block/unspecified", "ask", "allow"] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}

// Covers: R11
#[test]
fn discards_match_the_rendered_claude_copy_over_real_repositories() -> TestResult {
    let scratch = Scratch::new("guard-discard")?;
    let script = scratch.install(
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
    };
    let project = scratch.path("proj");
    let env = [
        ("HOME", home.as_str()),
        ("CLAUDE_PROJECT_DIR", project.as_str()),
    ];
    let labels = compare(&script, Engine::Claude, &host, &env, &commands)?;
    for label in ["block/unspecified", "block/oversize", "allow"] {
        assert!(labels.iter().any(|l| l == label), "{label} never decided");
    }
    Ok(())
}
