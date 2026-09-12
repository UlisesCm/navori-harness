## Content search (the tgrep wrapper)

Content search — a literal, a regex, a copy string — goes through one command: `bash .claude/scripts/tgrep-search.sh <search args…>`.

It carries an `allow` rule, so it runs with no permission prompt in any mode. That rule is narrow, and narrow Bash allow rules resolve BEFORE the classifier in auto mode — so it pays no round-trip either. What it does NOT buy you is an advantage over a shell `grep`, which is allow-listed on the same terms: the reason to come through here is that `guard-search-routing` blocks recursive shell search outright, so this is the route that runs at all. Its flag surface is ripgrep's. Never ask which engine the machine has: the wrapper resolves that and keeps the exit-code contract (0 = match, 1 = no match) whichever one it picks. A third code exists and means something else entirely: **exit 2 is "nothing was searched"** — never read it as "no match".

**Structure is a different question.** *Where is this symbol, who calls it, what breaks if I change it* is `codegraph_explore`; *which files hold this string* is the wrapper. And searching is not extracting — once you know the file, `grep -n "x" that-file` or `Read` is the cheaper call.

**Dot-directories are outside every default search**, here and in the native `Grep`: `.claude/`, `.github/` and friends need `--hidden`, so an empty result without it proves nothing.

The routing table, the portable flag set and why the index is rebuilt before every query: Rung 1 of the `structural-search` skill.
