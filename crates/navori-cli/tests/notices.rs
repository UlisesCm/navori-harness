//! The native version notices are on from 0.13.0 (spec 0062 T9, R85): the CLI prints the update
//! notice before a command and answers the two private workers itself. The behavior is compared
//! with the TS in `navori-oracle-tests/tests/notices_parity.rs`.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use navori_cli::notices::{ENABLED, worker};
use navori_core::tools::{notice, update_notice};

const BIN: &str = env!("CARGO_BIN_EXE_navori-rust");
type TestResult = Result<(), Box<dyn Error>>;

/// Install `body` at `path` as an executable that this process never held open for writing.
/// Tests run on parallel threads that fork: a write descriptor open here at that moment lives
/// on in the forked child until its exec, and running `path` in that window fails with ETXTBSY
/// ("Text file busy"). `/bin/cp` writes the file in its own process, which never forks.
fn install_executable(path: &Path, body: &str, mode: u32) -> TestResult {
    use std::os::unix::fs::PermissionsExt as _;
    let mut staged = path.as_os_str().to_owned();
    staged.push(".staged");
    let staged = PathBuf::from(staged);
    fs::write(&staged, body)?;
    let status = Command::new("/bin/cp").arg(&staged).arg(path).status()?;
    fs::remove_file(&staged)?;
    if !status.success() {
        return Err(format!("cp exited with {status}").into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

// Covers: R85
#[test]
fn los_avisos_nativos_estan_encendidos_desde_0_13_0() {
    const {
        assert!(ENABLED, "the notices are on from 0.13.0");
    }
    // Only an argv that is not a worker is run here: a real worker would reach the network.
    for args in [
        vec![],
        vec![OsString::from("render")],
        vec![OsString::from("--other-flag")],
    ] {
        assert!(worker(args.as_slice()).is_none(), "{args:?}");
    }
    // The private flags are the TS's, so a worker either CLI reserves is one the other can run.
    assert_eq!(update_notice::WORKER_ARG, "--navori-private-update-worker");
    assert_eq!(notice::WORKER_ARG, "--navori-private-tool-version-worker");
}

/// The update worker, run natively with the reserved token: it claims the token, asks the registry
/// through the `curl` of `PATH` (a fake that answers `9.9.9` with the status `--write-out` asks
/// for) and caches the answer in `latest.json`. A token that is not the reserved one does nothing.
// Covers: R85
#[test]
fn el_worker_de_actualizacion_nativo_reclama_su_token_y_guarda_la_version() -> TestResult {
    const TOKEN: &str = "0123abcd-0123-4abc-8def-0123456789ab";
    const OTHER: &str = "ffffffff-0123-4abc-8def-0123456789ab";
    for (name, token, claims) in [("reserved", TOKEN, true), ("other", OTHER, false)] {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("notices-{name}-{}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        let state = dir.join("home/.navori/update-notice");
        fs::create_dir_all(&state)?;
        fs::create_dir_all(dir.join("bin"))?;
        let record = dir.join("curl-argv");
        install_executable(
            &dir.join("bin/curl"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nout=\n\
                 while [ $# -gt 0 ]; do [ \"$1\" = --write-out ] && out=$2; shift; done\n\
                 printf '{{\"version\":\"9.9.9\"}}'\nprintf '%s' \"$out\" | sed 's/%{{http_code}}/200/'\n",
                record.display()
            ),
            0o755,
        )?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis();
        fs::write(
            state.join("attempt.json"),
            format!(r#"{{"at":{now},"token":"{TOKEN}"}}"#),
        )?;
        // The worker runs in the foreground here, so its writes are done when it returns.
        let out = Command::new(BIN)
            .args([update_notice::WORKER_ARG, token])
            .env_clear()
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", dir.join("bin").display()),
            )
            .env("HOME", dir.join("home"))
            .env("NAVORI_TS_CLI", "/nonexistent/index.js")
            .output()?;
        assert!(out.status.success(), "{name}: {out:?}");
        let attempt = fs::read_to_string(state.join("attempt.json"))?;
        let latest = fs::read_to_string(state.join("latest.json")).ok();
        let argv = fs::read_to_string(&record).ok();
        if claims {
            assert_eq!(
                attempt,
                format!(r#"{{"at":{now},"token":null}}"#),
                "claimed"
            );
            assert_eq!(
                argv.as_deref().and_then(|a| a.lines().last()),
                Some(update_notice::REGISTRY)
            );
            let latest = latest.ok_or("latest.json")?;
            assert!(
                latest.starts_with(r#"{"at":"#) && latest.ends_with(r#","version":"9.9.9"}"#),
                "{latest}"
            );
        } else {
            assert!(attempt.contains(TOKEN), "not claimed: {attempt}");
            assert_eq!(argv, None, "no request without the reserved token");
            assert_eq!(latest, None);
        }
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}
