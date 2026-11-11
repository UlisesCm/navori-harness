//! The Codex mirror this repository would render, generated once per test binary.
//!
//! `dev` dropped Codex from this repository's engines (318d5eff), so `.codex/` is no longer in
//! the checkout. The tests that compare against a rendered Codex copy render one instead: the
//! repository's `navori.config.json` with `codex` added to its engines, applied by the real TS
//! `render` command (Node strips the types) into a scratch project outside the checkout.
//! The TS renderer signs the native wrappers with this checkout's `crates/ported.json`, exactly
//! as `bun run render:apply` signs the Claude and Pi copies.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Name prefix of each scratch render in the temporary directory.
const PREFIX: &str = "navori-codex-render-";

fn workspace() -> PathBuf {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")))
}

/// Root of the scratch project holding the rendered `.codex/` tree.
///
/// # Errors
/// When the configuration cannot be read or the TS render fails; the message carries its output.
pub fn codex_root() -> Result<&'static Path, String> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(render)
        .as_ref()
        .map(PathBuf::as_path)
        .map_err(Clone::clone)
}

fn render() -> Result<PathBuf, String> {
    let workspace = workspace();
    // Outside the checkout: under the target directory the scratch would sit in its work tree.
    let parent = std::env::temp_dir();
    sweep(&parent);
    let root = parent.join(format!(
        "{PREFIX}{}-{}",
        env!("CARGO_CRATE_NAME"),
        std::process::id()
    ));
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    }
    let home = root.join(".home");
    std::fs::create_dir_all(&home).map_err(|e| format!("{}: {e}", home.display()))?;
    let source = workspace.join("navori.config.json");
    let text =
        std::fs::read_to_string(&source).map_err(|e| format!("{}: {e}", source.display()))?;
    let mut config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", source.display()))?;
    let engines = config
        .get_mut("engines")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or("navori.config.json has no engines array")?;
    if !engines.iter().any(|engine| engine == "codex") {
        engines.push("codex".into());
    }
    let rendered = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(root.join("navori.config.json"), format!("{rendered}\n"))
        .map_err(|e| format!("{}: {e}", root.display()))?;
    // Paths travel as environment variables: Node builds the module URL itself.
    let script = "const { pathToFileURL } = await import('node:url');\n\
         const r = await import(pathToFileURL(process.env.NAVORI_CODEX_RENDER_MODULE).href);\n\
         await r.renderCommand.run({ args: { cwd: process.env.NAVORI_CODEX_RENDER_ROOT, apply: true, json: false, force: false, _: [] }, rawArgs: [], cmd: r.renderCommand });";
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(&root)
        .env(
            "NAVORI_CODEX_RENDER_MODULE",
            workspace.join("packages/cli/src/commands/render.ts"),
        )
        .env("NAVORI_CODEX_RENDER_ROOT", &root)
        .env("HOME", &home)
        .env("NAVORI_BACKUP_ROOT", root.join(".backups"))
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| format!("cannot start node: {e}"))?;
    if !output.status.success() || !root.join(".codex/hooks").is_dir() {
        return Err(format!(
            "codex render failed ({}):\n{}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(root)
}

/// Remove the renders left by test processes that no longer run. The scratch outlives its
/// binary (a static has no destructor); where `/proc` cannot tell (macOS), nothing is removed.
/// Only real directories named `<PREFIX><crate>-<pid>` are candidates; another user's fail to
/// delete in a sticky temporary directory and are left alone.
fn sweep(parent: &Path) {
    if !Path::new("/proc/self").is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = name
            .to_str()
            .filter(|n| n.starts_with(PREFIX))
            .and_then(|n| n.rsplit_once('-'))
            .map(|(_, p)| p);
        let directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if directory
            && pid.is_some_and(|p| p.parse::<u32>().is_ok() && !Path::new("/proc").join(p).exists())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
