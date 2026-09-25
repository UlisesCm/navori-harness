---
name: worktree-hygiene
description: "Use when session startup warns about conserved worktrees under `.claude/worktrees/`, or before deleting one by hand. Read-only diagnosis that classifies each worktree as safe / keep / ask and proposes the removal command — never deletes. Not for the automated sweep itself (see `worktree-reclaim.sh`), only for the ones it already refused to touch."
---

<!-- navori:managed id="worktree-hygiene-local-pointer" hash="51433e17" version="0.10.1" source="@navori/core" fmkeys="name,description" -->
Project-local skill, maintained in `.claude/skills/worktree-hygiene/SKILL.md` (relative to the directory that holds `.agents/`). Read that file before acting; its supporting files resolve relative to its directory. This entry only makes it discoverable here.
<!-- /navori:managed id="worktree-hygiene-local-pointer" -->
