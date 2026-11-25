//! #1509 / #1596: `search::segments` against the real sed + awk pipeline of
//! `guard-search-routing.sh`, on hand-written and fixed-seed generated commands.

use std::error::Error;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use navori_hooks::hooks::guard_destructive::search::segments;

type TestResult = Result<(), Box<dyn Error>>;

const SED: [&str; 8] = ["-e", ":a", "-e", "$!N", "-e", r"s/\\\n/ /", "-e", "ta"];

/// The awk program text between `| awk '` and the closing `')` of the real script.
fn awk_program() -> Result<String, Box<dyn Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/plugins/tgrep/scripts/guard-search-routing.sh");
    let text = std::fs::read_to_string(path)?;
    let start = text.find("| awk '\n").ok_or("awk start")? + "| awk '\n".len();
    let end = start + text[start..].find("\n  ')").ok_or("awk end")?;
    Ok(text[start..end].to_owned())
}

/// `printf '%s' cmd | sed ... | awk prog`, exactly as the script runs it.
fn shell_segments(program: &str, cmd: &str) -> Result<String, Box<dyn Error>> {
    let mut sed = Command::new("sed")
        .args(SED)
        .args(["-e", "P", "-e", "D"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut feed = sed.stdin.take().ok_or("sed stdin")?;
    let bytes = cmd.as_bytes().to_vec();
    let writer = std::thread::spawn(move || feed.write_all(&bytes));
    let awk = Command::new("awk")
        .arg(program)
        .stdin(sed.stdout.take().ok_or("sed stdout")?)
        .output()?;
    writer.join().map_err(|_| "writer panicked")??;
    sed.wait()?;
    Ok(String::from_utf8(awk.stdout)?)
}

fn assert_same(program: &str, cmd: &str) -> TestResult {
    let shell = shell_segments(program, cmd)?;
    // The caller trims the trailing newline of `$(...)`; the Rust side trims the same way.
    let want = shell.trim_end_matches('\n');
    let got = segments(cmd);
    assert_eq!(got, want, "segments differ for {cmd:?}");
    Ok(())
}

fn handwritten() -> Vec<&'static str> {
    vec![
        // #1509: a grep at the start of a new line is a command start.
        "echo x\ngrep -rn foo .",
        "echo x\n\ngrep -rn foo .\n",
        "grep -rn foo .\n",
        "grep -rn foo .\n\n",
        // A pipe, `&&`, `||` or `;` at the end of a line continues on the next.
        "echo x |\ngrep -rn foo .",
        "echo x &&\ngrep -rn foo .",
        "echo x ||\ngrep -rn foo .",
        "echo x ;\ngrep -rn foo .",
        "echo x |   \n   grep -rn foo .",
        "echo x |&\ngrep -rn foo .",
        "echo x |& grep foo",
        // Comments between lines.
        "echo x\n# note\ngrep -rn foo .",
        "echo x |\n# note\ngrep -rn foo .",
        "# first\ngrep -rn foo .",
        "  \t# first\ngrep -rn foo .",
        "echo x # trailing\ngrep -rn foo .",
        // Quotes crossing lines: the newline is data.
        "echo 'a\ngrep -rn foo .'\ngrep -rn bar .",
        "echo \"a\ngrep -rn foo .\"\ngrep -rn bar .",
        "echo 'a\n# not a comment\nb'",
        "echo \"a \\\" b\ngrep -rn x .\"\ngrep -rn y .",
        "echo \"a \\\\\" ; grep -rn x .",
        "echo 'a \\' ; grep -rn x .",
        // Continuations joined by sed.
        "echo x \\\ngrep -rn foo .",
        "echo x \\\n\ngrep -rn foo .",
        "echo x\\\n",
        "echo x\\\n\n",
        "echo x; grep -rn foo . | head\nrg foo\n",
        "",
        "\n",
        "\n\n",
        "#",
        "echo x\n#",
        "a;\n\n;b",
    ]
}

/// Xorshift with a fixed seed: the generated corpus is the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn generated(count: usize) -> Vec<String> {
    const TOKENS: [&str; 24] = [
        "grep -rn foo .",
        "echo",
        "x",
        " ",
        "  ",
        "\t",
        "\n",
        "\n",
        "\n",
        "|",
        "||",
        "&&",
        "&",
        ";",
        "|&",
        "'",
        "\"",
        "\\",
        "\\\n",
        "#",
        "# c",
        "rg y",
        "a b",
        "$",
    ];
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    (0..count)
        .map(|_| {
            let len = 1 + (rng.next() % 14) as usize;
            (0..len)
                .map(|_| TOKENS[(rng.next() % TOKENS.len() as u64) as usize])
                .collect::<String>()
        })
        .collect()
}

// Covers: #1509, #1596
#[test]
fn handwritten_cases_match_the_shell_pipeline() -> TestResult {
    let program = awk_program()?;
    for cmd in handwritten() {
        assert_same(&program, cmd)?;
    }
    Ok(())
}

#[test]
fn generated_cases_match_the_shell_pipeline() -> TestResult {
    let program = awk_program()?;
    for cmd in generated(1500) {
        assert_same(&program, &cmd)?;
    }
    Ok(())
}

#[test]
fn a_new_line_starts_a_command() {
    assert_eq!(
        segments("echo x\ngrep -rn foo ."),
        "echo x\n@C@grep -rn foo ."
    );
}
