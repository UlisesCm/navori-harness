//! citty-format help renderer, driven by the declarative command table (D2).

use std::fmt::Write as _;

use crate::commands::ROOT_COMMANDS;

/// Tagline of the root command (`meta.description`).
const ROOT_DESCRIPTION: &str = "Multi-agent harness + SDD scaffolder";

/// Renders `navori --help` byte for byte as citty does, with `version` as `meta.version`.
#[must_use]
pub fn root_help(version: &str) -> String {
    let names: Vec<&str> = ROOT_COMMANDS.iter().map(|(name, _)| *name).collect();
    let mut out = format!(
        "{ROOT_DESCRIPTION} (navori v{version})\n\nUSAGE navori {}\n\nCOMMANDS\n\n",
        names.join("|")
    );
    // citty's `formatLineColumns`: names right-aligned to the longest name plus the two backticks
    // it adds (the renderer then drops them), descriptions padded to the longest one plus the two
    // trailing spaces TS emits (measured against `dist/`; the oracle checks every byte).
    let name_width = ROOT_COMMANDS
        .iter()
        .map(|(n, _)| n.len())
        .max()
        .unwrap_or(0)
        + 2;
    let description_width = ROOT_COMMANDS
        .iter()
        .map(|(_, d)| d.len())
        .max()
        .unwrap_or(0);
    for (name, description) in ROOT_COMMANDS {
        let pad = name_width - name.len();
        // Writing to a String cannot fail.
        let _ = writeln!(
            out,
            "{:pad$}{name}    {description:<description_width$}  ",
            ""
        );
    }
    // citty trims the whole command block, so the last row loses its trailing padding.
    out.truncate(out.trim_end().len());
    out.push_str("\n\nUse navori <command> --help for more information about a command.\n\n");
    out
}
