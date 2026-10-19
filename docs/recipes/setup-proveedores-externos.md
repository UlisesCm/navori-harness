> [English](setup-proveedores-externos.md) | [Español](setup-proveedores-externos.es.md) | [简体中文](setup-proveedores-externos.zh-CN.md)

# Recipe — setting up codegraph and tgrep after installation

What to do after `navori add codegraph` / `navori add tgrep` (or after `navori init --full` enables tgrep; codegraph requires explicit opt-in) so the MCP server and index actually respond. Distilled from `docs/research/search-v2.md` §6.1, excluding the internal dogfood protocol (branch, base SHA, Git hooks) also covered by that document.

## When this applies

Codegraph is available by opt-in and is no longer included in the defaults for new `navori init --full` installations, following the T31 evaluation. Existing configurations that enable it are unchanged. To disable it in your own configuration, set `enabled: false` and run `navori sync`; do not remove the key, because a missing key does not mean that a plugin is disabled.

These steps apply only to the two plugins that provide their own binary and index: `codegraph` (MCP server, `packages/plugins/codegraph`) and `tgrep` (CLI and server, `packages/plugins/tgrep`). The other plugins (`engram`, `gh`, `acli`) do not need these steps; `navori add <plugin>` already leaves their binary ready to use.

## Steps

1. Confirm the binary is available: `codegraph --version` / `tgrep --version`. If `navori add` did not install it (you declined, or your platform has no automatic installation command), install it using the command shown by `navori doctor`.
2. Initialize the codegraph index at the project root:



```
   codegraph init .


```

   If an index already exists, `init` fails. Rebuild it with `codegraph index --force`; do not run `init` again.
3. Start tgrep from the same root. First check whether a server is already running:



```
   tgrep status .


```

   If there is no server, start one in a dedicated terminal:



```
   tgrep serve .


```

   The server runs while that terminal remains open. navori does not stop external processes, so closing the terminal is how you stop it. If you cannot keep a terminal open, use `tgrep index .` (disk mode, without a server: searches still work, but the index does not update itself).
4. Open (or restart) Claude Code from that same root and approve the codegraph MCP server when the host asks. Approval is interactive by design; navori never pre-authorizes an MCP server declared in the repository itself.
5. Verify that both respond: make a real `codegraph_explore` call from an agent and run a search with `tgrep search -n -- "algo" .`. From this point on, `navori doctor` warns you if either index becomes stale.

## Notes

- `codegraph init` creates `.codegraph/` with its own `.gitignore`; you do not need to ignore it manually. `tgrep index`/`serve` do not write an ignore file. If your mode (`local`/`full`) does not cover `.tgrep/`, add it yourself.
- Disabling the plugin (`navori remove codegraph` / `navori remove tgrep`) does not delete the index already generated on disk.
