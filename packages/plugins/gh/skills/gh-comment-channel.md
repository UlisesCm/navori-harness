---
name: gh-comment-channel
description: Use when publisher posts a PR/issue comment, a review or a GraphQL comment mutation through gh.
metadata:
  type: tool
  maxWords: 150
---

### GitHub comments and reviews (`gh`)

The body always comes from a file, never inline:

- `gh pr comment`, `gh issue comment` (incl. `--edit-last`), `gh pr review -c/-a/-r`: `--body-file <path>`.
- `gh api` on a `/comments` or `/reviews` endpoint: `--input <path>` or `-F body=@<path>`.
- `gh api graphql` mutations (`add*Comment`, `updateIssueComment`, `updateDiscussionComment`, `updatePullRequestReview`, `updatePullRequestReviewComment`): the `body` variable/field sourced from `@<path>`; the `query` string never carries the comment text.
