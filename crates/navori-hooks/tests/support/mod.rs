//! Helpers shared by the hook test targets that compare against the live shell.

use std::error::Error;
use std::process::Command;
use std::sync::OnceLock;

use navori_hooks::shell::capture::ShellDialect;

/// Identify the actual oracle binary; unsupported diagnostic dialects fail instead of guessing.
///
/// The probe runs `/bin/bash --version` under `LC_ALL=C` without `LANGUAGE`, so a translated
/// banner ("GNU bash, versión …") cannot hide the binary. Only this probe pins the locale: the
/// shell under test keeps the environment each case gives it.
pub fn bash_dialect() -> Result<ShellDialect, Box<dyn Error>> {
    static DIALECT: OnceLock<Result<ShellDialect, String>> = OnceLock::new();
    let result = DIALECT.get_or_init(|| {
        let output = Command::new("/bin/bash")
            .arg("--version")
            .env("LC_ALL", "C")
            .env_remove("LANGUAGE")
            .output()
            .map_err(|error| error.to_string())?;
        let version = String::from_utf8_lossy(&output.stdout);
        if output.status.success() && version.starts_with("GNU bash, version 3.") {
            Ok(ShellDialect::Bash3)
        } else if output.status.success() && version.starts_with("GNU bash, version 5.") {
            Ok(ShellDialect::Bash5)
        } else {
            Err(format!("unsupported oracle Bash dialect: {version}"))
        }
    });
    result
        .as_ref()
        .copied()
        .map_err(|error| error.clone().into())
}
