//! `navori.config.json` as `readConfig` sees it (spec 0058 D22, R32/R33).
//!
//! The TS validates with zod (`lib/config/schema.ts`) and returns the parsed object: defaults
//! filled in, unknown keys stripped from strict-by-default objects and kept in `.passthrough()`
//! ones, shape keys first and extension keys after. This module reproduces that output as a
//! [`JsValue`] plus the advisory warnings `readConfig` writes to stderr.
//!
//! Anything Rust would not reproduce exactly is reported as [`Delegate`] (Q4 of spec 0058): the
//! native command hands the invocation to the TS before any output, so an invalid config prints
//! exactly what the TS prints. Rejecting more than zod is therefore safe; accepting a config zod
//! rejects, or producing a different object, is a parity bug the property tests catch.

use crate::i18n;
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsObject, JsString, JsValue};
use crate::render::context::Lang;

/// Why the native command must hand the invocation to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delegate {
    /// Not UTF-8: Node would decode it with replacement characters.
    NotUtf8,
    /// `JSON.parse` would throw, or the text is outside what [`js_json::parse`] models.
    Json,
    /// `checkRetiredConfigKeys` would throw.
    RetiredKeys,
    /// `NavoriConfigSchema.safeParse` would fail.
    Schema,
}

/// A config `readConfig` accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// `result.data`.
    pub data: JsValue,
    /// Lines `readConfig` writes to stderr, without the trailing newline, in order.
    pub warnings: Vec<String>,
}

impl Config {
    /// `config.language` resolved to a shipped locale.
    #[must_use]
    pub fn lang(&self) -> Lang {
        Lang::resolve(string_at(&self.data, "language").as_deref())
    }

    /// `config.harnessVersion`, the anti-rollback floor.
    #[must_use]
    pub fn harness_version(&self) -> Option<String> {
        string_at(&self.data, "harnessVersion")
    }
}

fn string_at(value: &JsValue, key: &str) -> Option<String> {
    match value {
        JsValue::Object(object) => match object.get(key) {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

/// `readConfig` over the bytes of `navori.config.json`.
///
/// # Errors
/// Returns why the TS must handle this config instead.
pub fn read(bytes: &[u8]) -> Result<Config, Delegate> {
    let text = std::str::from_utf8(bytes).map_err(|_| Delegate::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw = js_json::parse(text).ok_or(Delegate::Json)?;
    if has_retired_keys(&raw) {
        return Err(Delegate::RetiredKeys);
    }
    let data = schema::navori_config(&raw).map_err(|_| Delegate::Schema)?;
    let warnings = warnings(&raw, &data);
    Ok(Config { data, warnings })
}

/// `{ ...value }`: own enumerable properties in JS order (`null`/`undefined` spread nothing).
fn spread(value: Option<&JsValue>) -> JsObject {
    let mut out = JsObject::new();
    match value {
        Some(JsValue::Object(object)) => {
            for (key, value) in object.ordered() {
                out.insert(key.clone(), value.clone());
            }
        }
        Some(JsValue::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                out.insert(index.to_string(), item.clone());
            }
        }
        Some(JsValue::String(text)) => {
            for (index, unit) in text.units().iter().enumerate() {
                out.insert(
                    index.to_string(),
                    JsValue::String(JsString::from_units(vec![*unit])),
                );
            }
        }
        _ => {}
    }
    out
}

/// `obj?.[key]` for a JSON value: only objects have own data properties here.
fn member<'a>(value: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    match value {
        Some(JsValue::Object(object)) => object.get(key),
        _ => None,
    }
}

/// `a ?? fallback`.
fn or_default(value: Option<&JsValue>, fallback: JsValue) -> JsValue {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => fallback,
        Some(value) => value.clone(),
    }
}

/// `effectiveConfig` (`config.ts`): the render-only derived defaults (`prTarget`,
/// `project.typedLanguage`, `sdd.*`). Never persisted. Like the TS, an absent `prTarget` and
/// `branchBase` leave an own `prTarget: undefined`, which `JSON.stringify` omits.
#[must_use]
pub fn effective_config(config: &JsValue) -> JsValue {
    let root = Some(config);
    let project = member(root, "project");
    let sdd = member(root, "sdd");
    let typed = !matches!(
        member(project, "codeLanguage"),
        Some(JsValue::String(text)) if text.is("python") || text.is("rust") || text.is("go")
    );

    let mut out = spread(root);
    let pr_target = or_default(
        member(root, "prTarget"),
        member(root, "branchBase")
            .cloned()
            .unwrap_or(JsValue::Undefined),
    );
    out.insert("prTarget", pr_target);

    let mut derived_project = spread(project);
    derived_project.insert("typedLanguage", JsValue::Bool(typed));
    out.insert("project", JsValue::Object(derived_project));

    let mut derived_sdd = spread(sdd);
    derived_sdd.insert(
        "enabled",
        or_default(member(sdd, "enabled"), JsValue::Bool(true)),
    );
    derived_sdd.insert(
        "specsDir",
        or_default(member(sdd, "specsDir"), JsValue::string("specs")),
    );
    derived_sdd.insert(
        "applyWhen",
        or_default(member(sdd, "applyWhen"), JsValue::Array(Vec::new())),
    );
    derived_sdd.insert(
        "doesNotApplyTo",
        or_default(member(sdd, "doesNotApplyTo"), JsValue::Array(Vec::new())),
    );
    out.insert("sdd", JsValue::Object(derived_sdd));
    JsValue::Object(out)
}

/// `isSafeGateChain` (`engines/shared/permission-rules.ts:200`): every step is `<pm> …` or `cd <dir>`.
#[must_use]
pub fn is_safe_gate_chain(gate: &str) -> bool {
    schema::is_safe_gate_chain(gate)
}

/// `RETIRED_CONFIG_KEYS`: `(key, sections)`, where `None` means harness, models and effort.
const RETIRED: &[(&str, Option<&str>)] = &[
    ("leader", None),
    ("researcher", None),
    ("explorer", None),
    ("ticketAudit", None),
    ("commitPrPilot", None),
    ("architect", Some("harness")),
];

/// `checkRetiredConfigKeys` throws for any of these; the message is the TS's to print.
fn has_retired_keys(raw: &JsValue) -> bool {
    let JsValue::Object(root) = raw else {
        return false;
    };
    ["harness", "models", "effort"].iter().any(|section| {
        let Some(JsValue::Object(values)) = root.get(section) else {
            return false;
        };
        RETIRED
            .iter()
            .any(|(key, only)| only.is_none_or(|only| only == *section) && values.has(key))
    })
}

// --- warnings ---------------------------------------------------------------------------------

/// The four advisory writes of `readConfig`, in its order.
fn warnings(raw: &JsValue, data: &JsValue) -> Vec<String> {
    let lang = Lang::resolve(string_at(data, "language").as_deref());
    let mut out = Vec::new();
    let unknown = unknown_keys::find(raw);
    if !unknown.is_empty() {
        let listed: Vec<String> = unknown
            .iter()
            .map(|(path, suggestion)| match suggestion {
                None => path.clone(),
                Some(suggestion) => {
                    let suggested = match path.rfind('.') {
                        None => suggestion.clone(),
                        Some(dot) => format!("{}{suggestion}", &path[..=dot]),
                    };
                    format!("{path} → {suggested}")
                }
            })
            .collect();
        out.push(i18n::unknown_config_keys(lang, &listed.join(", ")));
    }
    let dropped = dropped_enums(raw, data);
    if !dropped.is_empty() {
        out.push(i18n::unknown_config_values(lang, &dropped.join(", ")));
    }
    let JsValue::Object(root) = raw else {
        return out;
    };
    if let Some(JsValue::Object(progress)) = root.get("progress") {
        let removed: Vec<&str> = ["checkpointsDir", "archiveAfterDays"]
            .into_iter()
            .filter(|key| progress.has(key))
            .collect();
        if !removed.is_empty() {
            out.push(i18n::dead_progress_keys(lang, &removed.join(", ")));
        }
    }
    let mut deprecated = Vec::new();
    if let Some(JsValue::Object(project)) = root.get("project")
        && project.has("testRunner")
    {
        deprecated.push("project.testRunner".to_owned());
    }
    if let Some(JsValue::Object(progress)) = root.get("progress") {
        for key in ["dir", "currentFile", "historyFile"] {
            if progress.has(key) {
                deprecated.push(format!("progress.{key}"));
            }
        }
    }
    if !deprecated.is_empty() {
        out.push(i18n::deprecated_config_keys(lang, &deprecated.join(", ")));
    }
    out
}

/// `warnDroppedEnums`: raw enum strings the tolerant schema replaced or removed.
fn dropped_enums(raw: &JsValue, data: &JsValue) -> Vec<String> {
    let (JsValue::Object(raw), JsValue::Object(data)) = (raw, data) else {
        return Vec::new();
    };
    let mut dropped = Vec::new();
    if let (Some(JsValue::Array(engines)), Some(JsValue::Array(kept))) =
        (raw.get("engines"), data.get("engines"))
    {
        for engine in engines {
            if let JsValue::String(name) = engine
                && !kept.contains(engine)
            {
                dropped.push(format!("engines: \"{}\"", lossy(name)));
            }
        }
    }
    for key in ["commits", "language"] {
        if let Some(JsValue::String(value)) = raw.get(key)
            && data.get(key) != raw.get(key)
        {
            dropped.push(format!("{key}: \"{}\"", lossy(value)));
        }
    }
    dropped
}

fn lossy(text: &JsString) -> String {
    String::from_utf16_lossy(text.units())
}

/// JS `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Advisory typo diagnostics (`findUnknownConfigKeys`, `CONFIG_KEY_RULE`).
mod unknown_keys {
    use super::{JsObject, JsValue, lossy};

    /// One object level of `CONFIG_KEY_RULE`.
    struct Rule {
        keys: &'static [&'static str],
        children: &'static [(&'static str, &'static Rule)],
        record_values: Option<&'static Rule>,
        array_items: Option<&'static Rule>,
        allow_extensions: bool,
    }

    const fn rule(keys: &'static [&'static str]) -> Rule {
        Rule {
            keys,
            children: &[],
            record_values: None,
            array_items: None,
            allow_extensions: false,
        }
    }

    const QUALITY_GATE: Rule = rule(&["fast", "full", "scoped", "nativeHooks"]);
    const MIGRATION: Rule = rule(&["legacy", "preferred", "domain"]);
    const MIGRATIONS: Rule = Rule {
        array_items: Some(&MIGRATION),
        ..rule(&[])
    };
    const ROLES: &[&str] = &[
        "orchestrator",
        "implementer",
        "reviewer",
        "scout",
        "auditor",
        "publisher",
        "scribe",
        "architect",
    ];
    const WORKSPACE: Rule = Rule {
        children: &[
            ("qualityGate", &QUALITY_GATE),
            ("libraryMigrations", &MIGRATIONS),
        ],
        ..rule(&[
            "name",
            "path",
            "preset",
            "qualityGate",
            "libraries",
            "extraLibraries",
            "libraryMigrations",
        ])
    };
    const WORKSPACES: Rule = Rule {
        array_items: Some(&WORKSPACE),
        ..rule(&[])
    };
    const DELIVERIES: Rule = rule(&["splitMinTasks", "splitMinLoc", "maxPrsPerSpec"]);
    const CODEX_MAP: Rule = rule(&["opus", "sonnet", "haiku"]);
    const PLUGIN: Rule = rule(&["enabled", "nativeHook"]);
    const ROOT: Rule = Rule {
        children: &[
            ("qualityGate", &QUALITY_GATE),
            ("hooks", &rule(&["verifyOnStop"])),
            ("audit", &rule(&["mode"])),
            (
                "sdd",
                &Rule {
                    children: &[("deliveries", &DELIVERIES)],
                    ..rule(&[
                        "enabled",
                        "specsDir",
                        "applyWhen",
                        "doesNotApplyTo",
                        "deliveries",
                    ])
                },
            ),
            (
                "harness",
                &rule(&[
                    "orchestrator",
                    "implementer",
                    "reviewer",
                    "scout",
                    "auditor",
                    "publisher",
                    "scribe",
                    "scribeOwnsMarkdown",
                    "planTiers",
                    "codexIntegration",
                    "masterPlan",
                    "compactAdviceTokens",
                ]),
            ),
            (
                "models",
                &Rule {
                    children: &[("codexMap", &CODEX_MAP), ("piMap", &CODEX_MAP)],
                    ..rule(&[
                        "orchestrator",
                        "implementer",
                        "reviewer",
                        "scout",
                        "auditor",
                        "publisher",
                        "scribe",
                        "architect",
                        "codexMap",
                        "piMap",
                    ])
                },
            ),
            ("effort", &rule(ROLES)),
            (
                "plugins",
                &Rule {
                    record_values: Some(&PLUGIN),
                    allow_extensions: true,
                    ..rule(&[])
                },
            ),
            ("blocks", &rule(&["exclude"])),
            ("progress", &rule(&["dir", "currentFile", "historyFile"])),
            (
                "project",
                &Rule {
                    allow_extensions: true,
                    children: &[
                        ("foreignHarness", &rule(&["acknowledged"])),
                        ("libraryMigrations", &MIGRATIONS),
                    ],
                    ..rule(&[
                        "legacyPaths",
                        "criticalAreas",
                        "testRunner",
                        "posture",
                        "reviewRigor",
                        "architectureRule",
                        "testsForNewCode",
                        "testsExclude",
                        "localSkills",
                        "foreignHarness",
                        "libraries",
                        "extraLibraries",
                        "libraryMigrations",
                        "codeLanguage",
                    ])
                },
            ),
            (
                "monorepo",
                &Rule {
                    children: &[("workspaces", &WORKSPACES)],
                    ..rule(&["enabled", "tool", "workspaces", "workspaceHarness"])
                },
            ),
        ],
        ..rule(&[
            "$schema",
            "name",
            "version",
            "harnessVersion",
            "workspace",
            "engines",
            "preset",
            "language",
            "branchBase",
            "gitignoreHarness",
            "prTarget",
            "commits",
            "qualityGate",
            "hooks",
            "audit",
            "packageManager",
            "sdd",
            "harness",
            "models",
            "effort",
            "plugins",
            "blocks",
            "progress",
            "project",
            "monorepo",
        ])
    };

    /// `(path, suggestion)` of every unknown key, in the TS order.
    pub(super) fn find(raw: &JsValue) -> Vec<(String, Option<String>)> {
        let mut unknown = Vec::new();
        visit(raw, &ROOT, "", &mut unknown);
        unknown
    }

    fn join(path: &str, key: &str) -> String {
        if path.is_empty() {
            key.to_owned()
        } else {
            format!("{path}.{key}")
        }
    }

    fn visit(value: &JsValue, rule: &Rule, path: &str, out: &mut Vec<(String, Option<String>)>) {
        match value {
            JsValue::Array(items) => {
                if let Some(item_rule) = rule.array_items {
                    for (index, item) in items.iter().enumerate() {
                        visit(item, item_rule, &format!("{path}[{index}]"), out);
                    }
                }
            }
            JsValue::Object(object) => visit_object(object, rule, path, out),
            _ => {}
        }
    }

    fn visit_object(
        object: &JsObject,
        rule: &Rule,
        path: &str,
        out: &mut Vec<(String, Option<String>)>,
    ) {
        for (key, _) in object.ordered() {
            let key = lossy(key);
            if !rule.allow_extensions && !rule.keys.contains(&key.as_str()) {
                out.push((join(path, &key), closest_key(&key, rule.keys)));
            }
        }
        for (key, child_rule) in rule.children {
            if let Some(child) = object.get(key) {
                visit(child, child_rule, &join(path, key), out);
            }
        }
        if let Some(value_rule) = rule.record_values {
            for (key, child) in object.ordered() {
                visit(child, value_rule, &join(path, &lossy(key)), out);
            }
        }
    }

    /// `normalizedKey` in UTF-16 units: no `-`/`_`, lower case.
    fn normalized(key: &str) -> Vec<u16> {
        key.replace(['-', '_'], "")
            .to_lowercase()
            .encode_utf16()
            .collect()
    }

    fn edit_distance(left: &[u16], right: &[u16]) -> usize {
        let mut previous: Vec<usize> = (0..=right.len()).collect();
        for row in 1..=left.len() {
            let mut diagonal = previous[0];
            previous[0] = row;
            for column in 1..=right.len() {
                let above = previous[column];
                previous[column] = (previous[column] + 1)
                    .min(previous[column - 1] + 1)
                    .min(diagonal + usize::from(left[row - 1] != right[column - 1]));
                diagonal = above;
            }
        }
        previous[right.len()]
    }

    /// `closestKey`: a formatting-only match first, else the nearest key within the TS threshold.
    fn closest_key(key: &str, candidates: &[&str]) -> Option<String> {
        let normalized_key = normalized(key);
        if let Some(exact) = candidates
            .iter()
            .find(|candidate| normalized(candidate) == normalized_key)
        {
            return Some((*exact).to_owned());
        }
        let mut closest = None;
        let mut distance = usize::MAX;
        for candidate in candidates {
            let candidate_distance = edit_distance(&normalized_key, &normalized(candidate));
            if candidate_distance < distance {
                closest = Some(*candidate);
                distance = candidate_distance;
            }
        }
        // `Math.max(2, Math.floor(length * 0.3))`, in floating point like JS.
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "reproduces Math.floor(length * 0.3) on a small non-negative length"
        )]
        let threshold = 2.max((normalized_key.len() as f64 * 0.3).floor() as usize);
        (distance <= threshold)
            .then(|| closest.map(str::to_owned))
            .flatten()
    }
}

/// `NavoriConfigSchema`, field by field, with zod 4 semantics.
mod schema {
    use super::{JsObject, JsString, JsValue, is_js_whitespace, js_trim};
    use crate::zod::{
        Invalid, Parsed, Shape, array_of, boolean, empty_array, kebab, non_empty,
        non_empty_strings, object, one_of, safe_integer_at_least, safe_rel_path, string, strings,
        text,
    };

    /// `isSafeGateChain` (`engines/shared/permission-rules.ts:200`).
    pub(super) fn is_safe_gate_chain(gate: &str) -> bool {
        sequenced_steps(gate).iter().all(|step| {
            let step = js_trim(step);
            !step.is_empty() && gate_step_is_safe(step)
        })
    }

    /// `gate.split(/\s*(?:&&|\|\||;)\s*/)`: the surrounding whitespace is trimmed by the caller.
    fn sequenced_steps(gate: &str) -> Vec<&str> {
        let mut steps = Vec::new();
        let mut start = 0;
        let mut index = 0;
        let bytes = gate.as_bytes();
        while index < bytes.len() {
            let width = match (bytes[index], bytes.get(index + 1)) {
                (b'&', Some(b'&')) | (b'|', Some(b'|')) => 2,
                (b';', _) => 1,
                _ => 0,
            };
            if width == 0 {
                index += 1;
            } else {
                steps.push(&gate[start..index]);
                index += width;
                start = index;
            }
        }
        steps.push(&gate[start..]);
        steps
    }

    /// `gateStepRule(step) !== null`.
    fn gate_step_is_safe(step: &str) -> bool {
        // SAFE_GATE_STEP: /^[\w @.:/=-]+$/ with ASCII `\w`.
        let quiet = step
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_ @.:/=-".contains(&b));
        if !quiet {
            return false;
        }
        let runner = step.split(' ').next().unwrap_or_default();
        if ["pnpm", "npm", "yarn", "bun"].contains(&runner) {
            return true;
        }
        // CD_STEP: /^cd\s+\S+$/, restricted by SAFE_GATE_STEP to spaces.
        step.strip_prefix("cd ").is_some_and(|operand| {
            let operand = operand.trim_start_matches(' ');
            !operand.is_empty() && !operand.contains(' ')
        })
    }

    fn safe_gate_chain(value: &JsValue) -> Parsed {
        let content = text(value)?;
        if content.is_empty() || !is_safe_gate_chain(&content) {
            return Err(Invalid);
        }
        Ok(value.clone())
    }

    fn quality_gate(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .required("fast", non_empty)?
            .required("full", non_empty)?
            .optional("scoped", non_empty)?
            .optional("affected", safe_gate_chain)?
            .optional("docs", safe_gate_chain)?
            .optional("nativeHooks", boolean)?
            .strip())
    }

    fn hooks(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("verifyOnStop", JsValue::Bool(false), boolean)?
            .strip())
    }

    fn audit(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("mode", JsValue::string("opt-in"), |v| {
                one_of(v, &["opt-in", "always"])
            })?
            .strip())
    }

    fn library_migration(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .required("legacy", string)?
            .required("preferred", string)?
            .required("domain", string)?
            .strip())
    }

    fn library_migrations(value: &JsValue) -> Parsed {
        array_of(value, library_migration)
    }

    fn workspace_name(value: &JsValue) -> Parsed {
        let content = text(value)?;
        if content.is_empty() || content.contains(['<', '>', '\r', '\n']) {
            return Err(Invalid);
        }
        Ok(value.clone())
    }

    fn monorepo_workspace(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .required("name", workspace_name)?
            .required("path", safe_rel_path)?
            .optional("preset", string)?
            .optional("qualityGate", quality_gate)?
            .optional("libraries", strings)?
            .optional("extraLibraries", non_empty_strings)?
            .optional("libraryMigrations", library_migrations)?
            .strip())
    }

    fn monorepo(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .required("enabled", boolean)?
            .optional("tool", |v| {
                one_of(v, &["pnpm", "turbo", "nx", "rush", "lerna", "npm"])
            })?
            .defaulted("workspaces", empty_array(), |v| {
                array_of(v, monorepo_workspace)
            })?
            .defaulted("workspaceHarness", JsValue::string("minimal"), |v| {
                one_of(v, &["minimal", "full", "root"])
            })?
            .strip())
    }

    fn deliveries(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .optional("splitMinTasks", |v| safe_integer_at_least(v, 1.0))?
            .optional("splitMinLoc", |v| safe_integer_at_least(v, 1.0))?
            .optional("maxPrsPerSpec", |v| safe_integer_at_least(v, 2.0))?
            .strip())
    }

    fn sdd(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .optional("deliveries", deliveries)?
            .defaulted("enabled", JsValue::Bool(true), boolean)?
            .defaulted("specsDir", JsValue::string("specs"), string)?
            .defaulted("applyWhen", empty_array(), strings)?
            .defaulted("doesNotApplyTo", empty_array(), strings)?
            .strip())
    }

    fn harness(value: &JsValue) -> Parsed {
        let mut shape = Shape::new(value)?;
        for key in [
            "orchestrator",
            "implementer",
            "reviewer",
            "scout",
            "auditor",
            "publisher",
            "scribe",
        ] {
            shape = shape.defaulted(key, JsValue::Bool(true), boolean)?;
        }
        for key in [
            "scribeOwnsMarkdown",
            "planTiers",
            "codexIntegration",
            "masterPlan",
        ] {
            shape = shape.defaulted(key, JsValue::Bool(false), boolean)?;
        }
        Ok(shape
            .defaulted("compactAdviceTokens", JsValue::Number(175_000.0), |v| {
                safe_integer_at_least(v, 0.0)
            })?
            .strip())
    }

    const ROLES: [&str; 8] = [
        "orchestrator",
        "implementer",
        "reviewer",
        "scout",
        "auditor",
        "publisher",
        "scribe",
        "architect",
    ];
    const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

    /// `z.string().trim().min(1)`: the output is the trimmed text.
    fn trimmed_non_empty(value: &JsValue) -> Parsed {
        let content = text(value)?;
        let trimmed = js_trim(&content);
        if trimmed.is_empty() {
            return Err(Invalid);
        }
        Ok(JsValue::string(trimmed))
    }

    fn codex_profile(value: &JsValue) -> Parsed {
        Shape::new(value)?
            .optional("model", trimmed_non_empty)?
            .optional("effort", |v| one_of(v, &EFFORTS))?
            .strict()
    }

    /// `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`.
    fn profile_name(key: &JsString) -> bool {
        key.to_rust().is_some_and(|name| {
            let mut bytes = name.bytes();
            bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
                && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    }

    fn record(
        value: &JsValue,
        key_ok: fn(&JsString) -> bool,
        parse: fn(&JsValue) -> Parsed,
    ) -> Parsed {
        let input = object(value)?;
        let mut output = JsObject::new();
        for (key, member) in input.entries() {
            if !key_ok(key) {
                return Err(Invalid);
            }
            output.insert(key.clone(), parse(member)?);
        }
        Ok(JsValue::Object(output))
    }

    fn codex_map(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .optional("opus", string)?
            .optional("sonnet", string)?
            .optional("haiku", string)?
            .strip())
    }

    /// `PiModelSchema`: `/^[a-z0-9][a-z0-9._-]*\/\S+$/i`, a `provider/id` with no JS whitespace
    /// after the first slash (nested ids and a `:thinking` suffix included).
    fn pi_model(value: &JsValue) -> Parsed {
        let content = text(value)?;
        let Some((provider, id)) = content.split_once('/') else {
            return Err(Invalid);
        };
        let mut head = provider.bytes();
        let provider_ok = head.next().is_some_and(|b| b.is_ascii_alphanumeric())
            && head.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if provider_ok && !id.is_empty() && !id.chars().any(is_js_whitespace) {
            Ok(value.clone())
        } else {
            Err(Invalid)
        }
    }

    fn pi_map(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .optional("opus", pi_model)?
            .optional("sonnet", pi_model)?
            .optional("haiku", pi_model)?
            .strip())
    }

    fn models(value: &JsValue) -> Parsed {
        let mut shape = Shape::new(value)?
            .optional("codexProfiles", |v| record(v, profile_name, codex_profile))?;
        for key in ROLES {
            shape = shape.optional(key, |v| one_of(v, &["opus", "sonnet", "haiku"]))?;
        }
        Ok(shape
            .optional("codexMap", codex_map)?
            .optional("piMap", pi_map)?
            .strip())
    }

    fn effort(value: &JsValue) -> Parsed {
        let mut shape = Shape::new(value)?;
        for key in ROLES {
            shape = shape.optional(key, |v| one_of(v, &EFFORTS))?;
        }
        Ok(shape.strip())
    }

    fn plugin_entry(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .required("enabled", boolean)?
            .optional("nativeHook", boolean)?
            .strip())
    }

    fn blocks(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("exclude", empty_array(), strings)?
            .strip())
    }

    fn progress(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("dir", JsValue::string("progress"), safe_rel_path)?
            .defaulted("currentFile", JsValue::string("current.md"), safe_rel_path)?
            .defaulted("historyFile", JsValue::string("history.md"), safe_rel_path)?
            .strip())
    }

    fn foreign_harness(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("acknowledged", empty_array(), strings)?
            .passthrough())
    }

    fn project(value: &JsValue) -> Parsed {
        Ok(Shape::new(value)?
            .defaulted("legacyPaths", empty_array(), strings)?
            .defaulted("criticalAreas", empty_array(), strings)?
            .defaulted("criticalPaths", empty_array(), strings)?
            .optional("testRunner", string)?
            .optional("posture", string)?
            .optional("reviewRigor", string)?
            .optional("architectureRule", string)?
            .optional("testsForNewCode", string)?
            .defaulted("testsExclude", empty_array(), strings)?
            .defaulted("localSkills", empty_array(), strings)?
            .optional("foreignHarness", foreign_harness)?
            .defaulted("libraries", empty_array(), strings)?
            .optional("extraLibraries", non_empty_strings)?
            .defaulted("libraryMigrations", empty_array(), library_migrations)?
            .optional("codeLanguage", string)?
            .passthrough())
    }

    const ENGINES: [&str; 6] = ["claude", "agents-md", "cursor", "copilot", "codex", "pi"];

    /// `tolerantEnumArray(ENGINES, "claude")`.
    fn engines(value: &JsValue) -> Parsed {
        let JsValue::Array(items) = value else {
            return Err(Invalid);
        };
        let known: Vec<JsValue> = items
            .iter()
            .filter(|item| matches!(item, JsValue::String(s) if ENGINES.iter().any(|e| s.is(e))))
            .cloned()
            .collect();
        if known.is_empty() {
            if items.is_empty() {
                return Err(Invalid);
            }
            return Ok(JsValue::Array(vec![JsValue::string("claude")]));
        }
        Ok(JsValue::Array(known))
    }

    /// `tolerantEnum(values, fallback)` for a key that exists: unknown values become `fallback`.
    fn tolerant(value: &JsValue, allowed: &[&str], fallback: &str) -> JsValue {
        match value {
            JsValue::String(s) if allowed.iter().any(|a| s.is(a)) => value.clone(),
            _ => JsValue::string(fallback),
        }
    }

    /// `NavoriConfigSchema.safeParse(raw).data`.
    pub(super) fn navori_config(raw: &JsValue) -> Parsed {
        Ok(Shape::new(raw)?
            .optional("$schema", string)?
            .required("name", kebab)?
            .defaulted("version", JsValue::string("1.0.0"), string)?
            .optional("harnessVersion", string)?
            .optional("workspace", kebab)?
            .required("engines", engines)?
            .required("preset", non_empty)?
            .defaulted("language", JsValue::string("es"), |v| {
                Ok(tolerant(v, &["es", "en"], "es"))
            })?
            .defaulted("branchBase", JsValue::string("main"), string)?
            .defaulted("gitignoreHarness", JsValue::string("off"), |v| {
                one_of(v, &["off", "local", "full"])
            })?
            .optional("prTarget", string)?
            .defaulted("commits", JsValue::string("conventional-es"), |v| {
                Ok(tolerant(
                    v,
                    &["conventional", "conventional-es", "free"],
                    "conventional-es",
                ))
            })?
            .optional("qualityGate", quality_gate)?
            .optional("hooks", hooks)?
            .defaulted("audit", audit_default(), audit)?
            .optional("packageManager", |v| {
                one_of(v, &["pnpm", "npm", "yarn", "bun"])
            })?
            .optional("sdd", sdd)?
            .optional("harness", harness)?
            .optional("models", models)?
            .optional("effort", effort)?
            .optional("plugins", |v| record(v, |_| true, plugin_entry))?
            .optional("blocks", blocks)?
            .optional("progress", progress)?
            .optional("project", project)?
            .optional("monorepo", monorepo)?
            .passthrough())
    }

    fn audit_default() -> JsValue {
        let mut mode = JsObject::new();
        mode.insert("mode", JsValue::string("opt-in"));
        JsValue::Object(mode)
    }
}
