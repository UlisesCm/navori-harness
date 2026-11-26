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
4. Run the scoped gate before continuing:

   ```bash
   bun run check:render
   (cd packages/cli && bunx vitest run golden-render-tree)  # no --update
   bun typecheck
   bun run check:assets
   bun run check:doc-budgets
   bun run check:links
   ```

   Plus the tests of the packages touched by main's incoming diff. Do not
   use `test:golden` as a check: it runs `--update` and never fails.
   `qualityGate.full` still runs before the PR.

## Render-only conflicts

When EVERY conflicted path is render output (the generated mirror), resolve
by taking main's side (step 1), then `bun run render:apply` and the scoped
gate. No implementer→reviewer cycle. Any conflict in source (core-assets,
`packages/**`, specs, user sections of `AGENTS.md`/`CLAUDE.md`) follows the
normal cycle.

## Native hook headers (`navori:native-hook`)

A hook mirror wired to the native runtime (`.claude/hooks/*.sh`,
`.pi/navori/hooks/*.sh`) opens with a generated `navori:native-hook`
signature above its managed block, and `crates/ported.json` carries the
block's hash. When a merge or rebase brings a change to one of those hooks,
git usually conflicts on that generated header. The guard blocks shell
writes to `.pi/navori` (`git checkout --ours` and `git checkout --theirs`
included), so step 1
does not apply there.

1. **Check the condition first.** `-X` is allowed only when this lists
   generated files and nothing else (hook headers in `.claude/` and `.pi/`,
   `crates/ported.json`):

   ```bash
   git diff --name-only --diff-filter=U
   ```

   Any source or corpus file in the list: no `-X`. Resolve that conflict
   normally or report it.
2. Abort and redo the operation with `-X`, taking the side whose header you
   want git to keep: `git merge --abort` then `git merge -X theirs <ref>`
   (merging the base in), or `git rebase --abort` then
   `git cherry-pick -X ours <commit>` onto the base.
3. Regenerate and verify:

   ```bash
   bun run render:apply
   bun run rust:hooks-sync --no-install
   bun run rust:hooks-sync --check   # must exit 0
   bun run render:apply              # must report no change
   ```

   Then confirm `.claude/settings.json` still wraps every ported hook with
   `navori:native-runtime` (same count as the base).
4. **If the other side also changed the block body**, `-X` keeps a header
   hash that no longer matches the merged body. `render` then calls the
   block user-edited and refuses it, and `hooks-sync --check` fails. The
   two mirrors of that hook must go back to the base version (`git
   checkout <base> --` on both paths) so render can rewrite them. The
   guard blocks that on `.pi/navori`, so the user runs it outside the
   agent; then step 3 runs again.

Pending after 0.13: teach render to recognise a header with conflict
markers and replace it, so none of the above needs the user.

## One-time setup

```bash
git config rerere.enabled true
git config merge.navori-generated.driver true
```

The driver is declared in `.gitattributes` for `.codex/agents/*.toml`,
`.codex/hooks/**`, `.codex/scripts/**` and `.codex/rules/**`. It keeps the
current side; `render:apply` then overwrites it.

## Checklist

- [ ] One-time setup (`rerere`, `navori-generated` driver) is configured.
- [ ] No managed block was hand-edited to resolve a conflict.
- [ ] `bun run render:apply` ran from the repo root, after the rebase/merge.
- [ ] If it reported `updated` files, `golden-render-tree` ran without
      `--update` and its diff is understood.
- [ ] Scoped gate green (plus tests of packages in main's incoming diff);
      `qualityGate.full` before the PR.
- [ ] Native hook header conflicts: `--diff-filter=U` listed only
      generated files before using `-X`, and `rust:hooks-sync --check` is 0.
- [ ] Render-only conflicts skipped the implementer→reviewer cycle; source
      conflicts did not.

If any item fails, fix it and re-run the whole list.
