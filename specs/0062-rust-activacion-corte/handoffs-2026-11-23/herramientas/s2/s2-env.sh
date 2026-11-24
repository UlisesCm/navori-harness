export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH="$HOME/.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin:$(echo "$PATH" | tr ':' '\n' | grep -v '\.cargo/bin' | paste -sd:)"
export CARGO_HOME="$HOME/.cargo" RUSTUP_TOOLCHAIN=1.99.1
