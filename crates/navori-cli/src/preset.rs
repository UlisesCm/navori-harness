//! `navori preset init <id>`, native (spec 0060 M12, R73).
//!
//! Scaffolds `.navori/presets/<id>/` (manifest, managed block and example skill) and points the
//! repo's config at it, as `commands/preset.ts` does, with the clack output of [`crate::clack`].
//! A config Rust does not model (for the language or the rewrite) stays with the TS.

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use navori_core::config::write_config;
use navori_core::fs::{Fs, RealFs, write_file_atomic};
use navori_core::js_json::{JsObject, JsValue};
use navori_core::render::context::Lang;

use crate::backup::{PROTOTYPE_KEYS, parse_leaf};
use crate::clack::{Clack, Symbol, plain_output};
use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::{Output, read_config};
use crate::{NativeCall, Outcome};

const INIT: CommandDef = CommandDef {
    name: "init",
    description: "Scaffold a local preset under .navori/presets/<id>/ and wire it into config",
    args: &[
        ArgDef {
            name: "id",
            kind: ArgKind::Positional,
            description: "Preset id (kebab-case)",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root (default: current)",
        },
    ],
    sub_commands: &[],
};

const PRESET: CommandDef = CommandDef {
    name: "preset",
    description: "Manage local presets under .navori/presets/",
    args: &[],
    sub_commands: &[("init", INIT.description)],
};

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};

const PARENT: Parent<'static> = Parent {
    name: "preset",
    version: None,
};

const PRESET_SCHEMA_URL: &str =
    "https://ulisescm.github.io/navori-harness/schema/navori.preset.v1.json";

/// `preset` alone.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, false))
}

/// `preset init`.
#[must_use]
pub fn run_init(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, true))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], init_row: bool) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "preset" || rest.contains(&"--") {
        return None;
    }
    let is_help = |a: &&str| *a == "--help" || *a == "-h";
    let help = rest.iter().any(is_help);
    let at = rest.iter().position(|a| !a.starts_with('-'));
    if rest[..at.unwrap_or(rest.len())].iter().any(|a| !is_help(a)) {
        return None;
    }
    let Some(at) = at else {
        if init_row {
            return None;
        }
        let error = (!help).then(|| "No command specified.".to_owned());
        return Some(Output::usage(&PRESET, ROOT, error).emit());
    };
    match rest[at] {
        "init" if init_row => {}
        "init" => return None,
        name if init_row || PROTOTYPE_KEYS.contains(&name) => return None,
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&PRESET, ROOT, error).emit());
        }
    }
    if help {
        return Some(Output::usage(&INIT, PARENT, None).emit());
    }
    let options = parse_leaf(&rest[at + 1..], &["cwd"], &[])?;
    let Some(id) = options.positional else {
        let error = "Missing required positional argument: ID".to_owned();
        return Some(Output::usage(&INIT, PARENT, Some(error)).emit());
    };
    if !plain_output() {
        return None;
    }
    let process_cwd = std::env::current_dir().ok()?;
    let cwd = navori_core::posix::resolve(process_cwd.to_str()?, options.get("cwd").unwrap_or(""));
    Some(init(id, &cwd)?.emit())
}

fn is_preset_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn stack_template(lang: Lang, id: &str) -> String {
    let lines: &[&str] = match lang {
        Lang::Es => &[
            "",
            "> Plantilla generada por `navori preset init`. Edítala: describe el stack,",
            "> las capas por las que fluye una petición/feature, y las reglas de oro que",
            "> el código nuevo debe seguir. Este bloque se inyecta en CLAUDE.md.",
            "",
            "### Qué es",
            "",
            "Describe en 1-2 líneas qué hace este proyecto y sobre qué stack corre.",
            "",
            "### Reglas",
            "",
            "- Regla de oro 1 (p.ej. validación siempre en el boundary).",
            "- Regla de oro 2 (p.ej. nada de `console.log`; usa el logger).",
            "",
            "Aplica las skills de este preset según la capa que toques.",
            "",
        ],
        Lang::En => &[
            "",
            "> Template generated by `navori preset init`. Edit it: describe the stack,",
            "> the layers a request/feature flows through, and the golden rules new code",
            "> must follow. This block is injected into CLAUDE.md.",
            "",
            "### What it is",
            "",
            "Describe in 1-2 lines what this project does and what stack it runs on.",
            "",
            "### Rules",
            "",
            "- Golden rule 1 (e.g. always validate at the boundary).",
            "- Golden rule 2 (e.g. no `console.log`; use the logger).",
            "",
            "Apply this preset's skills according to the layer you touch.",
            "",
        ],
    };
    format!("## Stack — {id}\n{}", lines.join("\n"))
}

fn skill_template(lang: Lang, skill: &str) -> String {
    let (description, when, trigger, pattern, body) = match lang {
        Lang::Es => (
            "Skill de ejemplo del preset. Reemplaza esta descripción por cuándo aplicarla (el frontmatter es lo que los agentes leen para descubrirla).",
            "## Cuándo usar este skill",
            "Describe el disparador concreto (qué archivos/capa, qué tarea).",
            "## Patrón",
            "Documenta el patrón con un ejemplo mínimo. Borra este skill o renómbralo\ncuando agregues los reales en `skills/` y los declares en el manifest.",
        ),
        Lang::En => (
            "Example preset skill. Replace this description with when to apply it (the frontmatter is what agents read to discover it).",
            "## When to use this skill",
            "Describe the concrete trigger (which files/layer, which task).",
            "## Pattern",
            "Document the pattern with a minimal example. Delete this skill or rename it\nwhen you add the real ones under `skills/` and declare them in the manifest.",
        ),
    };
    format!(
        "---\nname: {skill}\ndescription: {description}\ntype: reference\n---\n\n# {skill}\n\n{when}\n\n{trigger}\n\n{pattern}\n\n{body}\n"
    )
}

fn manifest(id: &str, skill: &str) -> Option<String> {
    let entry = |pairs: &[(&str, String)]| {
        let mut o = JsObject::new();
        for (key, value) in pairs {
            o.insert(*key, JsValue::string(value));
        }
        JsValue::Object(o)
    };
    let mut extras = JsObject::new();
    extras.insert(
        "managed",
        JsValue::Array(vec![entry(&[
            ("id", format!("stack-{id}")),
            ("relPath", "managed/stack.md".to_owned()),
        ])]),
    );
    extras.insert("agents", JsValue::Array(Vec::new()));
    extras.insert(
        "skills",
        JsValue::Array(vec![entry(&[
            ("id", skill.to_owned()),
            ("relPath", format!("skills/{skill}.md")),
            ("destRelPath", format!(".claude/skills/{skill}/SKILL.md")),
        ])]),
    );
    extras.insert("hooks", JsValue::Array(Vec::new()));
    let mut doc = JsObject::new();
    doc.insert("$schema", JsValue::string(PRESET_SCHEMA_URL));
    doc.insert("id", JsValue::string(id));
    doc.insert("displayName", JsValue::string(id));
    doc.insert("extends", JsValue::string("core"));
    doc.insert("extras", JsValue::Object(extras));
    doc.insert("invariants", JsValue::Array(Vec::new()));
    Some(format!("{}\n", JsValue::Object(doc).stringify(Some(2))?))
}

fn init(id: &str, cwd: &str) -> Option<Output> {
    let config_path = format!("{cwd}/navori.config.json");
    // `repoLang`: a config `readConfig` rejects reads as Spanish, but one Rust does not model is
    // the TS's.
    let first = read_config(cwd)?;
    let lang = first.as_ref().map_or(Lang::resolve(None), |c| c.lang());
    let es = lang == Lang::Es;
    let mut clack = Clack::default();
    if let Some(config) = &first {
        for warning in &config.warnings {
            clack.out.stderr.push_str(&format!("{warning}\n"));
        }
    }
    clack.intro(&format!("navori preset init {id}"));
    if id == "custom" {
        clack.cancel(if es {
            "'custom' es un id reservado (es el baseline sin extras). Elige otro nombre."
        } else {
            "'custom' is a reserved id (it's the baseline with no extras). Pick another name."
        });
        return Some(clack.out);
    }
    if !is_preset_id(id) {
        clack.cancel(&if es {
            format!("Id inválido '{id}': usa kebab-case — minúsculas, números y guiones, empezando con alfanumérico.")
        } else {
            format!("Invalid id '{id}': use kebab-case — lowercase, digits and hyphens, starting alphanumeric.")
        });
        return Some(clack.out);
    }
    let preset_dir = format!("{cwd}/.navori/presets/{id}");
    if Path::new(&preset_dir).exists() {
        clack.cancel(&if es {
            format!("Ya existe .navori/presets/{id}/ — bórralo o usa otro id si quieres regenerarlo.")
        } else {
            format!(".navori/presets/{id}/ already exists — delete it or use another id to regenerate it.")
        });
        return Some(clack.out);
    }
    let skill = format!("{id}-example");
    let manifest = manifest(id, &skill)?;
    // The config rewrite is planned before the first write: the TS reads it again here.
    let rewrite = match &first {
        Some(config) => {
            let JsValue::Object(mut data) = config.data.clone() else {
                return None;
            };
            data.insert("preset", JsValue::string(id));
            Some(write_config(&data).ok()?)
        }
        None => None,
    };
    let mut fs = RealFs::default();
    let dir = Path::new(&preset_dir);
    let written = fs
        .mkdir_all(&dir.join("managed"))
        .and_then(|()| fs.mkdir_all(&dir.join("skills")))
        .is_ok()
        && write_file_atomic(&mut fs, &dir.join(format!("{id}.json")), &manifest).is_ok()
        && write_file_atomic(
            &mut fs,
            &dir.join("managed/stack.md"),
            &stack_template(lang, id),
        )
        .is_ok()
        && write_file_atomic(
            &mut fs,
            &dir.join(format!("skills/{skill}.md")),
            &skill_template(lang, &skill),
        )
        .is_ok();
    if !written {
        clack
            .out
            .stderr
            .push_str("navori-rust: cannot scaffold the preset\n");
        clack.out.code = 1;
        return Some(clack.out);
    }
    clack.log(
        Symbol::Success,
        &if es {
            format!("Creado .navori/presets/{id}/")
        } else {
            format!("Created .navori/presets/{id}/")
        },
    );
    clack.log(
        Symbol::Bar,
        &format!("  · {id}.json\n  · managed/stack.md\n  · skills/{skill}.md"),
    );
    match (rewrite, &first) {
        (Some(text), Some(config)) => {
            for warning in &config.warnings {
                clack.out.stderr.push_str(&format!("{warning}\n"));
            }
            if write_file_atomic(&mut fs, Path::new(&config_path), &text).is_err() {
                clack
                    .out
                    .stderr
                    .push_str("navori-rust: cannot write navori.config.json\n");
                clack.out.code = 1;
                return Some(clack.out);
            }
            clack.log(
                Symbol::Success,
                &format!("navori.config.json → preset: {id}"),
            );
            clack.outro(if es {
                "Listo. Edita la plantilla y corre navori render --apply para materializarla."
            } else {
                "Done. Edit the template and run navori render --apply to materialize it."
            });
        }
        _ => {
            clack.log(
                Symbol::Warn,
                &if es {
                    format!("No hay navori.config.json en {cwd}. Corre navori init y elige el preset '{id}' para activarlo.")
                } else {
                    format!("No navori.config.json at {cwd}. Run navori init and pick preset '{id}' to activate it.")
                },
            );
            clack.outro(if es {
                "Preset local scaffoldeado. Inicializa navori para activarlo."
            } else {
                "Local preset scaffolded. Initialize navori to activate it."
            });
        }
    }
    Some(clack.out)
}
