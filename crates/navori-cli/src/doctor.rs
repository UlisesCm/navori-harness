//! `navori doctor` in text mode, native (spec 0060 T23, R73, R76; slice 5e5a).
//!
//! The text report of `commands/doctor.ts`: the config and filesystem notes, the per-repo findings
//! (retired assets and plugins, managed blocks, excluded blocks, plugins, presets, names, local
//! skills, libraries, drift, invariants, markers, hook scripts, legacy agents, model profiles,
//! control gaps, block order) and the next steps. `--json` is delegated for good: its report
//! carries the entrypoint's own provenance (`PERMANENT_DELEGATION`), so the manifest does not
//! declare it.
//!
//! Everything is decided before a byte is printed: the output is buffered and the TS runs instead
//! (`Outcome::Delegate`) when ANY of these holds:
//! - an argv shape citty could read differently, a positional, or colored human output;
//! - a config `readConfig` rejects or Rust does not model, and any scan that answers
//!   [`Unmodeled`] (including every branch [`compute_health_verdict`] delegates: workspaces,
//!   Codex health, native hooks, unreadable or corrupted `settings.json`);
//! - a scan the port does not model applies to this config ([`doctor_ts_only_scans`]: the OTel
//!   receiver, operational tools, the codegraph wiring, Pi health) or to this repo (a master plan
//!   registry; a git checkout, where `scanNativeHooks` always prints its note);
//! - any section of the machine and tools slice (5e5b) or the closing notes (5e5c) would print: those
//!   sections are not rendered here, so a non-empty scan sends the whole report to the TS;
//! - user-derived text in a note that is not plain ASCII, or a note line Rust cannot wrap.

use std::ffi::OsString;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use navori_core::config::Config;
use navori_core::diagnose::distribution::scan_distribution;
use navori_core::diagnose::doctor_assets::{
    ControlGap, ControlState, DEFAULT_PROGRESS_THRESHOLD_BYTES, MissingModelProfile, MissingTier,
    doctor_skill_dirs, scan_control_gaps, scan_doc_budget, scan_empty_user_sections,
    scan_flat_skills, scan_foreign_skill_indexes, scan_git_hygiene, scan_gitignore_harness,
    scan_interpolation_artifacts, scan_missing_model_profile, scan_nested_worktrees,
    scan_prettier_ignore, scan_progress_size, scan_quality_gate_readiness, scan_stale_harness,
    scan_triggerless_local_skills, scan_workspace_full_harness,
};
use navori_core::diagnose::doctor_local::LocalSkills;
use navori_core::diagnose::doctor_local::{
    ClaudeHookScripts, ExcludedBlocks, LegacyAgent, MalformedMarker, MalformedReason, NameMismatch,
    OrderReport, RetiredAssetOnDisk, RetiredBlock, classify_local_skills, is_placeholder_name,
    list_available_external_providers, list_context_markers, needs_external_provider_setup_hint,
    preset_override, scan_claude_hook_scripts, scan_excluded_blocks, scan_legacy_agents,
    scan_malformed_markers, scan_managed_order, scan_mcp_coherence, scan_monorepo_drift,
    scan_name_mismatch, scan_permission_mode, scan_retired_assets, scan_retired_plugin_leftovers,
};
use navori_core::diagnose::doctor_machine::{
    GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS, Host, scan_audit_root_permissions, scan_disk_usage,
    scan_external_tool_capabilities, scan_global_claude_md, scan_missing_external_tools,
    scan_missing_optional_tools, scan_pinned_version_drift, scan_stale_global_cli,
    scan_tool_updates, scan_version_advisories, scan_workspace_dead_repos, scan_workspace_drift,
    scan_workspace_link,
};
use navori_core::diagnose::doctor_user_scope::{
    doctor_ts_only_scans, scan_foreign_harness, scan_global_layer_leftovers,
};
use navori_core::diagnose::health::{
    DoctorHealth, DriftKind, DriftReport, HealthState, MarkerInfo, OrphanedEngineOutput, Unmodeled,
    configured_engines, known_drift_sources, list_markers, read_text, scan_managed_drift,
    scan_orphaned_engine_outputs, suggest_doctor_next_steps,
};
use navori_core::diagnose::verdict::{HealthVerdict, compute_health_verdict};
use navori_core::i18n::Doctor;
use navori_core::js_json::JsValue;
use navori_core::process::{Env, ProcessRunner, RealRunner, Request, has_binary};
use navori_core::render::context::Lang;
use navori_core::render::library_skills::unknown_libraries;
use navori_core::render::plugins::load_enabled_plugins;
use navori_core::tools::notice::Plugins;

use crate::backup::parse_leaf;
use crate::clack::{Clack, Symbol, plain_output};
use crate::native_io::{Output, member, read_config, specs_dir};
use crate::render::{home, pending_changes};
use crate::status::{kv, wrap};
use crate::{NativeCall, Outcome};

/// Columns clack wraps a note's message at (`getColumns()` of a non-TTY minus 6).
const NOTE_COLUMNS: usize = 74;

/// `EXTERNAL_PROVIDER_SETUP_RECIPE_URL`.
const SETUP_RECIPE_URL: &str = "https://github.com/UlisesCm/navori-harness/blob/main/docs/recipes/setup-proveedores-externos.md";

/// `navori doctor` (text).
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    run_args(call.args).map_or(Outcome::Delegate, Outcome::Exit)
}

fn run_args(args: &[OsString]) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "doctor" || rest.contains(&"--") {
        return None;
    }
    let options = parse_leaf(rest, &["cwd"], &["strict"])?;
    if !options.positionals.is_empty() || !plain_output() {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd = navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or(""));
    Some(doctor(&cwd, options.flag("strict"), &process_cwd)?.emit())
}

/// `config[key]` as a string, whatever its characters.
fn text(config: &JsValue, key: &str) -> Option<String> {
    match member(Some(config), key) {
        Some(JsValue::String(text)) => text.to_rust(),
        _ => None,
    }
}

/// User-derived text for a note: only plain ASCII is printed by clack unchanged and measured the
/// way [`crate::clack::width`] does.
fn ascii(text: &str) -> Option<&str> {
    text.is_ascii().then_some(text)
}

/// `config.project?.<key> ?? []` as strings; `None` when it is not an array of strings.
fn project_strings(config: &JsValue, key: &str) -> Option<Vec<String>> {
    match member(member(Some(config), "project"), key) {
        None | Some(JsValue::Undefined) => Some(Vec::new()),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::String(text) => text.to_rust(),
                _ => None,
            })
            .collect(),
        Some(_) => None,
    }
}

/// `process.getuid()`: `/proc/self`'s owner, or `id -u` where there is no procfs.
fn current_uid() -> Option<u32> {
    if let Ok(meta) = std::fs::metadata("/proc/self") {
        return Some(meta.uid());
    }
    let out = std::process::Command::new("id").arg("-u").output().ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

/// Whether `git -C <cwd> <args>` exits 0 (`None`: it could not be answered, so the caller
/// delegates; a git that cannot start is a definite "no", as in the TS).
fn git_succeeds(env: &Env, process_cwd: &Path, cwd: &str, args: &[&str]) -> Option<(bool, String)> {
    let mut full = vec!["-C", cwd];
    full.extend_from_slice(args);
    match RealRunner.run(&Request {
        program: "git",
        args: &full,
        cwd: process_cwd,
        env,
        input: None,
        timeout: Duration::from_secs(30),
    }) {
        Ok(output) => Some((
            output.status.code() == Some(0),
            String::from_utf8(output.stdout).ok()?,
        )),
        Err(navori_core::process::Failure::Spawn(_)) => Some((false, String::new())),
        Err(navori_core::process::Failure::Timeout) => None,
    }
}

/// `Some(())` when a scan answered and found nothing: the sections that would print for a finding
/// are not ported here, so anything else (a finding, or no answer) delegates.
fn none_found<T>(scan: Result<Vec<T>, Unmodeled>) -> Option<()> {
    scan.ok()?.is_empty().then_some(())
}

/// Same for the scans that answer `T | null`.
fn absent<T>(scan: Result<Option<T>, Unmodeled>) -> Option<()> {
    scan.ok()?.is_none().then_some(())
}

/// Every finding the native sections print, gathered (and every deferred scan confirmed empty)
/// before any output exists.
struct Report {
    lang: Lang,
    configured_engines: Vec<String>,
    claude_md: bool,
    agents_md: bool,
    claude_dir: bool,
    /// `(dir name, exists)`; `None` under `harness.sessionState: false` (#1579).
    progress: Option<(String, bool)>,
    markers: Vec<MarkerInfo>,
    orphans: Vec<OrphanedEngineOutput>,
    retired_assets: Vec<RetiredAssetOnDisk>,
    retired_blocks: Vec<RetiredBlock>,
    excluded: Option<ExcludedBlocks>,
    verdict: HealthVerdict,
    preset: String,
    preset_override: Option<String>,
    placeholder_name: Option<String>,
    name_mismatch: Option<NameMismatch>,
    local_skills: LocalSkills,
    stale_libraries: Vec<(String, bool, &'static [&'static str])>,
    drifts: Vec<DriftReport>,
    malformed: Vec<MalformedMarker>,
    claude_hooks: Option<ClaudeHookScripts>,
    legacy_agents: Vec<LegacyAgent>,
    available_providers: Vec<String>,
    model_profile: Vec<MissingModelProfile>,
    control_gaps: Vec<ControlGap>,
    order: Option<OrderReport>,
}

/// The scans `doctor` runs for this repo; `None` delegates.
#[allow(
    clippy::too_many_lines,
    reason = "one pass per scan of `doctorCommand.run`, in its order"
)]
fn gather(cwd: &str, config: &Config, process_cwd: &Path) -> Option<Report> {
    let root = Path::new(cwd);
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let host = Host {
        env: &env,
        process_cwd,
        runner: &RealRunner,
    };
    let engines = configured_engines(&config.data)?;
    let claude_md_exists = root.join("CLAUDE.md").exists();

    // Scans the port does not model: the config or the repo makes one of them apply.
    if !doctor_ts_only_scans(config).ok()?.is_empty() {
        return None;
    }
    let specs = specs_dir(Some(config))?;
    let master = navori_core::posix::resolve(cwd, &format!("{specs}/_master/index.json"));
    if Path::new(&master).exists() {
        return None;
    }
    // `scanNativeHooks` prints its note for every checkout (`git rev-parse --show-toplevel`).
    let (inside_git, _) = git_succeeds(&env, process_cwd, cwd, &["rev-parse", "--show-toplevel"])?;
    if inside_git {
        return None;
    }

    // Native sections.
    let claude_text = read_text(&root.join("CLAUDE.md")).ok()?.unwrap_or_default();
    let mut markers = list_markers(&claude_text);
    markers.extend(list_context_markers(root).ok()?);
    let plugins = load_enabled_plugins(member(Some(&config.data), "plugins")).ok()?;
    let verdict = compute_health_verdict(root, config, &plugins).ok()?;
    let known = known_drift_sources(&plugins.loaded);
    let drifts = scan_managed_drift(root, config, &known, navori_core::STAMP_VERSION).ok()?;
    let order = scan_managed_order(root, config).ok()?;
    let malformed = scan_malformed_markers(root, config).ok()?;
    let mut github = || -> Result<bool, Unmodeled> {
        let (found, stdout) = git_succeeds(
            &env,
            process_cwd,
            cwd,
            &["config", "--get", "remote.origin.url"],
        )
        .ok_or(Unmodeled)?;
        Ok(found && stdout.to_lowercase().contains("github.com"))
    };
    let available_providers = list_available_external_providers(config, &mut github).ok()?;
    let model_profile = scan_missing_model_profile(config).ok()?;
    let control_gaps = scan_control_gaps(config).ok()?;
    let claude_hooks = scan_claude_hook_scripts(root, config).ok()?;
    let legacy_agents = scan_legacy_agents(root, config).ok()?;
    let excluded = scan_excluded_blocks(config).ok()?;
    let preset_override = preset_override(root, config).ok()?;
    let name = text(&config.data, "name")?;
    let name_mismatch = scan_name_mismatch(root, config).ok()?;
    let orphans = scan_orphaned_engine_outputs(root, config).ok()?;
    let retired_assets = scan_retired_assets(root).ok()?;
    let retired = scan_retired_plugin_leftovers(root, config).ok()?;
    let local_skills = classify_local_skills(root, config).ok()?;
    let mut library_ids = project_strings(&config.data, "libraries")?;
    library_ids.extend(project_strings(&config.data, "extraLibraries")?);

    // Sections of 5e5b and 5e5c: not rendered here, so a finding delegates.
    let mut tool_plugins = Plugins::default();
    none_found(scan_missing_external_tools(
        &host,
        config,
        &mut tool_plugins,
    ))?;
    none_found(scan_pinned_version_drift(&host, config, &mut tool_plugins))?;
    none_found(scan_version_advisories(&host, config, &mut tool_plugins))?;
    let updates = scan_tool_updates(&host, config, &mut tool_plugins).ok()?;
    if !updates.updates.is_empty() || !updates.unparseable.is_empty() {
        return None;
    }
    none_found(scan_external_tool_capabilities(
        &host,
        config,
        &mut tool_plugins,
    ))?;
    none_found(scan_mcp_coherence(root, config))?;
    scan_missing_optional_tools(&host)
        .is_empty()
        .then_some(())?;
    absent(scan_audit_root_permissions(&host, current_uid()?))?;
    absent(scan_monorepo_drift(config))?;
    absent(scan_workspace_link(&host, root, config))?;
    none_found(scan_workspace_dead_repos(&host, root, config))?;
    none_found(scan_quality_gate_readiness(root, config, &|binary| {
        has_binary(&env, process_cwd, binary)
    }))?;
    let skill_dirs = doctor_skill_dirs(config).ok()?;
    none_found(scan_empty_user_sections(root, &skill_dirs, &env))?;
    none_found(scan_triggerless_local_skills(root, config, &env))?;
    none_found(scan_interpolation_artifacts(root, config))?;
    let backups = navori_core::backup::backup_root().ok()?;
    none_found(scan_disk_usage(&host, root, &backups))?;
    scan_progress_size(root, DEFAULT_PROGRESS_THRESHOLD_BYTES)
        .is_none()
        .then_some(())?;
    if engines.iter().any(|e| e == "claude") {
        absent(scan_global_claude_md(
            &host,
            GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS,
        ))?;
    }
    if claude_md_exists && pending_changes(root, config)? > 0 {
        return None;
    }
    absent(scan_nested_worktrees(root))?;
    for health in [
        scan_gitignore_harness(root, config).ok()?,
        scan_prettier_ignore(root, config).ok()?,
    ]
    .into_iter()
    .flatten()
    {
        if health.missing || health.drift {
            return None;
        }
    }
    if let Some(hygiene) = scan_git_hygiene(root, config, &RealRunner, &env).ok()?
        && (hygiene.specs_ignored.is_some()
            || !hygiene.ephemeral_not_ignored.is_empty()
            || !hygiene.ephemeral_tracked.is_empty()
            || hygiene.presets_ignored
            || hygiene.nested_state_unprotected)
    {
        return None;
    }
    absent(scan_doc_budget(root, config, navori_core::STAMP_VERSION))?;
    absent(scan_distribution(root, &config.data, &RealRunner, &env))?;
    absent(scan_workspace_drift(&host, root, config))?;
    none_found(scan_stale_harness(root, config, &env))?;
    absent(scan_workspace_full_harness(config))?;
    none_found(scan_flat_skills(root, &home()?, &env))?;
    none_found(scan_foreign_skill_indexes(root))?;
    none_found(scan_permission_mode(root))?;
    if let Some(foreign) = scan_foreign_harness(&host, cwd, config, None).ok()?
        && (!foreign.conflicts.is_empty()
            || !foreign.permissions.is_empty()
            || !foreign.stale_acknowledged.is_empty())
    {
        return None;
    }
    none_found(scan_global_layer_leftovers(&host))?;
    absent(scan_stale_global_cli(
        &host,
        root,
        config,
        navori_core::STAMP_VERSION,
    ))?;

    let progress = if member(member(Some(&config.data), "harness"), "sessionState")
        == Some(&JsValue::Bool(false))
    {
        None
    } else {
        let dir = match member(member(Some(&config.data), "progress"), "dir") {
            None | Some(JsValue::Undefined) => "progress".to_owned(),
            Some(JsValue::String(dir)) => dir.to_rust()?,
            Some(_) => return None,
        };
        let exists = Path::new(&format!("{cwd}/{dir}")).exists();
        Some((dir, exists))
    };
    Some(Report {
        lang: config.lang(),
        agents_md: root.join("AGENTS.md").exists(),
        claude_dir: root.join(".claude").exists(),
        configured_engines: engines,
        claude_md: claude_md_exists,
        progress,
        markers,
        orphans,
        retired_assets,
        retired_blocks: retired.blocks,
        excluded,
        verdict,
        preset: text(&config.data, "preset")?,
        preset_override,
        placeholder_name: is_placeholder_name(&name).then_some(name),
        name_mismatch,
        local_skills,
        stale_libraries: unknown_libraries(&library_ids),
        drifts,
        malformed,
        claude_hooks,
        legacy_agents,
        available_providers,
        model_profile,
        control_gaps,
        order,
    })
}

/// A `p.log.warn`/`error`/`info` body: `<title>(n)…:\n<rows>`.
fn lines(rows: Vec<String>) -> String {
    rows.join("\n")
}

/// `doctorCommand.run` (text) for `cwd`; `None` delegates.
#[allow(
    clippy::too_many_lines,
    reason = "one function per `doctorCommand.run`, section for section"
)]
fn doctor(cwd: &str, strict: bool, process_cwd: &Path) -> Option<Output> {
    let config_path = format!("{cwd}/navori.config.json");
    let mut clack = Clack::default();
    clack.intro("navori doctor");
    if !Path::new(cwd).exists() {
        clack.cancel(&format!("Directorio no encontrado: {cwd}"));
        return Some(clack.out);
    }
    if !Path::new(&config_path).exists() {
        clack.cancel(&Doctor(Lang::Es).no_config_run_init(&config_path));
        return Some(clack.out);
    }
    let config = read_config(cwd)??;
    let report = gather(cwd, &config, process_cwd)?;
    let td = Doctor(report.lang);
    let lang = report.lang;

    // `readConfig` warns on the doctor read and again inside the render dry run.
    for _ in 0..1 + usize::from(report.claude_md) {
        for warning in &config.warnings {
            clack.out.stderr.push_str(&format!("{warning}\n"));
        }
    }

    let note = |clack: &mut Clack, message: &str, title: &str| -> Option<()> {
        clack.note(&wrap(message, NOTE_COLUMNS)?, title)
    };
    let fail = "\u{2717}";
    let update = "\u{21e1}";
    let bullet = "\u{b7}";

    // Config and filesystem checks.
    let workspace = match member(Some(&config.data), "workspace") {
        None | Some(JsValue::Undefined) => "(none)".to_owned(),
        Some(JsValue::String(w)) => ascii(&w.to_rust()?)?.to_owned(),
        Some(_) => return None,
    };
    let field = |key: &str| text(&config.data, key).and_then(|v| ascii(&v).map(str::to_owned));
    let rows: Vec<(&str, String)> = vec![
        ("name", field("name")?),
        ("version", field("version")?),
        ("workspace", workspace),
        ("engines", {
            report
                .configured_engines
                .iter()
                .map(|e| ascii(e).map(str::to_owned))
                .collect::<Option<Vec<_>>>()?
                .join(", ")
        }),
        ("preset", field("preset")?),
        ("language", field("language")?),
        ("branchBase", field("branchBase")?),
        ("commits", field("commits")?),
    ];
    note(
        &mut clack,
        &kv(&rows),
        &td.config_note_title(ascii(&config_path)?),
    )?;
    let check = |ok: bool| if ok { "\u{2713}" } else { "\u{25cb}" };
    let agents_row = report
        .configured_engines
        .iter()
        .any(|e| e == "agents-md" || e == "codex");
    let mut checks = vec![format!("  {} CLAUDE.md", check(report.claude_md))];
    if agents_row {
        checks.push(format!("  {} AGENTS.md", check(report.agents_md)));
    }
    checks.push(format!("  {} .claude/", check(report.claude_dir)));
    if let Some((dir, exists)) = &report.progress {
        checks.push(format!("  {} {}/", check(*exists), ascii(dir)?));
    }
    note(&mut clack, &checks.join("\n"), td.fs_checks_title())?;

    if !report.orphans.is_empty() {
        let total: usize = report.orphans.iter().map(|o| o.paths.len()).sum();
        let mut rows = Vec::new();
        for orphan in &report.orphans {
            for path in &orphan.paths {
                rows.push(format!(
                    "  {bullet} {}  {}",
                    ascii(path)?,
                    td.orphaned_engine_output_row(&orphan.engine)
                ));
            }
        }
        note(
            &mut clack,
            &lines(rows),
            &td.orphaned_engine_outputs_title(&total.to_string()),
        )?;
    }

    if !report.retired_assets.is_empty() {
        let mut rows = Vec::new();
        for asset in &report.retired_assets {
            let successor = ascii(asset.successor.as_deref().unwrap_or(match lang {
                Lang::Es => "ninguno",
                Lang::En => "none",
            }))?;
            let row = match asset.reason {
                None => td.retired_asset_row_delete(successor),
                Some("newer") => td.retired_asset_row_newer(successor),
                Some("modified") => td.retired_asset_row_modified(successor),
                Some(_) => td.retired_asset_row_foreign(successor),
            };
            rows.push(format!("  {update} {}  {row}", ascii(&asset.path)?));
        }
        note(
            &mut clack,
            &lines(rows),
            &td.retired_assets_title(&report.retired_assets.len().to_string()),
        )?;
    }

    if !report.retired_blocks.is_empty() {
        let mut rows = Vec::new();
        for block in &report.retired_blocks {
            rows.push(format!(
                "  {update} {}#{}  {}",
                ascii(&block.path)?,
                ascii(&block.id)?,
                td.retired_plugin_block_row(&block.id)
            ));
        }
        let title = td.retired_plugins_title(&rows.len().to_string());
        note(&mut clack, &lines(rows), &title)?;
    }

    if !report.markers.is_empty() {
        let mut rows = Vec::new();
        for marker in &report.markers {
            let version = match marker.version.as_deref() {
                Some(v) => format!(" v{}", ascii(v)?),
                None => format!(" {}", td.no_version()),
            };
            let source = match marker.source.as_deref() {
                Some(s) => ascii(s)?.to_owned(),
                None => td.unknown_source().to_owned(),
            };
            rows.push(format!(
                "  {bullet} {}  \u{2190}  {source}{version}",
                ascii(&marker.id)?
            ));
        }
        note(
            &mut clack,
            &lines(rows),
            &td.managed_blocks_title(&report.markers.len().to_string()),
        )?;
    }

    if let Some(excluded) = &report.excluded {
        if !excluded.excluded.is_empty() {
            let mut rows = Vec::new();
            for id in &excluded.excluded {
                rows.push(format!(
                    "  {bullet} {}  {}",
                    ascii(id)?,
                    td.excluded_block_row()
                ));
            }
            note(
                &mut clack,
                &lines(rows),
                &td.excluded_blocks_title(&excluded.excluded.len().to_string()),
            )?;
        }
        if !excluded.non_excludable.is_empty() {
            let rows = excluded
                .non_excludable
                .iter()
                .map(|id| format!("  {update} {id}  {}", td.non_excludable_block_row(id)))
                .collect();
            clack.log(
                Symbol::Warn,
                &td.non_excludable_blocks(&excluded.non_excludable.len().to_string(), &lines(rows)),
            );
        }
        if !excluded.unknown.is_empty() {
            let rows = excluded
                .unknown
                .iter()
                .map(|id| format!("  {update} {id}  {}", td.unknown_excluded_block_row(id)))
                .collect();
            clack.log(
                Symbol::Warn,
                &td.unknown_excluded_blocks(&excluded.unknown.len().to_string(), &lines(rows)),
            );
        }
    }

    let verdict = &report.verdict;
    if !verdict.missing_plugins.is_empty() {
        let rows = verdict
            .missing_plugins
            .iter()
            .map(|m| format!("  {fail} {}  \u{2014} {}", m.id, m.reason))
            .collect();
        clack.log(
            Symbol::Warn,
            &td.missing_plugins(&verdict.missing_plugins.len().to_string(), &lines(rows)),
        );
    }
    if let Some(preset) = &verdict.missing_preset {
        clack.log(Symbol::Warn, &td.missing_preset(preset));
    }
    if let Some(preset) = &report.preset_override {
        clack.log(Symbol::Warn, &td.preset_override(preset));
    }
    if let Some(name) = &report.placeholder_name {
        clack.log(Symbol::Warn, &td.placeholder_name(name));
    }
    if let Some(mismatch) = &report.name_mismatch {
        clack.log(
            Symbol::Warn,
            &td.name_mismatch(
                &mismatch.config_name,
                &mismatch.dir_name,
                &mismatch.suggested_name,
            ),
        );
    }
    if !verdict.missing_preset_files.is_empty() {
        let rows = verdict
            .missing_preset_files
            .iter()
            .map(|f| {
                format!(
                    "  {fail} {}  {}",
                    f.id,
                    td.missing_preset_file_row(&f.rel_path)
                )
            })
            .collect();
        clack.log(
            Symbol::Warn,
            &td.missing_preset_files(
                &report.preset,
                &verdict.missing_preset_files.len().to_string(),
                &lines(rows),
            ),
        );
    }

    if !report.local_skills.missing.is_empty() {
        let rows = report
            .local_skills
            .missing
            .iter()
            .map(|id| format!("  {fail} {id}  {}", td.missing_local_skill_row(id)))
            .collect();
        clack.log(
            Symbol::Warn,
            &td.missing_local_skills(&report.local_skills.missing.len().to_string(), &lines(rows)),
        );
    }
    for id in &report.local_skills.foreign {
        clack.log(
            Symbol::Warn,
            &td.local_skill_foreign_pointer(&format!(".agents/skills/{id}/SKILL.md")),
        );
    }

    if !report.stale_libraries.is_empty() {
        let rows = report
            .stale_libraries
            .iter()
            .map(|(id, removed, successors)| {
                let row = if *removed && !successors.is_empty() {
                    td.unknown_library_removed_row(&successors.join(", "))
                } else if *removed {
                    td.unknown_library_removed_row_bare().to_owned()
                } else {
                    td.unknown_library_unknown_row().to_owned()
                };
                format!("  {update} {id}  {row}")
            })
            .collect();
        clack.log(
            Symbol::Warn,
            &td.unknown_libraries(&report.stale_libraries.len().to_string(), &lines(rows)),
        );
    }

    if !report.drifts.is_empty() {
        let rows = report
            .drifts
            .iter()
            .map(|d| drift_row(d, td, update))
            .collect();
        let hint = if report.drifts.iter().any(|d| d.kind == DriftKind::Content) {
            td.drift_hint_content()
        } else {
            td.drift_hint_downgrade()
        };
        clack.log(
            Symbol::Warn,
            &td.drift(&report.drifts.len().to_string(), hint, &lines(rows)),
        );
    }

    // `corruptedSettings` is always empty here: `compute_health_verdict` delegates on a
    // `settings.json` it cannot read or parse.
    if !verdict.missing_invariants.is_empty() {
        let rows = verdict
            .missing_invariants
            .iter()
            .map(|m| {
                format!(
                    "  {fail} {}  {}",
                    m.invariant,
                    td.missing_invariant_row(&m.source)
                )
            })
            .collect();
        clack.log(
            Symbol::Error,
            &td.missing_invariants(&verdict.missing_invariants.len().to_string(), &lines(rows)),
        );
    }

    if !report.malformed.is_empty() {
        let rows = report
            .malformed
            .iter()
            .map(|m| {
                let why = match m.reason {
                    MalformedReason::MissingId => td.malformed_marker_row_missing_id(),
                    MalformedReason::Unterminated => td.malformed_marker_row_unterminated(),
                };
                format!(
                    "  {update} {}:{}  {why} {bullet} {}",
                    m.file_path, m.line, m.snippet
                )
            })
            .collect();
        clack.log(
            Symbol::Warn,
            &td.malformed_markers(&report.malformed.len().to_string(), &lines(rows)),
        );
    }

    if !verdict.duplicate_markers.is_empty() {
        let rows = verdict
            .duplicate_markers
            .iter()
            .map(|m| {
                format!(
                    "  {fail} {}:{}  {}",
                    m.file_path,
                    m.id,
                    td.duplicate_marker_row(&m.count.to_string())
                )
            })
            .collect();
        clack.log(
            Symbol::Error,
            &td.duplicate_markers(&verdict.duplicate_markers.len().to_string(), &lines(rows)),
        );
    }

    if let Some(scripts) = &report.claude_hooks {
        if !scripts.missing.is_empty() {
            let rows = scripts
                .missing
                .iter()
                .map(|p| format!("  {fail} {p}  {}", td.claude_hook_script_missing_row()))
                .collect();
            clack.log(
                Symbol::Warn,
                &td.claude_hook_scripts_missing(&scripts.missing.len().to_string(), &lines(rows)),
            );
        }
        if !scripts.not_executable.is_empty() {
            let rows = scripts
                .not_executable
                .iter()
                .map(|p| {
                    format!(
                        "  {update} {p}  {}",
                        td.claude_hook_script_not_executable_row()
                    )
                })
                .collect();
            clack.log(
                Symbol::Warn,
                &td.claude_hook_scripts_not_executable(
                    &scripts.not_executable.len().to_string(),
                    &lines(rows),
                ),
            );
        }
    }

    if !report.legacy_agents.is_empty() {
        let rows = report
            .legacy_agents
            .iter()
            .map(|l| {
                format!(
                    "  {update} .claude/agents/{}.md  {}",
                    l.legacy_name,
                    td.legacy_agent_row(&l.canonical)
                )
            })
            .collect();
        clack.log(
            Symbol::Warn,
            &td.legacy_agents(&report.legacy_agents.len().to_string(), &lines(rows)),
        );
    }

    if !report.available_providers.is_empty() {
        let rows = report
            .available_providers
            .iter()
            .map(|id| format!("  {bullet} {id}  {}", td.available_provider_row(id)))
            .collect();
        clack.log(
            Symbol::Info,
            &td.available_external_providers(
                &report.available_providers.len().to_string(),
                &lines(rows),
            ),
        );
    }
    // The tgrep and codegraph reports and the missing tools are empty here (their scans are
    // confirmed empty or delegated above), so only the available providers can raise the hint.
    if needs_external_provider_setup_hint(&[], &report.available_providers, false, false) {
        clack.log(
            Symbol::Info,
            &td.external_provider_setup_hint(SETUP_RECIPE_URL),
        );
    }

    if !report.model_profile.is_empty() {
        let rows = report
            .model_profile
            .iter()
            .map(|m| {
                let missing: Vec<&str> = m
                    .missing
                    .iter()
                    .map(|tier| match tier {
                        MissingTier::Model => "model",
                        MissingTier::Effort => "effort",
                    })
                    .collect();
                format!(
                    "  {update} {}  {}",
                    m.agent,
                    td.missing_model_profile_row(&missing.join(", "))
                )
            })
            .collect();
        clack.log(
            Symbol::Warn,
            &td.missing_model_profile(&report.model_profile.len().to_string(), &lines(rows)),
        );
    }

    let gap_row = |g: &ControlGap| {
        let state = match g.state {
            ControlState::Advisory => "advisory",
            ControlState::Unsupported => "unsupported",
        };
        format!(
            "  {bullet} {} \u{b7} {}  {state} \u{2014} {}",
            g.engine, g.control, g.reason
        )
    };
    let info: Vec<String> = report
        .control_gaps
        .iter()
        .filter(|g| !g.warn)
        .map(gap_row)
        .collect();
    let warn: Vec<String> = report
        .control_gaps
        .iter()
        .filter(|g| g.warn)
        .map(gap_row)
        .collect();
    if !info.is_empty() {
        clack.log(
            Symbol::Info,
            &td.control_gaps(&info.len().to_string(), &lines(info)),
        );
    }
    if !warn.is_empty() {
        clack.log(
            Symbol::Warn,
            &td.control_gaps_warn(&warn.len().to_string(), &lines(warn)),
        );
    }

    if let Some(order) = &report.order {
        let spotlight = order
            .misplaced_first
            .as_ref()
            .map_or_else(String::new, |m| {
                td.order_spotlight(&m.id, &m.current_pos.to_string(), &m.total.to_string())
            });
        let current = order.current.join(", ");
        let expected = order.expected.join(", ");
        clack.log(
            Symbol::Warn,
            &if order.interleaved {
                td.order_interleaved(&current, &expected, &spotlight)
            } else {
                td.order_reorderable(&current, &expected, &spotlight)
            },
        );
    }

    // `renderPending` is not part of the doctor's own next steps.
    let state = HealthState {
        claude_md_exists: report.claude_md,
        missing_plugins: verdict.missing_plugins.len(),
        drifts: &report.drifts,
        render_pending: None,
    };
    let steps: Vec<String> = suggest_doctor_next_steps(
        &state,
        DoctorHealth {
            order_report: report.order.as_ref(),
            legacy_agents: &report.legacy_agents,
        },
        lang,
    )
    .iter()
    .map(|s| format!("  {bullet} {s}"))
    .collect();
    note(&mut clack, &steps.join("\n"), td.next_steps_title())?;

    let has_issues = !verdict.ok;
    // Without a `mcpCoherenceIssues` finding (delegated above), only drift can fail `--strict`.
    let strict_fail = strict && !report.drifts.is_empty();
    clack.outro(if has_issues {
        td.outro_issues()
    } else if strict_fail {
        td.outro_drift_strict()
    } else {
        td.outro_ok()
    });
    clack.out.code = if has_issues { 2 } else { u8::from(strict_fail) };
    Some(clack.out)
}

/// One drift row of the warning.
fn drift_row(d: &DriftReport, td: Doctor, update: &str) -> String {
    let at = format!("{}:{}", d.file_path, d.marker_id);
    if d.kind == DriftKind::Content {
        return format!(
            "  ! {at}  hash {} \u{2260} {}  {}",
            d.expected_hash.as_deref().unwrap_or("undefined"),
            d.actual_hash.as_deref().unwrap_or("undefined"),
            td.drift_content_row(&d.source)
        );
    }
    let suffix = if d.kind == DriftKind::Harness {
        td.drift_harness_row().to_owned()
    } else {
        td.drift_downgrade_row(&d.source)
    };
    format!(
        "  {update} {at}  {} \u{2192} {}  {suffix}",
        d.from_version.as_deref().unwrap_or("undefined"),
        d.to_version.as_deref().unwrap_or("undefined")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drift(kind: DriftKind) -> DriftReport {
        DriftReport {
            file_path: "CLAUDE.md".to_owned(),
            marker_id: "idioma-rol".to_owned(),
            source: "@navori/core".to_owned(),
            kind,
            from_version: Some("2.0.0".to_owned()),
            to_version: Some("1.0.0".to_owned()),
            expected_hash: Some("aaaa".to_owned()),
            actual_hash: Some("bbbb".to_owned()),
        }
    }

    // Covers: R73
    #[test]
    fn drift_rows_follow_the_ts_shapes_in_both_languages() {
        let es = Doctor(Lang::Es);
        let en = Doctor(Lang::En);
        assert_eq!(
            drift_row(&drift(DriftKind::Content), es, "\u{21e1}"),
            "  ! CLAUDE.md:idioma-rol  hash aaaa \u{2260} bbbb  (@navori/core, content edited)"
        );
        assert_eq!(
            drift_row(&drift(DriftKind::Downgrade), en, "\u{21e1}"),
            "  \u{21e1} CLAUDE.md:idioma-rol  2.0.0 \u{2192} 1.0.0  (@navori/core, disk ahead)"
        );
        assert!(drift_row(&drift(DriftKind::Harness), es, "\u{21e1}").ends_with("adelantado)"));
    }

    // Covers: R73
    #[test]
    fn user_derived_note_text_must_be_ascii() {
        assert_eq!(ascii("plain"), Some("plain"));
        assert_eq!(ascii("ni\u{f1}o"), None);
    }

    // Covers: R73
    #[test]
    fn argv_shapes_citty_could_read_differently_delegate() {
        let args = |list: &[&str]| -> Vec<OsString> { list.iter().map(OsString::from).collect() };
        assert!(run_args(&args(&["doctor", "--json"])).is_none());
        assert!(run_args(&args(&["doctor", "extra"])).is_none());
        assert!(run_args(&args(&["doctor", "--", "x"])).is_none());
        assert!(run_args(&args(&["doctor", "--cwd"])).is_none());
    }
}
