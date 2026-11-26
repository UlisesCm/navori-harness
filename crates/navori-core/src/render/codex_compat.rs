//! `adaptHarnessTextForCodex` (`engines/codex/compat.ts`, spec 0059 T19): Claude-oriented prose
//! retargeted to Codex's surfaces and tool vocabulary. Each rule rewrites a path or a term and
//! leaves the sentence around it alone; none depends on the repo's language (#443).

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// The commit-hygiene line keeps its literal `.claude/` and `CLAUDE.md` (#209).
const NEVER_COMMIT_PHRASE: &str = "Never commit `.claude/` or `CLAUDE.md`";
const NEVER_COMMIT_SENTINEL: &str = "\u{0}navori:never-commit\u{0}";

/// `CODEX_VOCABULARY`, applied last and in order.
pub const CODEX_VOCABULARY: [(&str, &str); 6] = [
    (
        "`Agent(subagent_type: orchestrator)`",
        "`spawn_agent(orchestrator)`",
    ),
    ("`Agent`", "`spawn_agent`"),
    (
        "Claude serializes by default",
        "Codex serializes by default",
    ),
    ("/spec-bootstrap", "$spec-bootstrap"),
    ("`SendMessage`", "`send_input`"),
    ("/master-plan", "$master-plan"),
];

/// `CODEX_MIRRORED_DIRS`: the `.claude/` directories a Codex render mirrors (#428).
fn mirrored_dir(dir: &str) -> Option<&'static str> {
    match dir {
        "agents" => Some(".codex/agents"),
        "hooks" => Some(".codex/hooks"),
        "skills" => Some(".agents/skills"),
        _ => None,
    }
}

struct Patterns {
    agent: Regex,
    skill_dir: Regex,
    skill_flat: Regex,
    citation: Regex,
}

static PATTERNS: LazyLock<Option<Patterns>> = LazyLock::new(|| {
    Some(Patterns {
        agent: Regex::new(r"\.claude/agents/([a-z0-9-]+)\.md").ok()?,
        skill_dir: Regex::new(r"\.claude/skills/([a-z0-9-]+)/SKILL\.md").ok()?,
        skill_flat: Regex::new(r"\.claude/skills/([a-z0-9-]+)\.md").ok()?,
        citation: Regex::new(r"\.claude/([A-Za-z0-9_.-]*)").ok()?,
    })
});

/// `adaptHarnessTextForCodex(content, config)`; `None` only if a constant pattern failed to
/// compile.
#[must_use]
pub fn adapt_harness_text_for_codex(content: &str) -> Option<String> {
    let p = PATTERNS.as_ref()?;
    let text = content.replace(".claude/agents/orchestrator.md", ".codex/orchestrator.md");
    let text = p.agent.replace_all(&text, ".codex/agents/$1.toml");
    let text = p.skill_dir.replace_all(&text, ".agents/skills/$1/SKILL.md");
    let text = p
        .skill_flat
        .replace_all(&text, ".agents/skills/$1/SKILL.md");
    let text = text.replace(NEVER_COMMIT_PHRASE, NEVER_COMMIT_SENTINEL);
    let text = p.citation.replace_all(&text, |caps: &Captures<'_>| {
        let dir = caps.get(1).map_or("", |m| m.as_str());
        let mapped = if dir.is_empty() {
            Some(".codex/")
        } else {
            mirrored_dir(dir)
        };
        mapped.map_or_else(|| caps[0].to_owned(), str::to_owned)
    });
    let mut text = text
        .replace("CLAUDE.md", "AGENTS.md")
        .replace(NEVER_COMMIT_SENTINEL, NEVER_COMMIT_PHRASE);
    for (from, to) in CODEX_VOCABULARY {
        text = text.replace(from, to);
    }
    Some(text)
}
