//! `navori scan`, native (spec 0060 T23, R73).
//!
//! Re-detects a monorepo's workspaces and adds the new ones to `navori.config.json`, as
//! `commands/scan.ts` does, with the clack output of [`crate::clack`]. The native subset is every
//! non-interactive path: no config, no `monorepo`, no workspace patterns, the summary with its
//! new and orphan lists, a current config, and `--yes` writing the new workspaces. A run that
//! would prompt (new workspaces without `--yes`), colored output, a config Rust does not model,
//! and any workspace input [`detect_project`] or the patterns port do not model, are handed to the
//! TS before any output or effect.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use navori_core::collate::{compare_ascii, default_locale_modeled};
use navori_core::config::{Config, write_config};
use navori_core::diagnose::detect::detect_project;
use navori_core::fs::{RealFs, write_file_atomic};
use navori_core::js_json::{JsObject, JsValue};
use navori_core::process::RealRunner;
use navori_core::render::context::Lang;
use navori_core::render::library_skills::ActiveMigration;
use navori_core::workspace::patterns::{collect_workspace_patterns, expand_pattern};

use crate::backup::parse_leaf;
use crate::clack::{Clack, Symbol, plain_output};
use crate::native_io::{Output, member, read_config};
use crate::{NativeCall, Outcome};

/// `navori scan`.
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    run_args(call.args).map_or(Outcome::Delegate, Outcome::Exit)
}

fn run_args(args: &[OsString]) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "scan" || rest.contains(&"--") {
        return None;
    }
    let options = parse_leaf(rest, &["cwd"], &["yes"])?;
    if !options.positionals.is_empty() || !plain_output() {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd = navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or(""));
    Some(scan(&cwd, options.flag("yes"))?.emit())
}

/// `tc(lang).scan`, the strings the native paths print.
struct Text {
    lang: Lang,
}

impl Text {
    const fn es(&self) -> bool {
        matches!(self.lang, Lang::Es)
    }

    fn no_config(&self, path: &str) -> String {
        if self.es() {
            format!("No encontré navori.config.json en {path}. Corre 'navori init' primero.")
        } else {
            format!("No navori.config.json found at {path}. Run 'navori init' first.")
        }
    }

    fn not_monorepo(&self, path: &str) -> String {
        if self.es() {
            format!(
                "{path} no declara 'monorepo'. Edita el config para agregar {{ monorepo: {{ enabled: true, tool: '...' }} }} y vuelve a correr scan."
            )
        } else {
            format!(
                "{path} does not declare 'monorepo'. Add {{ monorepo: {{ enabled: true, tool: '...' }} }} to the config and run scan again."
            )
        }
    }

    const fn no_patterns(&self) -> &'static str {
        if self.es() {
            "No encontré patrones de workspace en pnpm-workspace.yaml ni en package.json#workspaces."
        } else {
            "No workspace patterns found in pnpm-workspace.yaml or package.json#workspaces."
        }
    }

    const fn nothing_to_scan(&self) -> &'static str {
        if self.es() {
            "Nada que escanear"
        } else {
            "Nothing to scan"
        }
    }

    fn orphaned(&self, count: usize) -> String {
        if self.es() {
            format!(
                "{count} workspace(s) en config ya no existen en disco. Edita navori.config.json para removerlos."
            )
        } else {
            format!(
                "{count} workspace(s) in config no longer exist on disk. Edit navori.config.json to remove them."
            )
        }
    }

    const fn config_current(&self) -> &'static str {
        if self.es() {
            "Config al día"
        } else {
            "Config is up to date"
        }
    }

    fn added(&self, count: usize, path: &str) -> String {
        if self.es() {
            format!("Agregué {count} workspace(s) a {path}")
        } else {
            format!("Added {count} workspace(s) to {path}")
        }
    }

    const fn render_hint(&self) -> &'static str {
        if self.es() {
            "Corre 'navori render --apply' para generar los archivos de los engines por workspace"
        } else {
            "Run 'navori render --apply' to generate engine files for each workspace"
        }
    }

    const fn summary_title(&self) -> &'static str {
        if self.es() { "resumen" } else { "summary" }
    }

    const fn new_workspaces_title(&self) -> &'static str {
        if self.es() {
            "Workspaces nuevos:"
        } else {
            "New workspaces:"
        }
    }

    const fn orphaned_title(&self) -> &'static str {
        if self.es() {
            "Huérfanos (en config, no existen en disco):"
        } else {
            "Orphans (in config, missing on disk):"
        }
    }
}

/// `DetectedWorkspace`.
struct Detected {
    name: String,
    path: String,
    suggested_preset: String,
    framework: Option<&'static str>,
    libraries: Vec<String>,
    migrations: Vec<ActiveMigration>,
}

/// `scanMonorepoWorkspaces(cwd)`: deduped, sorted by `localeCompare` of the path. `None` for any
/// input the ports do not model, or a sort outside the modelled collation.
fn scan_workspaces(cwd: &str) -> Option<Vec<Detected>> {
    let root = Path::new(cwd);
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for pattern in collect_workspace_patterns(root).ok()? {
        for rel in expand_pattern(root, &pattern).ok()? {
            if !seen.insert(rel.clone()) {
                continue;
            }
            let abs = root.join(&rel);
            if !abs.join("package.json").exists() {
                continue;
            }
            let project = detect_project(&abs, &RealRunner, &env).ok()?;
            let name = match project.name {
                Some(name) => name,
                None => rel.rsplit('/').next().unwrap_or_default().to_owned(),
            };
            results.push(Detected {
                name,
                path: rel,
                suggested_preset: project.suggested_preset,
                framework: project.framework,
                libraries: project.libraries,
                migrations: project.migrations,
            });
        }
    }
    if results.len() > 1 {
        if !default_locale_modeled(&env) {
            return None;
        }
        let mut modeled = true;
        results.sort_by(|a, b| {
            compare_ascii(&a.path, &b.path).unwrap_or_else(|| {
                modeled = false;
                Ordering::Equal
            })
        });
        if !modeled {
            return None;
        }
    }
    Some(results)
}

/// `config.monorepo.workspaces[].path`, as Rust text.
fn configured_paths(workspaces: &[JsValue]) -> Option<Vec<String>> {
    workspaces
        .iter()
        .map(|w| match member(Some(w), "path") {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        })
        .collect()
}

/// `buildMonorepoWorkspace(detected, detected.suggestedPreset, config)`.
fn workspace_entry(detected: &Detected, root_preset: Option<&JsValue>) -> JsValue {
    let mut entry = JsObject::new();
    entry.insert("name", JsValue::string(&detected.name));
    entry.insert("path", JsValue::string(&detected.path));
    let preset = &detected.suggested_preset;
    if !preset.is_empty() && root_preset != Some(&JsValue::string(preset)) {
        entry.insert("preset", JsValue::string(preset));
    }
    if !detected.libraries.is_empty() {
        let libraries = detected.libraries.iter().map(|l| JsValue::string(l));
        entry.insert("libraries", JsValue::Array(libraries.collect()));
    }
    if !detected.migrations.is_empty() {
        let migrations = detected.migrations.iter().map(|m| {
            let mut object = JsObject::new();
            object.insert("legacy", JsValue::string(&m.legacy));
            object.insert("preferred", JsValue::string(&m.preferred));
            object.insert("domain", JsValue::string(m.domain));
            JsValue::Object(object)
        });
        entry.insert("libraryMigrations", JsValue::Array(migrations.collect()));
    }
    JsValue::Object(entry)
}

fn push_warnings(out: &mut Output, config: &Config, times: usize) {
    for _ in 0..times {
        for warning in &config.warnings {
            out.stderr.push_str(&format!("{warning}\n"));
        }
    }
}

/// `scanCommand.run` for `cwd`; `None` delegates.
#[allow(
    clippy::too_many_lines,
    reason = "one function per `scanCommand.run`, branch for branch"
)]
fn scan(cwd: &str, yes: bool) -> Option<Output> {
    let config_path = navori_core::posix::resolve(cwd, "navori.config.json");
    let mut clack = Clack::default();
    clack.intro("navori scan");
    let Some(config) = read_config(cwd)? else {
        let text = Text {
            lang: Lang::resolve(None),
        };
        clack.cancel(&text.no_config(&config_path));
        return Some(clack.out);
    };
    let text = Text {
        lang: config.lang(),
    };
    let monorepo = match member(Some(&config.data), "monorepo") {
        None | Some(JsValue::Undefined) => {
            // `runScan` and the language read each print the config warnings.
            push_warnings(&mut clack.out, &config, 2);
            clack.cancel(&text.not_monorepo(&config_path));
            return Some(clack.out);
        }
        Some(JsValue::Object(monorepo)) => monorepo,
        Some(_) => return None,
    };
    let detected = scan_workspaces(cwd)?;
    if detected.is_empty() {
        push_warnings(&mut clack.out, &config, 2);
        clack.log(Symbol::Info, text.no_patterns());
        clack.outro(text.nothing_to_scan());
        return Some(clack.out);
    }
    let configured = match monorepo.get("workspaces") {
        Some(JsValue::Array(items)) => items.clone(),
        _ => return None,
    };
    let configured_paths = configured_paths(&configured)?;
    let detected_paths: HashSet<&str> = detected.iter().map(|d| d.path.as_str()).collect();
    let configured_set: HashSet<&str> = configured_paths.iter().map(String::as_str).collect();
    let added: Vec<&Detected> = detected
        .iter()
        .filter(|d| !configured_set.contains(d.path.as_str()))
        .collect();
    let existing = configured_paths
        .iter()
        .filter(|p| detected_paths.contains(p.as_str()))
        .count();
    let orphan: Vec<&String> = configured_paths
        .iter()
        .filter(|p| !detected_paths.contains(p.as_str()))
        .collect();
    if !added.is_empty() && !yes {
        // The TS prompts for confirmation and presets here.
        return None;
    }

    let mut rows: Vec<(&str, String)> = vec![
        ("detected", (added.len() + existing).to_string()),
        ("new", added.len().to_string()),
        ("existing", existing.to_string()),
    ];
    if !orphan.is_empty() {
        rows.push(("orphan", orphan.len().to_string()));
    }
    let width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    let kv: Vec<String> = rows
        .iter()
        .map(|(k, v)| format!("  {k:<width$} : {v}"))
        .collect();
    clack.note(&kv.join("\n"), text.summary_title())?;
    if !added.is_empty() {
        let lines: Vec<String> = added
            .iter()
            .map(|w| {
                let fw = w.framework.map(|f| format!(" [{f}]")).unwrap_or_default();
                format!("  + {}{fw}  → {}", w.path, w.suggested_preset)
            })
            .collect();
        clack.log(
            Symbol::Bar,
            &format!("{}\n{}", text.new_workspaces_title(), lines.join("\n")),
        );
    }
    if !orphan.is_empty() {
        let lines: Vec<String> = orphan.iter().map(|p| format!("  ? {p}")).collect();
        clack.log(
            Symbol::Bar,
            &format!("{}\n{}", text.orphaned_title(), lines.join("\n")),
        );
    }

    if added.is_empty() {
        push_warnings(&mut clack.out, &config, 2);
        if !orphan.is_empty() {
            clack.log(Symbol::Warn, &text.orphaned(orphan.len()));
        }
        clack.outro(text.config_current());
        return Some(clack.out);
    }

    // `--yes`: the second `runScan` reads the config again and writes it.
    let JsValue::Object(mut data) = config.data.clone() else {
        return None;
    };
    let root_preset = data.get("preset").cloned();
    let mut workspaces = configured;
    workspaces.extend(
        added
            .iter()
            .map(|d| workspace_entry(d, root_preset.as_ref())),
    );
    let mut next_monorepo = monorepo.clone();
    next_monorepo.insert("workspaces", JsValue::Array(workspaces));
    data.insert("monorepo", JsValue::Object(next_monorepo));
    let written = write_config(&data).ok()?;
    push_warnings(&mut clack.out, &config, 3);
    let mut fs = RealFs::default();
    if write_file_atomic(&mut fs, Path::new(&config_path), &written).is_err() {
        clack
            .out
            .stderr
            .push_str("navori-rust: cannot write navori.config.json\n");
        clack.out.code = 1;
        return Some(clack.out);
    }
    clack.log(Symbol::Success, &text.added(added.len(), &config_path));
    clack.outro(text.render_hint());
    Some(clack.out)
}
