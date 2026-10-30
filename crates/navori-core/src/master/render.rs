//! The deterministic renders `check` compares the files on disk against (`lib/master/status.ts`):
//! `STATUS.md` of a legacy stage and the `navori:master-parts` region of `MASTER.md`.

use sha2::{Digest, Sha256};

use super::markers::master_markers;
use super::state::Part;
use super::status::LegacyStatus;
use crate::js_json::number_to_js;

/// `renderStatusMd(status, language)` for a legacy stage, joined with `\n`.
#[must_use]
pub fn render_status_md(status: &LegacyStatus, english: bool) -> String {
    let markers = master_markers(english);
    let l = &markers.status;
    let closable = format!(
        "{}: {}",
        l.closable,
        if status.closable { l.yes } else { l.no }
    );
    let mut lines: Vec<String> = vec![
        format!("# {} {}", l.stage, status.stage.dir),
        String::new(),
        format!("{}: {}", l.phase, status.state.phase),
    ];
    if let Some(ux) = status.state.ux {
        lines.push(format!("UX: {ux}"));
    }
    lines.push(format!(
        "{}: {}",
        l.active_part,
        status.active_part.as_deref().unwrap_or(l.none)
    ));
    lines.push(closable);
    lines.push(String::new());
    lines.push(format!("| {} |", l.columns.join(" | ")));
    lines.push("|---|---|---|---|---|".to_owned());
    for part in &status.parts {
        lines.push(format!(
            "| {} | {} | {}/{} | {} | {} |",
            part.id,
            part.effective,
            part.tasks_done,
            part.tasks_total,
            part.spec.as_deref().unwrap_or("—"),
            part.issue.map_or_else(|| "—".to_owned(), number_to_js),
        ));
    }
    lines.extend([String::new(), format!("## {}", l.evidence), String::new()]);
    for part in &status.parts {
        for criterion in &part.acceptance {
            lines.push(format!(
                "- {}.{} ({}): {}",
                part.id,
                criterion.id,
                criterion.method,
                if criterion.verified {
                    l.verified
                } else {
                    l.unverified
                }
            ));
        }
    }
    lines.extend([
        String::new(),
        format!("## {}", l.discrepancies),
        String::new(),
    ]);
    if status.discrepancies.is_empty() {
        lines.push(markers.ninguna.to_owned());
    } else {
        lines.extend(status.discrepancies.iter().map(|d| format!("- {d}")));
    }
    lines.extend([String::new(), format!("## {}", l.blockers), String::new()]);
    if status.blockers.is_empty() {
        lines.push(markers.ninguno_digest.to_owned());
    } else {
        lines.extend(status.blockers.iter().map(|b| format!("- {b}")));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// `list.join(sep) || "—"`.
fn joined_or_dash(items: &[String], sep: &str) -> String {
    if items.is_empty() {
        "—".to_owned()
    } else {
        items.join(sep)
    }
}

/// `renderMasterParts(parts, mode, language)`.
#[must_use]
pub fn render_master_parts(parts: &[Part], mode: Option<&str>, english: bool) -> String {
    let l = &master_markers(english).parts;
    let mut lines: Vec<String> = Vec::new();
    for part in parts {
        lines.extend([
            format!("### {} — {}", part.id, part.title),
            String::new(),
            format!("{}: {}", l.objective, part.objective),
            format!("{}: {}", l.scope, joined_or_dash(&part.scope, "; ")),
            format!(
                "{}: {}",
                l.out_of_scope,
                joined_or_dash(&part.out_of_scope, "; ")
            ),
            format!(
                "{}: {}",
                l.depends_on,
                joined_or_dash(&part.depends_on, ", ")
            ),
            format!(
                "{}: {}",
                l.seed_requirements,
                joined_or_dash(&part.seed_requirements, ", ")
            ),
        ]);
        if mode == Some("en-curso") {
            lines.push(format!("{}: {}", l.state, part.state));
        }
        for a in &part.acceptance {
            lines.push(format!(
                "- {}.{} ({}): {} — {}",
                part.id, a.id, a.method, a.description, a.detail
            ));
        }
        lines.push(String::new());
    }
    let body = lines.join("\n");
    let digest = Sha256::digest(body.as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("<!-- navori:master-parts hash=\"{hash}\" -->\n{body}<!-- /navori:master-parts -->")
}

/// `masterPartsRegion(content)`: the region with its markers, or `None`.
#[must_use]
pub fn master_parts_region(content: &str) -> Option<&str> {
    let start = content.find("<!-- navori:master-parts hash=\"")?;
    let header_end = start + content[start..].find(" -->")?;
    let closing = "<!-- /navori:master-parts -->";
    let end = header_end + 4 + content[header_end + 4..].find(closing)?;
    Some(&content[start..end + closing.len()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_is_cut_between_its_markers() {
        let text = "a\n<!-- navori:master-parts hash=\"abcd1234\" -->\nx\n<!-- /navori:master-parts -->\nb";
        assert_eq!(
            master_parts_region(text),
            Some(
                "<!-- navori:master-parts hash=\"abcd1234\" -->\nx\n<!-- /navori:master-parts -->"
            )
        );
        assert_eq!(
            master_parts_region("<!-- navori:master-parts hash=\"x\" -->"),
            None
        );
        assert_eq!(master_parts_region("nada"), None);
    }

    #[test]
    fn empty_parts_hash_the_empty_body() {
        // sha256("") starts with e3b0c442.
        assert_eq!(
            render_master_parts(&[], None, false),
            "<!-- navori:master-parts hash=\"e3b0c442\" -->\n<!-- /navori:master-parts -->"
        );
    }
}
