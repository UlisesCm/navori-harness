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
//! - a workspace with a full harness (`scanWorkspaceFullHarness`): its note is not rendered, so
//!   any answer other than "none" sends the whole report to the TS. The other closing notes
//!   (stale global CLI, harness `.gitignore` and `.prettierignore`, git hygiene, workspace drift,
//!   frozen harness, flat skills, foreign skill indexes, permission mode, foreign harness, global
//!   layer leftovers) and the machine and tools sections of 5e5b are native;
//! - user-derived text in a note that is not plain ASCII, or a note line Rust cannot wrap.

use std::ffi::OsString;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use navori_core::config::Config;
use navori_core::diagnose::distribution::{DistributionReport, scan_distribution};
use navori_core::diagnose::doctor_assets::{
    ArtifactReason, BlockKind, ContextDelivery, ControlGap, ControlState,
    DEFAULT_PROGRESS_THRESHOLD_BYTES, DocBudgetLever, DocBudgetReport, EmptyUserSection, FlatSkill,
    ForeignSkillIndex, GateBlocker, GateReadinessIssue, GitHygieneReport, IgnoreHealth,
    InterpolationArtifact, MissingModelProfile, MissingTier, NestedWorktreeConflict,
    ProgressSizeIssue, StaleHarness, TriggerlessSkill, doctor_skill_dirs, scan_control_gaps,
    scan_doc_budget, scan_empty_user_sections, scan_flat_skills, scan_foreign_skill_indexes,
    scan_git_hygiene, scan_gitignore_harness, scan_interpolation_artifacts,
    scan_missing_model_profile, scan_nested_worktrees, scan_prettier_ignore, scan_progress_size,
    scan_quality_gate_readiness, scan_stale_harness, scan_triggerless_local_skills,
    scan_workspace_full_harness,
};
use navori_core::diagnose::doctor_local::LocalSkills;
use navori_core::diagnose::doctor_local::{
    ClaudeHookScripts, ExcludedBlocks, LegacyAgent, MalformedMarker, MalformedReason,
    McpCoherenceIssue, MonorepoDrift, NameMismatch, OrderReport, PermissionModeConflict,
    RetiredAssetOnDisk, RetiredBlock, classify_local_skills, is_placeholder_name,
    list_available_external_providers, list_context_markers, needs_external_provider_setup_hint,
    preset_override, scan_claude_hook_scripts, scan_excluded_blocks, scan_legacy_agents,
    scan_malformed_markers, scan_managed_order, scan_mcp_coherence, scan_monorepo_drift,
    scan_name_mismatch, scan_permission_mode, scan_retired_assets, scan_retired_plugin_leftovers,
};
use navori_core::diagnose::doctor_machine::{
    AuditRootOpen, DiskUsageIssue, DiskUsageTarget, ExternalToolCapabilityGap,
    GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS, GlobalClaudeMdIssue, Host, MissingExternalTool,
    MissingOptionalTool, PinnedVersionDrift, StaleGlobalCli, ToolUpdates, VersionAdvisoryHit,
    WorkspaceDeadReposIssue, WorkspaceDriftReport, WorkspaceLinkIssue, claude_user_dir,
    scan_audit_root_permissions, scan_disk_usage, scan_external_tool_capabilities,
    scan_global_claude_md, scan_js_launcher_on_path, scan_missing_external_tools,
    scan_missing_optional_tools, scan_pinned_version_drift, scan_stale_global_cli,
    scan_tool_updates, scan_version_advisories, scan_workspace_dead_repos, scan_workspace_drift,
    scan_workspace_link,
};
use navori_core::diagnose::doctor_user_scope::{
    ConflictWinner, ForeignAssetType, ForeignHarnessReport, GlobalLeftover, GlobalLeftoverKind,
    doctor_ts_only_scans, scan_foreign_harness, scan_global_layer_leftovers,
};
use navori_core::diagnose::health::{
    DoctorHealth, DriftKind, DriftReport, HealthState, MarkerInfo, OrphanedEngineOutput, Unmodeled,
    configured_engines, known_drift_sources, list_markers, read_text, scan_managed_drift,
    scan_orphaned_engine_outputs, suggest_doctor_next_steps,
};
use navori_core::diagnose::native_hooks::{FindingCode, FindingLevel, NativeHookFinding};
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

/// `CODEX_PROJECT_DOC_WARN_RATIO`.
const CODEX_PROJECT_DOC_WARN_RATIO: f64 = 0.8;

/// `MAX_DISTRIBUTION_SAMPLE`: harness paths the uncommitted row names before it stops.
const MAX_DISTRIBUTION_SAMPLE: usize = 3;

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

/// `sym.fail`, `sym.update` and `sym.bullet` of a non-TTY run.
const FAIL: &str = "\u{2717}";
const UPDATE: &str = "\u{21e1}";

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

/// An optional user-derived text: `None` (delegate) when it is present and not plain ASCII, so a
/// value is never silently dropped from a note.
fn ascii_opt(text: Option<&str>) -> Option<Option<&str>> {
    match text {
        Some(text) => ascii(text).map(Some),
        None => Some(None),
    }
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

/// `Some(())` when a scan that answers `T | null` found nothing (a finding, or no answer,
/// delegates).
fn absent<T>(scan: Result<Option<T>, Unmodeled>) -> Option<()> {
    scan.ok()?.is_none().then_some(())
}

/// The machine and tools scans (`doctor.ts` 843-1172), gathered before any output exists.
struct Machine {
    missing_tools: Vec<MissingExternalTool>,
    pinned_drift: Vec<PinnedVersionDrift>,
    advisories: Vec<VersionAdvisoryHit>,
    updates: ToolUpdates,
    capability_gaps: Vec<ExternalToolCapabilityGap>,
    mcp: Vec<McpCoherenceIssue>,
    optional_tools: Vec<MissingOptionalTool>,
    audit_root: Option<AuditRootOpen>,
    gate: Vec<GateReadinessIssue>,
    empty_sections: Vec<EmptyUserSection>,
    triggerless: Vec<TriggerlessSkill>,
    interpolation: Vec<InterpolationArtifact>,
    disk: Vec<DiskUsageIssue>,
    progress_size: Option<ProgressSizeIssue>,
    global_claude_md: Option<GlobalClaudeMdIssue>,
    render_pending: Option<usize>,
    nested_worktrees: Option<NestedWorktreeConflict>,
    monorepo: Option<MonorepoDrift>,
    workspace_link: Option<WorkspaceLinkIssue>,
    dead_repos: Vec<WorkspaceDeadReposIssue>,
}

/// Every finding the native sections print, gathered (and every deferred scan confirmed empty)
/// before any output exists.
struct Report {
    machine: Machine,
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
    doc_budget: Option<DocBudgetReport>,
    distribution: Option<DistributionReport>,
    stale_global_cli: Option<StaleGlobalCli>,
    /// Bins whose `PATH` match is the package's Node launcher (native-only note).
    js_launchers: Vec<&'static str>,
    gitignore: Option<IgnoreHealth>,
    prettier_ignore: Option<IgnoreHealth>,
    git_hygiene: Option<GitHygieneReport>,
    workspace_drift: Option<WorkspaceDriftReport>,
    stale_harness: Vec<StaleHarness>,
    flat_skills: Vec<FlatSkill>,
    foreign_indexes: Vec<ForeignSkillIndex>,
    permission_modes: Vec<PermissionModeConflict>,
    foreign_harness: Option<ForeignHarnessReport>,
    /// The leftovers of the retired global layer and the resolved `<claudeUserDir>/settings.json`.
    global_leftovers: Vec<GlobalLeftover>,
    claude_settings: Option<String>,
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

    // Native sections.
    let claude_text = read_text(&root.join("CLAUDE.md")).ok()?.unwrap_or_default();
    let mut markers = list_markers(&claude_text);
    markers.extend(list_context_markers(root).ok()?);
    let plugins = load_enabled_plugins(member(Some(&config.data), "plugins")).ok()?;
    let verdict = compute_health_verdict(root, config, &plugins, &RealRunner, &env).ok()?;
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

    // Sections of 5e5b: every finding is kept and rendered.
    let mut tool_plugins = Plugins::default();
    let missing_tools = scan_missing_external_tools(&host, config, &mut tool_plugins).ok()?;
    let pinned_drift = scan_pinned_version_drift(&host, config, &mut tool_plugins).ok()?;
    let advisories = scan_version_advisories(&host, config, &mut tool_plugins).ok()?;
    let updates = scan_tool_updates(&host, config, &mut tool_plugins).ok()?;
    let capability_gaps = scan_external_tool_capabilities(&host, config, &mut tool_plugins).ok()?;
    let mcp = scan_mcp_coherence(root, config).ok()?;
    let optional_tools = scan_missing_optional_tools(&host);
    let audit_root = scan_audit_root_permissions(&host, current_uid()?).ok()?;
    let monorepo = scan_monorepo_drift(config).ok()?;
    let workspace_link = scan_workspace_link(&host, root, config).ok()?;
    let dead_repos = scan_workspace_dead_repos(&host, root, config).ok()?;
    let gate = scan_quality_gate_readiness(root, config, &|binary| {
        has_binary(&env, process_cwd, binary)
    })
    .ok()?;
    let skill_dirs = doctor_skill_dirs(config).ok()?;
    let empty_sections = scan_empty_user_sections(root, &skill_dirs, &env).ok()?;
    let triggerless = scan_triggerless_local_skills(root, config, &env).ok()?;
    let interpolation = scan_interpolation_artifacts(root, config).ok()?;
    let backups = navori_core::backup::backup_root().ok()?;
    let disk = scan_disk_usage(&host, root, &backups).ok()?;
    let progress_size = scan_progress_size(root, DEFAULT_PROGRESS_THRESHOLD_BYTES);
    let global_claude_md = if engines.iter().any(|e| e == "claude") {
        scan_global_claude_md(&host, GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS).ok()?
    } else {
        None
    };
    let render_pending = if claude_md_exists {
        Some(pending_changes(root, config)?)
    } else {
        None
    };
    let nested_worktrees = scan_nested_worktrees(root).ok()?;
    let machine = Machine {
        missing_tools,
        pinned_drift,
        advisories,
        updates,
        capability_gaps,
        mcp,
        optional_tools,
        audit_root,
        gate,
        empty_sections,
        triggerless,
        interpolation,
        disk,
        progress_size,
        global_claude_md,
        render_pending,
        nested_worktrees,
        monorepo,
        workspace_link,
        dead_repos,
    };

    // Closing notes (5e5c, part 1): rendered here.
    let stale_global_cli =
        scan_stale_global_cli(&host, root, config, navori_core::STAMP_VERSION).ok()?;
    let js_launchers = scan_js_launcher_on_path(&host);
    let gitignore = scan_gitignore_harness(root, config).ok()?;
    let prettier_ignore = scan_prettier_ignore(root, config).ok()?;
    let git_hygiene = scan_git_hygiene(root, config, &RealRunner, &env).ok()?;
    let doc_budget = scan_doc_budget(root, config, navori_core::STAMP_VERSION).ok()?;
    let distribution = scan_distribution(root, &config.data, &RealRunner, &env).ok()?;
    let workspace_drift = scan_workspace_drift(&host, root, config).ok()?;
    let stale_harness = scan_stale_harness(root, config, &env).ok()?;
    absent(scan_workspace_full_harness(config))?;
    let flat_skills = scan_flat_skills(root, &home()?, &env).ok()?;
    let foreign_indexes = scan_foreign_skill_indexes(root).ok()?;
    let permission_modes = scan_permission_mode(root).ok()?;
    let foreign_harness = scan_foreign_harness(&host, cwd, config, None).ok()?;
    let global_leftovers = scan_global_layer_leftovers(&host).ok()?;
    let claude_settings = if global_leftovers.is_empty() {
        None
    } else {
        Some(format!("{}/settings.json", claude_user_dir(&host).ok()??))
    };

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
        machine,
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
        doc_budget,
        distribution,
        stale_global_cli,
        js_launchers,
        gitignore,
        prettier_ignore,
        git_hygiene,
        workspace_drift,
        stale_harness,
        flat_skills,
        foreign_indexes,
        permission_modes,
        foreign_harness,
        global_leftovers,
        claude_settings,
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

    for (symbol, message) in tool_logs(&report.machine, td, lang)? {
        clack.log(symbol, &message);
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
    for (symbol, message) in coherence_logs(&report.machine, td)? {
        clack.log(symbol, &message);
    }
    // The tgrep and codegraph reports are empty here (their scans delegate above), so the
    // missing tools and the available providers are what can raise the hint.
    let missing_ids: Vec<&str> = report
        .machine
        .missing_tools
        .iter()
        .map(|t| t.plugin_id.as_str())
        .collect();
    if needs_external_provider_setup_hint(&missing_ids, &report.available_providers, false, false) {
        clack.log(
            Symbol::Info,
            &td.external_provider_setup_hint(SETUP_RECIPE_URL),
        );
    }

    for (symbol, message) in readiness_logs(&report.machine, td) {
        clack.log(symbol, &message);
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

    for (symbol, message) in host_logs(&report.machine, td)? {
        clack.log(symbol, &message);
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

    if let Some(stale) = &report.stale_global_cli {
        clack.log(
            Symbol::Warn,
            &td.global_cli_stale(ascii(&stale.global)?, ascii(&stale.current)?),
        );
    }
    if !report.js_launchers.is_empty() {
        clack.log(
            Symbol::Warn,
            &td.js_launcher_on_path(&report.js_launchers.join("', '")),
        );
    }
    for (health, missing, drift, title) in [
        (
            &report.gitignore,
            td.gitignore_missing(),
            td.gitignore_drift(),
            td.gitignore_title(),
        ),
        (
            &report.prettier_ignore,
            td.prettier_ignore_missing(),
            td.prettier_ignore_drift(),
            td.prettier_ignore_title(),
        ),
    ] {
        if let Some(health) = health
            && (health.missing || health.drift)
        {
            let body = if health.missing { missing } else { drift };
            note(&mut clack, &format!("  {update} {body}"), title)?;
        }
    }
    if let Some(hygiene) = &report.git_hygiene {
        let mut rows = Vec::new();
        if let Some(dir) = &hygiene.specs_ignored {
            rows.push(format!(
                "  {update} {}",
                td.git_hygiene_specs_ignored(ascii(dir)?)
            ));
        }
        for path in &hygiene.ephemeral_not_ignored {
            rows.push(format!(
                "  {update} {}",
                td.git_hygiene_ephemeral_not_ignored(path)
            ));
        }
        for path in &hygiene.ephemeral_tracked {
            rows.push(format!(
                "  {update} {}",
                td.git_hygiene_ephemeral_tracked(path)
            ));
        }
        if hygiene.presets_ignored {
            rows.push(format!("  {update} {}", td.git_hygiene_presets_ignored()));
        }
        if hygiene.nested_state_unprotected {
            rows.push(format!(
                "  {update} {}",
                td.git_hygiene_nested_state_unprotected()
            ));
        }
        if !rows.is_empty() {
            note(&mut clack, &lines(rows), td.git_hygiene_title())?;
        }
    }
    // Spec 0045 D3: errors flip the verdict (counted in `compute_health_verdict`).
    if let Some(hooks) = &verdict.native_hooks {
        let rows = hooks
            .findings
            .iter()
            .map(|f| {
                let mark = match f.level {
                    FindingLevel::Error => fail,
                    FindingLevel::Warning => update,
                    FindingLevel::Info => bullet,
                };
                Some(format!("  {mark} {}", native_hook_text(f, td)?))
            })
            .collect::<Option<Vec<_>>>()?;
        note(&mut clack, &lines(rows), td.native_hooks_title())?;
    }
    if let Some(budget) = &report.doc_budget {
        note(
            &mut clack,
            &lines(doc_budget_lines(budget, td)?),
            td.doc_budget_title(),
        )?;
    }
    if let Some(distribution) = &report.distribution {
        note(
            &mut clack,
            &lines(distribution_lines(distribution, td)?),
            td.distribution_title(),
        )?;
    }
    if let Some(drift) = &report.workspace_drift {
        let mut rows = Vec::new();
        for d in &drift.vs_defaults {
            rows.push(format!(
                "  {update} {}",
                td.workspace_drift_default_row(
                    ascii(&d.key)?,
                    ascii(&d.local)?,
                    ascii(&d.expected)?
                )
            ));
        }
        for d in &drift.vs_siblings {
            rows.push(format!(
                "  {update} {}",
                td.workspace_drift_sibling_row(
                    ascii(&d.key)?,
                    ascii(&d.local)?,
                    ascii(&d.expected)?,
                    d.agree,
                    d.total
                )
            ));
        }
        rows.push(format!("  {bullet} {}", td.workspace_drift_hint()));
        note(
            &mut clack,
            &lines(rows),
            &td.workspace_drift_title(ascii(&drift.workspace)?, drift.siblings_read),
        )?;
    }
    if !report.stale_harness.is_empty() {
        let mut rows = Vec::new();
        for h in &report.stale_harness {
            rows.push(format!(
                "  {update} {}\n      {}",
                td.stale_harness_row(ascii(&h.path)?, h.files, ascii_opt(h.frozen_at.as_deref())?),
                td.stale_harness_undeclared()
            ));
        }
        note(&mut clack, &lines(rows), td.stale_harness_title())?;
    }

    // `workspaceFullHarness` is always empty here (it delegates in `gather`).
    if !report.flat_skills.is_empty() {
        let mut rows = Vec::new();
        for f in &report.flat_skills {
            rows.push(format!(
                "  {update} {}",
                td.flat_skills_row(ascii(&f.path)?, ascii(&f.suggested)?)
            ));
        }
        rows.push(format!("  {bullet} {}", td.flat_skills_hint()));
        note(&mut clack, &lines(rows), td.flat_skills_title())?;
    }
    if !report.foreign_indexes.is_empty() {
        let mut rows = Vec::new();
        for idx in &report.foreign_indexes {
            let frozen = match ascii_opt(idx.frozen_at.as_deref())? {
                None => String::new(),
                Some(date) => format!(" ({})", td.foreign_skill_index_frozen(date)),
            };
            rows.push(format!(
                "  {update} {}{frozen}",
                td.foreign_skill_index_row(idx.path, idx.indexed, idx.producer)
            ));
        }
        rows.push(format!("  {bullet} {}", td.foreign_skill_index_hint()));
        note(&mut clack, &lines(rows), td.foreign_skill_index_title())?;
    }
    for conflict in &report.permission_modes {
        note(
            &mut clack,
            &format!(
                "  {update} {}",
                td.permission_mode_unsupported(
                    ascii(&conflict.mode)?,
                    ascii(&conflict.path)?,
                    &conflict.missing.join(", ")
                )
            ),
            td.permission_mode_title(),
        )?;
    }
    if let Some(foreign) = &report.foreign_harness {
        let rows = foreign_harness_lines(foreign, td, update)?;
        if !rows.is_empty() {
            note(&mut clack, &lines(rows), td.foreign_harness_title())?;
        }
    }
    if let Some(settings) = &report.claude_settings {
        clack.log(
            Symbol::Warn,
            &global_layer_message(&report.global_leftovers, ascii(settings)?, td)?,
        );
    }

    let has_issues = !verdict.ok;
    // `isStrictModeFailure`: drift or an incoherent `.mcp.json` fail `--strict`.
    let strict_fail = strict && (!report.drifts.is_empty() || !report.machine.mcp.is_empty());
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

/// `foreignHarnessLines` (#555): the rows of a foreign-harness report; `None` delegates (non-ASCII
/// user text).
fn foreign_harness_lines(
    report: &ForeignHarnessReport,
    td: Doctor,
    update: &str,
) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for c in &report.conflicts {
        let what = match c.asset_type {
            ForeignAssetType::Agent => td.foreign_harness_agent_word(),
            ForeignAssetType::Skill => td.foreign_harness_skill_word(),
        };
        let (name, foreign, navori) = (
            ascii(&c.name)?,
            ascii(&c.foreign_path)?,
            ascii(&c.navori_path)?,
        );
        let row = match c.winner {
            ConflictWinner::Undecided => td.foreign_harness_undecided(what, name, navori, foreign),
            ConflictWinner::Navori => td.foreign_harness_conflict(what, name, navori, foreign),
            ConflictWinner::Foreign => td.foreign_harness_conflict(what, name, foreign, navori),
        };
        let gitignored = if c.gitignored == Some(true) {
            format!(" {}", td.foreign_harness_gitignored())
        } else {
            String::new()
        };
        out.push(format!("  {update} {row}{gitignored}"));
        out.push(format!(
            "      {}",
            if c.adoptable {
                td.foreign_harness_adopt_hint(foreign)
            } else {
                td.foreign_harness_ack_hint(ascii(&c.id)?)
            }
        ));
    }
    for p in &report.permissions {
        out.push(format!(
            "  {update} {}",
            td.foreign_harness_permission(ascii(&p.rule)?, ascii(&p.path)?)
        ));
    }
    for id in &report.stale_acknowledged {
        out.push(format!(
            "  {update} {}",
            td.foreign_harness_stale_ack(ascii(id)?)
        ));
    }
    Some(out)
}

/// `globalLayerLeftoversMessage` (spec 0046 D5): the leftovers found and only the removal steps
/// that apply; `None` delegates (non-ASCII path).
fn global_layer_message(
    leftovers: &[GlobalLeftover],
    settings: &str,
    td: Doctor,
) -> Option<String> {
    let by = |kind: GlobalLeftoverKind| -> Option<Option<&str>> {
        leftovers
            .iter()
            .find(|l| l.kind == kind)
            .map(|l| ascii(&l.path))
            .map_or(Some(None), |p| p.map(Some))
    };
    let plist = by(GlobalLeftoverKind::LaunchAgent)?;
    let hook = by(GlobalLeftoverKind::LegacyHook)?;
    let plugin = by(GlobalLeftoverKind::Plugin)?;
    let manifest = by(GlobalLeftoverKind::Manifest)?;
    let mut steps = Vec::new();
    if let Some(plist) = plist {
        steps.push(td.global_layer_step_launch_agent(plist));
        steps.push(td.global_layer_step_audit_always().to_owned());
    }
    if hook.is_some() || manifest.is_some() {
        steps.push(td.global_layer_step_settings(settings, "navori-global-baseline.sh", manifest));
    }
    let files: Vec<&str> = [plugin, hook].into_iter().flatten().collect();
    if !files.is_empty() {
        steps.push(td.global_layer_step_files(&files));
    }
    if let Some(manifest) = manifest {
        steps.push(td.global_layer_step_manifest(manifest));
    }
    let mut rows = Vec::new();
    for l in leftovers {
        rows.push(td.global_layer_leftover_row(l.kind.as_str(), ascii(&l.path)?));
    }
    rows.extend(steps);
    Some(td.global_layer_leftovers(&rows))
}

/// The log messages of one block of sections, in print order.
type Logs = Vec<(Symbol, String)>;

/// A bullet row of a machine section: `  <mark> <subject>  <detail>`.
fn row(mark: &str, subject: &str, detail: &str) -> String {
    format!("  {mark} {subject}  {detail}")
}

/// `how` of a missing tool: the install command (plus its post-install), the docs page, or the
/// generic advice.
fn install_how(td: Doctor, tool: &MissingExternalTool) -> String {
    if let Some(install) = tool.install.as_deref().filter(|i| !i.is_empty()) {
        return match tool.post_install.as_deref().filter(|p| !p.is_empty()) {
            Some(post) => format!("{install} && {post}"),
            None => install.to_owned(),
        };
    }
    match tool.install_docs.as_deref().filter(|d| !d.is_empty()) {
        Some(docs) => td.external_tool_docs_how(docs),
        None => td.external_tool_fallback_how().to_owned(),
    }
}

/// External tools: missing binaries, pinned versions, advisories, updates and capability gaps
/// (`doctor.ts` 843-907). `None` for a path or text Rust cannot print.
fn tool_logs(m: &Machine, td: Doctor, lang: Lang) -> Option<Logs> {
    let mut out: Logs = Vec::new();
    let n = |len: usize| len.to_string();
    if !m.missing_tools.is_empty() {
        let rows: Vec<String> = m
            .missing_tools
            .iter()
            .map(|t| {
                row(
                    UPDATE,
                    &t.plugin_id,
                    &td.external_tool_row(&t.binary, &install_how(td, t)),
                )
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.external_tools(&n(rows.len()), &lines(rows)),
        ));
    }
    if !m.pinned_drift.is_empty() {
        let rows: Vec<String> = m
            .pinned_drift
            .iter()
            .map(|d| {
                let how = d
                    .install
                    .as_deref()
                    .unwrap_or_else(|| td.external_tool_fallback_how());
                row(
                    UPDATE,
                    &d.plugin_id,
                    &td.pinned_version_drift_row(&d.installed_version, &d.pinned_version, how),
                )
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.pinned_version_drift(&n(rows.len()), &lines(rows)),
        ));
    }
    if !m.advisories.is_empty() {
        let rows: Vec<String> = m
            .advisories
            .iter()
            .map(|a| {
                let reason = if lang == Lang::Es {
                    &a.reason_es
                } else {
                    &a.reason_en
                };
                let text = td.version_advisory_row(&a.installed_version, &a.below, reason);
                let mut line = row(UPDATE, &a.plugin_id, &text);
                if let Some(reference) = a.reference.as_deref().filter(|r| !r.is_empty()) {
                    line.push_str(&format!("\n      {reference}"));
                }
                line
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.version_advisories(&n(rows.len()), &lines(rows)),
        ));
    }
    if !m.updates.updates.is_empty() {
        let rows: Vec<String> = m
            .updates
            .updates
            .iter()
            .map(|u| {
                row(
                    UPDATE,
                    &u.plugin_id,
                    &td.tool_update_row(&u.installed_version, &u.latest_version),
                )
            })
            .collect();
        out.push((Symbol::Warn, td.tool_updates(&n(rows.len()), &lines(rows))));
    }
    if !m.updates.unparseable.is_empty() {
        let rows: Vec<String> = m
            .updates
            .unparseable
            .iter()
            .map(|u| {
                row(
                    UPDATE,
                    &u.plugin_id,
                    &td.tool_release_unparseable_row(&u.source, &u.id),
                )
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.tool_release_unparseable(&n(rows.len()), &lines(rows)),
        ));
    }
    if !m.capability_gaps.is_empty() {
        let rows: Vec<String> = m
            .capability_gaps
            .iter()
            .map(|g| {
                let how = g
                    .install
                    .as_deref()
                    .unwrap_or_else(|| td.external_tool_fallback_how());
                row(
                    UPDATE,
                    &g.plugin_id,
                    &td.external_tool_capability_gap_row(
                        &g.binary,
                        &g.missing.join(", "),
                        &g.min_version,
                        how,
                    ),
                )
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.external_tool_capability_gaps(&n(rows.len()), &lines(rows)),
        ));
    }
    Some(out)
}

/// `.mcp.json` coherence, optional tools and the audit root (`doctor.ts` 923-962).
fn coherence_logs(m: &Machine, td: Doctor) -> Option<Logs> {
    let mut out: Logs = Vec::new();
    if !m.mcp.is_empty() {
        let rows: Vec<String> = m
            .mcp
            .iter()
            .map(|issue| match issue {
                McpCoherenceIssue::MissingEntry { plugin_id } => {
                    row(FAIL, plugin_id, td.mcp_coherence_missing_entry())
                }
                McpCoherenceIssue::CommandMismatch {
                    plugin_id,
                    expected,
                    actual,
                } => row(
                    FAIL,
                    plugin_id,
                    &td.mcp_coherence_command_mismatch(expected, actual),
                ),
            })
            .collect();
        out.push((
            Symbol::Error,
            td.mcp_coherence(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if !m.optional_tools.is_empty() {
        let rows: Vec<String> = m
            .optional_tools
            .iter()
            .map(|tool| {
                let binaries = tool
                    .binaries
                    .iter()
                    .map(|b| format!("'{b}'"))
                    .collect::<Vec<_>>()
                    .join(" / ");
                row(
                    UPDATE,
                    tool.id,
                    &td.optional_tool_row(&binaries, tool.install),
                )
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.optional_tools(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if let Some(open) = &m.audit_root {
        let rows = open
            .paths
            .iter()
            .map(|p| p.to_str().map(|p| format!("  {UPDATE} {p}")))
            .collect::<Option<Vec<_>>>()?
            .join("\n");
        let command = audit_root_repair_command(open.root.to_str()?);
        out.push((Symbol::Warn, td.audit_root_open(&rows, &command)));
    }
    Some(out)
}

/// `auditRootRepairCommand(root)`: the root single-quoted, embedded quotes escaped.
fn audit_root_repair_command(root: &str) -> String {
    let quoted = format!("'{}'", root.replace('\'', "'\\''"));
    format!(
        "find {quoted} -type d -exec chmod 700 {{}} + && find {quoted} -type f -exec chmod 600 {{}} +"
    )
}

/// `MAX_ARTIFACT_ROWS`: interpolation rows printed before the "and n more" line.
const MAX_ARTIFACT_ROWS: usize = 10;

/// The quality gate, empty user sections, triggerless skills and interpolation leftovers
/// (`doctor.ts` 990-1049).
fn readiness_logs(m: &Machine, td: Doctor) -> Logs {
    let mut out: Logs = Vec::new();
    if !m.gate.is_empty() {
        let rows: Vec<String> = m
            .gate
            .iter()
            .map(|issue| {
                let why = match issue.reason {
                    GateBlocker::MissingBinary => td.gate_missing_binary_row(&issue.detail),
                    GateBlocker::MissingDeps => td.gate_missing_deps_row(&issue.detail),
                    GateBlocker::MissingScript => td.gate_missing_script_row(&issue.detail),
                };
                row(UPDATE, &format!("qualityGate.{}", issue.gate), &why)
            })
            .collect();
        out.push((
            Symbol::Warn,
            td.gate_not_runnable(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if !m.empty_sections.is_empty() {
        let rows: Vec<String> = m
            .empty_sections
            .iter()
            .map(|s| row(UPDATE, &s.id, &td.empty_user_section_row(&s.path)))
            .collect();
        out.push((
            Symbol::Warn,
            td.empty_user_sections(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if !m.triggerless.is_empty() {
        let rows: Vec<String> = m
            .triggerless
            .iter()
            .map(|s| row(UPDATE, &s.id, &td.triggerless_skill_row(&s.path)))
            .collect();
        out.push((
            Symbol::Warn,
            td.triggerless_skills(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if !m.interpolation.is_empty() {
        // Unresolved placeholders first (a stable sort), so the scarce signal survives the cap.
        let mut by_severity: Vec<&InterpolationArtifact> = m.interpolation.iter().collect();
        by_severity.sort_by_key(|a| a.reason == ArtifactReason::UnconfiguredGate);
        let mut rows: Vec<String> = by_severity
            .iter()
            .take(MAX_ARTIFACT_ROWS)
            .map(|a| {
                let why = match a.reason {
                    ArtifactReason::UnconfiguredGate => {
                        td.interpolation_artifact_gate_row().to_owned()
                    }
                    ArtifactReason::UnresolvedPlaceholder => {
                        td.interpolation_artifact_unresolved_row(&a.token)
                    }
                };
                row(UPDATE, &format!("{}:{}", a.path, a.line), &why)
            })
            .collect();
        let hidden = m.interpolation.len() - rows.len();
        if hidden > 0 {
            rows.push(td.interpolation_artifacts_more(&hidden.to_string()));
        }
        out.push((
            Symbol::Warn,
            td.interpolation_artifacts(&m.interpolation.len().to_string(), &lines(rows)),
        ));
    }
    out
}

/// `Math.round` (halves go up).
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `humanBytes`: "512 MB" under a GiB, "4.2 GB" above.
fn human_bytes(bytes: f64) -> String {
    let gib = bytes / 1024_f64.powi(3);
    if gib >= 1.0 {
        let shown = if gib >= 10.0 {
            js_round(gib)
        } else {
            js_round(gib * 10.0) / 10.0
        };
        return format!("{shown} GB");
    }
    format!("{} MB", js_round(bytes / 1024_f64.powi(2)).max(1.0))
}

/// Disk usage, the session state size, the global `CLAUDE.md`, the pending render, nested
/// worktrees, the monorepo and the workspace registry (`doctor.ts` 1051-1180).
fn host_logs(m: &Machine, td: Doctor) -> Option<Logs> {
    let mut out: Logs = Vec::new();
    if !m.disk.is_empty() {
        let rows = m
            .disk
            .iter()
            .map(|issue| {
                let size = human_bytes(issue.bytes);
                let why = match issue.target {
                    DiskUsageTarget::Backups => td.disk_backups_row(&size),
                    DiskUsageTarget::Worktrees => td.disk_worktrees_row(&size),
                };
                Some(row(UPDATE, issue.path.to_str()?, &why))
            })
            .collect::<Option<Vec<_>>>()?;
        out.push((
            Symbol::Warn,
            td.disk_usage(&rows.len().to_string(), &lines(rows)),
        ));
    }
    if let Some(size) = &m.progress_size {
        let why = td.progress_size_row(&size.bytes.to_string(), &size.threshold_bytes.to_string());
        out.push((
            Symbol::Warn,
            td.progress_size(&row(UPDATE, size.path, &why)),
        ));
    }
    if let Some(global) = &m.global_claude_md {
        let why = td.global_claude_md_row(
            &global.chars.to_string(),
            &global.threshold_chars.to_string(),
        );
        out.push((
            Symbol::Warn,
            td.global_claude_md(&row(UPDATE, &global.path, &why)),
        ));
    }
    if let Some(pending) = m.render_pending.filter(|p| *p > 0) {
        out.push((Symbol::Warn, td.render_pending(&pending.to_string())));
    }
    if let Some(nested) = &m.nested_worktrees {
        let rows: Vec<String> = nested
            .worktrees
            .iter()
            .map(|path| row(UPDATE, path, td.nested_worktree_row()))
            .collect();
        out.push((
            Symbol::Warn,
            td.nested_worktrees(&rows.len().to_string(), &nested.eslint_config, &lines(rows)),
        ));
    }
    if let Some(monorepo) = &m.monorepo {
        let mut rows: Vec<String> = Vec::new();
        if monorepo.disabled {
            rows.push(format!("  {UPDATE} {}", td.monorepo_disabled()));
        }
        if monorepo.empty_declared {
            rows.push(format!("  {UPDATE} {}", td.monorepo_empty_declared()));
        }
        for path in &monorepo.added {
            rows.push(format!("  {UPDATE} {path}  {}", td.monorepo_added_row()));
        }
        for path in &monorepo.orphan {
            rows.push(format!("  {UPDATE} {path}  {}", td.monorepo_orphan_row()));
        }
        if !rows.is_empty() {
            out.push((
                Symbol::Warn,
                td.monorepo_drift(&rows.len().to_string(), &lines(rows)),
            ));
        }
    }
    if let Some(link) = &m.workspace_link {
        out.push((Symbol::Warn, workspace_link_warning(link, td)));
    }
    for dead in &m.dead_repos {
        let rows: Vec<String> = dead
            .repos
            .iter()
            .map(|(name, path)| format!("  - {name}: {path}"))
            .collect();
        out.push((
            Symbol::Warn,
            td.ws_dead_repos(&dead.workspace, &lines(rows)),
        ));
    }
    Some(out)
}

/// `formatWorkspaceLinkWarning`.
fn workspace_link_warning(issue: &WorkspaceLinkIssue, td: Doctor) -> String {
    match issue {
        WorkspaceLinkIssue::WorkspaceMissing { workspace } => td.ws_link_missing(workspace),
        WorkspaceLinkIssue::RepoNotRegistered { workspace } => td.ws_link_not_registered(workspace),
        WorkspaceLinkIssue::PathMismatch {
            workspace,
            repo_name,
            registered_path,
        } => td.ws_link_path_mismatch(repo_name, workspace, registered_path),
        WorkspaceLinkIssue::UndeclaredPathMismatch {
            workspace,
            repo_name,
            registered_path,
        } => td.ws_link_undeclared_mismatch(repo_name, workspace, registered_path),
    }
}

/// `nativeHookFindingText`; `None` for text clack cannot reproduce (non-ASCII paths).
fn native_hook_text(f: &NativeHookFinding, td: Doctor) -> Option<String> {
    let path = |p: &Option<String>| -> Option<Option<String>> {
        match p {
            Some(p) => ascii(p).map(|p| Some(p.to_owned())),
            None => Some(None),
        }
    };
    Some(match &f.code {
        FindingCode::Found(state) => {
            let manager = state.manager.filter(|_| state.active).map(|m| m.as_str());
            td.native_hooks_found(
                state.event.as_str(),
                manager,
                path(&state.path)?.as_deref(),
                state.absence.map(|a| a.as_str()),
            )
        }
        FindingCode::GateDeclaredMissing { state, git_version } => td.native_hooks_gate_missing(
            state.manager.map(|m| m.as_str()),
            state.absence.map(|a| a.as_str()),
            ascii_opt(git_version.as_deref())?,
        ),
        FindingCode::PluginDeclaredMissing {
            plugin,
            git_version,
        } => td.native_hooks_plugin_missing(ascii(plugin)?, ascii_opt(git_version.as_deref())?),
        FindingCode::PluginOnlyGuarantee(plugin) => {
            td.native_hooks_plugin_only_guarantee(ascii(plugin)?)
        }
        FindingCode::Duplicate(state) => td.native_hooks_duplicate(
            state.manager.map(|m| m.as_str()),
            path(&state.path)?.as_deref(),
        ),
        FindingCode::WorktreeMissing(path) => td.native_hooks_worktree_missing(ascii(path)?),
    })
}

/// `docBudgetLines`; `None` for text clack cannot reproduce.
fn doc_budget_lines(r: &DocBudgetReport, td: Doctor) -> Option<Vec<String>> {
    let bullet = "\u{b7}";
    let update = "\u{21e1}";
    let n = |v: usize| v.to_string();
    let mut out = Vec::new();
    if let Some(managed) = r.managed_words {
        let unbudgeted = r.unbudgeted_words.unwrap_or(0);
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_summary(
                &n(r.total_words.unwrap_or(0)),
                &n(managed - unbudgeted),
                &n(r.ceiling.unwrap_or(0)),
                &r.own_words.unwrap_or(0).to_string(),
            )
        ));
    }
    if let Some(words) = r.per_subagent_words {
        out.push(format!("  {bullet} {}", td.doc_budget_subagents(&n(words))));
    }
    if !r.mcp_servers.is_empty() {
        let ids = r
            .mcp_servers
            .iter()
            .map(|s| ascii(&s.id))
            .collect::<Option<Vec<_>>>()?
            .join(", ");
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_mcp_servers(&n(r.mcp_servers.len()), &ids)
        ));
        let always: Vec<&str> = r
            .mcp_servers
            .iter()
            .filter(|s| s.always_load)
            .map(|s| ascii(&s.id))
            .collect::<Option<_>>()?;
        if !always.is_empty() {
            out.push(format!(
                "  {bullet} {}",
                td.doc_budget_mcp_always_load(&always.join(", "))
            ));
        }
    }
    if r.unbudgeted_words.unwrap_or(0) > 0 {
        let ids = r
            .blocks
            .iter()
            .filter(|b| b.kind == BlockKind::Unbudgeted)
            .map(|b| ascii(&b.id))
            .collect::<Option<Vec<_>>>()?
            .join(", ");
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_unbudgeted(&n(r.unbudgeted_words.unwrap_or(0)), &ids)
        ));
    }
    if !r.context_files.is_empty() {
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_context(
                &n(r.context_files.len()),
                &n(r.context_words),
                &n(r.context_chars),
                &n(r.context_delivery_budget),
            )
        ));
        for f in r
            .context_files
            .iter()
            .filter(|c| c.delivered == ContextDelivery::Pointer)
        {
            out.push(format!(
                "  {update} {}",
                td.doc_budget_context_pointer(
                    ascii(&f.file.path)?,
                    &n(f.ctx_chars_before),
                    &n(r.context_delivery_budget),
                )
            ));
        }
    }
    if let Some(agents) = &r.agents_md {
        #[expect(
            clippy::cast_precision_loss,
            reason = "byte counts are far below 2^53, as JS numbers"
        )]
        let ratio = agents.chars as f64 / r.agents_md_max_bytes as f64;
        // `Math.round`: halves go up.
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a non-negative percentage of a byte ratio"
        )]
        let pct = (ratio * 100.0 + 0.5).floor() as usize;
        let args = (
            n(agents.words),
            n(agents.chars),
            n(pct),
            n(r.agents_md_max_bytes),
        );
        if ratio >= CODEX_PROJECT_DOC_WARN_RATIO {
            out.push(format!(
                "  {update} {}",
                td.doc_budget_agents_md_near(&args.0, &args.1, &args.2, &args.3)
            ));
        } else {
            out.push(format!(
                "  {bullet} {}",
                td.doc_budget_agents_md(&args.0, &args.1, &args.2, &args.3)
            ));
        }
    }
    if r.agents_md_over_by.unwrap_or(0) > 0 {
        out.push(format!(
            "  {update} {}",
            td.doc_budget_agents_md_over_ceiling(
                &n(r.agents_md.as_ref().map_or(0, |a| a.words)),
                &n(r.agents_md_ceiling.unwrap_or(0)),
                &n(r.agents_md_over_by.unwrap_or(0)),
            )
        ));
    }
    if let Some(cursor) = &r.cursor_rules {
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_cursor_rules(&n(cursor.words), &n(cursor.chars))
        ));
    }
    if let Some(copilot) = &r.copilot_instructions {
        out.push(format!(
            "  {bullet} {}",
            td.doc_budget_copilot_instructions(&n(copilot.words), &n(copilot.chars))
        ));
    }
    for block in r.blocks.iter().filter(|b| b.over) {
        let lever = match block.lever {
            DocBudgetLever::ProjectContext => td.doc_budget_lever_project_context(),
            DocBudgetLever::Preset => td.doc_budget_lever_preset(),
            DocBudgetLever::Plugins => td.doc_budget_lever_plugins(),
            DocBudgetLever::Core => td.doc_budget_lever_core(),
        };
        out.push(format!(
            "  {update} {}",
            td.doc_budget_over_block(
                ascii(&block.id)?,
                &n(block.words),
                &n(block.ceiling.unwrap_or(0)),
                lever,
            )
        ));
    }
    Some(out)
}

/// `distributionLines`; `None` for text clack cannot reproduce.
fn distribution_lines(r: &DistributionReport, td: Doctor) -> Option<Vec<String>> {
    let update = "\u{21e1}";
    let mut out = Vec::new();
    if !r.uncommitted.is_empty() {
        let shown: Vec<&str> = r
            .uncommitted
            .iter()
            .take(MAX_DISTRIBUTION_SAMPLE)
            .map(|p| ascii(p))
            .collect::<Option<_>>()?;
        let rest = r.uncommitted.len() - shown.len();
        let sample = if rest > 0 {
            format!("{}, +{rest}", shown.join(", "))
        } else {
            shown.join(", ")
        };
        out.push(format!(
            "  {update} {}",
            td.distribution_uncommitted(&r.uncommitted.len().to_string(), &sample)
        ));
    }
    if let Some(unpushed) = &r.unpushed {
        out.push(format!(
            "  {update} {}",
            td.distribution_unpushed(&unpushed.commits.to_string(), ascii(&unpushed.upstream)?)
        ));
    }
    if let Some(base) = &r.base {
        let base_ref = ascii(&base.base_ref)?;
        if base.files > 0 {
            out.push(format!(
                "  {update} {}",
                td.distribution_vs_base(
                    base_ref,
                    &base.files.to_string(),
                    ascii(base.local_version.as_deref().unwrap_or("?"))?,
                    ascii(base.base_version.as_deref().unwrap_or("?"))?,
                )
            ));
        }
        if base.behind > 0 {
            out.push(format!(
                "  {update} {}",
                td.distribution_behind_base(base_ref, &base.behind.to_string())
            ));
        }
    }
    out.push(format!("  \u{b7} {}", td.distribution_hint()));
    Some(out)
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

    fn machine() -> Machine {
        Machine {
            missing_tools: Vec::new(),
            pinned_drift: Vec::new(),
            advisories: Vec::new(),
            updates: ToolUpdates::default(),
            capability_gaps: Vec::new(),
            mcp: Vec::new(),
            optional_tools: Vec::new(),
            audit_root: None,
            gate: Vec::new(),
            empty_sections: Vec::new(),
            triggerless: Vec::new(),
            interpolation: Vec::new(),
            disk: Vec::new(),
            progress_size: None,
            global_claude_md: None,
            render_pending: None,
            nested_worktrees: None,
            monorepo: None,
            workspace_link: None,
            dead_repos: Vec::new(),
        }
    }

    // Covers: R73
    #[test]
    fn human_bytes_rounds_like_the_ts() {
        let gib = 1024_f64.powi(3);
        assert_eq!(human_bytes(1.5 * gib), "1.5 GB");
        assert_eq!(human_bytes(12.4 * gib), "12 GB");
        assert_eq!(human_bytes(3.04 * gib), "3 GB");
        assert_eq!(human_bytes(512.0 * 1024.0 * 1024.0), "512 MB");
        assert_eq!(human_bytes(100.0), "1 MB");
    }

    // Covers: R73
    #[test]
    fn the_audit_root_repair_command_quotes_the_root() {
        assert_eq!(
            audit_root_repair_command("/a b/it's"),
            "find '/a b/it'\\''s' -type d -exec chmod 700 {} + && find '/a b/it'\\''s' -type f -exec chmod 600 {} +"
        );
    }

    // Covers: R73
    #[test]
    fn disk_and_global_claude_md_rows_in_both_languages() {
        let mut m = machine();
        m.disk = vec![
            DiskUsageIssue {
                target: DiskUsageTarget::Backups,
                path: "/h/.navori/backups".into(),
                bytes: 1.5 * 1024_f64.powi(3),
                threshold_bytes: 1024_f64.powi(3),
            },
            DiskUsageIssue {
                target: DiskUsageTarget::Worktrees,
                path: "/r/.claude/worktrees".into(),
                bytes: 12.0 * 1024_f64.powi(3),
                threshold_bytes: 2.0 * 1024_f64.powi(3),
            },
        ];
        m.global_claude_md = Some(GlobalClaudeMdIssue {
            path: "~/.claude/CLAUDE.md".to_owned(),
            chars: 3000,
            threshold_chars: 2000,
        });
        let en = host_logs(&m, Doctor(Lang::En)).unwrap_or_default();
        assert_eq!(en.len(), 2);
        assert_eq!(
            en[0].1,
            "Disk usage over threshold (2) \u{2014} nothing bounds these directories automatically; clean them yourself:\n  \u{21e1} /h/.navori/backups  \u{2014} 1.5 GB in backups; run 'navori backup prune' to trim them\n  \u{21e1} /r/.claude/worktrees  \u{2014} 12 GB in agent worktrees; review 'git worktree list' and drop stale ones with 'git worktree remove <path>' (they may hold uncommitted work; navori never deletes them itself)"
        );
        assert_eq!(
            en[1].1,
            "Your global CLAUDE.md is too large \u{2014} it loads in every session and crowds out the repo's context:\n  \u{21e1} ~/.claude/CLAUDE.md  \u{2014} 3000 characters (cap 2000); move workspace-specific content to its Dominio and drop what the repo already declares (navori never edits this file)"
        );
        let es = host_logs(&m, Doctor(Lang::Es)).unwrap_or_default();
        assert!(
            es[0]
                .1
                .starts_with("Uso de disco por encima del umbral (2)")
        );
        assert!(
            es[0]
                .1
                .contains("\u{2014} 1.5 GB en backups; corre 'navori backup prune'")
        );
        assert!(es[1].1.contains("3000 caracteres (tope 2000)"));
    }

    // Covers: R73
    #[test]
    fn workspace_link_dead_repos_and_monorepo_rows() {
        let mut m = machine();
        m.workspace_link = Some(WorkspaceLinkIssue::UndeclaredPathMismatch {
            workspace: "acme".to_owned(),
            repo_name: "x".to_owned(),
            registered_path: "/old/x".to_owned(),
        });
        m.dead_repos = vec![WorkspaceDeadReposIssue {
            workspace: "acme".to_owned(),
            repos: vec![("ghost".to_owned(), "/gone".to_owned())],
        }];
        m.monorepo = Some(MonorepoDrift {
            disabled: false,
            added: vec!["apps/a".to_owned()],
            orphan: vec!["apps/b".to_owned()],
            empty_declared: true,
        });
        m.render_pending = Some(3);
        let en = host_logs(&m, Doctor(Lang::En)).unwrap_or_default();
        assert_eq!(
            en[0].1,
            "Render pending: 3 file(s) or block(s) would change (hooks or doctrine from an older navori version) \u{2014} run 'navori render --apply'"
        );
        assert_eq!(
            en[1].1,
            "Monorepo out of sync with disk (3):\n  \u{21e1} monorepo declared but workspaces[] empty \u{2014} run 'navori scan' to populate it\n  \u{21e1} apps/a  \u{2014} on disk, missing in config (run 'navori scan')\n  \u{21e1} apps/b  \u{2014} in config, missing on disk (remove it from config)"
        );
        assert!(en[2].1.starts_with("Repo 'x' is registered in workspace 'acme' with a path that is no longer this one (/old/x)"));
        assert_eq!(
            en[3].1,
            "Workspace 'acme': repos registered with a path that does not exist on disk:\n  - ghost: /gone\nRun 'navori workspace link' from each repo's new location to update it."
        );
        m.render_pending = Some(0);
        m.monorepo = None;
        assert_eq!(host_logs(&m, Doctor(Lang::Es)).unwrap_or_default().len(), 2);
    }

    // Covers: R73
    #[test]
    fn tool_rows_cover_every_branch_of_the_how() {
        let mut m = machine();
        m.missing_tools = vec![
            MissingExternalTool {
                plugin_id: "a".to_owned(),
                binary: "a".to_owned(),
                install: Some("brew install a".to_owned()),
                post_install: Some("a login".to_owned()),
                install_docs: None,
            },
            MissingExternalTool {
                plugin_id: "b".to_owned(),
                binary: "b".to_owned(),
                install: None,
                post_install: None,
                install_docs: Some("https://b.example".to_owned()),
            },
            MissingExternalTool {
                plugin_id: "c".to_owned(),
                binary: "c".to_owned(),
                install: None,
                post_install: None,
                install_docs: None,
            },
        ];
        m.pinned_drift = vec![PinnedVersionDrift {
            plugin_id: "p".to_owned(),
            binary: "p".to_owned(),
            installed_version: "1.0.0".to_owned(),
            pinned_version: "1.6.0".to_owned(),
            install: None,
        }];
        m.advisories = vec![VersionAdvisoryHit {
            plugin_id: "e".to_owned(),
            binary: "e".to_owned(),
            installed_version: "0.1.0".to_owned(),
            below: "0.2.0".to_owned(),
            reason_es: "razon".to_owned(),
            reason_en: "reason".to_owned(),
            reference: Some("https://ref".to_owned()),
        }];
        m.updates = ToolUpdates {
            updates: vec![navori_core::diagnose::doctor_machine::ToolUpdate {
                plugin_id: "u".to_owned(),
                binary: "u".to_owned(),
                installed_version: "1.0.0".to_owned(),
                latest_version: "2.0.0".to_owned(),
            }],
            unparseable: vec![navori_core::diagnose::doctor_machine::UnparseableRelease {
                plugin_id: "v".to_owned(),
                source: "github".to_owned(),
                id: "o/v".to_owned(),
            }],
        };
        m.capability_gaps = vec![ExternalToolCapabilityGap {
            plugin_id: "g".to_owned(),
            binary: "g".to_owned(),
            missing: vec!["x".to_owned(), "y".to_owned()],
            min_version: "3.0".to_owned(),
            install: Some("upgrade g".to_owned()),
        }];
        let en = tool_logs(&m, Doctor(Lang::En), Lang::En).unwrap_or_default();
        assert_eq!(en.len(), 6);
        assert!(en[0].1.ends_with("\n  \u{21e1} a  \u{2014} missing 'a' in PATH; brew install a && a login\n  \u{21e1} b  \u{2014} missing 'b' in PATH; install it following https://b.example\n  \u{21e1} c  \u{2014} missing 'c' in PATH; install the tool and restart Claude Code"));
        assert!(en[1].1.ends_with("\n  \u{21e1} p  \u{2014} installed 1.0.0, manifest pins 1.6.0; install the tool and restart Claude Code"));
        assert!(en[2].1.ends_with(
            "\n  \u{21e1} e  \u{2014} installed 0.1.0 < 0.2.0: reason\n      https://ref"
        ));
        assert!(
            en[3]
                .1
                .ends_with("\n  \u{21e1} u  \u{2014} installed 1.0.0, available 2.0.0")
        );
        assert!(
            en[4]
                .1
                .ends_with("\n  \u{21e1} v  \u{2014} source github:o/v")
        );
        assert!(en[5].1.ends_with(
            "\n  \u{21e1} g  \u{2014} 'g' doesn't support x, y (needs >= 3.0); upgrade g"
        ));
        let es = tool_logs(&m, Doctor(Lang::Es), Lang::Es).unwrap_or_default();
        assert!(
            es[2]
                .1
                .ends_with("\u{2014} instalado 0.1.0 < 0.2.0: razon\n      https://ref")
        );
    }

    // Covers: R73
    #[test]
    fn interpolation_rows_cap_at_ten_with_unresolved_first() {
        let mut m = machine();
        let artifact = |line: usize, reason: ArtifactReason| InterpolationArtifact {
            path: "CLAUDE.md".to_owned(),
            line,
            token: "{{x}}".to_owned(),
            reason,
        };
        m.interpolation = (1..=11)
            .map(|n| artifact(n, ArtifactReason::UnconfiguredGate))
            .collect();
        m.interpolation
            .push(artifact(99, ArtifactReason::UnresolvedPlaceholder));
        let out = readiness_logs(&m, Doctor(Lang::En));
        assert_eq!(out.len(), 1);
        let rows: Vec<&str> = out[0].1.lines().collect();
        // Header, ten rows and the "more" line.
        assert_eq!(rows.len(), 12);
        assert!(
            rows[1].starts_with("  \u{21e1} CLAUDE.md:99  \u{2014} '{{x}}' published in the prose")
        );
        assert!(rows[2].starts_with("  \u{21e1} CLAUDE.md:1  "));
        assert_eq!(rows[11], "  \u{2026} and 2 more");
    }

    // Covers: R73
    #[test]
    fn closing_note_texts_interpolate_like_the_ts_catalog() {
        let en = Doctor(Lang::En);
        let es = Doctor(Lang::Es);
        assert_eq!(
            en.global_cli_stale("0.1.0", "0.2.0"),
            "the global 'navori' on PATH is 0.1.0, older than this CLI (0.2.0) and the rendered hooks run it: they would silently run old logic \u{2014} update with 'npm i -g navori@0.2.0'"
        );
        assert!(
            en.js_launcher_on_path("navori', 'navori-rust")
                .starts_with("'navori', 'navori-rust' on PATH is the package's Node launcher")
        );
        assert!(
            es.js_launcher_on_path("navori")
                .contains("pnpm: sus atajos siempre ejecutan 'node <bin>'")
        );
        // pnpm's fix names the bins the hooks look up, never a bare "put it on PATH".
        assert!(en.js_launcher_on_path("navori-rust").contains(
            "create a symlink on PATH for each name ('navori-rust') to the '@navori/<platform>' binary (its 'bin/navori')"
        ));
        assert!(es.js_launcher_on_path("navori-rust").contains(
            "crea en el PATH un enlace simbólico por cada nombre ('navori-rust') hacia el binario de '@navori/<plataforma>'"
        ));
        assert_eq!(
            es.workspace_drift_sibling_row("branchBase", "main", "dev", 2, 3),
            "branchBase: main (2/3 repos usan dev)"
        );
        assert_eq!(
            en.workspace_drift_title("acme", 0),
            "Drift from workspace 'acme':"
        );
        assert_eq!(
            es.workspace_drift_title("acme", 2),
            "Drift respecto al workspace 'acme' (2 repos hermanos):"
        );
        assert_eq!(
            en.stale_harness_row("pkg/.claude", 3, Some("0.9.0")),
            "pkg/.claude \u{2014} 3 file(s), frozen at 0.9.0"
        );
        assert_eq!(
            es.stale_harness_row("pkg/.claude", 1, None),
            "pkg/.claude \u{2014} 1 archivo(s)"
        );
        assert!(
            en.git_hygiene_specs_ignored("specs")
                .ends_with("(\"sdd\": { \"enabled\": false })")
        );
    }

    // Covers: R73
    #[test]
    fn part_two_closing_notes_follow_the_ts_catalog() {
        let en = Doctor(Lang::En);
        let es = Doctor(Lang::Es);
        assert_eq!(
            es.flat_skills_row(".claude/skills/a.md", ".claude/skills/a/SKILL.md"),
            ".claude/skills/a.md \u{2014} mu\u{e9}vela a .claude/skills/a/SKILL.md"
        );
        assert_eq!(
            en.foreign_skill_index_row(".atl/skill-registry.md", 4, "gentle-ai"),
            ".atl/skill-registry.md indexes 4 skills and not one of those paths exists here \u{2014} written by gentle-ai"
        );
        assert_eq!(
            es.foreign_skill_index_frozen("2026-01-01"),
            "congelado el 2026-01-01"
        );
        assert!(
            en.permission_mode_unsupported("dontAsk", "s.json", "Edit, Write")
                .starts_with("'s.json' sets defaultMode 'dontAsk', and that mode auto-denies")
        );
        assert_eq!(
            es.foreign_harness_conflict("el agente", "x", "a", "b"),
            "el agente 'x': gana 'a' y 'b' queda inerte"
        );
        assert_eq!(
            en.foreign_harness_stale_ack("k"),
            "'k' is in project.foreignHarness.acknowledged but matches no conflict any more \u{2014} remove it"
        );
        assert_eq!(
            en.global_layer_step_settings("/h/s.json", "hook.sh", Some("/h/g.json")),
            "  2. in /h/s.json, remove the SessionStart entries pointing to hook.sh and the rules listed in ownedPermissions of /h/g.json (before deleting the manifest)"
        );
        assert_eq!(
            es.global_layer_step_settings("/h/s.json", "hook.sh", None),
            "  2. en /h/s.json, quita las entradas SessionStart que apuntan a hook.sh (antes de borrar el manifiesto)"
        );
        assert_eq!(es.global_layer_step_files(&["a", "b"]), "  3. borra a y b");
        assert_eq!(en.global_layer_step_manifest("m"), "  4. delete m");
        assert_eq!(
            en.global_layer_leftovers(&["  - plugin: /p".to_owned()]),
            "leftovers of navori's retired global layer remain. Steps to clean them up, in this order:\n  - plugin: /p"
        );
    }
}
