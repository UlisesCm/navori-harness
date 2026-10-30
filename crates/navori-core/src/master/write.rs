//! What `navori master` writes (`lib/master/status.ts` `writeMasterStatus`, `stages.ts`
//! `renderIndexMd` and `checks.ts` `runMasterAdvance`): `STATUS.md`, the `navori:master-parts`
//! region of `MASTER.md`, `INDEX.md`, and the phase in `state.json`.
//!
//! Everything that can make the native run differ from the TS is checked **before** the first
//! byte is written, and answered with [`Delegate`]: the TS then does it all, partial failures
//! included. The writes themselves go through the [`Fs`] layer of spec 0058 (atomic: a temporary
//! next to the destination, `fsync`, `rename`).

use std::fs;
use std::path::Path;

use super::check_part::PartConfig;
use super::checks::{
    CheckContext, StageCtx, check_raw_gitignore, checks_for_transition, js_join, next_phase,
};
use super::index::{MASTER_DIR_NAME, MasterIndex};
use super::render::{master_parts_region, render_master_parts, render_status_md};
use super::state::{self, Part};
use super::status::{self, Delegate, LegacyStatus, read_json};
use crate::fs::{RealFs, write_file_atomic};
use crate::js_json::{JsObject, JsValue, number_to_js};

/// `renderIndexMd(index, specsDir)`.
#[must_use]
pub fn render_index_md(index: &MasterIndex, specs_dir: &str) -> String {
    let first = index.active().map_or_else(
        || "Etapa activa: ninguna".to_owned(),
        |a| {
            format!(
                "Etapa activa: {specs_dir}/{MASTER_DIR_NAME}/{}/STATUS.md",
                a.dir
            )
        },
    );
    let mut lines = vec![
        first,
        String::new(),
        "| Número | Slug | Estado | Apertura | Cierre | Enlace |".to_owned(),
        "|---|---|---|---|---|---|".to_owned(),
    ];
    for s in &index.stages {
        let link = if s.deliveries {
            format!("[STATUS.md]({}/STATUS.md)", s.dir)
        } else if s.state == super::index::StageState::Active {
            format!("[MASTER.md]({}/MASTER.md)", s.dir)
        } else {
            format!("[CLOSURE.md]({}/CLOSURE.md)", s.dir)
        };
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {link} |",
            number_to_js(s.number),
            s.slug,
            s.state.as_str(),
            s.opened_at,
            s.closed_at.as_deref().unwrap_or("—"),
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// `detectEol(text)`: CRLF when the first line break is one.
fn detect_eol(text: &str) -> &'static str {
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

const fn is_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Byte offsets where a JS multiline `^` matches.
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0)
        .chain(
            text.char_indices()
                .filter(|(_, c)| is_terminator(*c))
                .map(|(at, c)| at + c.len_utf8()),
        )
        .filter(|at| *at <= text.len())
}

/// `/^## (?:Entrega en partes|Delivery in parts)[ \t]*$/m`: where the heading line ends.
fn parts_heading_end(content: &str) -> Option<usize> {
    line_starts(content).find_map(|at| {
        let rest = &content[at..];
        let line = &rest[..rest.find(is_terminator).unwrap_or(rest.len())];
        let body = line.strip_prefix("## ")?;
        ["Entrega en partes", "Delivery in parts"]
            .iter()
            .find_map(|name| body.strip_prefix(name))
            .filter(|after| after.chars().all(|c| c == ' ' || c == '\t'))
            .map(|_| at + line.len())
    })
}

/// The `MASTER.md` of `writeMasterStatus` with its parts region replaced or inserted; `None` when
/// the file has neither a region nor the heading to insert it under.
///
/// # Errors
/// [`Delegate`] for an opening marker without its close (the TS refuses and says how to repair).
fn master_replacement(content: &str, region: &str) -> Result<Option<String>, Delegate> {
    let eol = detect_eol(content);
    let region = region.replace('\n', eol);
    if let Some(existing) = master_parts_region(content) {
        return Ok(Some(content.replacen(existing, &region, 1)));
    }
    if content.contains("<!-- navori:master-parts") {
        return Err(Delegate);
    }
    let Some(start) = parts_heading_end(content) else {
        return Ok(None);
    };
    let end = line_starts(content)
        .find(|at| *at > start && content[*at..].starts_with("## "))
        .unwrap_or(content.len());
    let previous = content[start..end].trim_matches(crate::integrity::is_js_whitespace);
    let kept = if previous.is_empty() {
        String::new()
    } else {
        format!("{previous}{eol}{eol}")
    };
    Ok(Some(format!(
        "{}{eol}{eol}{region}{eol}{eol}{kept}{}",
        &content[..start],
        &content[end..]
    )))
}

/// `assertWritableInRepo(cwd, path)`: the path and its parent must resolve inside the repo.
fn assert_writable(cwd: &str, path: &str) -> Result<(), Delegate> {
    let root = fs::canonicalize(cwd).map_err(|_| Delegate)?;
    let parent = Path::new(path).parent().ok_or(Delegate)?;
    let parent = fs::canonicalize(parent).map_err(|_| Delegate)?;
    if parent == root || !parent.starts_with(&root) {
        return Err(Delegate);
    }
    if Path::new(path).exists() {
        let real = fs::canonicalize(path).map_err(|_| Delegate)?;
        if real == root || !real.starts_with(&root) {
            return Err(Delegate);
        }
    }
    Ok(())
}

/// One file `writeMasterStatus` writes.
pub type Planned = (String, String);

/// `writeMasterStatus` up to its first write: the files, in order, with every guard checked.
/// `status` is the active legacy stage's status; `None` writes `INDEX.md` alone.
///
/// # Errors
/// [`Delegate`] wherever the TS would throw: an unsafe destination, an unclosed region marker, a
/// file that is not UTF-8, a parts file the schema rejects.
pub fn plan_status_writes(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    english: bool,
    index: &MasterIndex,
    status: Option<&LegacyStatus>,
) -> Result<Vec<Planned>, Delegate> {
    let index_path = js_join(master_dir, "INDEX.md");
    let index_md = render_index_md(index, specs_dir);
    let Some(status) = status else {
        assert_writable(cwd, &index_path)?;
        return Ok(vec![(index_path, index_md)]);
    };
    let stage_path = js_join(master_dir, &status.stage.dir);
    let parts_path = js_join(&stage_path, "parts.json");
    let parts: Vec<Part> = if Path::new(&parts_path).exists() {
        state::parts(&read_json(Path::new(&parts_path))?).map_err(|_| Delegate)?
    } else {
        Vec::new()
    };
    let master_path = js_join(&stage_path, "MASTER.md");
    let replacement = if Path::new(&master_path).exists() {
        let content = String::from_utf8(fs::read(&master_path).map_err(|_| Delegate)?)
            .map_err(|_| Delegate)?;
        master_replacement(
            &content,
            &render_master_parts(&parts, status.state.mode, english),
        )?
    } else {
        None
    };
    let status_path = js_join(&stage_path, "STATUS.md");
    assert_writable(cwd, &status_path)?;
    if replacement.is_some() {
        assert_writable(cwd, &master_path)?;
    }
    assert_writable(cwd, &index_path)?;
    let mut files = vec![(status_path, render_status_md(status, english))];
    if let Some(content) = replacement {
        files.push((master_path, content));
    }
    files.push((index_path, index_md));
    Ok(files)
}

/// The writes failed after the phase was durable (or for the derived files alone): the TS message.
fn write_all(files: &[Planned]) -> Result<(), String> {
    let mut fs = RealFs::default();
    for (path, content) in files {
        write_file_atomic(&mut fs, Path::new(path), content).map_err(|e| e.message)?;
    }
    Ok(())
}

/// `writeMasterStatus` for the active legacy stage (or none), reported as the command prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusWritten {
    /// `status.stage?.dir`.
    pub stage: Option<String>,
    /// `status.phase`.
    pub phase: Option<&'static str>,
    /// How many times the TS read the config again (its warnings print each time).
    pub config_reads: usize,
}

/// `navori master status` without flags.
///
/// # Errors
/// `Ok(Err(message))` for the failure the TS reports; [`Delegate`] where it throws or the native
/// path would differ.
pub fn write_master_status(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    config: PartConfig,
    index: Option<&MasterIndex>,
) -> Result<Result<StatusWritten, String>, Delegate> {
    let active = index.and_then(MasterIndex::active);
    let legacy = match (index, active) {
        (Some(index), Some(stage)) => Some(status::legacy(
            cwd,
            specs_dir,
            Path::new(master_dir),
            index,
            stage,
            config,
        )?),
        _ => None,
    };
    let config_reads = 1 + legacy.as_ref().map_or(0, |s| s.config_reads);
    let Some(index) = index else {
        return Ok(Err(
            "no index.json: run 'navori master init <slug>' first".to_owned()
        ));
    };
    let files = plan_status_writes(
        cwd,
        specs_dir,
        master_dir,
        config.english,
        index,
        legacy.as_ref(),
    )?;
    write_all(&files).map_err(|_| Delegate)?;
    Ok(Ok(StatusWritten {
        stage: legacy.as_ref().map(|s| s.stage.dir.clone()),
        phase: legacy.as_ref().map(|s| s.state.phase),
        config_reads,
    }))
}

/// `runMasterAdvance`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Advance {
    /// A setup failure the command reports (`MasterCheckSetupError`), after `config_reads` more
    /// reads of the config.
    Setup {
        message: String,
        config_reads: usize,
    },
    /// The checks refused: nothing was written.
    Blocked(Vec<String>),
    /// The phase moved.
    Advanced {
        from: &'static str,
        to: &'static str,
        /// How many times the TS read the config again.
        config_reads: usize,
    },
}

/// `today()`: `new Date().toISOString().slice(0, 10)`.
fn utc_today() -> String {
    jiff::Timestamp::now().strftime("%Y-%m-%d").to_string()
}

/// `runMasterAdvance(cwd)` over a built context.
///
/// # Errors
/// [`Delegate`] before any write whenever the TS would behave differently or throw.
pub fn advance(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    config: PartConfig,
    index: &MasterIndex,
    built: &StageCtx,
) -> Result<Advance, Delegate> {
    let dir = &built.stage.dir;
    if let Some(outcome) = built.state.outcome {
        return Ok(Advance::Setup {
            message: format!(
                "{dir}: cierre iniciado ({outcome}); reanude con 'navori master close'"
            ),
            config_reads: 0,
        });
    }
    let Some(target) = next_phase(built.state.phase) else {
        return Ok(Advance::Blocked(vec![format!(
            "{dir} ya está en fase 'executing': para cerrar la etapa use 'navori master close'"
        )]));
    };
    let ctx = CheckContext {
        english: config.english,
        master_dir,
        index,
        stage: &built.stage,
        stage_path: &built.stage_path,
        state: &built.state,
    };
    let mut failures = check_raw_gitignore(&ctx);
    failures.extend(checks_for_transition(&ctx, target)?);
    if !failures.is_empty() {
        return Ok(Advance::Blocked(failures));
    }
    // `{ ...ctx.state, phase: target, history: [...history, { phase: target, at: today() }] }`.
    let mut updated = built.state.normalized.clone();
    let JsValue::Object(object) = &mut updated else {
        return Err(Delegate);
    };
    object.insert("phase", JsValue::string(target));
    let mut entry = JsObject::new();
    entry.insert("phase", JsValue::string(target));
    entry.insert("at", JsValue::string(&utc_today()));
    match object.get_mut("history") {
        Some(JsValue::Array(history)) => history.push(JsValue::Object(entry)),
        _ => return Err(Delegate),
    }
    let text = format!("{}\n", updated.stringify(Some(2)).ok_or(Delegate)?);
    // The derived files are computed from the state the TS will read back after its write.
    let new_state = state::master_state(&updated).map_err(|_| Delegate)?;
    let status = status::legacy_with_state(
        cwd,
        specs_dir,
        Path::new(master_dir),
        index,
        &built.stage,
        config,
        new_state,
    )?;
    let files = plan_status_writes(
        cwd,
        specs_dir,
        master_dir,
        config.english,
        index,
        Some(&status),
    )?;
    // The state file is atomic: if this fails nothing changed and the TS can take over.
    write_all(&[(js_join(&built.stage_path, "state.json"), text)]).map_err(|_| Delegate)?;
    // `writeMasterStatus` reads the config again, once for the status and once for itself.
    let config_reads = 2 + status.config_reads;
    if let Err(detail) = write_all(&files) {
        return Ok(Advance::Setup {
            message: format!(
                "{dir}: fase durable '{target}'; falló la escritura derivada: {detail}. Repare con 'navori master status'; no repita 'navori master advance'."
            ),
            config_reads,
        });
    }
    Ok(Advance::Advanced {
        from: built.state.phase,
        to: target,
        config_reads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_is_replaced_in_place_and_keeps_the_line_endings() {
        let old = "a\r\n<!-- navori:master-parts hash=\"x\" -->\r\nviejo\r\n<!-- /navori:master-parts -->\r\nz";
        let out = master_replacement(
            old,
            "<!-- navori:master-parts hash=\"y\" -->\nnuevo\n<!-- /navori:master-parts -->",
        );
        assert_eq!(
            out,
            Ok(Some("a\r\n<!-- navori:master-parts hash=\"y\" -->\r\nnuevo\r\n<!-- /navori:master-parts -->\r\nz".to_owned()))
        );
    }

    #[test]
    fn region_is_inserted_under_its_heading_before_the_old_body() {
        let text = "# M\n\n## Entrega en partes \t\nOrigen: x\n\n## Testing\nt\n";
        let out = master_replacement(text, "R");
        assert_eq!(
            out,
            Ok(Some(
                "# M\n\n## Entrega en partes \t\n\nR\n\nOrigen: x\n\n## Testing\nt\n".to_owned()
            ))
        );
        let english = master_replacement("## Delivery in parts\n", "R");
        assert_eq!(
            english,
            Ok(Some("## Delivery in parts\n\nR\n\n".to_owned()))
        );
        assert_eq!(master_replacement("## Otra cosa\n", "R"), Ok(None));
        assert_eq!(
            master_replacement("x <!-- navori:master-parts sin cierre", "R"),
            Err(Delegate)
        );
    }
}
