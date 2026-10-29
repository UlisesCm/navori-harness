//! Native `render` (spec 0058 E3 M6): what runs natively and what is handed to the TS (R39).
//! The manifest entry is the one T17 will add; `crates/ported.json` does not list it yet.

use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use navori_cli::render::{RenderArgs, admit, parse_args};
use navori_cli::{dispatch, parser};
use navori_core::manifest::{Command, Manifest};

type TestResult = Result<(), Box<dyn Error>>;

const ENTRY: &str = r#"{"schema":2,"commands":[
    {"path":["render"],"flags":["cwd","dry-run","json"],"when":{"engines":["claude"]}}
]}"#;

fn manifest() -> Result<Manifest, Box<dyn Error>> {
    Ok(Manifest::parse(ENTRY)?)
}

fn entry(manifest: &Manifest) -> Result<&Command, Box<dyn Error>> {
    manifest.commands.first().ok_or_else(|| "no entry".into())
}

fn argv(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

/// A fresh scratch directory under cargo's per-target tmp dir.
fn scratch(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("render-{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

// Covers: R39
#[test]
fn only_the_declared_flags_in_their_plain_form_are_native() -> TestResult {
    let m = manifest()?;
    let e = entry(&m)?;
    let base = Path::new("/repo/sub");
    let parsed = |args: &[&str]| parse_args(&argv(args), e, base);
    assert_eq!(
        parsed(&["render"]),
        Some(RenderArgs {
            cwd: base.to_path_buf(),
            dry_run: false,
            json: false
        })
    );
    assert_eq!(
        parsed(&["render", "--cwd", "../other/./x", "--dry-run", "--json"]),
        Some(RenderArgs {
            cwd: PathBuf::from("/repo/other/x"),
            dry_run: true,
            json: true
        })
    );
    assert_eq!(
        parsed(&["render", "--cwd=/abs"]).map(|a| a.cwd),
        Some(PathBuf::from("/abs"))
    );
    for args in [
        &["render", "--apply"][..],
        &["render", "--force"],
        &["render", "--all"],
        &["render", "--prune"],
        &["render", "--verbose"],
        &["render", "--workspace", "web"],
        &["render", "--no-json"],
        &["render", "--json=true"],
        &["render", "--json", "--json"],
        &["render", "--cwd", "a", "--cwd", "b"],
        &["render", "--cwd"],
        &["render", "--cwd", ""],
        &["render", "--cwd", "--json"],
        &["render", "-j"],
        &["render", "extra"],
        &["render", "--", "--json"],
        &["sync"],
        &[],
    ] {
        assert_eq!(parsed(args), None, "{args:?}");
    }
    // A flag the entry does not declare is delegated even if the command knows it.
    let narrow =
        Manifest::parse(r#"{"schema":2,"commands":[{"path":["render"],"flags":["cwd"]}]}"#)?;
    assert_eq!(
        parse_args(&argv(&["render", "--json"]), entry(&narrow)?, base),
        None
    );
    Ok(())
}

// Covers: R39
#[test]
fn the_config_decides_before_any_output() -> TestResult {
    let m = manifest()?;
    let e = entry(&m)?;
    let dir = scratch("admit")?;
    let args = || RenderArgs {
        cwd: dir.clone(),
        dry_run: false,
        json: false,
    };
    // No config, or one readConfig rejects: the TS reports it.
    assert!(admit(args(), e).is_none());
    let write = |body: &str| fs::write(dir.join("navori.config.json"), body);
    for (body, native) in [
        // `engines` is required and non-empty in the schema.
        (r#"{"name":"demo","preset":"custom"}"#, false),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"]}"#,
            true,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude","codex"]}"#,
            false,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["pi"]}"#,
            false,
        ),
        (r#"{"name":"demo","preset":"custom","engines":[]}"#, false),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"],"monorepo":{"enabled":true,"workspaces":[{"name":"web","path":"apps/web"}]}}"#,
            false,
        ),
        (
            r#"{"name":"demo","preset":"custom","engines":["claude"],"monorepo":{"enabled":false,"workspaces":[{"name":"web","path":"apps/web"}]}}"#,
            true,
        ),
        ("{not json", false),
        (
            r#"{"name":"demo","preset":"custom","engines":"claude"}"#,
            false,
        ),
    ] {
        write(body)?;
        assert_eq!(admit(args(), e).is_some(), native, "{body}");
    }
    let missing = RenderArgs {
        cwd: dir.join("missing"),
        dry_run: false,
        json: false,
    };
    assert!(admit(missing, e).is_none());
    Ok(())
}

// Covers: R7, R39
#[test]
fn render_is_dispatched_only_when_an_entry_lists_it() -> TestResult {
    let m = manifest()?;
    let inv = parser::parse(&argv(&["render", "--json"]));
    assert!(dispatch(&m, &inv).is_some());
    assert!(dispatch(&Manifest::embedded()?, &inv).is_none());
    let apply = parser::parse(&argv(&["render", "--apply"]));
    assert!(dispatch(&m, &apply).is_none());
    Ok(())
}
