//! Injectable transport for external processes (spec 0060 D42, T18).
use navori_core::process::{Call, Failure, ProcessRunner, RealRunner, RecordedRunner, Request};
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

type TestResult = Result<(), Box<dyn Error>>;

struct Temp(PathBuf);
impl Temp {
    fn new(name: &str) -> Result<Self, Box<dyn Error>> {
        let dir = std::env::temp_dir().join(format!("navori-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn request<'a>(program: &'a str, args: &'a [&'a str], cwd: &'a Path) -> Request<'a> {
    const ENV: &[(OsString, OsString)] = &[];
    Request {
        program,
        args,
        cwd,
        env: ENV,
        input: None,
        timeout: Duration::from_secs(5),
    }
}

// Covers: R76
#[test]
fn la_respuesta_grabada_se_sirve_por_argv_y_registra_la_llamada() -> TestResult {
    let temp = Temp::new("process-runner")?;
    std::fs::write(
        temp.0.join("gh.json"),
        r#"{ "schema": 1, "tool": "gh", "version": "gh version 2.0.0 (2026-01-01)", "responses": [
            { "args": ["auth", "status"], "status": 0, "stdout": "Logged in\n" },
            { "args": ["api", "user"], "status": 4, "stdout": "", "stderr": "HTTP 401\n" }
        ] }"#,
    )?;
    std::fs::write(temp.0.join("notes.txt"), "not a recording")?;
    let runner = RecordedRunner::load(&temp.0)?;

    // A path to the program answers as its file name does.
    let ok = runner.run(&request("/usr/local/bin/gh", &["auth", "status"], &temp.0))?;
    assert_eq!(ok.status.code(), Some(0));
    assert_eq!(ok.stdout, b"Logged in\n");
    let failed = runner.run(&request("gh", &["api", "user"], &temp.0))?;
    assert_eq!(failed.status.code(), Some(4));
    // Same tool, other argv, and an unknown tool: no answer, never the real program.
    assert!(matches!(
        runner.run(&request("gh", &["auth"], &temp.0)),
        Err(Failure::Spawn(_))
    ));
    assert!(matches!(
        runner.run(&request("git", &["status"], &temp.0)),
        Err(Failure::Spawn(_))
    ));
    let version = Some("gh version 2.0.0 (2026-01-01)".to_owned());
    let call = |tool: &str, args: &[&str], version: Option<String>| Call {
        tool: tool.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        version,
    };
    assert_eq!(
        runner.calls(),
        vec![
            call("gh", &["auth", "status"], version.clone()),
            call("gh", &["api", "user"], version),
            call("gh", &["auth"], None),
            call("git", &["status"], None),
        ]
    );
    Ok(())
}

// Covers: R76
#[test]
fn una_grabacion_sin_version_o_de_otra_herramienta_no_carga() -> TestResult {
    for (name, body) in [
        (
            "gh.json",
            r#"{ "schema": 1, "tool": "gh", "version": " ", "responses": [] }"#,
        ),
        (
            "gh.json",
            r#"{ "schema": 1, "tool": "git", "version": "git 2", "responses": [] }"#,
        ),
        (
            "gh.json",
            r#"{ "schema": 2, "tool": "gh", "version": "gh 2", "responses": [] }"#,
        ),
        (
            "gh.json",
            r#"{ "schema": 1, "tool": "gh", "version": "gh 2", "responses": [], "extra": 1 }"#,
        ),
    ] {
        let temp = Temp::new("process-runner-bad")?;
        std::fs::write(temp.0.join(name), body)?;
        assert!(RecordedRunner::load(&temp.0).is_err(), "{body}");
    }
    Ok(())
}

// Covers: R76
#[test]
fn las_grabaciones_del_oraculo_cargan_y_el_runner_real_ejecuta() -> TestResult {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/js/rust-oracle/recordings");
    let runner = RecordedRunner::load(&dir)?;
    let git = runner.run(&request("git", &["--version"], &dir))?;
    assert!(git.stdout.starts_with(b"git version "));

    let env = [(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))];
    let real = RealRunner.run(&Request {
        env: &env,
        input: Some(b"echo"),
        ..request("cat", &[], &dir)
    })?;
    assert_eq!(real.stdout, b"echo");
    Ok(())
}
