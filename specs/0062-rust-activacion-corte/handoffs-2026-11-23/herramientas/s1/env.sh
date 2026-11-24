# S1 environment: cargo toolchain, UTF-8 locale, no global navori-rust, a chosen jq first in PATH.
# usage: . env.sh [jq-version]
export LANG=C.UTF-8
S1=$HOME/.cache/navori-rust/s1
_p=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/navori-rust' | paste -sd:)
export PATH="$HOME/.cargo/bin:$_p"
if [ -n "${1:-}" ]; then export PATH="$S1/jq/$1:$PATH"; fi
