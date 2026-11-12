//! Port of `detectProject` (`lib/diagnose/detect.ts`) for what `navori scan` reads of it (spec
//! 0060 T23): the name, the framework, the library skills, the active migrations and the
//! suggested preset of one package directory.
//!
//! The port covers a directory whose `package.json` is a JSON object, optionally beside a
//! `Cargo.toml`. A `pyproject.toml`, a missing or non-object `package.json` (the Python
//! fallback), dependency maps that are not plain objects of strings, a non-string
//! `packageManager`, and text that is not UTF-8 are [`Unmodeled`]: the caller delegates.
//! `git config --get remote.origin.url` runs through a [`ProcessRunner`] (D42).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use crate::integrity::is_js_whitespace;
use crate::js_json::{JsObject, JsValue};
use crate::posix::js_trim;
use crate::process::{Env, ProcessRunner, Request};
use crate::render::library_skills::{
    ActiveMigration, detect_library_skills, detect_migrations, migration_dep_names,
};
use crate::render::presets::preset_exists;
use crate::workspace::patterns::{Unmodeled, collect_workspace_patterns, read_json};

/// The part of `DetectedProject` `scan` consumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedProject {
    /// `name`: the normalized manifest, git remote or directory name.
    pub name: Option<String>,
    /// `stack.framework`.
    pub framework: Option<&'static str>,
    /// `libraries`.
    pub libraries: Vec<String>,
    /// `migrations`.
    pub migrations: Vec<ActiveMigration>,
    /// `suggestedPreset`.
    pub suggested_preset: String,
    /// `suggestedPresetGap`.
    pub suggested_preset_gap: Option<String>,
}

/// `detectProject(cwd)`, restricted to the fields of [`DetectedProject`].
///
/// # Errors
/// [`Unmodeled`] for any input outside the subset the module docs describe.
pub fn detect_project(
    cwd: &Path,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<DetectedProject, Unmodeled> {
    if cwd.join("pyproject.toml").exists() {
        return Err(Unmodeled);
    }
    let pkg_path = cwd.join("package.json");
    let pkg = if pkg_path.exists() {
        read_json(&pkg_path)?
    } else {
        None
    };
    let Some(JsValue::Object(pkg)) = pkg else {
        return Err(Unmodeled);
    };
    let cargo = read_cargo_name(cwd)?;

    let from_package_json = match pkg.get("name") {
        Some(JsValue::String(text)) => Some(text.to_rust().ok_or(Unmodeled)?),
        _ => None,
    };
    let raw_name = match (from_package_json, &cargo) {
        (Some(name), _) => name,
        (None, Some(Some(name))) => name.clone(),
        _ => match git_repo_name(cwd, runner, env)? {
            Some(name) => name,
            None => cwd
                .file_name()
                .map(|n| n.to_str().map(str::to_owned).ok_or(Unmodeled))
                .transpose()?
                .unwrap_or_default(),
        },
    };
    let name = normalize_name(&raw_name);

    let deps: Vec<String> = if cargo.is_some() {
        Vec::new()
    } else {
        node_deps(&pkg)?
    };
    let versions = if cargo.is_some() {
        HashMap::new()
    } else {
        node_dep_versions(&pkg)?
    };
    let present: HashSet<String> = deps.iter().cloned().collect();
    let framework = if cargo.is_some() {
        None
    } else {
        pick(&present, FRAMEWORKS)
    };
    let worker = if cargo.is_some() {
        None
    } else {
        pick(&present, WORKERS)
    };
    let ui = if cargo.is_some() {
        None
    } else {
        pick(&present, UIS)
    };
    let state = if cargo.is_some() {
        None
    } else {
        pick(&present, STATES)
    };

    let migration_present: Vec<&str> = migration_dep_names()
        .into_iter()
        .filter(|d| present.contains(*d))
        .collect();
    let counts =
        (!migration_present.is_empty()).then(|| count_dep_imports(cwd, &migration_present));
    let libraries = detect_library_skills(&present, Some(cwd), &versions);
    let migrations = detect_migrations(&present, counts.as_ref());

    let uses_pnpm =
        package_manager(cwd, &pkg)? == Some("pnpm") || cwd.join("pnpm-workspace.yaml").exists();
    let monorepo = detect_monorepo(cwd, &pkg)?;
    let stack = Stack {
        rust: cargo.is_some(),
        framework,
        ui,
        state,
        worker,
        mongoose: present.contains("mongoose"),
    };
    let candidate = pick_preset_candidate(&stack, monorepo, uses_pnpm);
    let (suggested_preset, suggested_preset_gap) = if candidate == "custom" {
        ("custom".to_owned(), None)
    } else if preset_exists(candidate) {
        (candidate.to_owned(), None)
    } else {
        ("custom".to_owned(), Some(candidate.to_owned()))
    };
    Ok(DetectedProject {
        name,
        framework,
        libraries,
        migrations,
        suggested_preset,
        suggested_preset_gap,
    })
}

/// `normalizeName(raw)`: lowercase kebab without an npm scope; `None` when nothing is left.
#[must_use]
pub fn normalize_name(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let lower = js_trim(raw).to_lowercase();
    let unscoped = match lower
        .strip_prefix('@')
        .and_then(|rest| rest.split_once('/'))
    {
        Some((scope, rest)) if !scope.is_empty() => rest,
        _ => lower.as_str(),
    };
    let mut cleaned = String::new();
    let mut in_gap = false;
    for c in unscoped.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cleaned.push(c);
            in_gap = false;
        } else if !in_gap {
            cleaned.push('-');
            in_gap = true;
        }
    }
    let cleaned = cleaned.trim_matches('-');
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

/// `readCargoToml(cwd)`: `None` without `Cargo.toml` (or when the read throws), else its
/// `name = "…"` (the first match of `/^\s*name\s*=\s*"([^"]+)"/m`).
fn read_cargo_name(cwd: &Path) -> Result<Option<Option<String>>, Unmodeled> {
    let path = cwd.join("Cargo.toml");
    if !path.exists() {
        return Ok(None);
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    let text = String::from_utf8(bytes).map_err(|_| Unmodeled)?;
    Ok(Some(cargo_name(&text)))
}

fn cargo_name(text: &str) -> Option<String> {
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(at, c)| at + c.len_utf8()),
    );
    starts.into_iter().find_map(|start| {
        let rest = text[start..].trim_start_matches(is_js_whitespace);
        let rest = rest.strip_prefix("name")?;
        let rest = rest
            .trim_start_matches(is_js_whitespace)
            .strip_prefix('=')?;
        let rest = rest
            .trim_start_matches(is_js_whitespace)
            .strip_prefix('"')?;
        let end = rest.find('"')?;
        (end > 0).then(|| rest[..end].to_owned())
    })
}

/// `detectGitRepoName(cwd)`: the last path segment of `remote.origin.url`, without `.git`.
fn git_repo_name(
    cwd: &Path,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<Option<String>, Unmodeled> {
    let Some(cwd_text) = cwd.to_str() else {
        return Err(Unmodeled);
    };
    let args = ["-C", cwd_text, "config", "--get", "remote.origin.url"];
    let request = Request {
        program: "git",
        args: &args,
        cwd,
        env,
        input: None,
        // `spawnSync` without a timeout; the bound only guards a hung child.
        timeout: Duration::from_secs(60 * 60),
    };
    let Ok(output) = runner.run(&request) else {
        return Ok(None);
    };
    if output.status.code() != Some(0) {
        return Ok(None);
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| Unmodeled)?;
    let url = js_trim(&stdout);
    if url.is_empty() {
        return Ok(None);
    }
    Ok(repo_name_from_url(url))
}

/// `url.match(/[/:]([^/:]+?)(?:\.git)?$/)?.[1]` for a trimmed `url`.
fn repo_name_from_url(url: &str) -> Option<String> {
    let at = url.rfind(['/', ':'])?;
    let tail = &url[at + 1..];
    if tail.is_empty() {
        return None;
    }
    let name = match tail.strip_suffix(".git") {
        Some(stem) if !stem.is_empty() => stem,
        _ => tail,
    };
    Some(name.to_owned())
}

/// The keys of one dependency map: absent/`null` is empty, a plain object of strings is read,
/// anything else is [`Unmodeled`] (`Object.keys` over a string or array lists indices).
fn dep_map(pkg: &JsObject, key: &str) -> Result<Vec<(String, String)>, Unmodeled> {
    match pkg.get(key) {
        None | Some(JsValue::Null | JsValue::Undefined) => Ok(Vec::new()),
        Some(JsValue::Object(map)) => map
            .ordered()
            .into_iter()
            .map(|(name, value)| match value {
                JsValue::String(range) => Ok((
                    name.to_rust().ok_or(Unmodeled)?,
                    range.to_rust().ok_or(Unmodeled)?,
                )),
                _ => Err(Unmodeled),
            })
            .collect(),
        Some(_) => Err(Unmodeled),
    }
}

const DEP_KEYS: [&str; 3] = ["dependencies", "devDependencies", "peerDependencies"];

/// `collectNodeDeps(pkg)`.
fn node_deps(pkg: &JsObject) -> Result<Vec<String>, Unmodeled> {
    let mut out = Vec::new();
    for key in DEP_KEYS {
        out.extend(dep_map(pkg, key)?.into_iter().map(|(name, _)| name));
    }
    Ok(out)
}

/// `collectNodeDepVersions(pkg)`: `dependencies` wins over `devDependencies` over
/// `peerDependencies`.
fn node_dep_versions(pkg: &JsObject) -> Result<HashMap<String, String>, Unmodeled> {
    let mut out = HashMap::new();
    for key in DEP_KEYS {
        for (name, range) in dep_map(pkg, key)? {
            out.entry(name).or_insert(range);
        }
    }
    Ok(out)
}

/// The first candidate present, in order.
fn pick(present: &HashSet<String>, candidates: &[&'static str]) -> Option<&'static str> {
    candidates.iter().copied().find(|c| present.contains(*c))
}

const FRAMEWORKS: &[&str] = &[
    "next",
    "@nestjs/core",
    "@medusajs/medusa",
    "@keystone-6/core",
    "expo",
    "react-native",
    "remix",
    "astro",
    "@sveltejs/kit",
    "@builder.io/qwik",
    "solid-js",
    "@tauri-apps/api",
    "electron",
    "svelte",
    "vue",
    "vite",
    "react",
    "@angular/core",
    "fastify",
    "hono",
    "elysia",
    "express",
];

const UIS: &[&str] = &[
    "@mantine/core",
    "@mui/material",
    "tailwindcss",
    "tamagui",
    "@radix-ui/themes",
];

const STATES: &[&str] = &[
    "@reduxjs/toolkit",
    "redux",
    "zustand",
    "jotai",
    "valtio",
    "@tanstack/react-query",
    "@apollo/client",
];

const WORKERS: &[&str] = &[
    "agenda",
    "bullmq",
    "bull",
    "bee-queue",
    "bree",
    "node-cron",
    "cron",
    "amqplib",
    "amqp-connection-manager",
    "kafkajs",
    "sqs-consumer",
    "rhea",
];

const LOCKFILES: [(&str, &str); 5] = [
    ("pnpm-lock.yaml", "pnpm"),
    ("bun.lockb", "bun"),
    ("bun.lock", "bun"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
];

/// `detectPackageManager(cwd)`: `package.json#packageManager`, then the lockfiles.
fn package_manager(cwd: &Path, pkg: &JsObject) -> Result<Option<&'static str>, Unmodeled> {
    let declared = pkg.get("packageManager");
    if let Some(value) = declared.filter(|v| js_truthy(v)) {
        let JsValue::String(text) = value else {
            // `.split` on a truthy non-string throws.
            return Err(Unmodeled);
        };
        let text = text.to_rust().ok_or(Unmodeled)?;
        let tool = text.split('@').next().unwrap_or("");
        if let Some(found) = ["pnpm", "npm", "yarn", "bun"]
            .into_iter()
            .find(|t| *t == tool)
        {
            return Ok(Some(found));
        }
    }
    Ok(LOCKFILES
        .iter()
        .find(|(file, _)| cwd.join(file).exists())
        .map(|(_, manager)| *manager))
}

/// JS truthiness of a JSON value.
fn js_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsValue::String(text) => !text.units().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

/// `detectMonorepo(cwd).tool`.
fn detect_monorepo(cwd: &Path, pkg: &JsObject) -> Result<Option<&'static str>, Unmodeled> {
    let turbo = cwd.join("turbo.json").exists();
    if cwd.join("pnpm-workspace.yaml").exists() && !collect_workspace_patterns(cwd)?.is_empty() {
        return Ok(Some(if turbo { "turbo" } else { "pnpm" }));
    }
    if turbo {
        return Ok(Some("turbo"));
    }
    for (file, tool) in [
        ("nx.json", "nx"),
        ("rush.json", "rush"),
        ("lerna.json", "lerna"),
    ] {
        if cwd.join(file).exists() {
            return Ok(Some(tool));
        }
    }
    if pkg.get("workspaces").is_some_and(js_truthy) && !collect_workspace_patterns(cwd)?.is_empty()
    {
        return Ok(Some("npm"));
    }
    Ok(None)
}

/// The `StackInfo` fields the preset choice reads.
struct Stack {
    rust: bool,
    framework: Option<&'static str>,
    ui: Option<&'static str>,
    state: Option<&'static str>,
    worker: Option<&'static str>,
    mongoose: bool,
}

/// `pickPresetCandidate(stack, monorepo, usesPnpm)` for a Node or Rust stack.
fn pick_preset_candidate(stack: &Stack, monorepo: Option<&str>, uses_pnpm: bool) -> &'static str {
    match monorepo {
        Some("turbo") => {
            return if uses_pnpm {
                "monorepo-turbopnpm"
            } else {
                "custom"
            };
        }
        Some("pnpm") => return "monorepo-pnpm",
        Some("npm" | "lerna") => return "monorepo-npm",
        _ => {}
    }
    if stack.rust {
        return "rust";
    }
    match stack.framework {
        Some("@medusajs/medusa") => "medusa",
        Some("@keystone-6/core") => "bun-keystone",
        Some("next") if stack.state == Some("@apollo/client") => "nextjs-apollo",
        Some("next") => "nextjs",
        Some("@nestjs/core") => "nestjs",
        Some("expo" | "react-native") => "react-native-expo",
        Some("astro") => "astro",
        Some("@sveltejs/kit" | "svelte") => "sveltekit",
        Some("@builder.io/qwik") => "qwik",
        Some("solid-js") => "solid",
        Some("@tauri-apps/api") => "tauri",
        Some("electron") => "electron",
        Some("vue") => "vue",
        Some("@angular/core") => "angular",
        Some("vite") if stack.ui == Some("@mantine/core") => "vite-react-ts-mantine",
        Some("vite") => "vite-react-ts",
        Some("react") => "react",
        Some("remix") => "remix",
        Some("fastify") => "fastify",
        Some("hono") => "hono",
        Some("elysia") => "elysia",
        Some("express") if stack.worker.is_some() && !stack.mongoose => "background-worker",
        None if stack.worker.is_some() => "background-worker",
        Some("express") if stack.mongoose => "express-mongoose",
        Some("express") => "express",
        _ => "custom",
    }
}

/// `SCAN_EXTENSIONS` of `dep-usage.ts`.
const SCAN_EXTENSIONS: &[&str] = &[
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
];

/// `SKIP_DIRS` of `dep-usage.ts`.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    "vendor",
    "__pycache__",
];

/// `MAX_FILES` of `dep-usage.ts`.
const MAX_FILES: usize = 12_000;

/// `countDepImports(projectRoot, depNames)`: per dep, how many source files hold a quoted
/// specifier equal to it or one of its subpaths. Directory order is the OS's, as Node's
/// `readdirSync`, so the `MAX_FILES` cut lands on the same files.
#[must_use]
pub fn count_dep_imports(root: &Path, dep_names: &[&str]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> =
        dep_names.iter().map(|d| ((*d).to_owned(), 0)).collect();
    let mut budget = MAX_FILES;
    count_walk(root, dep_names, &mut budget, &mut counts);
    counts
}

fn count_walk(dir: &Path, deps: &[&str], budget: &mut usize, counts: &mut HashMap<String, usize>) {
    if *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        if *budget == 0 {
            return;
        }
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let raw = entry.file_name();
        // Node decodes a non-UTF-8 name lossily, so the path it rebuilds names nothing.
        let exact = raw.to_str().is_some();
        let name = raw.to_string_lossy();
        if kind.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) || name.starts_with('.') || !exact {
                continue;
            }
            count_walk(&dir.join(&raw), deps, budget, counts);
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let Some(dot) = name.rfind('.') else {
            continue;
        };
        if !SCAN_EXTENSIONS.contains(&&name[dot..]) {
            continue;
        }
        *budget -= 1;
        if !exact {
            continue;
        }
        let Ok(bytes) = std::fs::read(dir.join(&raw)) else {
            continue;
        };
        for dep in deps {
            if imports(&bytes, dep.as_bytes()) {
                *counts.entry((*dep).to_owned()).or_insert(0) += 1;
            }
        }
    }
}

/// `/['"]<dep>(?:\/[^'"]*)?['"]/.test(text)` over the file bytes (the pattern is ASCII, and a
/// quote byte never sits inside a UTF-8 sequence or a replacement).
fn imports(text: &[u8], dep: &[u8]) -> bool {
    let is_quote = |b: u8| b == b'\'' || b == b'"';
    let last_quote = text.iter().rposition(|b| is_quote(*b));
    text.iter().enumerate().any(|(at, b)| {
        if !is_quote(*b) || !text[at + 1..].starts_with(dep) {
            return false;
        }
        let next = at + 1 + dep.len();
        match text.get(next) {
            Some(b) if is_quote(*b) => true,
            Some(b'/') => last_quote.is_some_and(|q| q > next),
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{RecordedRunner, Recording};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("navori-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    }

    fn no_git() -> RecordedRunner {
        RecordedRunner::new(Vec::new())
    }

    // Covers: R73
    #[test]
    fn names_normalize_like_the_ts() {
        assert_eq!(normalize_name("@Acme/My App!"), Some("my-app".to_owned()));
        assert_eq!(normalize_name("@/x"), Some("x".to_owned()));
        assert_eq!(normalize_name("___"), None);
        assert_eq!(normalize_name(""), None);
        assert_eq!(
            repo_name_from_url("git@github.com:org/repo.git"),
            Some("repo".to_owned())
        );
        assert_eq!(
            repo_name_from_url("https://h/x/.git"),
            Some(".git".to_owned())
        );
        assert_eq!(repo_name_from_url("https://h/x/"), None);
        assert_eq!(
            cargo_name("[package]\n  name = \"crate-a\"\n"),
            Some("crate-a".to_owned())
        );
        assert_eq!(cargo_name("xname = \"no\""), None);
    }

    // Covers: R73
    #[test]
    fn presets_follow_the_stack() -> Result<(), Unmodeled> {
        let runner = no_git();
        let root = temp("presets");
        write(
            &root,
            "next/package.json",
            "{\"name\":\"@a/web\",\"dependencies\":{\"next\":\"15\",\"react\":\"19\"}}",
        );
        let next = detect_project(&root.join("next"), &runner, &[])?;
        assert_eq!(next.name.as_deref(), Some("web"));
        assert_eq!(next.framework, Some("next"));
        assert_eq!(next.suggested_preset, "nextjs");
        write(
            &root,
            "jobs/package.json",
            "{\"dependencies\":{\"express\":\"4\",\"bullmq\":\"5\"}}",
        );
        let jobs = detect_project(&root.join("jobs"), &runner, &[])?;
        assert_eq!(jobs.suggested_preset, "background-worker");
        assert_eq!(jobs.name.as_deref(), Some("jobs"));
        assert_eq!(jobs.libraries, vec!["bullmq".to_owned()]);
        write(
            &root,
            "ng/package.json",
            "{\"dependencies\":{\"@angular/core\":\"17\"}}",
        );
        let ng = detect_project(&root.join("ng"), &runner, &[])?;
        assert_eq!(ng.suggested_preset, "custom");
        assert_eq!(ng.suggested_preset_gap.as_deref(), Some("angular"));
        write(&root, "turbo/package.json", "{\"name\":\"t\"}");
        write(&root, "turbo/turbo.json", "{}");
        write(&root, "turbo/pnpm-lock.yaml", "");
        let turbo = detect_project(&root.join("turbo"), &runner, &[])?;
        assert_eq!(turbo.suggested_preset, "monorepo-turbopnpm");
        write(&root, "py/package.json", "{}");
        write(&root, "py/pyproject.toml", "");
        assert_eq!(
            detect_project(&root.join("py"), &runner, &[]),
            Err(Unmodeled)
        );
        write(&root, "bad/package.json", "{\"dependencies\":\"x\"}");
        assert_eq!(
            detect_project(&root.join("bad"), &runner, &[]),
            Err(Unmodeled)
        );
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    // Covers: R73, R76
    #[test]
    fn git_remote_names_an_unnamed_package() -> Result<(), Unmodeled> {
        let root = temp("git");
        write(&root, "package.json", "{}");
        let dir = root.to_str().unwrap_or_default().to_owned();
        let runner = RecordedRunner::new(vec![Recording {
            tool: "git".to_owned(),
            version: "git version 2".to_owned(),
            args: ["-C", &dir, "config", "--get", "remote.origin.url"]
                .map(str::to_owned)
                .to_vec(),
            status: 0,
            stdout: "git@github.com:Org/My_Repo.git\n".to_owned(),
            stderr: String::new(),
        }]);
        let detected = detect_project(&root, &runner, &[])?;
        assert_eq!(detected.name.as_deref(), Some("my-repo"));
        assert_eq!(runner.calls().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }

    // Covers: R73
    #[test]
    fn migrations_weigh_real_imports() -> Result<(), Unmodeled> {
        let root = temp("imports");
        write(
            &root,
            "package.json",
            "{\"name\":\"x\",\"dependencies\":{\"moment\":\"2\",\"dayjs\":\"1\"}}",
        );
        write(&root, "src/a.ts", "import m from 'moment';");
        write(&root, "src/b.ts", "import d from \"dayjs/plugin/utc\";");
        write(&root, "src/c.md", "'moment'");
        write(&root, "node_modules/x.js", "'moment'");
        let counts = count_dep_imports(&root, &["moment", "dayjs"]);
        assert_eq!(counts.get("moment"), Some(&1));
        assert_eq!(counts.get("dayjs"), Some(&1));
        // Legacy seen once, preferred below the adoption floor: no rule.
        assert!(detect_project(&root, &no_git(), &[])?.migrations.is_empty());
        assert!(imports(b"x 'axios' y", b"axios"));
        assert!(!imports(b"'axios-retry'", b"axios"));
        assert!(!imports(b"'axios/x", b"axios"));
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    }
}
