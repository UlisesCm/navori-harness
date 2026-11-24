#!/usr/bin/env bash
# Usage: s2-measure.sh <worktree> <outdir>. Measures cargo test, oracle and gate full under the shared heavy lock.
set -u
wt=$1; out=$2; mkdir -p "$out"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH="$HOME/.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin:$(echo "$PATH" | tr ':' '\n' | grep -v '\.cargo/bin' | paste -sd:)"
export CARGO_HOME="$HOME/.cargo" RUSTUP_TOOLCHAIN=1.99.1
cd "$wt" || exit 2
command -v navori-rust >/dev/null && { echo "navori-rust global in PATH" >"$out/ABORT"; exit 3; }
step() { local name=$1; shift; echo "== $name $(date +%T)" >>"$out/progress"; flock /tmp/navori-heavy.lock "$@" >"$out/$name.log" 2>&1; echo "$name exit=$? $(date +%T)" >>"$out/progress"; }
step install bun install --frozen-lockfile
step cargo cargo test --workspace --no-fail-fast
grep -E '^test .* FAILED$|^    [a-z_:]+$' "$out/cargo.log" | sed 's/^test //; s/ \.\.\. FAILED$//; s/^ *//' | sort -u >"$out/cargo-failed.txt"
step oracle bun run oracle:rust
step gate bun run check
echo DONE >>"$out/progress"
