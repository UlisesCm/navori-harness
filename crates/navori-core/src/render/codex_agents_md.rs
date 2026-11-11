//! `AGENTS.md` as the Codex engine writes it (`buildAgentsMdRequest`, `compactAgentDescription`)
//! and the orchestrator playbook reference (`orchestratorRequest`,
//! `adaptOrchestratorPlaybookForCodex`), from `engines/codex/index.ts` (spec 0059 T19).

use std::collections::BTreeMap;
use std::path::Path;

use crate::STAMP_VERSION;
use crate::i18n;
use crate::js_json::JsValue;
use crate::markers::{CommentStyle, InjectOptions, MarkerMeta, inject_managed_section};
use crate::posix::js_trim;
use crate::render::assets;
use crate::render::codex_agents::CodexDelegate;
use crate::render::codex_compat::adapt_harness_text_for_codex;
use crate::render::collect::{
    BodyRequest, Collected, RepoView, collect_body, collect_managed, read_if_exists,
};
use crate::render::context::Lang;
use crate::render::frontmatter::strip_frontmatter;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::RenderManagedFileInput;
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugins::LoadedPlugin;
use crate::render::prose::{ProseOptions, build_harness_prose};

/// `firstRenderSeed` of `AGENTS.md`.
const AGENTS_MD_HEADER: &str = "# AGENTS.md\n";
const AGENTS_MD_TRAILER: &str =
    "\n<!-- navori:user-section -->\n<!-- user: additional rules for Codex -->\n";

/// `compactAgentDescription`: the "Use ..." trigger clause cut at its first comma, else the first
/// sentence, without a final period.
#[must_use]
pub fn compact_agent_description(description: &str) -> String {
    // `/(?:^|\. )(Use [^.]*)/`: the leftmost `Use ` at the start or after `. `.
    let start = if description.starts_with("Use ") {
        Some(0)
    } else {
        description.find(". Use ").map(|at| at + 2)
    };
    let clause = match start {
        Some(at) => {
            let rest = &description[at..];
            &rest[..rest.find('.').unwrap_or(rest.len())]
        }
        None => description.split(". ").next().unwrap_or(description),
    };
    let first = clause.split(',').next().unwrap_or(clause);
    js_trim(first.strip_suffix('.').unwrap_or(first)).to_owned()
}

/// `buildAgentsIndexBlock(lang, agents, { withIntro: false })`.
pub(crate) fn agents_index_block(lang: Lang, agents: &[(String, String)]) -> Option<String> {
    if agents.is_empty() {
        return None;
    }
    let (heading, _) = i18n::agents_index(lang);
    let mut lines = vec![heading.to_owned(), String::new()];
    lines.extend(
        agents
            .iter()
            .map(|(id, description)| format!("- `{id}` — {description}")),
    );
    lines.push(String::new());
    Some(lines.join("\n"))
}

fn adapt(text: &str) -> Result<String, CodexDelegate> {
    adapt_harness_text_for_codex(text).ok_or(CodexDelegate)
}

/// The body of `AGENTS.md`: the harness prose with orchestration and plugin blocks, the agent
/// catalog, and plugin skills aimed at the orchestrator as sub-blocks.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws or Rust does not model the prose.
pub fn agents_md_body(
    config: &JsValue,
    repo_root: &Path,
    plugins: &[LoadedPlugin],
    agents: &[(String, String)],
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<String, CodexDelegate> {
    let base = build_harness_prose(
        config,
        repo_root,
        "codex",
        ProseOptions {
            include_orchestration: true,
            include_plugin_blocks: true,
            omit_skills_index: true,
            ambient_floor,
            ..ProseOptions::default()
        },
    )
    .map_err(|_| CodexDelegate)?;
    let compact: Vec<(String, String)> = agents
        .iter()
        .map(|(id, description)| (id.clone(), compact_agent_description(description)))
        .collect();
    let catalog = agents_index_block(lang, &compact).unwrap_or_default();
    let mut body = adapt(&format!("{base}\n{catalog}"))?;
    for plugin in plugins {
        let plugin_id = plugin.manifest_id();
        for skill in &plugin.skill_assets {
            if skill.inject_into.as_deref() != Some(".claude/agents/orchestrator.md") {
                continue;
            }
            let raw = assets::plugin(&plugin.dir, &skill.path)
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .ok_or(CodexDelegate)?;
            let sub_block = adapt(&interpolate(
                strip_frontmatter(raw),
                config,
                &InterpolateOptions::default(),
            ))?;
            let meta = MarkerMeta {
                source: Some(format!("@navori/plugin-{plugin_id}")),
                version: Some(STAMP_VERSION.to_owned()),
                ..MarkerMeta::default()
            };
            body = inject_managed_section(
                &body,
                &skill.id,
                &sub_block,
                &meta,
                InjectOptions {
                    ambient_floor,
                    ..InjectOptions::default()
                },
            )
            .output;
        }
    }
    Ok(body)
}

/// The `AGENTS.md` request (`navori-agents`, shared with the universal adapter), collected.
///
/// # Errors
/// [`CodexDelegate`] when the destination cannot be read.
pub fn collect_agents_md(
    view: &dyn RepoView,
    body: &str,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<Collected, CodexDelegate> {
    let request = BodyRequest {
        header: AGENTS_MD_HEADER,
        trailer: AGENTS_MD_TRAILER,
        ..BodyRequest::new("AGENTS.md", "navori-agents", body, CommentStyle::Html)
    };
    collect_body(view, &request, ambient_floor, lang).map_err(|_| CodexDelegate)
}

/// JS line starts (after `\n`, `\r`, U+2028 or U+2029), with each line's end.
fn js_lines(text: &str) -> Vec<(usize, usize)> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (at, ch) in text.char_indices() {
        if matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            lines.push((start, at));
            start = at + ch.len_utf8();
        }
    }
    lines.push((start, text.len()));
    lines
}

/// `adaptOrchestratorPlaybookForCodex`: one playbook source without its Claude-only navigation.
#[must_use]
pub fn adapt_orchestrator_playbook(content: &str) -> String {
    let text = adapt_harness_text_for_codex(strip_frontmatter(content))
        .unwrap_or_default()
        .replace("(../../AGENTS.md)", "(../AGENTS.md)")
        .replace(
            "which the `SessionStart` hook delivers to the session, not to a subagent:",
            "which `AGENTS.md` supplies to the main thread:",
        );
    // `/^2\. The catalog of subagents and skills is in .*$/m`, first match only.
    let prefix = "2. The catalog of subagents and skills is in ";
    let text = match js_lines(&text)
        .into_iter()
        .find(|(start, end)| text[*start..*end].starts_with(prefix))
    {
        Some((start, end)) => format!(
            "{}2. The catalog of subagents and skills is in `AGENTS.md`, inside its managed `navori-agents` block; read the rendered headings there, not a Claude-only block id.{}",
            &text[..start],
            &text[end..]
        ),
        None => text,
    };
    text.replace(
        "In Claude Code you can reference `subagent_type: \"Explore\"` when it exists; in other engines, `scout` is the replacement.",
        "Use the `scout` role for this scope.",
    )
    .replace(
        "The command lives in a cross-review sub-block that navori injects into THIS file, and only in that case. Scroll to the end: no such sub-block below means this repo renders Claude only and the option does not apply here. (Never re-derive this from a `grep` for the sub-block's id — you are reading the file that would match.)",
        "The optional cross-review guidance lives in `AGENTS.md`, not in this reference. Its absence here does not establish whether another engine is configured.",
    )
}

/// `orchestratorRequest`: the core orchestrator asset as `.codex/orchestrator.md`, collected.
///
/// # Errors
/// [`CodexDelegate`] where the TS throws.
pub fn collect_orchestrator(
    view: &dyn RepoView,
    config: &JsValue,
    ambient_floor: Option<&str>,
    lang: Lang,
) -> Result<Collected, CodexDelegate> {
    adapt_harness_text_for_codex("").ok_or(CodexDelegate)?;
    let raw = assets::core("core-assets/agents/orchestrator.md")
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .ok_or(CodexDelegate)?;
    let dest = ".codex/orchestrator.md";
    let existing = read_if_exists(view, dest).map_err(|_| CodexDelegate)?;
    let transform = |text: &str| adapt_orchestrator_playbook(text);
    let input = RenderManagedFileInput {
        asset: raw,
        style: CommentStyle::Html,
        existing: existing.as_deref(),
        managed_id: "orchestrator-codex-base",
        source: CORE_SOURCE_ID,
        version: STAMP_VERSION,
        config,
        extra_vars: BTreeMap::new(),
        transform: Some(&transform),
        engine: Some("codex"),
        force_overwrite: false,
        ambient_floor,
    };
    collect_managed(view, dest, &input, false, lang).map_err(|_| CodexDelegate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_description_takes_the_use_clause() {
        assert_eq!(
            compact_agent_description("Writes code. Use when a change touches 4+ files, always."),
            "Use when a change touches 4+ files"
        );
        assert_eq!(compact_agent_description("Reads. Writes, maybe."), "Reads");
        assert_eq!(compact_agent_description("Use it."), "Use it");
    }
}
