//! `navori status`, native (spec 0060 T23, R73, R76).
//!
//! The at-a-glance snapshot of `commands/status.ts`: config summary, enabled plugins, drift, the
//! pending render, the git distribution row and the next steps, with the health verdict `doctor`
//! shares ([`compute_health_verdict`]) driving `ok` and exit code 2. Text and `--json` are
//! byte-identical to the TS.
//!
//! Delegation triggers, each decided before any output or effect:
//! - an argv shape citty could read differently, a positional, or colored human output;
//! - a config `readConfig` rejects or Rust does not model;
//! - every branch [`compute_health_verdict`] delegates (workspaces, Codex health, native hooks,
//!   unreadable settings, presets the loader declines) and plugins the loader declines;
//! - a dry-run render the native render would delegate (`CLAUDE.md` present);
//! - git answers or JSON the distribution port cannot classify;
//! - config values that are not plain ASCII strings (clack normalizes and measures them), and a
//!   word longer than a note line (clack's hard break is not ported).

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use navori_core::config::Config;
use navori_core::diagnose::distribution::{
    DistributionReport, local_harness_version, scan_distribution,
};
use navori_core::diagnose::health::{
    HealthState, known_drift_sources, scan_managed_drift, suggest_next_steps,
};
use navori_core::diagnose::verdict::compute_health_verdict;
use navori_core::i18n::{Status, common_no_config};
use navori_core::js_json::{JsObject, JsValue};
use navori_core::process::RealRunner;
use navori_core::render::context::Lang;
use navori_core::render::plugins::load_enabled_plugins;

use crate::backup::parse_leaf;
use crate::clack::{Clack, plain_output, width};
use crate::native_io::{Output, json_line, member, number, object, read_config, string};
use crate::render::pending_changes;
use crate::{NativeCall, Outcome};

/// Columns clack wraps a note's message at (`getColumns()` of a non-TTY minus 6).
const NOTE_COLUMNS: usize = 74;

/// `navori status`.
#[must_use]
pub fn run(call: &NativeCall<'_>) -> Outcome {
    run_args(call.args).map_or(Outcome::Delegate, Outcome::Exit)
}

fn run_args(args: &[OsString]) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "status" || rest.contains(&"--") {
        return None;
    }
    let options = parse_leaf(rest, &["cwd"], &["json"])?;
    let json = options.flag("json");
    if !options.positionals.is_empty() || (!json && !plain_output()) {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd = navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or(""));
    Some(status(&cwd, json)?.emit())
}

/// `wrapAnsi(text, columns, { hard: true, trim: false })` for plain text: words split on spaces,
/// a space kept at the end of the row it ends. `None` for a word wider than `columns` (the hard
/// break is not ported) or one Rust cannot measure.
fn wrap(text: &str, columns: usize) -> Option<String> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        let mut rows = vec![String::new()];
        let mut row_width = 0;
        for (index, word) in line.split(' ').enumerate() {
            if index != 0 {
                if row_width >= columns {
                    rows.push(String::new());
                    row_width = 0;
                }
                rows.last_mut()?.push(' ');
                row_width += 1;
            }
            let word_width = width(word)?;
            if word_width > columns {
                return None;
            }
            if row_width + word_width > columns && row_width > 0 && word_width > 0 {
                rows.push(String::new());
                row_width = 0;
            }
            rows.last_mut()?.push_str(word);
            row_width += word_width;
        }
        out.push(rows.join("\n"));
    }
    Some(out.join("\n"))
}

/// `kv(rows)`: keys padded to the widest, `  key : value`.
fn kv(rows: &[(&str, String)]) -> String {
    let width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    rows.iter()
        .map(|(k, v)| format!("  {k:<width$} : {v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `distributionSummary(report, ts)`: the non-zero counts, joined.
fn distribution_summary(report: &DistributionReport, ts: Status) -> String {
    let mut parts = Vec::new();
    if !report.uncommitted.is_empty() {
        parts.push(ts.distribution_row_uncommitted(report.uncommitted.len()));
    }
    if let Some(unpushed) = &report.unpushed {
        parts.push(ts.distribution_row_unpushed(unpushed.commits));
    }
    if let Some(base) = &report.base {
        if base.files > 0 {
            parts.push(ts.distribution_row_vs_base(base.files, &base.base_ref));
        }
        if base.behind > 0 {
            parts.push(ts.distribution_row_behind(base.behind, &base.base_ref));
        }
    }
    parts.join(" · ")
}

/// `config[key]` as plain ASCII text, which clack prints unchanged.
fn ascii_text(config: &JsValue, key: &str) -> Option<String> {
    match member(Some(config), key) {
        Some(JsValue::String(text)) => text.to_rust().filter(|t| t.is_ascii()),
        _ => None,
    }
}

/// `Object.entries(config.plugins ?? {})` with `enabled === true`, their ids.
fn enabled_plugins(config: &JsValue) -> Option<Vec<String>> {
    match member(Some(config), "plugins") {
        None | Some(JsValue::Undefined) => Some(Vec::new()),
        Some(JsValue::Object(plugins)) => plugins
            .ordered()
            .into_iter()
            .filter(|(_, v)| member(Some(v), "enabled") == Some(&JsValue::Bool(true)))
            .map(|(k, _)| k.to_rust())
            .collect(),
        Some(_) => None,
    }
}

fn config_value(config: &Config, key: &str) -> JsValue {
    member(Some(&config.data), key)
        .cloned()
        .unwrap_or(JsValue::Undefined)
}

fn no_config(cwd: &str, json: bool) -> Output {
    let config_path = format!("{cwd}/navori.config.json");
    if json {
        let mut out = Output::default();
        let value = object(vec![
            ("ok", JsValue::Bool(false)),
            ("error", string("config-missing")),
            ("configPath", string(&config_path)),
        ]);
        json_line(&mut out, &value);
        out.code = 1;
        return out;
    }
    let mut clack = Clack::default();
    clack.intro("navori status");
    clack.cancel(&common_no_config(Lang::Es, &config_path));
    clack.out
}

/// `statusCommand.run` for `cwd`; `None` delegates.
#[allow(
    clippy::too_many_lines,
    reason = "one function per `statusCommand.run`, branch for branch"
)]
fn status(cwd: &str, json: bool) -> Option<Output> {
    if !Path::new(&format!("{cwd}/navori.config.json")).exists() {
        return Some(no_config(cwd, json));
    }
    let config = read_config(cwd)??;
    let root = Path::new(cwd);
    let claude_md_exists = root.join("CLAUDE.md").exists();
    let plugins = load_enabled_plugins(member(Some(&config.data), "plugins")).ok()?;
    let verdict = compute_health_verdict(root, &config, &plugins).ok()?;
    let known = known_drift_sources(&plugins.loaded);
    let drifts = scan_managed_drift(root, &config, &known, navori_core::STAMP_VERSION).ok()?;
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let distribution = scan_distribution(root, &config.data, &RealRunner, &env).ok()?;
    // `computeRenderPending`: the dry run only happens with `CLAUDE.md`, and a native render that
    // would delegate makes the whole command delegate.
    let render_pending = if claude_md_exists {
        Some(pending_changes(root, &config)?)
    } else {
        None
    };
    let enabled = enabled_plugins(&config.data)?;
    let rendered_version = local_harness_version(root).ok()?;
    let missing_plugins = verdict.missing_plugins.len();
    let state = HealthState {
        claude_md_exists,
        missing_plugins,
        drifts: &drifts,
        render_pending,
    };
    let code = if verdict.ok { 0 } else { 2 };

    let mut out = Output::default();
    // `readConfig` warns on the status read and again inside the dry-run render.
    for _ in 0..1 + usize::from(claude_md_exists) {
        for warning in &config.warnings {
            out.stderr.push_str(&format!("{warning}\n"));
        }
    }

    if json {
        let mut value = JsObject::new();
        value.insert("ok", JsValue::Bool(verdict.ok));
        value.insert("name", config_value(&config, "name"));
        value.insert("version", config_value(&config, "version"));
        value.insert(
            "renderedVersion",
            rendered_version.as_deref().map_or(JsValue::Null, string),
        );
        value.insert("preset", config_value(&config, "preset"));
        value.insert("engines", config_value(&config, "engines"));
        value.insert(
            "enabledPlugins",
            JsValue::Array(enabled.iter().map(|id| string(id)).collect()),
        );
        value.insert("claudeMdExists", JsValue::Bool(claude_md_exists));
        value.insert("drift", number(drifts.len()));
        value.insert(
            "renderPending",
            render_pending.map_or(JsValue::Null, number),
        );
        value.insert(
            "distribution",
            distribution
                .as_ref()
                .map_or(JsValue::Null, DistributionReport::to_json),
        );
        value.insert(
            "missingPlugins",
            JsValue::Array(
                verdict
                    .missing_plugins
                    .iter()
                    .map(|m| string(&m.id))
                    .collect(),
            ),
        );
        value.insert(
            "nextSteps",
            JsValue::Array(
                suggest_next_steps(&state, Lang::En)
                    .iter()
                    .map(|s| string(s))
                    .collect(),
            ),
        );
        out.stdout
            .push_str(&JsValue::Object(value).stringify(Some(2))?);
        out.stdout.push('\n');
        out.code = code;
        return Some(out);
    }

    let lang = config.lang();
    let ts = Status(lang);
    let name = ascii_text(&config.data, "name")?;
    let version = ascii_text(&config.data, "version")?;
    let preset = ascii_text(&config.data, "preset")?;
    let engines = match member(Some(&config.data), "engines") {
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::String(text) => text.to_rust().filter(|t| t.is_ascii()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    if !enabled.iter().all(|id| id.is_ascii()) {
        return None;
    }
    let mut rows: Vec<(&str, String)> = vec![
        ("name", name),
        ("version (project)", version),
        (
            "harness (last changed)",
            rendered_version.unwrap_or_else(|| ts.none().to_owned()),
        ),
        ("preset", preset),
        ("engines", engines.join(", ")),
        (
            "plugins",
            if enabled.is_empty() {
                ts.none().to_owned()
            } else {
                enabled.join(", ")
            },
        ),
        (
            "CLAUDE.md",
            if claude_md_exists {
                ts.present()
            } else {
                ts.missing()
            }
            .to_owned(),
        ),
        ("drift", drifts.len().to_string()),
    ];
    if let Some(pending) = render_pending {
        let row = if pending > 0 {
            ts.render_pending_row(pending)
        } else {
            "0".to_owned()
        };
        rows.push(("render pending", row));
    }
    if let Some(report) = &distribution {
        rows.push((
            "distribution",
            ts.distribution_row(&distribution_summary(report, ts)),
        ));
    }
    let steps: Vec<String> = suggest_next_steps(&state, lang)
        .iter()
        .map(|s| format!("  · {s}"))
        .collect();

    let mut clack = Clack { out };
    clack.intro("navori status");
    clack.note(&wrap(&kv(&rows), NOTE_COLUMNS)?, &ts.status_title(cwd))?;
    clack.note(
        &wrap(&steps.join("\n"), NOTE_COLUMNS)?,
        ts.next_steps_title(),
    )?;
    clack.outro(if verdict.ok {
        ts.ok()
    } else {
        ts.issues_found()
    });
    clack.out.code = code;
    Some(clack.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn wrap_breaks_like_fast_wrap_ansi_without_trimming() {
        assert_eq!(wrap("aaa bbb", 5).as_deref(), Some("aaa \nbbb"));
        assert_eq!(wrap("aaaaa bb", 5).as_deref(), Some("aaaaa\n bb"));
        assert_eq!(wrap("short", 74).as_deref(), Some("short"));
        assert_eq!(wrap("a\nb c", 3).as_deref(), Some("a\nb c"));
        assert_eq!(wrap("toolongword", 5), None);
    }

    // Covers: R73
    #[test]
    fn distribution_summary_joins_only_the_non_zero_counts() {
        use navori_core::diagnose::distribution::{BaseDivergence, Unpushed};
        let mut report = DistributionReport {
            uncommitted: vec!["a".to_owned(), "b".to_owned()],
            unpushed: Some(Unpushed {
                commits: 1,
                upstream: "origin/x".to_owned(),
            }),
            base: Some(BaseDivergence {
                base_ref: "origin/main".to_owned(),
                files: 0,
                local_version: None,
                base_version: None,
                behind: 3,
            }),
        };
        assert_eq!(
            distribution_summary(&report, Status(Lang::En)),
            "2 uncommitted · 1 unpushed · 3 commit(s) behind origin/main"
        );
        report.uncommitted.clear();
        report.unpushed = None;
        report.base = None;
        assert_eq!(distribution_summary(&report, Status(Lang::Es)), "");
    }

    // Covers: R73
    #[test]
    fn kv_pads_keys_to_the_widest() {
        assert_eq!(
            kv(&[("a", "1".to_owned()), ("bbb", "2".to_owned())]),
            "  a   : 1\n  bbb : 2"
        );
    }
}
