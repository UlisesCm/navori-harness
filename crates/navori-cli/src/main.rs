//! `navori-rust` entry point: native commands listed in `crates/ported.json`, everything else
//! delegated to the TS CLI.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    navori_cli::run(&args)
}
