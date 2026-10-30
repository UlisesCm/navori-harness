//! `navori master close`, native on a legacy stage or with no active stage (spec 0060 T8).
//!
//! `navori_core::master::close` plans the six durable steps; this command plans the last one too
//! (`finishRender`: the config with `harness.masterPlan` off, then the render) before the first
//! write. It is native only inside the entry's `when.engines` and without monorepo workspaces,
//! the subset where the render is native, and delegates whenever an audit session is reachable
//! from the environment, because the TS emits `master-close` through the audit writer (T18).

use std::path::Path;

use navori_core::backup::backup_root;
use navori_core::config::{self, Config, write_config};
use navori_core::fs::{RealFs, write_file_atomic};
use navori_core::integrity::is_js_whitespace;
use navori_core::js_json::{JsObject, JsValue};
use navori_core::master::close::{CloseOptions, ClosePlan, plan_close};
use navori_core::render::claude_md::has_monorepo_workspaces;
use navori_core::render::collect::DiskView;
use navori_core::render::command::{RenderOptions, plan_render};

use crate::help::{ArgDef, ArgKind, CommandDef};
use crate::master::{MASTER_PARENT, part_config};
use crate::master_read::{Repo, argv, cwd_of, fail, parse_options, push_warnings};
use crate::master_write::audit_may_write;
use crate::native_io::{Output, member};
use crate::render::{apply_render, config_name, configured_engines, home, registry_needs_refresh};
use crate::{NativeCall, Outcome};

const CLOSE: CommandDef = CommandDef {
    name: "close",
    description: "Close, convert or abandon the active stage (R47, R57, R58)",
    args: &[
        ArgDef {
            name: "convert",
            kind: ArgKind::String,
            description: "Convert to an empty spec path under specsDir",
        },
        ArgDef {
            name: "abandon",
            kind: ArgKind::Boolean,
            description: "Abandon before mastered",
        },
        ArgDef {
            name: "reason",
            kind: ArgKind::String,
            description: "Required reason for conversion or abandonment",
        },
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "Closed stages are read-only",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

/// `master close`.
#[must_use]
pub fn run_close(call: &NativeCall<'_>) -> Outcome {
    close(call).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

/// `{ ...config, harness: { ...config.harness, masterPlan: value } }` as `writeConfig` writes it.
fn config_with_master_plan(config: &Config, value: bool) -> Option<String> {
    let JsValue::Object(root) = &config.data else {
        return None;
    };
    let mut root = root.clone();
    let mut harness = match root.get("harness") {
        Some(JsValue::Object(harness)) => harness.clone(),
        None | Some(JsValue::Undefined | JsValue::Null) => JsObject::new(),
        Some(_) => return None,
    };
    harness.insert("masterPlan", JsValue::Bool(value));
    root.insert("harness", JsValue::Object(harness));
    write_config(&root).ok()
}

/// The config's engines inside the entry's `when.engines`, and no monorepo workspaces.
fn admitted(config: &Config, call: &NativeCall<'_>) -> bool {
    let engines_ok = call
        .entry
        .when
        .as_ref()
        .and_then(|w| w.engines.as_ref())
        .is_none_or(|allowed| {
            let configured = configured_engines(&config.data);
            !configured.is_empty() && configured.iter().all(|e| allowed.contains(e))
        });
    engines_ok && !has_monorepo_workspaces(&config.data)
}

fn close(call: &NativeCall<'_>) -> Option<Output> {
    let argv = argv(call.args)?;
    let ["master", "close", rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&CLOSE, MASTER_PARENT, None));
    }
    let parsed = parse_options(rest, &["abandon"], &["convert", "reason", "stage", "cwd"])?;
    if !parsed.positionals.is_empty() {
        return None;
    }
    if let Some(stage) = parsed.value("stage").filter(|s| !s.is_empty()) {
        return Some(fail(&format!(
            "--stage {stage} es de solo lectura; use 'navori master check --stage {stage}'"
        )));
    }
    if audit_may_write() {
        return None;
    }
    let options = CloseOptions {
        convert: parsed.value("convert"),
        abandon: parsed.flag("abandon"),
        reason: parsed.value("reason"),
    };
    // `runMasterClose` checks these two before it reads the config.
    if options.convert.is_some_and(|c| !c.is_empty()) && options.abandon {
        return Some(fail("--convert y --abandon son excluyentes"));
    }
    if options
        .reason
        .is_some_and(|r| r.trim_matches(is_js_whitespace).is_empty())
    {
        return Some(fail("--reason no puede estar vacío"));
    }
    let cwd = cwd_of(&parsed)?;
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    if !admitted(&repo.config, call) {
        return None;
    }
    let master_plan = match member(member(Some(&repo.config.data), "harness"), "masterPlan") {
        Some(JsValue::Bool(value)) => Some(*value),
        _ => None,
    };
    let plan = plan_close(
        &repo.cwd,
        &repo.specs_dir,
        &repo.master_dir,
        part_config(&repo.config),
        master_plan,
        repo.index.as_ref(),
        &options,
    )
    .ok()?;
    let (stage, outcome, writes, config_reads) = match plan {
        ClosePlan::Failed {
            message,
            config_reads,
        } => {
            for _ in 0..config_reads {
                push_warnings(&mut out, &repo.config.warnings);
            }
            out.stderr.push_str(&format!("{message}\n"));
            out.code = 1;
            return Some(out);
        }
        ClosePlan::Complete => {
            out.stdout
                .push_str("no hay etapa activa; cierre ya completo\n");
            return Some(out);
        }
        ClosePlan::Close {
            stage,
            outcome,
            writes,
            config_reads,
        } => (stage, outcome, writes, config_reads),
    };
    // `finishRender`, planned before the first write: the render reads the config just written.
    let cwd = Path::new(&repo.cwd);
    let off = config_with_master_plan(&repo.config, false)?;
    let on = config_with_master_plan(&repo.config, true)?;
    let rendered = config::read(off.as_bytes()).ok()?;
    let render_options = RenderOptions::default();
    plan_render(&DiskView(cwd), &rendered, cwd, &render_options).ok()?;
    let home = home()?;
    if registry_needs_refresh(&home, cwd, config_name(&rendered).as_deref())
        || backup_root().is_err()
    {
        return None;
    }
    for _ in 0..config_reads {
        push_warnings(&mut out, &repo.config.warnings);
    }
    let config_path = cwd.join("navori.config.json");
    let mut fs = RealFs::default();
    for (path, content) in &writes {
        if let Err(error) = write_file_atomic(&mut fs, Path::new(path), content) {
            out.stderr.push_str(&format!("{}\n", error.message));
            out.code = 1;
            return Some(out);
        }
    }
    if let Err(error) = write_file_atomic(&mut fs, &config_path, &off) {
        out.stderr.push_str(&format!("{}\n", error.message));
        out.code = 1;
        return Some(out);
    }
    // `runRender` reads the config it renders.
    push_warnings(&mut out, &rendered.warnings);
    match apply_render(cwd, &rendered, &render_options) {
        Ok((_, record)) => out.stderr.push_str(&record),
        Err(message) => {
            // The recovery signal survives a render that failed after the registry closed.
            let _ = write_file_atomic(&mut fs, &config_path, &on);
            out.stderr.push_str(&format!("{message}\n"));
            out.code = 1;
            return Some(out);
        }
    }
    let line = match (stage, outcome) {
        (Some(stage), Some(outcome)) => format!("{stage}: {outcome}\n"),
        _ => "no hay etapa activa; se apagó harness.masterPlan\n".to_owned(),
    };
    out.stdout.push_str(&line);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_are_read_strictly() {
        let parsed = parse_options(
            &["--abandon", "--reason", "r"],
            &["abandon"],
            &["convert", "reason", "stage", "cwd"],
        );
        assert!(parsed.is_some_and(|p| p.flag("abandon") && p.value("reason") == Some("r")));
        assert!(
            parse_options(
                &["--abandon=true"],
                &["abandon"],
                &["convert", "reason", "stage", "cwd"]
            )
            .is_none()
        );
    }
}
