//! `adaptHarnessTextForPi` (`engines/pi/compat.ts`): retargets Claude-oriented prose to the
//! surfaces Pi reads, for the shared files Pi writes when no other engine owns them (`AGENTS.md`,
//! `.agents/skills/<id>/SKILL.md`) and for its parent-only orchestrator doctrine.
//!
//! Only term and path swaps live here; a sentence a swap cannot make true for Pi sits in a
//! `navori:if-not onPi` span of the source asset instead.

use std::sync::LazyLock;

use regex::{Captures, Regex};

static SKILL_DIR: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\.claude/skills/([a-z0-9-]+)/SKILL\.md").ok());
static SKILL_FLAT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\.claude/skills/([a-z0-9-]+)\.md").ok());
static AGENT_FILE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\.claude/agents/([a-z0-9-]+)\.md").ok());

fn replace(
    re: &LazyLock<Option<Regex>>,
    text: &str,
    with: impl Fn(&Captures<'_>) -> String,
) -> String {
    match re.as_ref() {
        Some(re) => re
            .replace_all(text, |caps: &Captures<'_>| with(caps))
            .into_owned(),
        None => text.to_owned(),
    }
}

/// `adaptHarnessTextForPi(content)`.
#[must_use]
pub fn adapt_harness_text_for_pi(content: &str) -> String {
    // Pi discovers project skills under `.agents/skills/`, in the directory form.
    let text = replace(&SKILL_DIR, content, |c| {
        format!(".agents/skills/{}/SKILL.md", &c[1])
    });
    let text = replace(&SKILL_FLAT, &text, |c| {
        format!(".agents/skills/{}/SKILL.md", &c[1])
    });
    // Role files live under `.pi/agents/`; the orchestrator has none. The TS excludes it with
    // `(?!orchestrator\.md)` right after `agents/`: since `[a-z0-9-]` has no `.`, that lookahead
    // fails exactly when the captured name is `orchestrator`, so that match is left as it was.
    let text = replace(&AGENT_FILE, &text, |c| {
        if &c[1] == "orchestrator" {
            c[0].to_owned()
        } else {
            format!(".pi/agents/{}.md", &c[1])
        }
    });
    text
        // A manual skill invocation in Pi is `/skill:<name>`.
        .replace("`/spec-bootstrap`", "`/skill:spec-bootstrap`")
        .replace("`/master-plan`", "`/skill:master-plan`")
        // Pi delegates through the `navori_subagent` tool, with `role` and `task`.
        .replace(
            "`Agent(subagent_type: orchestrator)`",
            "`navori_subagent(role: orchestrator)`",
        )
        .replace("`Agent`", "`navori_subagent`")
        // A bare mention of the harness directory points at Pi's own.
        .replace("`.claude/`", "`.pi/`")
        .replace("CLAUDE.md", "AGENTS.md")
}

#[cfg(test)]
mod tests {
    use super::adapt_harness_text_for_pi;

    #[test]
    fn swaps_paths_and_terms_like_the_ts() {
        assert_eq!(
            adapt_harness_text_for_pi(
                "see .claude/skills/plan-simple/SKILL.md and .claude/skills/x.md; \
                 .claude/agents/reviewer.md, .claude/agents/orchestrator.md; \
                 `Agent` `Agent(subagent_type: orchestrator)` `/master-plan` `.claude/` CLAUDE.md"
            ),
            "see .agents/skills/plan-simple/SKILL.md and .agents/skills/x/SKILL.md; \
             .pi/agents/reviewer.md, .claude/agents/orchestrator.md; \
             `navori_subagent` `navori_subagent(role: orchestrator)` `/skill:master-plan` `.pi/` AGENTS.md"
        );
    }

    #[test]
    fn an_orchestrator_prefix_is_not_the_orchestrator() {
        assert_eq!(
            adapt_harness_text_for_pi(".claude/agents/orchestrator-x.md"),
            ".pi/agents/orchestrator-x.md"
        );
    }
}
