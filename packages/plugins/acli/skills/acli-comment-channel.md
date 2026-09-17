---
name: acli-comment-channel
description: Use when publisher drafts or updates a Jira comment through acli.
metadata:
  type: tool
  maxWords: 150
---

### Jira comments (`acli`)

Comment or update a ticket only through `acli jira workitem comment create` / `comment update`, body from file:

- Plain text: `--body-file <path>`.
- Any `@mention`: `--body-adf <path>` — a plain-text `@mention` never notifies, ADF is the only format that does.

Never write to Jira through the Atlassian/Rovo MCP: it authenticates as a different account, and it exposes no comment deletion, so a mistaken write there cannot be undone.
