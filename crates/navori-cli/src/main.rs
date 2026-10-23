//! `navori-rust` entry point. Only `--version` is native in M1; delegation lands in M2.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // citty answers `--version` only when it is the sole argument; mirror that.
    if args.len() == 1 && args[0] == "--version" {
        println!("{}", navori_core::VERSION);
        return ExitCode::SUCCESS;
    }
    eprintln!("navori-rust: command not available yet (delegation to the TS CLI lands in M2)");
    ExitCode::from(2)
}
