//! Spec 0057 T28 (R11, R12): guard-destructive's payload extraction (`payload_load` over its
//! nine fields, `cmd=$(extract_cmd)`, `hook-input`'s project directory) and the Bash NUL
//! diagnostics, against the rendered Claude copy run under each extraction cascade.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use navori_hooks::hooks::guard_destructive::entry::{self, Context};
use navori_hooks::hooks::guard_destructive::repo::System;
use navori_hooks::hooks::guard_destructive::{Host, Rendered};
use navori_hooks::runner::{Engine, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::capture::{CaptureContext, ShellDialect};
use navori_hooks::shell::payload::{Extractor, Profile};

type TestResult = Result<(), Box<dyn Error>>;

fn workspace() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

/// Tools the guard runs besides the extractors; each profile's PATH holds exactly these plus
/// the extractors it names, so the shell walks the cascade the model is told about.
const TOOLS: [&str; 19] = [
    "awk", "cat", "date", "dirname", "env", "git", "grep", "head", "id", "locale", "ls", "mkdir",
    "mv", "rm", "sed", "touch", "tr", "uname", "wc",
];

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new() -> Result<Self, Box<dyn Error>> {
        let root =
            std::env::temp_dir().join(format!("navori-guard-payload-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: fs::canonicalize(&root)?,
        })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn locate(tool: &str) -> Result<String, Box<dyn Error>> {
    let output = Command::new("/bin/sh")
        .args(["-c", "command -v \"$1\"", "lookup", tool])
        .output()?;
    let path = String::from_utf8(output.stdout)?.trim().to_owned();
    if path.is_empty() {
        return Err(format!("the oracle needs {tool}").into());
    }
    Ok(path)
}

/// A PATH directory with the guard's tools and the profile's extractors.
fn tool_dir(root: &Path, extractor: Extractor) -> Result<PathBuf, Box<dyn Error>> {
    let name = format!("{extractor:?}").to_lowercase();
    let bin = root.join("bin").join(name);
    if bin.exists() {
        return Ok(bin);
    }
    fs::create_dir_all(&bin)?;
    let mut tools = TOOLS.to_vec();
    match extractor {
        Extractor::JqAndNode => tools.extend(["jq", "node"]),
        Extractor::JqOnly => tools.push("jq"),
        Extractor::Node => tools.push("node"),
        Extractor::Sed => {}
    }
    for tool in tools {
        std::os::unix::fs::symlink(locate(tool)?, bin.join(tool))?;
    }
    Ok(bin)
}

fn dialect() -> Result<ShellDialect, Box<dyn Error>> {
    let output = Command::new("/bin/bash").arg("--version").output()?;
    let version = String::from_utf8_lossy(&output.stdout);
    if version.starts_with("GNU bash, version 3.") {
        Ok(ShellDialect::Bash3)
    } else if version.starts_with("GNU bash, version 5.") {
        Ok(ShellDialect::Bash5)
    } else {
        Err(format!("unsupported oracle Bash: {version}").into())
    }
}

/// 1-based line of the only source line equal to `needle`.
fn line_of(source: &str, needle: &str) -> Result<usize, Box<dyn Error>> {
    let lines: Vec<usize> = source
        .lines()
        .enumerate()
        .filter(|(_, line)| *line == needle)
        .map(|(index, _)| index + 1)
        .collect();
    match lines.as_slice() {
        [line] => Ok(*line),
        _ => Err(format!("{needle:?} is not a unique source line").into()),
    }
}

/// Payloads that walk every branch of the cascade: NULs in consumed and unconsumed fields,
/// members behind a non-object, non-string commands, malformed JSON and raw NUL bytes.
fn payloads(cwd: &str) -> Vec<Vec<u8>> {
    let object = |command: &str, extra: &str| {
        format!(
            r#"{{"cwd":"{cwd}","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{{"command":{command}{extra}}}}}"#
        )
        .into_bytes()
    };
    let mut cases = vec![
        object(r#""git status""#, ""),
        object(r#""rm -rf /""#, ""),
        object(r#""rm -rf /\u0000x""#, ""),
        object(r#""git push --force origin main""#, r#","file_path":"a\u0000b""#),
        object(r#""git commit --no-verify -m x""#, r#","subagent_type":"x\u0000""#),
        object(r#""echo ok\n\n""#, ""),
        object("12e3", ""),
        object(r#"{"a":[1,"rm -rf /"]}"#, ""),
        object("false", ""),
        object("true", r#","file_path":"\u0000""#),
        object(r#""echo \ud83d\ude80""#, ""),
        object(r#""echo \ud800""#, ""),
        object(r#""git commit --no-verify""#, r#","notebook_path":"\ud800\u0000""#),
        format!(
            r#"{{"cwd":"{cwd}\u0000","tool_name":"Bash","tool_input":"rm -rf /","command":"rm -rf /"}}"#
        )
        .into_bytes(),
        format!(r#"{{"cwd":"{cwd}","agent_type":"a\u0000","tool_input":7,"command":"git push -f origin main"}}"#)
            .into_bytes(),
        format!(r#"{{"cwd":"{cwd}","tool_input":{{"command":"rm -rf /"}}"#).into_bytes(),
        br#"{"tool_input":{"command":"rm -rf ~"}}"#.to_vec(),
        b"[]".to_vec(),
        b"null".to_vec(),
        Vec::new(),
    ];
    let mut raw = object(r#""git push --force origin main""#, "");
    raw.insert(10, 0);
    cases.push(raw);
    cases
}

struct Shell {
    status: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_shell(
    script: &Path,
    payload: &[u8],
    cwd: &Path,
    path: &Path,
    lc_all: &str,
    home: &Path,
) -> Result<Shell, Box<dyn Error>> {
    let mut child = Command::new("/bin/bash")
        .arg(script)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", path)
        .env("HOME", home)
        .env("PWD", cwd)
        .env("LC_ALL", lc_all)
        .env("CLAUDE_PROJECT_DIR", cwd)
        .env("NAVORI_AUDITS_ROOT", home.join("no-audits"))
        .env("NAVORI_HOOK_IMPL", "shell")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or("stdin")?.write_all(payload)?;
    let output = child.wait_with_output()?;
    Ok(Shell {
        status: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

// Covers: R11, R12
#[test]
fn cada_cascada_de_extraccion_llega_al_veredicto_del_shell() -> TestResult {
    let scratch = Scratch::new()?;
    let project = scratch.root.join("project");
    let home = scratch.root.join("home");
    fs::create_dir_all(&home)?;
    let script = project.join(".claude/hooks/guard-destructive.sh");
    fs::create_dir_all(script.parent().ok_or("hooks")?)?;
    fs::create_dir_all(project.join(".claude/scripts"))?;
    fs::copy(
        workspace().join(".claude/hooks/guard-destructive.sh"),
        &script,
    )?;
    fs::copy(
        workspace().join(".claude/scripts/guard-search-routing.sh"),
        project.join(".claude/scripts/guard-search-routing.sh"),
    )?;
    let source = fs::read_to_string(&script)?;
    let rendered = Rendered::from_script(&source).ok_or("rendered assignments")?;
    let capture = CaptureContext {
        shell: dialect()?,
        script: &script,
        input_line: line_of(&source, "payload=${payload-$(cat)}")?,
        fallback_line: line_of(
            &source,
            r#"    printf -v "${_pf_spec%%=*}" '%s' "$(payload_field "${_pf_spec#*=}")""#,
        )?,
    };
    let utf8 = if cfg!(target_os = "macos") {
        ("en_US.UTF-8", Locale::Utf8)
    } else {
        ("C.UTF-8", Locale::GnuUtf8)
    };
    let project_text = project.to_string_lossy().into_owned();
    let mut mismatches = Vec::new();
    let mut compared = 0;
    for extractor in [
        Extractor::JqAndNode,
        Extractor::JqOnly,
        Extractor::Node,
        Extractor::Sed,
    ] {
        let bin = tool_dir(&scratch.root, extractor)?;
        for (lc_all, locale) in [utf8, ("C", Locale::C)] {
            let mut blocks = 0;
            let context = Context {
                engine: Engine::Claude,
                profile: Profile { extractor, locale },
                capture,
                rendered: rendered.clone(),
                host: Host {
                    pwd: project_text.clone(),
                    home: Some(home.to_string_lossy().into_owned()),
                    claude_project_dir: Some(project_text.clone()),
                    hook_path: script.to_string_lossy().into_owned(),
                    path: Some(bin.to_string_lossy().into_owned()),
                    ..Host::default()
                },
            };
            for payload in payloads(&project_text) {
                let shown = String::from_utf8_lossy(&payload).into_owned();
                let shell = run_shell(&script, &payload, &project, &bin, lc_all, &home)?;
                let native = match entry::evaluate(&payload, &context, &System) {
                    Ok(native) => native,
                    Err(error) => {
                        mismatches.push(format!("{extractor:?} {lc_all} {shown}: {error}"));
                        continue;
                    }
                };
                let status = match native.verdict {
                    Verdict::Permit => 0,
                    Verdict::Error => 1,
                    Verdict::Block => 2,
                };
                compared += 1;
                blocks += usize::from(status == 2);
                if (status, &native.stdout, &native.stderr)
                    != (shell.status, &shell.stdout, &shell.stderr)
                {
                    mismatches.push(format!(
                        "{extractor:?} {lc_all} {shown}\n  shell: {} {:?} {:?}\n  rust:  {status} {:?} {:?}",
                        shell.status,
                        String::from_utf8_lossy(&shell.stdout),
                        String::from_utf8_lossy(&shell.stderr),
                        String::from_utf8_lossy(&native.stdout),
                        String::from_utf8_lossy(&native.stderr),
                    ));
                }
            }
            eprintln!("{extractor:?} {lc_all}: {blocks} blocks");
            // The cascades read different commands, but each one still reaches block rules.
            assert!(blocks >= 3, "{extractor:?} {lc_all}: {blocks} blocks");
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {compared} differ:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    Ok(())
}
