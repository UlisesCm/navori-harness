---
name: rebase-rerender
description: Use when this repo's harness needs re-rendering after a rebase or merge of `main`, or a git conflict lands inside a navori managed block (a `<!-- navori:managed ... -->` marker in `.claude/`, `CLAUDE.md`, `AGENTS.md`, etc). Runs the render-and-verify sequence in order. Not for ordinary code conflicts outside a managed block.
metadata:
  type: reference
---

# Re-render after rebasing `main`

This repo self-hosts its own harness: `.claude/` and `CLAUDE.md` are
generated output, so moving the base (rebase, merge, or a resolved conflict)
can leave the checked-in mirror stale. Full rationale, triggers, and the
`hash` mechanics behind step 2 live in `CONTRIBUTING.md`'s "Dos reglas que
solo se descubren cuando ya te mordieron (#435)" section and the golden step
right after it — this skill is only the sequence, not a copy of the why.

## Sequence

1. **Conflict inside a managed block → never hand-edit it.** Take `main`'s
   version of the conflicted block and let step 2 regenerate the rest. Which
   side is `main`'s depends on the operation, and the two are opposite:
   - Rebasing your branch onto `main` replays your commits on top of it, so
     `main` is the upstream side: `git checkout --ours <path>`.
   - Merging `main` into your branch brings it in as the incoming side:
     `git checkout --theirs <path>`.

   Editing the block by hand instead changes its content without updating
   its `hash` marker, which flags the block as user-modified — `render
   --apply` then skips it forever, and only `navori sync` can undo that
   drift.
2. Re-render the mirror from the repo root:

   ```bash
   bun run render:apply
   ```

   That alias builds the CLI first and only then applies the render (see
   `render:apply` in the root `package.json`) — the build half is required,
   not optional: without it, render compares against the last build's
   assets, not your working tree, and can report `unchanged` when it should
   report drift.
3. **If step 2 reported any file as `updated`**, the golden snapshot of the
   rendered tree moved too. Regenerate it and read the diff before trusting
   it:

   ```bash
   cd packages/cli && bun run test:golden
   ```

   (`vitest run golden-render-tree --update`, ~1s; five fixtures under
   `packages/cli/src/engines/__tests__/__golden__/<engine>.snap`.) A change
   in that diff you can't explain from your rebase is a finding to
   investigate, not noise to accept with `-u` and move on.
4. Run the quality gate (`qualityGate.full` per `CLAUDE.md`, or the scoped
   subset relevant to your change) before continuing your task.

## Checklist

- [ ] No managed block was hand-edited to resolve a conflict.
- [ ] `bun run render:apply` ran from the repo root, after the rebase/merge.
- [ ] If it reported `updated` files, `test:golden` ran and its diff is
      understood.
- [ ] Quality gate green before resuming other work.

If any item fails, fix it and re-run the whole list.
