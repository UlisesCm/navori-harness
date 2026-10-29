//! Spec 0057 T28 (R11, R13): guard-destructive through the production registry. The rendered
//! copies of every engine, signed for the compiled implementation, answer through `navori-rust`
//! exactly as the shell does, and a native decision audits like the shell's exit trap.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_cli::hook::{Mode, run_with};
use navori_core::integrity::script_hash;
use navori_core::manifest::Manifest;

type TestResult = Result<(), Box<dyn Error>>;

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROUTING: &str = "scripts/guard-search-routing.sh";
const CHILD: &str = "NAVORI_GUARD_REGISTRY_CHILD";
const ENGINES: [&str; 3] = [".claude", ".codex", ".pi/navori"];

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn implementation() -> Result<&'static str, Box<dyn Error>> {
    Ok(navori_hooks::compiled::implementation_hash("guard-destructive").ok_or("compiled hash")?)
}

/// The production manifest entry, in `mode`.
fn manifest(mode: &str) -> Result<Manifest, Box<dyn Error>> {
    Ok(Manifest::parse(
        &serde_json::json!({
            "schema":2, "commands":[], "hooks":{"guard-destructive":{
                "mode":mode, "gating":true,
                "blocks":{"guard-destructive-base":HASH, "tgrep-search-lane":HASH},
                "deps":{ROUTING:HASH}, "impl":implementation()?
            }}
        })
        .to_string(),
    )?)
}

/// Install each engine's rendered copy and its search-routing script under `project`, signed
/// for the compiled implementation as the renderer signs it.
fn install(project: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let zero = "0".repeat(64);
    ENGINES
        .iter()
        .map(|engine| {
            let routing = fs::read(workspace().join(engine).join(ROUTING))?;
            let dest = project.join(engine).join(ROUTING);
            fs::create_dir_all(dest.parent().ok_or("scripts")?)?;
            fs::write(&dest, &routing)?;
            let rendered =
                fs::read_to_string(workspace().join(engine).join("hooks/guard-destructive.sh"))?;
            // A checkout copy may already carry the renderer's signature: sign its body again
            // for the implementation compiled into this test.
            let source = match rendered.split_once('\n') {
                Some((first, body)) if first.starts_with("# navori:native-hook ") => body,
                _ => rendered.as_str(),
            };
            let unsigned = format!(
                "# navori:native-hook v=1 file=sha256:{zero} impl={}\n{source}",
                implementation()?
            );
            let hash = script_hash(unsigned.as_bytes(), &[&routing]).ok_or("metadata")?;
            let script = project.join(engine).join("hooks/guard-destructive.sh");
            fs::create_dir_all(script.parent().ok_or("hooks")?)?;
            fs::write(&script, unsigned.replacen(&zero, &hash[7..], 1))?;
            Ok(script)
        })
        .collect()
}

fn payload(cwd: &str, command: &str) -> Vec<u8> {
    serde_json::json!({
        "session_id":"s1", "cwd":cwd, "hook_event_name":"PreToolUse", "tool_name":"Bash",
        "tool_input":{"command":command}
    })
    .to_string()
    .into_bytes()
}

fn native(
    script: &Path,
    manifest: &Manifest,
    mode: Mode,
    payload: &[u8],
) -> (u8, Vec<u8>, Vec<u8>) {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let argv = vec![
        OsString::from("--via-script"),
        script.as_os_str().to_owned(),
    ];
    let code = run_with(
        &argv,
        manifest,
        &*navori_cli::hook::NATIVE_HOOKS,
        mode,
        &mut &payload[..],
        &mut stdout,
        &mut stderr,
    );
    (code, stdout, stderr)
}

fn shell(script: &Path, payload: &[u8]) -> Result<std::process::Output, Box<dyn Error>> {
    let mut child = Command::new("bash")
        .arg(script)
        .env("NAVORI_HOOK_IMPL", "shell")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    io::Write::write_all(&mut child.stdin.take().ok_or("stdin")?, payload)?;
    Ok(child.wait_with_output()?)
}

/// Spool events with the per-run `ms` and `tsMs` removed, in file-name order.
fn spool_events(spool: &Path) -> Result<Vec<serde_json::Value>, Box<dyn Error>> {
    let mut names: Vec<PathBuf> = fs::read_dir(spool)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<_>>()?;
    names.sort();
    names
        .iter()
        .map(|path| {
            let mut event: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
            let metadata = event["metadata"].as_object_mut().ok_or("metadata")?;
            metadata.remove("ms");
            metadata.remove("tsMs");
            Ok(event)
        })
        .collect()
}

fn clear(spool: &Path) -> TestResult {
    for entry in fs::read_dir(spool)? {
        fs::remove_file(entry?.path())?;
    }
    Ok(())
}

/// Child half, in the scratch project with a clean environment.
fn child(project: &Path) -> TestResult {
    let cwd = project.to_string_lossy().into_owned();
    let scripts: Vec<PathBuf> = ENGINES
        .iter()
        .map(|engine| project.join(engine).join("hooks/guard-destructive.sh"))
        .collect();
    let active = manifest("active")?;
    let mut nul = payload(&cwd, "git push --force origin dev");
    nul.insert(12, 0);
    let mut cases: Vec<Vec<u8>> = [
        "git status",
        "",
        "rm -rf /",
        ":(){ :|:& };:",
        "git push --force origin dev",
        "git commit --no-verify -m x",
        "echo x > CLAUDE.md",
        "git reset --hard",
        "git clean -fdx",
        "grep -rn foo .",
        "engram delete x",
        "cp a .claude/settings.json",
    ]
    .iter()
    .map(|command| payload(&cwd, command))
    .collect();
    cases.push(nul);
    cases.push(b"{".to_vec());
    let mut mismatches = Vec::new();
    for script in &scripts {
        for case in &cases {
            let (code, stdout, stderr) = native(script, &active, Mode::Rust, case);
            let oracle = shell(script, case)?;
            if (Some(i32::from(code)), &stdout, &stderr)
                != (oracle.status.code(), &oracle.stdout, &oracle.stderr)
            {
                mismatches.push(format!(
                    "{} {}\n  shell: {:?} {:?} {:?}\n  rust:  {code} {:?} {:?}",
                    script.display(),
                    String::from_utf8_lossy(case),
                    oracle.status.code(),
                    String::from_utf8_lossy(&oracle.stdout),
                    String::from_utf8_lossy(&oracle.stderr),
                    String::from_utf8_lossy(&stdout),
                    String::from_utf8_lossy(&stderr),
                ));
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));

    // A native decision records the event the shell's exit trap records; shadow only the shell.
    let audits = Path::new(&std::env::var_os("NAVORI_AUDITS_ROOT").ok_or("audit root")?)
        .join(project.file_name().ok_or("project name")?);
    let spool = audits.join("spool-s1");
    let claude = scripts.first().ok_or("claude copy")?;
    for (command, verdict) in [
        ("rm -rf /", "block"),
        ("git push origin feature", "allow"),
        ("git status", "skip"),
    ] {
        let case = payload(&cwd, command);
        clear(&spool)?;
        native(claude, &active, Mode::Rust, &case);
        let decided = spool_events(&spool)?;
        assert_eq!(decided.len(), 1, "{command}");
        assert_eq!(decided[0]["metadata"]["verdict"], verdict, "{command}");
        assert_eq!(decided[0]["metadata"]["tool"], "Bash", "{command}");
        shell(claude, &case)?;
        let both = spool_events(&spool)?;
        assert_eq!(both.len(), 2, "{command}");
        assert_eq!(both[0], both[1], "{command}");
        clear(&spool)?;
        native(claude, &manifest("shadow")?, Mode::Auto, &case);
        assert_eq!(spool_events(&spool)?, decided, "{command}");
    }
    Ok(())
}

// Covers: R11, R13
#[test]
fn el_registro_de_produccion_responde_como_cada_copia_renderizada() -> TestResult {
    if let Some(project) = std::env::var_os(CHILD) {
        return child(Path::new(&project));
    }
    let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("guard-registry-{}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    let project = root.join("project");
    fs::create_dir_all(&project)?;
    let project = fs::canonicalize(&project)?;
    let status = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&project)
        .status()?;
    assert!(status.success());
    install(&project)?;
    let audits = root.join("audits");
    let spool = audits.join("project/spool-s1");
    fs::create_dir_all(&spool)?;
    fs::write(audits.join("project/session-s1.log"), "")?;
    for dir in [&audits, &audits.join("project"), &spool] {
        fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    }
    let output = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "el_registro_de_produccion_responde_como_cada_copia_renderizada",
            "--nocapture",
        ])
        .current_dir(&project)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &root)
        .env("PWD", &project)
        .env("LC_ALL", "C")
        .env("CLAUDE_PROJECT_DIR", &project)
        .env("NAVORI_AUDITS_ROOT", &audits)
        .env(CHILD, &project)
        .output()?;
    let _ = fs::remove_dir_all(&root);
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    let _ = io::stdout().flush();
    Ok(())
}
