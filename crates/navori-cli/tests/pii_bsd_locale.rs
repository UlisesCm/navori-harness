//! pii-egress-guard under the BSD locale: the lane was not measured there, so the hook yields to
//! the shell before it reads a byte of stdin.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use navori_cli::hook::{Mode, NATIVE_HOOKS, run_with};
use navori_core::integrity::script_hash;
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHILD: &str = "NAVORI_PII_BSD_CHILD";
const CHILD_TEST: &str = "the_hook_yields_before_reading_stdin";
const HOOK: &str = "pii-egress-guard";
const CAUSE: &str = "hook is ineligible: pii-egress lane not measured under the BSD locale";
use navori_hooks::hooks::subagent_no_background::prepare::CANDIDATES;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        // Outside the checkout, as the other hook-entry tests do.
        let root = std::env::temp_dir().join(format!(
            "navori-pii-bsd-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        Ok(Self(fs::canonicalize(&root)?))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A stdin that fails the test if the hook touches it.
struct NeverRead;

impl Read for NeverRead {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        panic!("stdin must remain untouched during deferral")
    }
}

/// BSD `en_US.UTF-8` space class, as a macOS host's `grep`/`sed`/`tr` would report it.
fn bsd_space(c: char) -> bool {
    matches!(c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}'..='\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

/// What the facts probe's text script prints on a BSD host.
fn bsd_text_probe() -> Vec<u8> {
    let spaces: Vec<(usize, char)> = CANDIDATES
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, c)| bsd_space(*c))
        .collect();
    let mut out = Vec::new();
    for (index, c) in &spaces {
        out.extend_from_slice(format!("{}:{c}\n", index + 1).as_bytes());
    }
    out.push(0);
    out.extend_from_slice("S\n".repeat(spaces.len()).as_bytes());
    out.push(0);
    out.extend_from_slice(b"a b\0x\0y\n\0");
    out.extend_from_slice((CANDIDATES.len() * 2).to_string().as_bytes());
    out
}

/// Install `body` as an executable written by `/bin/cp`, a process of its own, so that no write
/// descriptor of this multithreaded test lives on in a forked sibling (ETXTBSY).
fn install(dir: &Path, name: &str, body: &str) -> TestResult {
    let staged = dir.join(format!("{name}.staged"));
    fs::write(&staged, body)?;
    let path = dir.join(name);
    let status = Command::new("/bin/cp").arg(&staged).arg(&path).status()?;
    assert!(status.success());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Child half: the exact preflight the host runs, with a stdin that panics if it is read.
fn child(project: &Path) -> TestResult {
    let script = project.join(format!(".claude/hooks/{HOOK}.sh"));
    let implementation =
        navori_hooks::compiled::implementation_hash(HOOK).ok_or("compiled hash")?;
    let manifest = Manifest::parse(
        &serde_json::json!({"schema":2, "commands":[], "hooks":{HOOK:{
            "mode":"active", "gating":true,
            "blocks":{"pii-egress-guard-base":HASH}, "impl":implementation
        }}})
        .to_string(),
    )?;
    let args = [
        OsString::from("--via-script"),
        script.as_os_str().to_owned(),
    ];
    for (mode, expected, expected_stderr) in [
        (Mode::Auto, 3, String::new()),
        (
            Mode::Rust,
            1,
            format!("navori-rust: hook deferred: {CAUSE}\n"),
        ),
    ] {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with(
            &args,
            &manifest,
            &*NATIVE_HOOKS,
            mode,
            &mut NeverRead,
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(code, expected, "{mode:?}");
        assert!(stdout.is_empty());
        assert_eq!(String::from_utf8(stderr)?, expected_stderr, "{mode:?}");
    }
    Ok(())
}

#[test]
fn the_hook_yields_before_reading_stdin() -> TestResult {
    if let Some(project) = std::env::var_os(CHILD) {
        return child(Path::new(&project));
    }
    let scratch = Scratch::new()?;
    let project = scratch.0.clone();
    let real_bash = ["/bin/bash", "/usr/bin/bash"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
        .ok_or("no bash on the host")?;
    // A signed copy of the rendered hook.
    let zero = "0".repeat(64);
    let implementation =
        navori_hooks::compiled::implementation_hash(HOOK).ok_or("compiled hash")?;
    let rendered = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../.claude/hooks/{HOOK}.sh")),
    )?;
    let body = match rendered.split_once('\n') {
        Some((first, body)) if first.starts_with("# navori:native-hook ") => body,
        _ => rendered.as_str(),
    };
    let unsigned =
        format!("# navori:native-hook v=1 file=sha256:{zero} impl={implementation}\n{body}");
    let hash = script_hash(unsigned.as_bytes(), &[]).ok_or("metadata")?;
    let script = project.join(format!(".claude/hooks/{HOOK}.sh"));
    fs::create_dir_all(script.parent().ok_or("hooks")?)?;
    fs::write(&script, unsigned.replacen(&zero, &hash[7..], 1))?;
    // A macOS-looking host: `uname` says Darwin, `locale charmap` says UTF-8 and the text probe
    // answers with the BSD space class. Every other probe runs on the real bash.
    let bin = project.join("bin");
    fs::create_dir(&bin)?;
    for tool in ["sed", "grep", "tr", "cat"] {
        symlink(Path::new("/usr/bin").join(tool), bin.join(tool))?;
    }
    let canned = project.join("text-probe.out");
    fs::write(&canned, bsd_text_probe())?;
    install(&bin, "uname", "#!/bin/sh\necho Darwin\n")?;
    install(&bin, "locale", "#!/bin/sh\necho UTF-8\n")?;
    install(
        &bin,
        "bash",
        &format!(
            "#!/bin/sh\n[ \"$3\" = text-probe ] && exec /bin/cat '{}'\nexec {real_bash} \"$@\"\n",
            canned.display()
        ),
    )?;
    let output = Command::new(std::env::current_exe()?)
        .args(["--exact", CHILD_TEST, "--nocapture"])
        .current_dir(&project)
        .env_clear()
        .env("PATH", &bin)
        .env("HOME", &project)
        .env("LC_ALL", "C.UTF-8")
        .env("CLAUDE_PROJECT_DIR", &project)
        .env(CHILD, &project)
        .output()?;
    assert!(
        output.status.success(),
        "child failed: {}\n{}{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    Ok(())
}
