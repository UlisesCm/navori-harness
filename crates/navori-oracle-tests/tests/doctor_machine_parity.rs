//! `navori_core::diagnose::doctor_machine` against the TS `doctor` machine scans (spec 0060 T23
//! slice 3c): external tools (presence, versions, pin, advisories, capabilities, releases),
//! optional tools, disk usage, the audit root, the user-level `CLAUDE.md`, the workspace registry
//! and the global `navori`.
//!
//! Every case builds a hermetic machine under one temp dir: an empty `HOME`, a `bin/` of stub
//! binaries that is the first (and almost only) `PATH` entry, a process working directory of its
//! own and a repo with an explicit config. The TS side runs each scan with the same `HOME`,
//! `PATH`, environment and working directory (`process.chdir`), and the Rust side does the same
//! through the real process runner. Nothing touches the network or the real machine. Replies are
//! compared as normalised JSON.
//!
//! Every scan the TS exports is called directly. `probeEnabledToolVersions` is the shared loop of
//! the pin, advisory and release scans, so it is compared on its own. No bundled manifest declares
//! a `capabilityProbe`, so the capability cases overlay one onto the bundled `engram` manifest on
//! both sides (the TS through a patched `fs.readFileSync`, the Rust through `capability_gap`).
//!
//! A scan the Rust port declines ([`Unmodeled`], the CLI then delegates) must be listed in the
//! case's `delegates`; the list is checked both ways, so it cannot rot.

mod support;

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use navori_core::config::{self, Config};
use navori_core::diagnose::doctor_machine::{
    DU_TIMEOUT, Host, WorkspaceLinkIssue, capability_gap, probe_enabled_tool_versions,
    scan_audit_root_permissions, scan_disk_usage, scan_external_tool_capabilities,
    scan_global_claude_md, scan_missing_external_tools, scan_missing_optional_tools,
    scan_pinned_version_drift, scan_stale_global_cli, scan_tool_updates, scan_version_advisories,
    scan_workspace_dead_repos, scan_workspace_drift, scan_workspace_link,
};
use navori_core::js_json;
use navori_core::process::RealRunner;
use navori_core::tools::notice::{self, Plugins};
use navori_core::workspace::patterns::Unmodeled;
use serde_json::{Map, Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const fs = (await import('node:fs')).default;\nconst path = await import('node:path');\n\
         const mm = await import('node:module');\n\
         const c = await import({:?});\nconst d = await import({:?});\nconst pv = await import({:?});\n\
         const tn = await import({:?});\nconst du = await import({:?});\nconst gc = await import({:?});\n\
         const wd = await import({:?});",
        cli_module("lib/config/config.ts"),
        cli_module("commands/doctor.ts"),
        cli_module("lib/primitives/tool-version-probe.ts"),
        cli_module("lib/primitives/tool-version-notice.ts"),
        cli_module("lib/diagnose/disk-usage.ts"),
        cli_module("lib/diagnose/global-claude-md.ts"),
        cli_module("lib/workspace/workspace-drift.ts"),
    )
}

/// One request = one machine; the reply maps each scan name to `{ ok }` or `{ err }`.
static NODE: Shared = Shared::new(
    prelude,
    r#"
for (const k of ['CI', 'NAVORI_NO_UPDATE_NOTIFIER', 'NAVORI_AUDITS_ROOT', 'CLAUDE_CONFIG_DIR', 'NAVORI_BACKUP_ROOT']) delete process.env[k];
process.env.HOME = request.home;
process.env.PATH = request.path;
// `os.homedir()` falls back to the passwd entry (the real home) without HOME: pin it to the stub,
// or to '' (what `safeHomedir` rejects) for the no-HOME case, so no scan can reach the real home.
const osm = (await import('node:os')).default;
osm.homedir = () => (request.noHome ? '' : request.home);
mm.syncBuiltinESMExports();
for (const [k, v] of Object.entries(request.env)) process.env[k] = v;
if (request.noHome) delete process.env.HOME;
process.chdir(request.cwd);
const cfg = c.readConfig(path.join(request.dir, 'navori.config.json'));
const dir = request.dir;
const out = {};
const run = (name, f) => { try { out[name] = { ok: f() ?? null }; } catch (e) { out[name] = { err: String(e && e.message || e) }; } };
const withManifests = (f) => {
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    for (const [id, m] of Object.entries(request.manifests)) {
      if (String(p).endsWith('/' + id + '/plugin.json')) return JSON.stringify(m);
    }
    return orig(p, ...rest);
  };
  mm.syncBuiltinESMExports();
  try { return f(); } finally { fs.readFileSync = orig; mm.syncBuiltinESMExports(); }
};
run('missingTools', () => d.scanMissingExternalTools(cfg));
run('versions', () => pv.probeEnabledToolVersions(cfg, () => true).map((v) => ({ pluginId: v.pluginId, binary: v.binary, installedVersion: v.installedVersion, install: v.install })));
run('pinned', () => d.scanPinnedVersionDrift(cfg));
run('advisories', () => d.scanVersionAdvisories(cfg));
run('capabilities', () => withManifests(() => d.scanExternalToolCapabilities(cfg)));
run('updates', () => tn.scanToolUpdates(cfg));
run('optional', () => d.scanMissingOptionalTools());
run('disk', () => du.scanDiskUsage(dir));
run('duTimeout', () => du.DU_TIMEOUT_MS);
run('audit', () => d.scanAuditRootPermissions());
run('claudeMd', () => gc.scanGlobalClaudeMd(request.threshold));
run('link', () => d.scanWorkspaceLink(dir, cfg));
run('dead', () => d.scanWorkspaceDeadRepos(dir, cfg));
run('drift', () => wd.scanWorkspaceDrift(dir, cfg));
run('stale', () => d.scanStaleGlobalCli(dir, cfg, undefined, request.current));
return out;
"#,
);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A machine to scan. Strings may use `{base}` (the case's temp dir), `{home}` and `{root}` (the
/// repo being scanned).
struct Case {
    name: &'static str,
    /// `navori.config.json` merged over `{ name, preset: "custom", engines: ["claude"] }`.
    config: Value,
    /// `(path, body)` under the repo root.
    repo_files: Vec<(String, String)>,
    /// `(path, body)` under `HOME`.
    home_files: Vec<(String, String)>,
    /// `(path, body)` under the case's base dir.
    base_files: Vec<(String, String)>,
    /// Executable stubs under `<base>/bin`.
    bins: Vec<(&'static str, String)>,
    /// `(path, body)` under the base dir that get `chmod 755`.
    exec_files: Vec<(String, String)>,
    /// Directories under the base dir.
    dirs: Vec<String>,
    /// `(link, target)` symlinks under the base dir.
    links: Vec<(String, String)>,
    /// `(path, mode)` applied after everything is written, under the base dir.
    modes: Vec<(String, u32)>,
    /// Extra environment variables, set on both sides.
    env: Vec<(&'static str, String)>,
    /// Environment variables only Rust sees (their bytes are not valid UTF-8).
    env_raw: Vec<(&'static str, Vec<u8>)>,
    /// `PATH` entries; defaults to `{base}/bin` and `{base}/sys` (only the base utilities, linked).
    path: Vec<String>,
    /// Both sides run without `HOME`.
    no_home: bool,
    /// How `HOME` is spelled on both sides (with `{base}`), when not the plain `{base}/home`; the
    /// files still land in `{base}/home`.
    home_spelling: Option<&'static str>,
    /// `capabilityProbe` overlaid onto the bundled `engram` manifest.
    probe: Option<Value>,
    /// The running CLI's version, for `scanStaleGlobalCli`.
    current: &'static str,
    /// `scanGlobalClaudeMd`'s threshold.
    threshold: usize,
    /// Scans the Rust port must decline for this case.
    delegates: &'static [&'static str],
    /// Scans whose reply must be non-trivial here (guards against a vacuous comparison).
    hits: &'static [&'static str],
}

fn case(name: &'static str, config: Value) -> Case {
    Case {
        name,
        config,
        repo_files: Vec::new(),
        home_files: Vec::new(),
        base_files: Vec::new(),
        bins: Vec::new(),
        exec_files: Vec::new(),
        dirs: Vec::new(),
        links: Vec::new(),
        modes: Vec::new(),
        env: Vec::new(),
        env_raw: Vec::new(),
        path: vec!["{base}/bin".into(), "{base}/sys".into()],
        no_home: false,
        home_spelling: None,
        probe: None,
        current: "1.0.0",
        threshold: 100,
        delegates: &[],
        hits: &[],
    }
}

/// Links only the utilities the stubs and scans need into `dir`, so the test `PATH` never reaches
/// a real `gh`, `engram` or any other binary of the machine running the tests.
fn link_base_utilities(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for name in ["du", "yes", "head", "git"] {
        // A missing utility would turn the cases that rely on it into silent passes (#1712).
        let real = ["/usr/bin", "/bin"]
            .iter()
            .map(|d| Path::new(d).join(name))
            .find(|p| p.is_file())
            .ok_or_else(|| format!("base utility `{name}` not found in /usr/bin or /bin"))?;
        std::os::unix::fs::symlink(real, dir.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `{ plugins: { <id>: { enabled: true }, … } }`.
fn plugins(ids: &[&str]) -> Value {
    let map: Map<String, Value> = ids
        .iter()
        .map(|id| ((*id).to_owned(), json!({ "enabled": true })))
        .collect();
    json!({ "plugins": map })
}

fn say(text: &str) -> String {
    format!("#!/bin/sh\necho '{text}'\n")
}

const FAIL: &str = "#!/bin/sh\nexit 1\n";

impl Case {
    fn repo_file(mut self, path: &str, body: &str) -> Self {
        self.repo_files.push((path.into(), body.into()));
        self
    }
    fn home_file(mut self, path: &str, body: &str) -> Self {
        self.home_files.push((path.into(), body.into()));
        self
    }
    fn base_file(mut self, path: &str, body: &str) -> Self {
        self.base_files.push((path.into(), body.into()));
        self
    }
    fn bin(mut self, name: &'static str, body: impl Into<String>) -> Self {
        self.bins.push((name, body.into()));
        self
    }
    fn exec_file(mut self, path: &str, body: &str) -> Self {
        self.exec_files.push((path.into(), body.into()));
        self
    }
    fn dir(mut self, path: &str) -> Self {
        self.dirs.push(path.into());
        self
    }
    fn link(mut self, link: &str, target: &str) -> Self {
        self.links.push((link.into(), target.into()));
        self
    }
    fn mode(mut self, path: &str, mode: u32) -> Self {
        self.modes.push((path.into(), mode));
        self
    }
    fn env(mut self, key: &'static str, value: &str) -> Self {
        self.env.push((key, value.into()));
        self
    }
    fn env_raw(mut self, key: &'static str, bytes: &[u8]) -> Self {
        self.env_raw.push((key, bytes.to_vec()));
        self
    }
    fn path(mut self, dirs: &[&str]) -> Self {
        self.path = dirs.iter().map(|d| (*d).to_owned()).collect();
        self
    }
    fn no_home(mut self) -> Self {
        self.no_home = true;
        self
    }
    fn home_spelling(mut self, spelling: &'static str) -> Self {
        self.home_spelling = Some(spelling);
        self
    }
    /// `HOME` as both sides see it.
    fn home_text(&self, machine: &Machine) -> String {
        self.home_spelling.map_or_else(
            || machine.home.display().to_string(),
            |spelling| machine.fill(spelling),
        )
    }
    fn probe(mut self, probe: Value) -> Self {
        self.probe = Some(probe);
        self
    }
    fn current(mut self, version: &'static str) -> Self {
        self.current = version;
        self
    }
    fn threshold(mut self, chars: usize) -> Self {
        self.threshold = chars;
        self
    }
    fn hits(mut self, scans: &'static [&'static str]) -> Self {
        self.hits = scans;
        self
    }
    fn delegates(mut self, scans: &'static [&'static str]) -> Self {
        self.delegates = scans;
        self
    }
}

/// Where a written case lives.
struct Machine {
    base: PathBuf,
    root: PathBuf,
    home: PathBuf,
    /// The process working directory.
    cwd: PathBuf,
}

impl Machine {
    fn fill(&self, text: &str) -> String {
        text.replace("{base}", &self.base.display().to_string())
            .replace("{home}", &self.home.display().to_string())
            .replace("{root}", &self.root.display().to_string())
    }
}

fn put(root: &Path, rel: &str, body: &str) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, body).map_err(|e| format!("{rel}: {e}"))
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0))
}

impl Case {
    /// Writes the machine; the canonical base dir keeps `/tmp` symlinks out of path comparisons.
    fn write(&self) -> Result<Machine, String> {
        let raw = std::env::temp_dir().join(format!(
            "navori-doctor-machine-{}-{}-{}",
            self.name.replace(['/', ' '], "-"),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&raw);
        let machine = |base: PathBuf| Machine {
            root: base.join("proj"),
            home: base.join("home"),
            cwd: base.join("cwd"),
            base,
        };
        std::fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
        let machine = machine(raw.canonicalize().map_err(|e| e.to_string())?);
        for dir in [&machine.root, &machine.home, &machine.cwd] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(machine.base.join("bin")).map_err(|e| e.to_string())?;
        link_base_utilities(&machine.base.join("sys"))?;
        let mut config = json!({ "name": "proj", "preset": "custom", "engines": ["claude"] });
        if let (Some(base), Some(extra)) = (config.as_object_mut(), self.config.as_object()) {
            for (k, v) in extra {
                base.insert(k.clone(), v.clone());
            }
        }
        put(
            &machine.root,
            "navori.config.json",
            &machine.fill(&config.to_string()),
        )?;
        for (rel, body) in &self.repo_files {
            put(&machine.root, rel, &machine.fill(body))?;
        }
        for (rel, body) in &self.home_files {
            put(&machine.home, rel, &machine.fill(body))?;
        }
        for (rel, body) in &self.base_files {
            put(&machine.base, rel, &machine.fill(body))?;
        }
        for dir in &self.dirs {
            std::fs::create_dir_all(machine.base.join(dir)).map_err(|e| e.to_string())?;
        }
        for (name, body) in &self.bins {
            let rel = format!("bin/{name}");
            put(&machine.base, &rel, &machine.fill(body))?;
            set_mode(&machine.base.join(rel), 0o755)?;
        }
        for (rel, body) in &self.exec_files {
            put(&machine.base, rel, &machine.fill(body))?;
            set_mode(&machine.base.join(rel), 0o755)?;
        }
        for (link, target) in &self.links {
            let path = machine.base.join(link);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::os::unix::fs::symlink(machine.fill(target), &path).map_err(|e| e.to_string())?;
        }
        for (rel, mode) in &self.modes {
            set_mode(&machine.base.join(rel), *mode)?;
        }
        Ok(machine)
    }

    /// The environment both sides see, after `{…}` expansion.
    fn env_pairs(&self, machine: &Machine) -> Vec<(String, String)> {
        self.env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), machine.fill(v)))
            .collect()
    }

    fn path_text(&self, machine: &Machine) -> String {
        machine.fill(&self.path.join(":"))
    }
}

/// A `workspace.json` body.
fn workspace(name: &str, defaults: &Value, repos: &[(&str, &str)]) -> String {
    json!({
        "name": name,
        "defaults": defaults,
        "repos": repos.iter().map(|(n, p)| json!({ "name": n, "path": p })).collect::<Vec<_>>(),
    })
    .to_string()
}

/// `~/.navori/workspaces/<name>/workspace.json`.
fn ws_path(name: &str) -> String {
    format!(".navori/workspaces/{name}/workspace.json")
}

/// A sibling repo's config at `{base}/repos/<name>/navori.config.json`.
fn sibling(name: &str, config: &Value) -> (String, String) {
    let mut base = json!({ "name": name, "preset": "custom", "engines": ["claude"] });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), config.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    (format!("repos/{name}/navori.config.json"), base.to_string())
}

/// `~/.navori/tool-versions/latest.json` with one fresh entry per `(id, source, repo, status,
/// version)`.
fn latest(entries: &[(&str, &str, &str, &str, Option<&str>)], at: u64) -> String {
    let tools: Map<String, Value> = entries
        .iter()
        .map(|(id, source, repo, status, version)| {
            (
                (*id).to_owned(),
                json!({ "at": at, "source": source, "id": repo, "status": status, "version": version }),
            )
        })
        .collect();
    json!({ "tools": tools }).to_string()
}

const ENGRAM_REPO: &str = "Gentleman-Programming/engram";

// ---------------------------------------------------------------------------------------------
// Rust side
// ---------------------------------------------------------------------------------------------

/// Drops `null`-valued members and folds integral floats to integers on both sides: the TS result
/// went through `JSON.stringify`, where `undefined` vanishes and `3221225472` has no `.0`.
fn strip(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, strip(v)))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(strip).collect()),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => json!(f as i64),
            _ => Value::Number(n),
        },
        other => other,
    }
}

fn opt<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

/// A scan name with the Rust answer (`Err` = the port declines).
type Scan = (&'static str, Result<Value, Unmodeled>);

fn link_json(issue: Option<WorkspaceLinkIssue>) -> Value {
    match issue {
        None => Value::Null,
        Some(WorkspaceLinkIssue::WorkspaceMissing { workspace }) => {
            json!({ "kind": "workspace-missing", "workspace": workspace })
        }
        Some(WorkspaceLinkIssue::RepoNotRegistered { workspace }) => {
            json!({ "kind": "repo-not-registered", "workspace": workspace })
        }
        Some(WorkspaceLinkIssue::PathMismatch {
            workspace,
            repo_name,
            registered_path,
        }) => json!({ "kind": "path-mismatch", "workspace": workspace, "repoName": repo_name,
                      "registeredPath": registered_path }),
        Some(WorkspaceLinkIssue::UndeclaredPathMismatch {
            workspace,
            repo_name,
            registered_path,
        }) => json!({ "kind": "undeclared-path-mismatch", "workspace": workspace,
                      "repoName": repo_name, "registeredPath": registered_path }),
    }
}

fn drift_items(items: Vec<navori_core::diagnose::doctor_machine::WorkspaceDriftItem>) -> Value {
    Value::Array(
        items
            .into_iter()
            .map(|i| {
                json!({ "key": i.key, "local": i.local, "expected": i.expected,
                        "agree": i.agree, "total": i.total })
            })
            .collect(),
    )
}

/// The bundled `engram` manifest's `externalTool` with `probe` as its `capabilityProbe`.
fn engram_manifest(probe: &Value) -> Result<Value, String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/plugins/engram/plugin.json");
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut manifest: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    manifest["externalTool"]["capabilityProbe"] = probe.clone();
    Ok(manifest)
}

fn gap_json(gap: navori_core::diagnose::doctor_machine::ExternalToolCapabilityGap) -> Value {
    json!({ "pluginId": gap.plugin_id, "binary": gap.binary, "missing": gap.missing,
            "minVersion": gap.min_version, "install": opt(gap.install) })
}

/// Every scan on the machine, as `name -> Ok(json) | Err(Unmodeled)`.
fn rust_scans(case: &Case, machine: &Machine) -> Result<Vec<Scan>, String> {
    let bytes =
        std::fs::read(machine.root.join("navori.config.json")).map_err(|e| e.to_string())?;
    let cfg: Config =
        config::read(&bytes).map_err(|e| format!("rust rejects the fixture config: {e:?}"))?;
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    if !case.no_home {
        env.push(("HOME".into(), case.home_text(machine).into()));
    }
    env.push(("PATH".into(), case.path_text(machine).into()));
    for (k, v) in case.env_pairs(machine) {
        env.push((k.into(), v.into()));
    }
    for (k, v) in &case.env_raw {
        env.push(((*k).into(), OsString::from_vec(v.clone())));
    }
    let host = Host {
        env: &env,
        process_cwd: &machine.cwd,
        runner: &RealRunner,
    };
    let mut plugins = Plugins::default();
    let mut out: Vec<Scan> = Vec::new();

    out.push((
        "missingTools",
        scan_missing_external_tools(&host, &cfg, &mut plugins).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|m| {
                        json!({ "pluginId": m.plugin_id, "binary": m.binary,
                                "install": opt(m.install), "postInstall": opt(m.post_install),
                                "installDocs": opt(m.install_docs) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "versions",
        probe_enabled_tool_versions(&host, &cfg, &mut plugins, &mut |_, _| Ok(true)).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|i| {
                        json!({ "pluginId": i.plugin_id, "binary": i.binary,
                                "installedVersion": i.installed_version,
                                "install": opt(i.install) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "pinned",
        scan_pinned_version_drift(&host, &cfg, &mut plugins).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|d| {
                        json!({ "pluginId": d.plugin_id, "binary": d.binary,
                                "installedVersion": d.installed_version,
                                "pinnedVersion": d.pinned_version, "install": opt(d.install) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "advisories",
        scan_version_advisories(&host, &cfg, &mut plugins).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|a| {
                        json!({ "pluginId": a.plugin_id, "binary": a.binary,
                                "installedVersion": a.installed_version, "below": a.below,
                                "reason": { "es": a.reason_es, "en": a.reason_en },
                                "ref": opt(a.reference) })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "capabilities",
        match &case.probe {
            None => scan_external_tool_capabilities(&host, &cfg, &mut plugins)
                .map(|v| Value::Array(v.into_iter().map(gap_json).collect())),
            Some(probe) => {
                let manifest = engram_manifest(probe)?;
                let tool = js_json::parse(&manifest["externalTool"].to_string())
                    .ok_or("the overlaid manifest does not parse")?;
                let mut gaps = Vec::new();
                let mut stop = None;
                for id in notice::enabled(&cfg) {
                    if id != "engram" {
                        continue;
                    }
                    match capability_gap(&host, &id, &tool, "engram") {
                        Ok(gap) => gaps.extend(gap.map(gap_json)),
                        Err(Unmodeled) => stop = Some(Unmodeled),
                    }
                }
                stop.map_or(Ok(Value::Array(gaps)), Err)
            }
        },
    ));
    out.push((
        "updates",
        scan_tool_updates(&host, &cfg, &mut plugins).map(|r| {
            json!({
                "updates": r.updates.into_iter().map(|u| json!({
                    "pluginId": u.plugin_id, "binary": u.binary,
                    "installedVersion": u.installed_version,
                    "latestVersion": u.latest_version })).collect::<Vec<_>>(),
                "unparseable": r.unparseable.into_iter().map(|u| json!({
                    "pluginId": u.plugin_id, "source": u.source, "id": u.id })).collect::<Vec<_>>(),
            })
        }),
    ));
    out.push((
        "optional",
        Ok(Value::Array(
            scan_missing_optional_tools(&host)
                .into_iter()
                .map(|t| json!({ "id": t.id, "binaries": t.binaries, "install": t.install }))
                .collect(),
        )),
    ));
    let backup_root = case
        .env
        .iter()
        .find(|(k, _)| *k == "NAVORI_BACKUP_ROOT")
        .map_or_else(
            || machine.home.join(".navori").join("backups"),
            |(_, v)| PathBuf::from(machine.fill(v)),
        );
    // Without HOME and `NAVORI_BACKUP_ROOT` the TS `backupRoot()` throws: no root to hand the scan, so
    // the caller delegates (the core takes the root as an input).
    let no_backup_root = case.no_home && !case.env.iter().any(|(k, _)| *k == "NAVORI_BACKUP_ROOT");
    out.push((
        "disk",
        if no_backup_root {
            Err(Unmodeled)
        } else {
            scan_disk_usage(&host, &machine.root, &backup_root)
        }
        .map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|i| {
                        json!({ "target": match i.target {
                                    navori_core::diagnose::doctor_machine::DiskUsageTarget::Backups => "backups",
                                    navori_core::diagnose::doctor_machine::DiskUsageTarget::Worktrees => "worktrees" },
                                "path": i.path.display().to_string(), "bytes": i.bytes,
                                "thresholdBytes": i.threshold_bytes })
                    })
                    .collect(),
            )
        }),
    ));
    // Not a scan: the `du` limit has to be the same number on both sides (#1712).
    out.push((
        "duTimeout",
        u64::try_from(DU_TIMEOUT.as_millis())
            .map(|ms| json!(ms))
            .map_err(|_| Unmodeled),
    ));
    let uid = std::fs::metadata(&machine.home)
        .map_err(|e| e.to_string())?
        .uid();
    out.push((
        "audit",
        scan_audit_root_permissions(&host, uid).map(|r| {
            r.map_or(Value::Null, |a| {
                json!({ "root": a.root.display().to_string(),
                        "paths": a.paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>() })
            })
        }),
    ));
    out.push((
        "claudeMd",
        scan_global_claude_md(&host, case.threshold).map(|r| {
            r.map_or(Value::Null, |i| {
                json!({ "path": i.path, "chars": i.chars, "thresholdChars": i.threshold_chars })
            })
        }),
    ));
    out.push((
        "link",
        scan_workspace_link(&host, &machine.root, &cfg).map(link_json),
    ));
    out.push((
        "dead",
        scan_workspace_dead_repos(&host, &machine.root, &cfg).map(|v| {
            Value::Array(
                v.into_iter()
                    .map(|i| {
                        json!({ "workspace": i.workspace,
                                "repos": i.repos.into_iter()
                                    .map(|(name, path)| json!({ "name": name, "path": path }))
                                    .collect::<Vec<_>>() })
                    })
                    .collect(),
            )
        }),
    ));
    out.push((
        "drift",
        scan_workspace_drift(&host, &machine.root, &cfg).map(|r| {
            r.map_or(Value::Null, |d| {
                json!({ "workspace": d.workspace, "vsDefaults": drift_items(d.vs_defaults),
                        "vsSiblings": drift_items(d.vs_siblings),
                        "siblingsRead": d.siblings_read })
            })
        }),
    ));
    out.push((
        "stale",
        scan_stale_global_cli(&host, &machine.root, &cfg, case.current).map(|r| {
            r.map_or(
                Value::Null,
                |s| json!({ "global": s.global, "current": s.current }),
            )
        }),
    ));
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/// A reply with no finding: `null`, `false`, `[]`, or an object whose every field is trivial.
fn is_trivial(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Array(items) => items.is_empty(),
        Value::Object(fields) => fields.values().all(is_trivial),
        _ => false,
    }
}

/// Runs one case and removes its scratch directory when it passes (a failure keeps it to inspect).
fn check(case: &Case) -> Result<(), String> {
    let machine = case.write()?;
    let result = check_in(case, &machine);
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(&machine.base);
    }
    result
}

fn check_in(case: &Case, machine: &Machine) -> Result<(), String> {
    let manifests = match &case.probe {
        Some(probe) => json!({ "engram": engram_manifest(probe)? }),
        None => json!({}),
    };
    let env: Map<String, Value> = case
        .env_pairs(machine)
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    // Rust first: the TS `loadWorkspace` migrates a legacy registry layout in place.
    let scans = rust_scans(case, machine)?;
    let ts = NODE.ask(&json!({
        "dir": machine.root, "home": case.home_text(machine), "cwd": machine.cwd,
        "path": case.path_text(machine), "env": env, "noHome": case.no_home,
        "current": case.current, "threshold": case.threshold, "manifests": manifests,
    }))?;
    let mut failures = Vec::new();
    for (scan, rust) in scans {
        let declared = case.delegates.contains(&scan);
        match rust {
            Err(Unmodeled) if declared => {}
            Err(Unmodeled) => failures.push(format!("{scan}: rust delegates, not declared")),
            Ok(_) if declared => {
                failures.push(format!("{scan}: declared as delegating, but rust answered"));
            }
            Ok(rust) => {
                let reply = &ts[scan];
                let Some(ok) = reply.get("ok") else {
                    failures.push(format!("{scan}: ts threw {reply}; rust answered {rust}"));
                    continue;
                };
                let (ts_v, rust_v) = (strip(ok.clone()), strip(rust));
                if is_trivial(&ts_v) && case.hits.contains(&scan) {
                    failures.push(format!("{scan}: expected a finding, ts replied {ts_v}"));
                }
                if ts_v != rust_v {
                    failures.push(format!("{scan}:\n  ts   {ts_v}\n  rust {rust_v}"));
                }
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("[{}]\n{}", case.name, failures.join("\n")))
    }
}

fn run_all(cases: &[Case]) -> Result<(), String> {
    let errors: Vec<String> = cases.iter().filter_map(|c| check(c).err()).collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n\n"))
    }
}

const ALL_TOOLS: &[&str] = &["engram", "tgrep", "acli", "gh", "codegraph"];

// ---------------------------------------------------------------------------------------------
// Cases: external tools
// ---------------------------------------------------------------------------------------------

#[test]
fn empty_machine() -> Result<(), String> {
    run_all(&[case("empty", json!({})).hits(&["optional"])])
}

#[test]
fn missing_external_tools() -> Result<(), String> {
    run_all(&[
        // Nothing installed: every tool is missing, with this platform's command.
        case("all-missing", plugins(ALL_TOOLS)).hits(&["missingTools"]),
        case("some-present", plugins(ALL_TOOLS))
            .bin("tgrep", say("tgrep 1.0.0"))
            .bin("gh", say("gh 2.0.0"))
            .hits(&["missingTools"]),
        case("all-present", plugins(ALL_TOOLS))
            .bin("engram", say("engram 3.0.0"))
            .bin("tgrep", say("tgrep 1.0.0"))
            .bin("acli", say("acli 1.0.0"))
            .bin("gh", say("gh 2.0.0"))
            .bin("codegraph", say("codegraph 1.6.0")),
        // A disabled plugin and an unknown one are never reported.
        case(
            "disabled-and-unknown",
            json!({ "plugins": {
                "engram": { "enabled": false },
                "tgrep": { "enabled": true },
                "not-a-plugin": { "enabled": true } } }),
        )
        .hits(&["missingTools"]),
        // `hasBinary` wants an executable regular file.
        case("not-executable", plugins(&["tgrep"]))
            .exec_file("bin/tgrep", "#!/bin/sh\n")
            .mode("bin/tgrep", 0o644)
            .hits(&["missingTools"]),
        case("a-directory", plugins(&["tgrep"]))
            .dir("bin/tgrep")
            .hits(&["missingTools"]),
        case("dangling-symlink", plugins(&["tgrep"]))
            .link("bin/tgrep", "{base}/nowhere")
            .hits(&["missingTools"]),
        case("symlinked-binary", plugins(&["tgrep"]))
            .exec_file("real/tgrep", say("tgrep 1.0.0").as_str())
            .link("bin/tgrep", "{base}/real/tgrep"),
        // Empty and relative `PATH` entries: relative ones read from the process directory.
        case("relative-path-entry", plugins(&["tgrep"]))
            .path(&["", "relbin", "{base}/sys"])
            .exec_file("cwd/relbin/tgrep", say("tgrep 1.0.0").as_str()),
        case("relative-path-miss", plugins(&["tgrep"]))
            .path(&["relbin", "{base}/sys"])
            .hits(&["missingTools"]),
        case("empty-path", plugins(&["tgrep"]))
            .path(&[])
            .hits(&["missingTools"]),
    ])
}

#[test]
fn installed_versions() -> Result<(), String> {
    run_all(&[
        case("versions", plugins(&["engram", "tgrep", "codegraph", "gh"]))
            .bin("engram", say("engram version v3.2.1"))
            .bin("tgrep", say("tgrep 1.0.10 (build 2.0.0)"))
            .bin("codegraph", say("codegraph 1.5.0"))
            .bin("gh", say("gh version 2.40.1 (2024-01-01)"))
            .hits(&["versions"]),
        case("unparseable", plugins(&["engram", "tgrep"]))
            .bin("engram", say("engram dev build"))
            .bin("tgrep", say("tgrep 1.2"))
            .hits(&["optional"]),
        case("failing", plugins(&["engram", "tgrep"]))
            .bin("engram", FAIL)
            .bin("tgrep", say("tgrep 1.0.0"))
            .hits(&["versions"]),
        // stderr is ignored: a version printed only there is not seen.
        case("stderr-only", plugins(&["engram"]))
            .bin("engram", "#!/bin/sh\necho 'engram 3.0.0' >&2\n"),
        // More than `maxBuffer` on stdout reads as a throw, whatever it holds.
        case("over-maxbuffer", plugins(&["engram"])).bin(
            "engram",
            "#!/bin/sh\nyes 'engram 3.0.0' | head -c 2000000\n",
        ),
        case("multi-line", plugins(&["engram"])).bin(
            "engram",
            "#!/bin/sh\nprintf 'banner\\nengram 4.5.6\\nlib 7.8.9\\n'\n",
        ),
        case("version-without-newline", plugins(&["engram"]))
            .bin("engram", "#!/bin/sh\nprintf 'v1.2.3'\n")
            .hits(&["versions"]),
        // A non-zero exit that still prints a version is a throw too.
        case("exit-2-with-output", plugins(&["engram"]))
            .bin("engram", "#!/bin/sh\necho 'engram 3.0.0'\nexit 2\n"),
    ])
}

#[test]
fn pinned_version_drift() -> Result<(), String> {
    run_all(&[
        case("drifted", plugins(&["codegraph"]))
            .bin("codegraph", say("codegraph 1.5.0"))
            .hits(&["pinned"]),
        case("newer", plugins(&["codegraph"]))
            .bin("codegraph", say("codegraph 2.0.0"))
            .hits(&["pinned"]),
        case("on-pin", plugins(&["codegraph"])).bin("codegraph", say("codegraph 1.6.0")),
        case("missing-binary", plugins(&["codegraph"])).hits(&["missingTools"]),
        case("version-fails", plugins(&["codegraph"])).bin("codegraph", FAIL),
        case("plugin-without-pin", plugins(&["tgrep"])).bin("tgrep", say("tgrep 9.9.9")),
        case(
            "disabled",
            json!({ "plugins": { "codegraph": { "enabled": false } } }),
        )
        .bin("codegraph", say("codegraph 1.0.0")),
    ])
}

#[test]
fn version_advisories() -> Result<(), String> {
    run_all(&[
        case("below-floor", plugins(&["engram"]))
            .bin("engram", say("engram 2.9.9"))
            .hits(&["advisories"]),
        case("at-floor", plugins(&["engram"])).bin("engram", say("engram 3.0.0")),
        case("above-floor", plugins(&["engram"])).bin("engram", say("engram 3.4.0")),
        // The prerelease suffix is ignored: `3.0.0-rc.1` reads as fixed.
        case("prerelease-of-fixed", plugins(&["engram"])).bin("engram", say("engram 3.0.0-rc.1")),
        case("numeric-not-lexical", plugins(&["engram"]))
            .bin("engram", say("engram 2.10.0"))
            .hits(&["advisories"]),
        case("very-old", plugins(&["engram"]))
            .bin("engram", say("engram 0.0.1"))
            .hits(&["advisories"]),
        case("plugin-without-advisory", plugins(&["tgrep"])).bin("tgrep", say("tgrep 0.0.1")),
    ])
}

#[test]
fn capabilities() -> Result<(), String> {
    let probe = json!({ "args": ["--help"], "mustContain": ["--flag", "--other"],
                        "minVersion": "1.2.3" });
    run_all(&[
        // No bundled manifest declares a probe: the real scan is empty on both sides.
        case("bundled-has-no-probe", plugins(ALL_TOOLS))
            .bin("engram", say("engram 3.0.0"))
            .bin("tgrep", say("tgrep 1.0.0")),
        case("one-needle-missing", plugins(&["engram"]))
            .probe(probe.clone())
            .bin("engram", say("usage --flag"))
            .hits(&["capabilities"]),
        case("all-needles-missing", plugins(&["engram"]))
            .probe(probe.clone())
            .bin("engram", say("usage"))
            .hits(&["capabilities"]),
        case("all-present", plugins(&["engram"]))
            .probe(probe.clone())
            .bin("engram", "#!/bin/sh\necho '--other'\necho '--flag'\n"),
        // The probe's own failure is silent, as is an absent binary.
        case("probe-fails", plugins(&["engram"]))
            .probe(probe.clone())
            .bin("engram", FAIL),
        case("binary-absent", plugins(&["engram"])).probe(probe.clone()),
        case("plugin-disabled", json!({ "plugins": { "engram": { "enabled": false } } }))
            .probe(probe.clone())
            .bin("engram", say("usage")),
        // The probe's args reach the binary: the stub answers only to `--help`.
        case("args-reach-the-binary", plugins(&["engram"]))
            .probe(probe.clone())
            .bin(
                "engram",
                "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '--flag --other'; else echo nothing; fi\n",
            ),
        case("needle-is-substring", plugins(&["engram"]))
            .probe(json!({ "args": ["x"], "mustContain": ["--fl"], "minVersion": "0.0.1" }))
            .bin("engram", say("--flag")),
        case("probe-over-maxbuffer", plugins(&["engram"]))
            .probe(probe)
            .bin("engram", "#!/bin/sh\nyes -- '--flag --other' | head -c 2000000\n"),
    ])
}

#[test]
fn tool_updates() -> Result<(), String> {
    let at = now_ms() - 60_000;
    let fresh = |status: &'static str, version: Option<&'static str>| {
        latest(&[("engram", "github", ENGRAM_REPO, status, version)], at)
    };
    run_all(&[
        case("update-available", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            )
            .hits(&["updates"]),
        case("major-bump", plugins(&["engram"]))
            .bin("engram", say("engram 2.9.9"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("4.0.0")),
            )
            .hits(&["updates"]),
        // `notify: minor` ignores a patch bump.
        case("patch-below-notify-level", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.0.5")),
            ),
        case("up-to-date", plugins(&["engram"]))
            .bin("engram", say("engram 3.1.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            ),
        case("installed-is-newer", plugins(&["engram"]))
            .bin("engram", say("engram 5.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            ),
        // A release the refresh could not parse is surfaced, never compared.
        case("unparseable-release", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("unparseable", None),
            )
            .hits(&["updates"]),
        case("unparseable-but-plugin-disabled", json!({}))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("unparseable", None),
            ),
        case("no-binary", plugins(&["engram"])).home_file(
            ".navori/tool-versions/latest.json",
            &fresh("ok", Some("3.1.0")),
        ),
        case("no-cache", plugins(&["engram"])).bin("engram", say("engram 3.0.0")),
        case("plugin-disabled", json!({}))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            ),
        // An entry older than a week, from the future, or for another repo is ignored.
        case("stale-cache", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &latest(
                    &[("engram", "github", ENGRAM_REPO, "ok", Some("3.1.0"))],
                    now_ms() - 8 * 24 * 60 * 60 * 1000,
                ),
            ),
        case("future-stamp", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &latest(
                    &[("engram", "github", ENGRAM_REPO, "ok", Some("3.1.0"))],
                    now_ms() + 60 * 60 * 1000,
                ),
            ),
        case("other-repo", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &latest(
                    &[("engram", "github", "someone/else", "ok", Some("3.1.0"))],
                    at,
                ),
            ),
        case("other-source", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &latest(&[("engram", "npm", ENGRAM_REPO, "ok", Some("3.1.0"))], at),
            ),
        case("prerelease-latest-is-invalid", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0-rc.1")),
            ),
        // Opt-out and CI win over any cache.
        case("opt-out", plugins(&["engram"]))
            .env("NAVORI_NO_UPDATE_NOTIFIER", "1")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            ),
        case("opt-out-other-value", plugins(&["engram"]))
            .env("NAVORI_NO_UPDATE_NOTIFIER", "0")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            )
            .hits(&["updates"]),
        case("ci", plugins(&["engram"]))
            .env("CI", "true")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            ),
        case("ci-false", plugins(&["engram"]))
            .env("CI", "False")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            )
            .hits(&["updates"]),
        case("ci-zero", plugins(&["engram"]))
            .env("CI", "0")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            )
            .hits(&["updates"]),
        case("ci-empty", plugins(&["engram"]))
            .env("CI", "")
            .bin("engram", say("engram 3.0.0"))
            .home_file(
                ".navori/tool-versions/latest.json",
                &fresh("ok", Some("3.1.0")),
            )
            .hits(&["updates"]),
        // Damaged state files read as an empty cache.
        case("corrupt-cache", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(".navori/tool-versions/latest.json", "{not json")
            .delegates(&["updates"]),
        case("tools-not-an-object", plugins(&["engram"]))
            .bin("engram", say("engram 3.0.0"))
            .home_file(".navori/tool-versions/latest.json", r#"{"tools":[1,2]}"#),
    ])
}

#[test]
fn optional_tools() -> Result<(), String> {
    run_all(&[
        case("ast-grep-missing", json!({})).hits(&["optional"]),
        case("ast-grep-present", json!({})).bin("ast-grep", say("ast-grep 0.30.0")),
        // The `sg` alias is not accepted (#495).
        case("only-the-sg-alias", json!({}))
            .bin("sg", say("sg"))
            .hits(&["optional"]),
        case("ast-grep-not-executable", json!({}))
            .exec_file("bin/ast-grep", "#!/bin/sh\n")
            .mode("bin/ast-grep", 0o600)
            .hits(&["optional"]),
    ])
}

// ---------------------------------------------------------------------------------------------
// Cases: disk, audit root, global CLAUDE.md
// ---------------------------------------------------------------------------------------------

/// `du -sk <path>` answering `kib`.
fn du(kib: &str) -> String {
    format!("#!/bin/sh\nprintf '%s\\t%s\\n' {kib} \"$2\"\n")
}

#[test]
fn disk_usage() -> Result<(), String> {
    const OVER_BACKUPS: &str = "1572864"; // 1.5 GiB
    const OVER_WORKTREES: &str = "3145728"; // 3 GiB
    run_all(&[
        // Real `du` on small directories: under both thresholds.
        case("small", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .repo_file(".claude/worktrees/w/file", "x"),
        case("neither-exists", json!({})).bin("du", du(OVER_WORKTREES)),
        case("backups-over", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du(OVER_BACKUPS))
            .hits(&["disk"]),
        case("both-over", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .repo_file(".claude/worktrees/w/file", "x")
            .bin("du", du(OVER_WORKTREES))
            .hits(&["disk"]),
        // Worktrees only cross at 2 GiB; backups at 1 GiB.
        case("worktrees-between-thresholds", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .repo_file(".claude/worktrees/w/file", "x")
            .bin("du", du(OVER_BACKUPS))
            .hits(&["disk"]),
        case("exactly-at-threshold", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("1048576")),
        case("one-kib-over", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("1048577"))
            .hits(&["disk"]),
        case("backup-root-override", json!({}))
            .env("NAVORI_BACKUP_ROOT", "{base}/elsewhere")
            .base_file("elsewhere/a/file", "x")
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du(OVER_BACKUPS))
            .hits(&["disk"]),
        // `du` failing, or answering something that is not a size, skips the check.
        case("du-fails", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", FAIL),
        case("du-garbage", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("abc")),
        case("du-negative", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("-5")),
        case("du-decimal", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("1572864.9"))
            .hits(&["disk"]),
        case("du-leading-plus", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", du("+1572864"))
            .hits(&["disk"]),
        case("du-empty", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", "#!/bin/sh\n"),
        case("du-leading-space", json!({}))
            .home_file(".navori/backups/a/file", "x")
            .bin("du", "#!/bin/sh\nprintf '  1572864\\t%s\\n' \"$2\"\n")
            .hits(&["disk"]),
        case("du-absent", json!({}))
            .path(&["{base}/bin"])
            .home_file(".navori/backups/a/file", "x"),
    ])
}

#[test]
fn audit_root_permissions() -> Result<(), String> {
    run_all(&[
        case("no-root", json!({})),
        case("private-root", json!({}))
            .dir("home/.navori/audits/repo-a")
            .mode("home/.navori/audits", 0o700)
            .mode("home/.navori/audits/repo-a", 0o700),
        case("open-root", json!({}))
            .dir("home/.navori/audits/repo-a")
            .mode("home/.navori/audits", 0o755)
            .mode("home/.navori/audits/repo-a", 0o700)
            .hits(&["audit"]),
        case("open-children", json!({}))
            .dir("home/.navori/audits/repo-a")
            .dir("home/.navori/audits/repo-b")
            .dir("home/.navori/audits/repo-c")
            .mode("home/.navori/audits", 0o700)
            .mode("home/.navori/audits/repo-a", 0o770)
            .mode("home/.navori/audits/repo-b", 0o700)
            .mode("home/.navori/audits/repo-c", 0o701)
            .hits(&["audit"]),
        case("many-open-children", json!({}))
            .dir("home/.navori/audits/zeta")
            .dir("home/.navori/audits/alpha")
            .dir("home/.navori/audits/mid")
            .dir("home/.navori/audits/beta")
            .mode("home/.navori/audits", 0o755)
            .mode("home/.navori/audits/zeta", 0o755)
            .mode("home/.navori/audits/alpha", 0o755)
            .mode("home/.navori/audits/mid", 0o755)
            .mode("home/.navori/audits/beta", 0o755)
            .hits(&["audit"]),
        // `path.join` normalizes the default root: a `HOME` spelled with `/./` and `//` reports
        // the same paths on both sides (#1712).
        case("open-root-unnormalized-home", json!({}))
            .home_spelling("{base}/./home//")
            .dir("home/.navori/audits/repo-a")
            .mode("home/.navori/audits", 0o755)
            .mode("home/.navori/audits/repo-a", 0o755)
            .hits(&["audit"]),
        // Files and symlinks under the root are never inspected.
        case("open-file-and-symlink", json!({}))
            .dir("home/.navori/audits")
            .dir("elsewhere")
            .base_file("home/.navori/audits/loose-file", "x")
            .link("home/.navori/audits/linked", "{base}/elsewhere")
            .mode("home/.navori/audits", 0o700)
            .mode("home/.navori/audits/loose-file", 0o666)
            .mode("elsewhere", 0o777),
        // The root itself a symlink: lstat sees a symlink, not a directory.
        case("root-is-a-symlink", json!({}))
            .dir("real-audits")
            .link("home/.navori/audits", "{base}/real-audits")
            .mode("real-audits", 0o777),
        case("root-is-a-file", json!({}))
            .base_file("home/.navori/audits", "x")
            .mode("home/.navori/audits", 0o666),
        case("override-root", json!({}))
            .env("NAVORI_AUDITS_ROOT", "{base}/aud")
            .dir("aud/r")
            .mode("aud", 0o755)
            .mode("aud/r", 0o755)
            .hits(&["audit"]),
        case("override-with-spaces", json!({}))
            .env("NAVORI_AUDITS_ROOT", "  {base}/aud  ")
            .dir("aud")
            .mode("aud", 0o755)
            .hits(&["audit"]),
        case("override-with-dotdot", json!({}))
            .env("NAVORI_AUDITS_ROOT", "{base}/x/../aud/")
            .dir("aud")
            .dir("x")
            .mode("aud", 0o777)
            .hits(&["audit"]),
        // A relative override throws in the TS; whitespace-only falls back to the default.
        case("override-relative", json!({}))
            .env("NAVORI_AUDITS_ROOT", "audits")
            .dir("cwd/audits")
            .mode("cwd/audits", 0o777),
        case("override-blank", json!({}))
            .env("NAVORI_AUDITS_ROOT", "   ")
            .dir("home/.navori/audits")
            .mode("home/.navori/audits", 0o755)
            .hits(&["audit"]),
        case("override-missing-dir", json!({})).env("NAVORI_AUDITS_ROOT", "{base}/none"),
        // A value Node would read differently from Rust is delegated.
        case("override-not-utf8", json!({}))
            .env_raw("NAVORI_AUDITS_ROOT", b"/tmp/\xff")
            .delegates(&["audit"]),
    ])
}

/// 150 characters; 300 UTF-16 units when each character is an astral one.
fn long_text(unit: &str) -> String {
    unit.repeat(150)
}

#[test]
fn global_claude_md() -> Result<(), String> {
    run_all(&[
        case("absent", json!({})),
        case("under-threshold", json!({})).home_file(".claude/CLAUDE.md", &long_text("a")[..100]),
        case("at-threshold", json!({})).home_file(".claude/CLAUDE.md", &"a".repeat(100)),
        case("one-over", json!({}))
            .home_file(".claude/CLAUDE.md", &"a".repeat(101))
            .hits(&["claudeMd"]),
        // `.length` counts UTF-16 code units: an astral character is two.
        case("astral-characters", json!({}))
            .home_file(".claude/CLAUDE.md", &long_text("\u{1F600}"))
            .hits(&["claudeMd"]),
        case("astral-at-threshold", json!({}))
            .threshold(100)
            .home_file(".claude/CLAUDE.md", &"\u{1F600}".repeat(50)),
        case("accents", json!({}))
            .home_file(".claude/CLAUDE.md", &"\u{e9}".repeat(101))
            .hits(&["claudeMd"]),
        case("default-sized", json!({}))
            .threshold(10)
            .home_file(".claude/CLAUDE.md", "0123456789a")
            .hits(&["claudeMd"]),
        case("config-dir-outside-home", json!({}))
            .env("CLAUDE_CONFIG_DIR", "{base}/claude-cfg")
            .base_file("claude-cfg/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("config-dir-inside-home", json!({}))
            .env("CLAUDE_CONFIG_DIR", "{home}/custom")
            .home_file("custom/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("config-dir-trimmed", json!({}))
            .env("CLAUDE_CONFIG_DIR", "  {base}/claude-cfg  ")
            .base_file("claude-cfg/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("config-dir-relative", json!({}))
            .env("CLAUDE_CONFIG_DIR", "rel-cfg")
            .base_file("cwd/rel-cfg/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("config-dir-blank", json!({}))
            .env("CLAUDE_CONFIG_DIR", "   ")
            .home_file(".claude/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("config-dir-dotdot", json!({}))
            .env("CLAUDE_CONFIG_DIR", "{home}/a/../.claude")
            .home_file(".claude/CLAUDE.md", &"a".repeat(200))
            .dir("home/a")
            .hits(&["claudeMd"]),
        // The home prefix only shortens at a path boundary.
        case("sibling-of-home", json!({}))
            .env("CLAUDE_CONFIG_DIR", "{base}/home-other")
            .base_file("home-other/CLAUDE.md", &"a".repeat(200))
            .hits(&["claudeMd"]),
        case("a-directory-named-claude-md", json!({})).dir("home/.claude/CLAUDE.md"),
        case("config-dir-not-utf8", json!({}))
            .env_raw("CLAUDE_CONFIG_DIR", b"/tmp/\xff")
            .delegates(&["claudeMd"]),
    ])
}

// ---------------------------------------------------------------------------------------------
// Cases: workspace registry
// ---------------------------------------------------------------------------------------------

#[test]
fn workspace_link() -> Result<(), String> {
    let me = "{root}";
    run_all(&[
        case("not-declared-empty-registry", json!({})),
        case("declared-not-in-registry", json!({ "workspace": "team" })).hits(&["link"]),
        case(
            "declared-and-listed-by-path",
            json!({ "workspace": "team" }),
        )
        .home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", me)]),
        ),
        case(
            "declared-listed-by-another-name",
            json!({ "workspace": "team" }),
        )
        .home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("other", me)]),
        ),
        case("declared-path-mismatch", json!({ "workspace": "team" }))
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("proj", "/somewhere/else")]),
            )
            .hits(&["link"]),
        case("declared-not-registered", json!({ "workspace": "team" }))
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("other", "/somewhere/else")]),
            )
            .hits(&["link"]),
        case("declared-empty-repos", json!({ "workspace": "team" }))
            .home_file(&ws_path("team"), &workspace("team", &json!({}), &[]))
            .hits(&["link"]),
        // A manifest that does not load reads as a missing workspace.
        case("declared-invalid-schema", json!({ "workspace": "team" }))
            .home_file(&ws_path("team"), r#"{"name":"Not Kebab"}"#)
            .hits(&["link"]),
        case("declared-invalid-json", json!({ "workspace": "team" }))
            .home_file(&ws_path("team"), "{nope")
            .delegates(&["link", "dead", "drift"]),
        case("declared-with-bom", json!({ "workspace": "team" })).home_file(
            &ws_path("team"),
            &format!("\u{feff}{}", workspace("team", &json!({}), &[("proj", me)])),
        ),
        // Registry paths are compared canonically: relative, `..`, trailing slash, symlink.
        case("relative-registered-path", json!({ "workspace": "team" })).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", "../proj")]),
        ),
        case("dotdot-registered-path", json!({ "workspace": "team" })).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", "{base}/x/../proj")]),
        ),
        case("trailing-slash-path", json!({ "workspace": "team" })).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", "{root}/")]),
        ),
        case("symlinked-registered-path", json!({ "workspace": "team" }))
            .link("alias", "{root}")
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("proj", "{base}/alias")]),
            ),
        // Undeclared: the repo's name registered under another path (#1269).
        case("undeclared-name-elsewhere", json!({}))
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("proj", "/old/place")]),
            )
            .hits(&["link"]),
        case("undeclared-listed-by-path", json!({})).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", me)]),
        ),
        case("undeclared-other-names-only", json!({})).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("other", "/old/place")]),
        ),
        case("undeclared-first-workspace-wins", json!({}))
            .home_file(
                &ws_path("alpha"),
                &workspace("alpha", &json!({}), &[("proj", "/a")]),
            )
            .home_file(
                &ws_path("beta"),
                &workspace("beta", &json!({}), &[("proj", "/b")]),
            )
            .hits(&["link"]),
        case("undeclared-skips-a-broken-manifest", json!({}))
            .home_file(&ws_path("alpha"), "{broken")
            .home_file(
                &ws_path("beta"),
                &workspace("beta", &json!({}), &[("proj", "/b")]),
            )
            .delegates(&["link", "dead"]),
        case("undeclared-listed-by-path-then-name", json!({}))
            .home_file(
                &ws_path("alpha"),
                &workspace("alpha", &json!({}), &[("proj", me)]),
            )
            .home_file(
                &ws_path("beta"),
                &workspace("beta", &json!({}), &[("proj", "/b")]),
            )
            .hits(&["link"]),
        // A directory without a manifest, and stray files at the root, are not workspaces.
        case("undeclared-stray-entries", json!({}))
            .dir("home/.navori/workspaces/empty-dir")
            .home_file(".navori/workspaces/stray.txt", "x")
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("proj", "/old/place")]),
            )
            .hits(&["link"]),
        // The legacy `<name>.json` layout migrates in the TS: the port delegates.
        case("legacy-layout", json!({ "workspace": "team" }))
            .home_file(
                ".navori/workspaces/team.json",
                &workspace("team", &json!({}), &[("proj", me)]),
            )
            .delegates(&["link", "dead", "drift"]),
        case("no-home", json!({ "workspace": "team" }))
            .no_home()
            .delegates(&[
                "disk", "claudeMd", "audit", "link", "dead", "drift", "updates",
            ]),
    ])
}

#[test]
fn workspace_dead_repos() -> Result<(), String> {
    let me = "{root}";
    run_all(&[
        case("no-registry", json!({})),
        case("all-alive", json!({ "workspace": "team" }))
            .dir("repos/api")
            .home_file(
                &ws_path("team"),
                &workspace(
                    "team",
                    &json!({}),
                    &[("proj", me), ("api", "{base}/repos/api")],
                ),
            ),
        case("one-dead", json!({ "workspace": "team" }))
            .dir("repos/api")
            .home_file(
                &ws_path("team"),
                &workspace(
                    "team",
                    &json!({}),
                    &[
                        ("proj", me),
                        ("api", "{base}/repos/api"),
                        ("web", "{base}/repos/gone"),
                    ],
                ),
            )
            .hits(&["dead"]),
        // The repo's own entry is never reported, dead or not.
        case("own-entry-dead", json!({ "workspace": "team" })).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("proj", "/does/not/exist")]),
        ),
        case("own-path-by-another-name", json!({ "workspace": "team" }))
            .home_file(
                &ws_path("team"),
                &workspace(
                    "team",
                    &json!({}),
                    &[("renamed", me), ("web", "{base}/gone")],
                ),
            )
            .hits(&["dead"]),
        // Member by name only, by path only, or by declaration only.
        case("member-by-name", json!({}))
            .home_file(
                &ws_path("team"),
                &workspace(
                    "team",
                    &json!({}),
                    &[("proj", "/old"), ("web", "{base}/gone")],
                ),
            )
            .hits(&["dead"]),
        case("member-by-path", json!({}))
            .home_file(
                &ws_path("team"),
                &workspace(
                    "team",
                    &json!({}),
                    &[("renamed", me), ("web", "{base}/gone")],
                ),
            )
            .hits(&["dead"]),
        case("member-by-declaration", json!({ "workspace": "team" }))
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("web", "{base}/gone")]),
            )
            .hits(&["dead"]),
        case("not-a-member", json!({})).home_file(
            &ws_path("team"),
            &workspace("team", &json!({}), &[("web", "{base}/gone")]),
        ),
        case("two-workspaces", json!({ "workspace": "beta" }))
            .home_file(
                &ws_path("alpha"),
                &workspace("alpha", &json!({}), &[("proj", me), ("x", "{base}/gone-a")]),
            )
            .home_file(
                &ws_path("beta"),
                &workspace(
                    "beta",
                    &json!({}),
                    &[("y", "{base}/gone-b"), ("z", "{base}/gone-c")],
                ),
            )
            .hits(&["dead"]),
        // Existence of a relative registry path is read from the process directory.
        case("relative-dead-path", json!({ "workspace": "team" }))
            .dir("cwd/present")
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("a", "present"), ("b", "absent")]),
            )
            .hits(&["dead"]),
        case("dead-symlink-target", json!({ "workspace": "team" }))
            .link("dangling", "{base}/nowhere")
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("a", "{base}/dangling")]),
            )
            .hits(&["dead"]),
        case("broken-manifest-skipped", json!({ "workspace": "team" }))
            .home_file(&ws_path("alpha"), "{broken")
            .home_file(
                &ws_path("team"),
                &workspace("team", &json!({}), &[("web", "{base}/gone")]),
            )
            .delegates(&["dead"]),
    ])
}

#[test]
fn workspace_drift() -> Result<(), String> {
    let team = |defaults: &Value, siblings: &[&str]| {
        let repos: Vec<(String, String)> = siblings
            .iter()
            .map(|n| ((*n).to_owned(), format!("{{base}}/repos/{n}")))
            .collect();
        let mut all: Vec<(&str, &str)> = vec![("proj", "{root}")];
        all.extend(repos.iter().map(|(n, p)| (n.as_str(), p.as_str())));
        workspace("team", defaults, &all)
    };
    let with = |config: Value, defaults: Value, siblings: &[(&str, Value)]| {
        let names: Vec<&str> = siblings.iter().map(|(n, _)| *n).collect();
        let mut c = case("drift", config).home_file(&ws_path("team"), &team(&defaults, &names));
        for (name, cfg) in siblings {
            let (path, body) = sibling(name, cfg);
            c = c.base_file(&path, &body);
        }
        c
    };
    let tgrep_on = plugins(&["tgrep"]);
    run_all(&[
        case("not-declared", json!({})),
        case("manifest-missing", json!({ "workspace": "team" })),
        with(json!({ "workspace": "team" }), json!({}), &[]),
        // Defaults.
        with(
            json!({ "workspace": "team", "branchBase": "main" }),
            json!({ "branchBase": "develop" }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "commits": "free", "language": "en" }),
            json!({ "commits": "conventional", "language": "es" }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "engines": ["codex", "claude"] }),
            json!({ "engines": ["claude"] }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "engines": ["codex", "claude"] }),
            json!({ "engines": ["claude", "codex"] }),
            &[],
        ),
        with(
            json!({ "workspace": "team" }),
            json!({ "plugins": { "tgrep": { "enabled": true }, "gh": { "enabled": false } } }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "plugins": { "tgrep": { "enabled": false } } }),
            json!({ "plugins": { "tgrep": { "enabled": true } } }),
            &[],
        )
        .hits(&["drift"]),
        // `prTarget` falls back to `branchBase`, and a row that only echoes it is dropped.
        with(
            json!({ "workspace": "team", "branchBase": "main" }),
            json!({ "branchBase": "develop", "prTarget": "develop" }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "branchBase": "main", "prTarget": "release" }),
            json!({ "branchBase": "develop", "prTarget": "develop" }),
            &[],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "branchBase": "main" }),
            json!({ "prTarget": "develop" }),
            &[],
        )
        .hits(&["drift"]),
        // Siblings: a strict majority of at least two.
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({}),
            &[
                ("a", json!({ "commits": "conventional" })),
                ("b", json!({ "commits": "conventional" })),
                ("c", json!({ "commits": "free" })),
            ],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({}),
            &[
                ("a", json!({ "commits": "conventional" })),
                ("b", json!({ "commits": "free" })),
            ],
        ),
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({}),
            &[("a", json!({ "commits": "conventional" }))],
        ),
        with(
            json!({ "workspace": "team", "branchBase": "main" }),
            json!({}),
            &[
                ("a", json!({ "branchBase": "develop" })),
                ("b", json!({ "branchBase": "develop" })),
            ],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "branchBase": "main", "prTarget": "release" }),
            json!({}),
            &[
                ("a", json!({ "branchBase": "develop" })),
                ("b", json!({ "branchBase": "develop" })),
            ],
        )
        .hits(&["drift"]),
        // Plugins are one-directional: "the others enable it" is drift, the opposite is not.
        with(
            json!({ "workspace": "team" }),
            json!({}),
            &[("a", tgrep_on.clone()), ("b", tgrep_on.clone())],
        )
        .hits(&["drift"]),
        with(
            json!({ "workspace": "team", "plugins": { "tgrep": { "enabled": true } } }),
            json!({}),
            &[("a", json!({})), ("b", json!({}))],
        ),
        // An explicit opt-out is a decision (#374), on either side.
        with(
            json!({ "workspace": "team", "plugins": { "tgrep": { "enabled": false } } }),
            json!({}),
            &[("a", tgrep_on.clone()), ("b", tgrep_on.clone())],
        ),
        with(
            json!({ "workspace": "team", "plugins": { "tgrep": { "enabled": true } } }),
            json!({}),
            &[
                ("a", json!({ "plugins": { "tgrep": { "enabled": false } } })),
                ("b", json!({ "plugins": { "tgrep": { "enabled": false } } })),
            ],
        ),
        // `models` and `effort` reduce to declared / undeclared.
        with(
            json!({ "workspace": "team" }),
            json!({}),
            &[
                ("a", json!({ "models": { "architect": "opus" } })),
                ("b", json!({ "models": { "architect": "sonnet" } })),
            ],
        )
        .hits(&["drift"]),
        // Engines compare sorted.
        with(
            json!({ "workspace": "team", "engines": ["claude"] }),
            json!({}),
            &[
                ("a", json!({ "engines": ["codex", "claude"] })),
                ("b", json!({ "engines": ["claude", "codex"] })),
            ],
        )
        .hits(&["drift"]),
        // The defaults row wins over a sibling row for the same key.
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({ "commits": "conventional-es" }),
            &[
                ("a", json!({ "commits": "conventional" })),
                ("b", json!({ "commits": "conventional" })),
            ],
        )
        .hits(&["drift"]),
        // Several keys at once, in key order.
        with(
            json!({ "workspace": "team", "branchBase": "main", "language": "en",
                    "commits": "free" }),
            json!({ "language": "es" }),
            &[
                (
                    "a",
                    json!({ "branchBase": "develop", "commits": "conventional", "language": "es" }),
                ),
                (
                    "b",
                    json!({ "branchBase": "develop", "commits": "conventional", "language": "es" }),
                ),
                (
                    "c",
                    json!({ "branchBase": "develop", "commits": "conventional", "language": "es" }),
                ),
            ],
        )
        .hits(&["drift"]),
        // A sibling with no config, or a repo that does not exist, does not count.
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({}),
            &[
                ("a", json!({ "commits": "conventional" })),
                ("b", json!({ "commits": "conventional" })),
            ],
        )
        .home_file(
            &ws_path("team"),
            &workspace(
                "team",
                &json!({}),
                &[
                    ("proj", "{root}"),
                    ("a", "{base}/repos/a"),
                    ("b", "{base}/repos/b"),
                    ("ghost", "{base}/repos/ghost"),
                ],
            ),
        )
        .dir("repos/empty")
        .hits(&["drift"]),
        // A sibling whose config only the TS reads makes the scan delegate.
        with(
            json!({ "workspace": "team", "commits": "free" }),
            json!({}),
            &[
                ("a", json!({ "commits": "conventional" })),
                ("b", json!({ "commits": "conventional" })),
            ],
        )
        .base_file("repos/c/navori.config.json", "{broken")
        .home_file(
            &ws_path("team"),
            &workspace(
                "team",
                &json!({}),
                &[
                    ("proj", "{root}"),
                    ("a", "{base}/repos/a"),
                    ("b", "{base}/repos/b"),
                    ("c", "{base}/repos/c"),
                ],
            ),
        )
        .delegates(&["drift"]),
    ])
}

// ---------------------------------------------------------------------------------------------
// Cases: global CLI
// ---------------------------------------------------------------------------------------------

#[test]
fn stale_global_cli() -> Result<(), String> {
    let hook = "#!/bin/sh\nnavori session-start\n";
    run_all(&[
        case("stale", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("same-version", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori 1.0.0")),
        case("newer", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori 2.0.0")),
        case("numeric-compare", json!({}))
            .current("1.10.0")
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori 1.9.0"))
            .hits(&["stale"]),
        case("no-hooks", json!({})).bin("navori", say("navori 0.9.0")),
        case("hook-does-not-call-navori", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\necho hi\n")
            .bin("navori", say("navori 0.9.0")),
        case("hook-only-in-a-comment", json!({}))
            .repo_file(
                ".claude/hooks/start.sh",
                "#!/bin/sh\n  # navori render\necho hi\n",
            )
            .bin("navori", say("navori 0.9.0")),
        case("hook-not-a-shell-script", json!({}))
            .repo_file(".claude/hooks/start.py", "navori render\n")
            .bin("navori", say("navori 0.9.0")),
        case("hook-after-a-semicolon", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\ncd x; navori render\n")
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("hook-in-a-subshell", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\nx=$(navori render)\n")
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("hook-in-quotes", json!({}))
            .repo_file(
                ".claude/hooks/start.sh",
                "#!/bin/sh\nsh -c \"navori render\"\n",
            )
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("hook-navori-uppercase-subcommand", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\nnavori Render\n")
            .bin("navori", say("navori 0.9.0")),
        case("hook-navori-prefix", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\nmynavori render\n")
            .bin("navori", say("navori 0.9.0")),
        case("hook-without-trailing-newline", json!({}))
            .repo_file(".claude/hooks/start.sh", "navori render")
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("hook-crlf", json!({}))
            .repo_file(".claude/hooks/start.sh", "#!/bin/sh\r\nnavori render\r\n")
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("scripts-dir", json!({}))
            .repo_file(".claude/scripts/x.sh", hook)
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("codex-hooks-dir", json!({ "engines": ["codex"] }))
            .repo_file(".codex/hooks/x.sh", hook)
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("codex-dir-but-claude-only-engine-still-scans", json!({}))
            .repo_file(".codex/hooks/x.sh", hook)
            .bin("navori", say("navori 0.9.0"))
            .hits(&["stale"]),
        case("pi-only-engine", json!({ "engines": ["pi"] }))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori 0.9.0")),
        case("no-global-navori", json!({})).repo_file(".claude/hooks/start.sh", hook),
        case("global-fails", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", FAIL),
        case("global-prints-no-version", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin("navori", say("navori dev")),
        case("global-version-in-a-banner", json!({}))
            .repo_file(".claude/hooks/start.sh", hook)
            .bin(
                "navori",
                "#!/bin/sh\nprintf 'navori cli\\nversion 0.8.1 (node 22.0.0)\\n'\n",
            )
            .hits(&["stale"]),
        case("a-directory-named-like-a-hook", json!({}))
            .dir("proj/.claude/hooks/dir.sh")
            .bin("navori", say("navori 0.9.0")),
    ])
}
