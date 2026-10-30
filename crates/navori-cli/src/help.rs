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
    // citty 0.2's `formatLineColumns`: each column gets a two-space prefix, columns are joined by
    // two spaces, names are right-aligned to the longest name and descriptions padded to the
    // longest one, with no trailing trim (measured against `dist/`; the oracle checks every byte).
    let name_width = ROOT_COMMANDS
        .iter()
        .map(|(n, _)| n.len())
        .max()
        .unwrap_or(0);
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
            "  {:pad$}{name}    {description:<description_width$}",
            ""
        );
    }
    out.push_str("\nUse navori <command> --help for more information about a command.\n\n");
    out
}

/// How citty reads one entry of a command's `args`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgKind {
    /// `type: "positional"`, required and without default.
    Positional,
    /// `type: "string"`, optional and without default.
    String,
    /// `type: "boolean"`, optional and without default.
    Boolean,
}

/// One entry of a citty `args` table, in declaration order.
#[derive(Debug, Clone, Copy)]
pub struct ArgDef {
    pub name: &'static str,
    pub kind: ArgKind,
    pub description: &'static str,
}

/// The parts of a citty command `renderUsage` reads.
#[derive(Debug, Clone, Copy)]
pub struct CommandDef {
    pub name: &'static str,
    pub description: &'static str,
    pub args: &'static [ArgDef],
    /// `(name, description)` of each subcommand, in registration order.
    pub sub_commands: &'static [(&'static str, &'static str)],
}

/// The `meta` of the parent command: its name and version.
#[derive(Debug, Clone, Copy)]
pub struct Parent<'a> {
    pub name: &'a str,
    pub version: Option<&'a str>,
}

/// citty's `noColor`, read once at module load in the TS.
#[must_use]
pub fn citty_no_color() -> bool {
    let truthy = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    std::env::var_os("NO_COLOR").is_some_and(|v| v == "1")
        || std::env::var_os("TERM").is_some_and(|v| v == "dumb")
        || truthy("TEST")
        || truthy("CI")
}

/// citty's ANSI helpers (`_c`), as no-ops without color.
#[derive(Debug, Clone, Copy)]
pub struct Paint {
    pub color: bool,
}

impl Paint {
    fn wrap(self, open: u8, close: u8, text: &str) -> String {
        if self.color {
            format!("\u{1b}[{open}m{text}\u{1b}[{close}m")
        } else {
            text.to_owned()
        }
    }

    #[must_use]
    pub fn cyan(self, text: &str) -> String {
        self.wrap(36, 39, text)
    }

    fn gray(self, text: &str) -> String {
        self.wrap(90, 39, text)
    }

    fn heading(self, text: &str) -> String {
        self.wrap(4, 24, &self.wrap(1, 22, text))
    }
}

/// citty's `formatLineColumns(lines, "  ")`: the first column right-aligned, the others padded
/// on the right, every cell prefixed, widths measured on the painted text.
fn format_columns(lines: &[[String; 2]]) -> String {
    let width = |column: usize| lines.iter().map(|l| l[column].len()).max().unwrap_or(0);
    let (first, second) = (width(0), width(1));
    lines
        .iter()
        .map(|[name, description]| format!("  {name:>first$}    {description:<second$}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `renderUsage(cmd, parent)` of citty 0.2, for commands whose args carry no alias, default or
/// value hint and are named in lowercase kebab-case (the case `snakeCase` maps by `-` → `_`).
#[must_use]
pub fn render_usage(cmd: &CommandDef, parent: Parent<'_>, paint: Paint) -> String {
    let command_name = format!("{} {}", parent.name, cmd.name);
    let mut positionals = Vec::new();
    let mut options = Vec::new();
    let mut usage_line = Vec::new();
    for arg in cmd.args {
        match arg.kind {
            ArgKind::Positional => {
                let name = arg.name.to_uppercase();
                let required = paint.gray("(Required)");
                positionals.push([
                    paint.cyan(&name),
                    [arg.description, required.as_str()]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" "),
                ]);
                usage_line.push(format!("<{name}>"));
            }
            ArgKind::String | ArgKind::Boolean => {
                let hint = if arg.kind == ArgKind::String {
                    format!("=<{}>", arg.name.replace('-', "_"))
                } else {
                    String::new()
                };
                options.push([
                    paint.cyan(&format!("--{}{hint}", arg.name)),
                    arg.description.to_owned(),
                ]);
            }
        }
    }
    if !cmd.sub_commands.is_empty() {
        let names: Vec<&str> = cmd.sub_commands.iter().map(|(name, _)| *name).collect();
        usage_line.push(names.join("|"));
    }
    let version = parent
        .version
        .map_or_else(String::new, |v| format!(" v{v}"));
    let has_options = !options.is_empty() || !positionals.is_empty();
    let mut lines = vec![
        paint.gray(&format!("{} ({command_name}{version})", cmd.description)),
        String::new(),
        format!(
            "{} {}",
            paint.heading("USAGE"),
            paint.cyan(&format!(
                "{command_name}{} {}",
                if has_options { " [OPTIONS]" } else { "" },
                usage_line.join(" ")
            ))
        ),
        String::new(),
    ];
    for (title, rows) in [("ARGUMENTS", &positionals), ("OPTIONS", &options)] {
        if !rows.is_empty() {
            lines.extend([
                paint.heading(title),
                String::new(),
                format_columns(rows),
                String::new(),
            ]);
        }
    }
    if !cmd.sub_commands.is_empty() {
        let rows: Vec<[String; 2]> = cmd
            .sub_commands
            .iter()
            .map(|(name, description)| [paint.cyan(name), (*description).to_owned()])
            .collect();
        lines.extend([
            paint.heading("COMMANDS"),
            String::new(),
            format_columns(&rows),
            String::new(),
            format!(
                "Use {} for more information about a command.",
                paint.cyan(&format!("{command_name} <command> --help"))
            ),
        ]);
    }
    lines.join("\n")
}
