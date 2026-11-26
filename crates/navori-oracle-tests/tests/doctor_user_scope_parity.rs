//! `navori_core::diagnose::doctor_user_scope` against the TS `doctor` user-scope scans (spec 0060
//! T23 slice 5e4): `scanGlobalLayerLeftovers`, `scanForeignHarness`, and the conditions under
//! which the scans that stay in the TS (`scanOtelReceiver`, `scanPiHealth`, `scanOperationalTools`,
//! `scanCodegraphWiring`) apply.
//!
//! Every case builds a hermetic machine under one temp dir: a `HOME` of its own (`os.homedir` is
//! pinned to it on the TS side), a `bin/` of nothing and a `sys/` with only `git`, a process working
//! directory of its own and a repo with an explicit config. Nothing reads the real machine. Replies
//! are compared as normalised JSON.
//!
//! A scan the Rust port declines ([`Unmodeled`], the CLI then delegates) must be listed in the
//! case's `delegates`; the list is checked both ways, so it cannot rot.

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::config::{self, Config};
use navori_core::diagnose::doctor_machine::Host;
use navori_core::diagnose::doctor_user_scope::{
    ForeignConflict, ForeignHarnessReport, GlobalLeftover, TsOnlyScan, doctor_ts_only_scans,
    scan_foreign_harness, scan_global_layer_leftovers,
};
use navori_core::process::RealRunner;
use navori_core::workspace::patterns::Unmodeled;
use serde_json::{Map, Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const fs = (await import('node:fs')).default;\nconst path = await import('node:path');\n\
         const mm = await import('node:module');\n\
         const c = await import({:?});\nconst d = await import({:?});\n\
         const fh = await import({:?});\nconst gl = await import({:?});\n\
         const pi = await import({:?});\nconst cw = await import({:?});",
        cli_module("lib/config/config.ts"),
        cli_module("commands/doctor.ts"),
        cli_module("lib/diagnose/foreign-harness.ts"),
        cli_module("lib/diagnose/global-leftovers.ts"),
        cli_module("lib/diagnose/pi-health.ts"),
        cli_module("lib/diagnose/codegraph-wiring.ts"),
    )
}

/// One request = one machine; the reply maps each scan name to `{ ok }` or `{ err }`.
static NODE: Shared = Shared::new(
    prelude,
    r#"
for (const k of ['CI', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) delete process.env[k];
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
const out = {};
const run = async (name, f) => { try { out[name] = { ok: (await f()) ?? null }; } catch (e) { out[name] = { err: String(e && e.message || e) }; } };
await run('leftovers', () => gl.scanGlobalLayerLeftovers());
await run('foreign', () => fh.scanForeignHarness(request.dir, cfg, request.claudeDir ? { claudeDir: request.claudeDir } : {}));
await run('tsOnly', async () => {
  const ops = d.scanOperationalTools(request.dir, cfg);
  return {
    otel: (await d.scanOtelReceiver(cfg, { port: 1 })) !== null,
    pi: pi.scanPiHealth(request.dir, cfg, () => null) !== null,
    operational: Boolean(ops.tgrep || ops.codegraph || ops.engram),
    wiring: cw.scanCodegraphWiring(request.dir, cfg) !== null,
  };
});
return out;
"#,
);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A file carrying a navori managed block.
const MANAGED: &str = "<!-- navori:managed id=\"x\" hash=\"abc\" version=\"0.1.0\" source=\"@navori/core\" -->\nbody\n<!-- /navori:managed id=\"x\" -->\n";
/// A hand-made file.
const MINE: &str = "my own asset\n";
/// A plugin manifest that Claude Code loads as a `@skills-dir` plugin.
const PLUGIN: &str = "{}";

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
    /// `(link, target)` symlinks under the base dir.
    links: Vec<(String, String)>,
    /// Extra environment variables, set on both sides.
    env: Vec<(&'static str, String)>,
    /// `git init` the repo.
    git_init: bool,
    /// Both sides run without `HOME`.
    no_home: bool,
    /// `scanForeignHarness`'s `claudeDir` option.
    claude_dir: Option<&'static str>,
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
        links: Vec::new(),
        env: Vec::new(),
        git_init: false,
        no_home: false,
        claude_dir: None,
        delegates: &[],
        hits: &[],
    }
}

impl Case {
    fn repo(mut self, path: &str, body: &str) -> Self {
        self.repo_files.push((path.into(), body.into()));
        self
    }
    fn home(mut self, path: &str, body: &str) -> Self {
        self.home_files.push((path.into(), body.into()));
        self
    }
    fn base(mut self, path: &str, body: &str) -> Self {
        self.base_files.push((path.into(), body.into()));
        self
    }
    fn link(mut self, link: &str, target: &str) -> Self {
        self.links.push((link.into(), target.into()));
        self
    }
    fn env(mut self, key: &'static str, value: &str) -> Self {
        self.env.push((key, value.into()));
        self
    }
    fn git(mut self) -> Self {
        self.git_init = true;
        self
    }
    fn no_home(mut self) -> Self {
        self.no_home = true;
        self
    }
    fn claude_dir(mut self, dir: &'static str) -> Self {
        self.claude_dir = Some(dir);
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

    /// `PATH`: nothing but `git`, linked into `sys/`.
    fn path_text(&self) -> String {
        format!("{}/bin:{}/sys", self.base.display(), self.base.display())
    }
}

fn put(root: &Path, rel: &str, body: &str) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, body).map_err(|e| format!("{rel}: {e}"))
}

/// Links only `git` into `dir`, so the test `PATH` never reaches another binary of the machine.
fn link_git(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let found = ["/usr/bin", "/bin"]
        .iter()
        .map(|d| Path::new(d).join("git"))
        .find(|p| p.is_file());
    if let Some(real) = found {
        std::os::unix::fs::symlink(real, dir.join("git")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Case {
    /// Writes the machine; the canonical base dir keeps `/tmp` symlinks out of path comparisons.
    fn write(&self) -> Result<Machine, String> {
        let raw = std::env::temp_dir().join(format!(
            "navori-doctor-user-scope-{}-{}-{}",
            self.name.replace(['/', ' '], "-"),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&raw);
        std::fs::create_dir_all(&raw).map_err(|e| e.to_string())?;
        let base = raw.canonicalize().map_err(|e| e.to_string())?;
        let machine = Machine {
            root: base.join("proj"),
            home: base.join("home"),
            cwd: base.join("cwd"),
            base,
        };
        for dir in [&machine.root, &machine.home, &machine.cwd] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(machine.base.join("bin")).map_err(|e| e.to_string())?;
        link_git(&machine.base.join("sys"))?;
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
        if self.git_init {
            let status = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&machine.root)
                .env("HOME", &machine.home)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("git init failed".to_owned());
            }
        }
        for (rel, body) in &self.repo_files {
            put(&machine.root, rel, &machine.fill(body))?;
        }
        for (rel, body) in &self.home_files {
            put(&machine.home, rel, &machine.fill(body))?;
        }
        for (rel, body) in &self.base_files {
            put(&machine.base, rel, &machine.fill(body))?;
        }
        for (link, target) in &self.links {
            let path = machine.base.join(link);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::os::unix::fs::symlink(machine.fill(target), &path).map_err(|e| e.to_string())?;
        }
        Ok(machine)
    }

    fn env_pairs(&self, machine: &Machine) -> Vec<(String, String)> {
        self.env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), machine.fill(v)))
            .collect()
    }
}

// ---------------------------------------------------------------------------------------------
// Rust side
// ---------------------------------------------------------------------------------------------

/// Drops `null`-valued members on both sides: the TS result went through `JSON.stringify`, where
/// `undefined` vanishes.
fn strip(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, strip(v)))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(strip).collect()),
        other => other,
    }
}

fn leftover_json(found: Vec<GlobalLeftover>) -> Value {
    Value::Array(
        found
            .into_iter()
            .map(|l| json!({ "kind": l.kind.as_str(), "path": l.path }))
            .collect(),
    )
}

fn conflict_json(c: ForeignConflict) -> Value {
    json!({
        "id": c.id, "type": c.asset_type.as_str(), "scope": c.scope.as_str(), "name": c.name,
        "foreignPath": c.foreign_path, "navoriPath": c.navori_path, "winner": c.winner.as_str(),
        "gitignored": c.gitignored, "adoptable": c.adoptable, "pluginId": c.plugin_id,
    })
}

fn report_json(report: Option<ForeignHarnessReport>) -> Value {
    report.map_or(Value::Null, |r| {
        json!({
            "conflicts": r.conflicts.into_iter().map(conflict_json).collect::<Vec<_>>(),
            "permissions": r.permissions.into_iter()
                .map(|p| json!({ "rule": p.rule, "path": p.path })).collect::<Vec<_>>(),
            "staleAcknowledged": r.stale_acknowledged,
        })
    })
}

/// A scan name with the Rust answer (`Err` = the port declines).
type Scan = (&'static str, Result<Value, Unmodeled>);

fn rust_scans(case: &Case, machine: &Machine) -> Result<Vec<Scan>, String> {
    let bytes =
        std::fs::read(machine.root.join("navori.config.json")).map_err(|e| e.to_string())?;
    let cfg: Config =
        config::read(&bytes).map_err(|e| format!("rust rejects the fixture config: {e:?}"))?;
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    if !case.no_home {
        env.push(("HOME".into(), machine.home.as_os_str().to_owned()));
    }
    env.push(("PATH".into(), machine.path_text().into()));
    for (k, v) in case.env_pairs(machine) {
        env.push((k.into(), v.into()));
    }
    let host = Host {
        env: &env,
        process_cwd: &machine.cwd,
        runner: &RealRunner,
    };
    let root = machine.root.display().to_string();
    let claude_dir = case.claude_dir.map(|d| machine.fill(d));
    let ts_only = doctor_ts_only_scans(&cfg).map(|scans| {
        let has = |scan| scans.contains(&scan);
        json!({
            "otel": has(TsOnlyScan::OtelReceiver),
            "pi": has(TsOnlyScan::PiHealth),
            "operational": has(TsOnlyScan::OperationalTools),
            "wiring": has(TsOnlyScan::CodegraphWiring),
        })
    });
    Ok(vec![
        (
            "leftovers",
            scan_global_layer_leftovers(&host).map(leftover_json),
        ),
        (
            "foreign",
            scan_foreign_harness(&host, &root, &cfg, claude_dir.as_deref()).map(report_json),
        ),
        ("tsOnly", ts_only),
    ])
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
    let env: Map<String, Value> = case
        .env_pairs(machine)
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    let scans = rust_scans(case, machine)?;
    let ts = NODE.ask(&json!({
        "dir": machine.root, "home": machine.home, "cwd": machine.cwd,
        "path": machine.path_text(), "env": env, "noHome": case.no_home,
        "claudeDir": case.claude_dir.map(|d| machine.fill(d)),
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

// ---------------------------------------------------------------------------------------------
// Cases: scanGlobalLayerLeftovers
// ---------------------------------------------------------------------------------------------

const NAVORI_PLUGIN_JSON: &str = ".claude/skills/navori/.claude-plugin/plugin.json";

#[test]
fn leftovers_of_the_retired_global_layer() -> Result<(), String> {
    run_all(&[
        case("no-leftovers", json!({})),
        case("manifest", json!({}))
            .home(".navori/global.json", "{}")
            .hits(&["leftovers"]),
        case("plugin", json!({}))
            .home(NAVORI_PLUGIN_JSON, r#"{"name":"navori"}"#)
            .hits(&["leftovers"]),
        case("legacy-hook", json!({}))
            .home(".claude/hooks/navori-global-baseline.sh", "#!/bin/sh\n")
            .hits(&["leftovers"]),
        case("launch-agent", json!({}))
            .home(
                "Library/LaunchAgents/com.navori.audit-collect.plist",
                "<plist/>",
            )
            .hits(&["leftovers"]),
        case("all-four", json!({}))
            .home(".navori/global.json", "{}")
            .home(NAVORI_PLUGIN_JSON, r#"{"name":"navori","version":"1"}"#)
            .home(".claude/hooks/navori-global-baseline.sh", "#!/bin/sh\n")
            .home(
                "Library/LaunchAgents/com.navori.audit-collect.plist",
                "<plist/>",
            )
            .hits(&["leftovers"]),
        // A broken symlink still counts as present (lstat).
        case("broken-symlink-manifest", json!({}))
            .link("home/.navori/global.json", "{base}/nowhere")
            .hits(&["leftovers"]),
        case("broken-symlink-hook", json!({}))
            .link(
                "home/.claude/hooks/navori-global-baseline.sh",
                "{base}/nowhere",
            )
            .hits(&["leftovers"]),
        // The plugin counts only when its manifest names navori: a user's own skill never does.
        case("plugin-other-name", json!({})).home(NAVORI_PLUGIN_JSON, r#"{"name":"mine"}"#),
        case("plugin-name-not-a-string", json!({}))
            .home(NAVORI_PLUGIN_JSON, r#"{"name":["navori"]}"#),
        case("plugin-array-manifest", json!({})).home(NAVORI_PLUGIN_JSON, r#"["navori"]"#),
        case("plugin-invalid-json", json!({})).home(NAVORI_PLUGIN_JSON, "{ not json"),
        case("plugin-empty-json", json!({})).home(NAVORI_PLUGIN_JSON, ""),
        case("plugin-bom", json!({})).home(NAVORI_PLUGIN_JSON, "\u{feff}{\"name\":\"navori\"}"),
        case("plugin-without-manifest", json!({})).home(".claude/skills/navori/SKILL.md", MINE),
        case("plugin-manifest-is-a-directory", json!({}))
            .home(".claude/skills/navori/.claude-plugin/plugin.json/x", "1"),
        case("plugin-dangling-symlink", json!({}))
            .link("home/.claude/skills/navori", "{base}/nowhere"),
        // The Claude dir moves with CLAUDE_CONFIG_DIR; the manifest and the plist stay under HOME.
        case("claude-dir-override", json!({}))
            .env("CLAUDE_CONFIG_DIR", "{base}/elsewhere")
            .base("elsewhere/hooks/navori-global-baseline.sh", "#!/bin/sh\n")
            .home(".claude/hooks/navori-global-baseline.sh", "#!/bin/sh\n")
            .home(".navori/global.json", "{}")
            .hits(&["leftovers"]),
        case("claude-dir-with-spaces", json!({}))
            .env("CLAUDE_CONFIG_DIR", "  {base}/my claude dir/  ")
            .base(
                "my claude dir/hooks/navori-global-baseline.sh",
                "#!/bin/sh\n",
            )
            .hits(&["leftovers"]),
        case("claude-dir-relative", json!({}))
            .env("CLAUDE_CONFIG_DIR", "rel/claude")
            .base(
                "cwd/rel/claude/hooks/navori-global-baseline.sh",
                "#!/bin/sh\n",
            )
            .hits(&["leftovers"]),
        case("claude-dir-blank", json!({}))
            .env("CLAUDE_CONFIG_DIR", "   ")
            .home(".claude/hooks/navori-global-baseline.sh", "#!/bin/sh\n")
            .hits(&["leftovers"]),
        // No usable HOME: the TS answers [], the port hands over to it.
        case("no-home", json!({}))
            .no_home()
            .delegates(&["leftovers", "foreign"]),
        case("no-home-claude-dir", json!({}))
            .no_home()
            .env("CLAUDE_CONFIG_DIR", "{base}/elsewhere")
            .delegates(&["leftovers"]),
    ])
}

// ---------------------------------------------------------------------------------------------
// Cases: scanForeignHarness
// ---------------------------------------------------------------------------------------------

#[test]
fn foreign_harness_needs_the_claude_engine() -> Result<(), String> {
    run_all(&[
        case("no-claude", json!({ "engines": ["codex"] }))
            .repo(".claude/skills/foo/SKILL.md", MANAGED)
            .repo(".claude/skills/foo.md", MINE),
        case(
            "claude-among-others",
            json!({ "engines": ["codex", "claude"] }),
        )
        .repo(".claude/skills/foo/SKILL.md", MANAGED)
        .repo(".claude/skills/foo.md", MINE)
        .hits(&["foreign"]),
        case("nothing-at-all", json!({})),
        // Foreign assets that collide with nothing are never reported.
        case("coexisting", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/agents/b.md", MINE)
            .home(".claude/skills/other.md", MINE)
            .home(".claude/skills/other-dir/SKILL.md", MINE),
    ])
}

#[test]
fn repo_skill_collisions() -> Result<(), String> {
    run_all(&[
        case("flat-vs-dir", json!({}))
            .repo(".claude/skills/foo/SKILL.md", MANAGED)
            .repo(".claude/skills/foo.md", MINE)
            .hits(&["foreign"]),
        case("flat-vs-dir-gitignored", json!({}))
            .git()
            .repo(".gitignore", ".claude/skills/foo.md\n")
            .repo(".claude/skills/foo/SKILL.md", MANAGED)
            .repo(".claude/skills/foo.md", MINE)
            .hits(&["foreign"]),
        case("flat-vs-dir-in-a-repo-not-ignored", json!({}))
            .git()
            .repo(".claude/skills/foo/SKILL.md", MANAGED)
            .repo(".claude/skills/foo.md", MINE)
            .hits(&["foreign"]),
        // A flat file that is navori's own is not a collision; nor is a flat navori skill.
        case("flat-also-managed", json!({}))
            .repo(".claude/skills/foo/SKILL.md", MANAGED)
            .repo(".claude/skills/foo.md", MANAGED),
        case("flat-managed-alone", json!({})).repo(".claude/skills/foo.md", MANAGED),
        // Neither layout is managed: nothing of navori's is shadowed.
        case("dir-not-managed", json!({}))
            .repo(".claude/skills/foo/SKILL.md", MINE)
            .repo(".claude/skills/foo.md", MINE),
        case("several", json!({}))
            .git()
            .repo(".gitignore", ".claude/skills/b.md\n")
            .repo(".claude/skills/a/SKILL.md", MANAGED)
            .repo(".claude/skills/a.md", MINE)
            .repo(".claude/skills/b/SKILL.md", MANAGED)
            .repo(".claude/skills/b.md", MINE)
            .repo(".claude/skills/c/SKILL.md", MANAGED)
            .hits(&["foreign"]),
        // A skill directory without SKILL.md declares nothing.
        case("dir-without-skill-md", json!({}))
            .repo(".claude/skills/foo/other.md", MANAGED)
            .repo(".claude/skills/foo.md", MINE),
        // A managed `SKILL.md` flat file at the top of the skills dir is not a skill.
        case("top-level-skill-md", json!({})).repo(".claude/skills/SKILL.md", MANAGED),
    ])
}

#[test]
fn personal_collisions() -> Result<(), String> {
    run_all(&[
        case("personal-agent", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/agents/a.md", MINE)
            .hits(&["foreign"]),
        // A hand-made repo agent is nobody's collision.
        case("repo-agent-not-managed", json!({}))
            .repo(".claude/agents/a.md", MINE)
            .home(".claude/agents/a.md", MINE),
        case("personal-agent-not-md", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/agents/a.txt", MINE),
        case("personal-skill-flat", json!({}))
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .home(".claude/skills/s.md", MINE)
            .hits(&["foreign"]),
        case("personal-skill-dir", json!({}))
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .home(".claude/skills/s/SKILL.md", MINE)
            .hits(&["foreign"]),
        case("personal-skill-vs-flat-managed", json!({}))
            .repo(".claude/skills/t.md", MANAGED)
            .home(".claude/skills/t.md", MINE)
            .hits(&["foreign"]),
        // A directory wins its name over a flat file of the same name.
        case("personal-skill-dir-and-flat", json!({}))
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .home(".claude/skills/s/SKILL.md", MINE)
            .home(".claude/skills/s.md", MINE)
            .hits(&["foreign"]),
        // A plugin directory is not a personal skill, even when its name matches.
        case("plugin-dir-skipped", json!({}))
            .repo(".claude/skills/pl/SKILL.md", MANAGED)
            .home(".claude/skills/pl/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/pl/SKILL.md", MINE),
        case("personal-dir-without-skill-md", json!({}))
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .home(".claude/skills/s/readme.txt", MINE),
        case("explicit-claude-dir-option", json!({}))
            .claude_dir("{base}/injected")
            .repo(".claude/agents/a.md", MANAGED)
            .base("injected/agents/a.md", MINE)
            .home(".claude/agents/a.md", MINE)
            .hits(&["foreign"]),
    ])
}

#[test]
fn plugin_collisions() -> Result<(), String> {
    run_all(&[
        case("foreign-plugin-agent", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/skills/other/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/other/agents/a.md", MINE)
            .hits(&["foreign"]),
        // navori's own global plugin is never foreign.
        case("navori-plugin-ignored", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(NAVORI_PLUGIN_JSON, PLUGIN)
            .home(".claude/skills/navori/agents/a.md", MINE),
        // A skills dir without the manifest is not a plugin.
        case("not-a-plugin", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/skills/other/agents/a.md", MINE),
        // Plugin skills are namespaced, so they never collide.
        case("plugin-skill-never-collides", json!({}))
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .home(".claude/skills/other/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/other/skills/s/SKILL.md", MINE),
        // The same agent in two plugins: equal ids keep the plugins' order.
        case("two-plugins-same-agent", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/skills/zeta/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/zeta/agents/a.md", MINE)
            .home(".claude/skills/alpha/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/alpha/agents/a.md", MINE)
            .home(".claude/skills/Beta/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/Beta/agents/a.md", MINE)
            .hits(&["foreign"]),
        case("plugin-agent-without-navori-counterpart", json!({}))
            .repo(".claude/agents/a.md", MANAGED)
            .home(".claude/skills/other/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/other/agents/zzz.md", MINE),
    ])
}

#[test]
fn acknowledged_conflicts() -> Result<(), String> {
    let ack = |ids: &[&str]| json!({ "project": { "foreignHarness": { "acknowledged": ids } } });
    run_all(&[
        // One conflict acknowledged, one live, one stale entry (sorted by UTF-16, not by locale).
        case(
            "ack-filters-and-stale",
            ack(&[
                "agent:personal:a",
                "zz:stale",
                "Aa:stale",
                "agent:plugin:gone",
            ]),
        )
        .repo(".claude/agents/a.md", MANAGED)
        .repo(".claude/agents/b.md", MANAGED)
        .home(".claude/agents/a.md", MINE)
        .home(".claude/agents/b.md", MINE)
        .hits(&["foreign"]),
        // Duplicates collapse (a Set); everything acknowledged leaves no conflicts.
        case(
            "ack-duplicates",
            ack(&["agent:personal:a", "agent:personal:a", "x", "x"]),
        )
        .repo(".claude/agents/a.md", MANAGED)
        .home(".claude/agents/a.md", MINE)
        .hits(&["foreign"]),
        case("ack-empty", ack(&[])),
        case("ack-absent", json!({ "project": {} })),
        case("ack-no-conflict-all-stale", ack(&["b:b", "a:a"])).hits(&["foreign"]),
    ])
}

#[test]
fn conflicts_sort_by_id() -> Result<(), String> {
    run_all(&[
        case("sorted", json!({}))
            .repo(".claude/agents/Zeta.md", MANAGED)
            .repo(".claude/agents/alpha.md", MANAGED)
            .repo(".claude/agents/Beta.md", MANAGED)
            .repo(".claude/agents/a-b.md", MANAGED)
            .repo(".claude/agents/a_b.md", MANAGED)
            .repo(".claude/agents/a b.md", MANAGED)
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .repo(".claude/skills/s.md", MINE)
            .home(".claude/agents/Zeta.md", MINE)
            .home(".claude/agents/alpha.md", MINE)
            .home(".claude/agents/Beta.md", MINE)
            .home(".claude/agents/a-b.md", MINE)
            .home(".claude/agents/a_b.md", MINE)
            .home(".claude/agents/a b.md", MINE)
            .home(".claude/skills/s.md", MINE)
            .home(".claude/skills/other/.claude-plugin/plugin.json", PLUGIN)
            .home(".claude/skills/other/agents/Beta.md", MINE)
            .hits(&["foreign"]),
        // Ids outside printable ASCII are ordered by ICU: the port declines the comparison...
        case("non-ascii-pair", json!({}))
            .repo(".claude/agents/ñandú.md", MANAGED)
            .repo(".claude/agents/b.md", MANAGED)
            .home(".claude/agents/ñandú.md", MINE)
            .home(".claude/agents/b.md", MINE)
            .delegates(&["foreign"]),
        // ...but never needs to compare a single conflict.
        case("non-ascii-single", json!({}))
            .repo(".claude/agents/ñandú.md", MANAGED)
            .home(".claude/agents/ñandú.md", MINE)
            .hits(&["foreign"]),
    ])
}

#[test]
fn permission_contradictions() -> Result<(), String> {
    let deny = r#"{"permissions":{"deny":["Bash(rm:*)","Read(x)","Write(y)"]}}"#;
    run_all(&[
        case("local-and-personal", json!({}))
            .repo(".claude/settings.json", deny)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Bash(rm:*)","Other","Bash(rm:*)",5,null]}}"#,
            )
            .home(
                ".claude/settings.json",
                r#"{"permissions":{"allow":["Read(x)","nope"]}}"#,
            )
            .hits(&["foreign"]),
        case("only-personal", json!({}))
            .repo(".claude/settings.json", deny)
            .home(
                ".claude/settings.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            )
            .hits(&["foreign"]),
        case("only-local", json!({}))
            .repo(".claude/settings.json", deny)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            )
            .hits(&["foreign"]),
        case("repo-settings-absent", json!({})).repo(
            ".claude/settings.local.json",
            r#"{"permissions":{"allow":["Write(y)"]}}"#,
        ),
        case("repo-settings-broken", json!({}))
            .repo(".claude/settings.json", "{ broken")
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("repo-settings-not-an-object", json!({}))
            .repo(".claude/settings.json", r#"["deny"]"#)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("repo-settings-without-deny", json!({}))
            .repo(
                ".claude/settings.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            )
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("repo-settings-empty-deny", json!({}))
            .repo(".claude/settings.json", r#"{"permissions":{"deny":[]}}"#)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("permissions-not-an-object", json!({}))
            .repo(".claude/settings.json", r#"{"permissions":["deny"]}"#)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("deny-not-a-list", json!({}))
            .repo(
                ".claude/settings.json",
                r#"{"permissions":{"deny":"Write(y)"}}"#,
            )
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            ),
        case("deny-mixed-types", json!({}))
            .repo(
                ".claude/settings.json",
                r#"{"permissions":{"deny":[1,"Write(y)",{"a":1}]}}"#,
            )
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":["Write(y)"]}}"#,
            )
            .hits(&["foreign"]),
        // The foreign files being unreadable or odd are ignored, not fatal.
        case("local-broken", json!({}))
            .repo(".claude/settings.json", deny)
            .repo(".claude/settings.local.json", "{ broken")
            .home(
                ".claude/settings.json",
                r#"{"permissions":{"allow":["Read(x)"]}}"#,
            )
            .hits(&["foreign"]),
        case("personal-array", json!({}))
            .repo(".claude/settings.json", deny)
            .home(
                ".claude/settings.json",
                r#"[{"permissions":{"allow":["Read(x)"]}}]"#,
            ),
        case("personal-is-a-directory", json!({}))
            .repo(".claude/settings.json", deny)
            .home(".claude/settings.json/x", "1"),
        case("local-allow-not-a-list", json!({}))
            .repo(".claude/settings.json", deny)
            .repo(
                ".claude/settings.local.json",
                r#"{"permissions":{"allow":"Read(x)"}}"#,
            ),
        // Rules live in the personal file of CLAUDE_CONFIG_DIR, labelled with its absolute path.
        case("claude-dir-env-with-spaces", json!({}))
            .env("CLAUDE_CONFIG_DIR", " {base}/my claude dir ")
            .repo(".claude/settings.json", deny)
            .base(
                "my claude dir/settings.json",
                r#"{"permissions":{"allow":["Read(x)"]}}"#,
            )
            .hits(&["foreign"]),
        case("claude-dir-env-relative", json!({}))
            .env("CLAUDE_CONFIG_DIR", "rel/../rel/claude")
            .repo(".claude/settings.json", deny)
            .base(
                "cwd/rel/claude/settings.json",
                r#"{"permissions":{"allow":["Read(x)"]}}"#,
            )
            .repo(".claude/skills/s/SKILL.md", MANAGED)
            .base("cwd/rel/claude/skills/s.md", MINE)
            .hits(&["foreign"]),
        // No usable HOME but an explicit CLAUDE_CONFIG_DIR: the foreign scan does not need HOME.
        case("no-home-with-claude-dir", json!({}))
            .no_home()
            .env("CLAUDE_CONFIG_DIR", "{base}/elsewhere")
            .repo(".claude/agents/a.md", MANAGED)
            .base("elsewhere/agents/a.md", MINE)
            .delegates(&["leftovers"])
            .hits(&["foreign"]),
    ])
}

// ---------------------------------------------------------------------------------------------
// Cases: the scans that stay in the TS
// ---------------------------------------------------------------------------------------------

#[test]
fn ts_only_scans_follow_the_ts_conditions() -> Result<(), String> {
    let plugin = |id: &str, enabled: Value| json!({ "plugins": { id: { "enabled": enabled } } });
    run_all(&[
        case("none", json!({})),
        case("audit-always", json!({ "audit": { "mode": "always" } })).hits(&["tsOnly"]),
        case("audit-other-mode", json!({ "audit": { "mode": "opt-in" } })),
        case("pi-engine", json!({ "engines": ["claude", "pi"] })).hits(&["tsOnly"]),
        case("codex-engine", json!({ "engines": ["claude", "codex"] })),
        case("tgrep", plugin("tgrep", json!(true))).hits(&["tsOnly"]),
        case("engram", plugin("engram", json!(true))).hits(&["tsOnly"]),
        case("codegraph", plugin("codegraph", json!(true))).hits(&["tsOnly"]),
        case("gh-only", plugin("gh", json!(true))),
        case("tgrep-disabled", plugin("tgrep", json!(false))),
        case(
            "everything",
            json!({ "engines": ["claude", "pi"], "audit": { "mode": "always" },
                    "plugins": { "tgrep": { "enabled": true }, "codegraph": { "enabled": true },
                                 "engram": { "enabled": true } } }),
        )
        .hits(&["tsOnly"]),
    ])
}
