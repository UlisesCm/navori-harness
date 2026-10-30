//! `finalizeNativeHooks` (spec 0058 T15, `lib/render/native-hook-render.ts`) for the Claude
//! engine: once every plugin extension is planned, a hook script `crates/ported.json` declares is
//! wrapped with the native runtime arm and signed, but only when it is exactly what navori would
//! render (the core block plus every configured extension, untouched). Anything else keeps its
//! shell form, without the stale signature header a previous wrap left.
//!
//! Where the TS throws, or Rust reads less than it does (a non-UTF-8 dependency, an asset it
//! cannot render), the plan delegates.

use std::collections::{BTreeMap, BTreeSet};

use crate::STAMP_VERSION;
use crate::js_json::JsValue;
use crate::manifest::{EMBEDDED_MANIFEST, Hook, Manifest};
use crate::markers::{
    CommentStyle, InjectOptions, InjectStatus, MarkerMeta, compute_managed_hash,
    inject_managed_section, read_marker_attrs,
};
use crate::render::assets;
use crate::render::collect::{PendingWrite, RepoView, read_if_exists};
use crate::render::harness_files::{asset_text, placement_extra_vars};
use crate::render::harness_plan::PlannedUnit;
use crate::render::hook_includes::expand_hook_includes;
use crate::render::managed_file::{RenderManagedFileInput, render_managed_file};
use crate::render::native_hook::{
    INTEGRITY_PREFIX, NativeEngine, NativeShell, native_dependency_path, native_runner_shell,
    sha256, sign_native_script,
};
use crate::render::plugin_scripts::{ScriptEngine, plugin_script_placements};
use crate::render::plugins::LoadedPlugin;
use crate::render::sub_blocks::plugin_text;
use crate::semver::is_downgrade;

/// Some input is outside what Rust reproduces: the invocation goes to the TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeHooksDelegate;

/// What `finalizeNativeHooks` reads besides the pending writes.
pub struct NativeHooksInput<'a> {
    /// The repo.
    pub view: &'a dyn RepoView,
    /// Effective config.
    pub config: &'a JsValue,
    /// `inventory.plan.hooks`.
    pub hooks: &'a [PlannedUnit],
    /// Enabled plugins.
    pub plugins: &'a [LoadedPlugin],
    /// The ported hooks (`loadNativeHooks()`).
    pub manifest: &'a BTreeMap<String, Hook>,
    /// `setMarkerFloorVersion`.
    pub ambient_floor: Option<&'a str>,
    /// The sealed owned paths, the guard's `extraVars` (`renderVars`).
    pub owned_paths: Option<&'a str>,
}

/// `loadNativeHooks()`: the embedded `crates/ported.json`, or none when it does not validate.
#[must_use]
pub fn embedded_native_hooks() -> BTreeMap<String, Hook> {
    Manifest::parse(EMBEDDED_MANIFEST)
        .map(|manifest| manifest.hooks)
        .unwrap_or_default()
}

/// `nativePathContained(cwd, path)` for a repo-relative path: no component is a symlink.
#[must_use]
pub fn native_path_contained(view: &dyn RepoView, rel: &str) -> bool {
    let mut current = String::new();
    for part in rel.split('/') {
        if part == ".." {
            return false;
        }
        if part.is_empty() || part == "." {
            continue;
        }
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        if view.symlink(&current) != Some(false) {
            return false;
        }
    }
    true
}

/// `stripSignature(content)`: drops a leading, well-formed signature line.
fn strip_signature(content: &str) -> &str {
    let Some(rest) = content.strip_prefix(INTEGRITY_PREFIX) else {
        return content;
    };
    let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let Some((line, after)) = rest.split_once('\n') else {
        return content;
    };
    match line.split_once(" impl=sha256:") {
        Some((file, implementation)) if hex(file) && hex(implementation) => after,
        _ => content,
    }
}

/// `text.indexOf(needle, from)`, as an `Option`.
fn index_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| at + from)
}

/// `text.indexOf("\n") + 1`: `0` when there is no newline.
fn after_first_line(text: &str) -> usize {
    text.find('\n').map_or(0, |at| at + 1)
}

/// `header.replace(/hash="[a-f0-9]{8}"/, hash="<hash>")`: the first well-formed one only.
fn replace_first_hash(header: &str, hash: &str) -> String {
    let mut from = 0;
    while let Some(at) = index_from(header, "hash=\"", from) {
        let digits = at + "hash=\"".len();
        let well_formed = header
            .get(digits..digits + 8)
            .is_some_and(|d| d.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            && header.get(digits + 8..digits + 9) == Some("\"");
        if well_formed {
            return format!("{}hash=\"{hash}\"{}", &header[..at], &header[digits + 9..]);
        }
        from = at + 1;
    }
    header.to_owned()
}

fn harness_version(config: &JsValue) -> Option<String> {
    match config {
        JsValue::Object(object) => match object.get("harnessVersion") {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

fn shell_inject(
    existing: &str,
    id: &str,
    body: &str,
    source: &str,
    version: &str,
    floor: Option<&str>,
) -> String {
    inject_managed_section(
        existing,
        id,
        body,
        &MarkerMeta {
            source: Some(source.to_owned()),
            version: Some(version.to_owned()),
            ..MarkerMeta::default()
        },
        InjectOptions {
            shell: true,
            ambient_floor: floor,
            ..InjectOptions::default()
        },
    )
    .output
}

/// `referenceFor`: the exact fresh render of `target`, core block plus configured extensions, at
/// the versions `script` carries; `None` when `script` cannot be navori's own current output.
fn reference_for(
    input: &NativeHooksInput<'_>,
    hook: &PlannedUnit,
    script: &str,
    descriptor: &Hook,
    target: &str,
) -> Result<Option<String>, NativeHooksDelegate> {
    let Some(attrs) = read_marker_attrs(script, &hook.managed_id, CommentStyle::Shell) else {
        return Ok(None);
    };
    let Some(version) = attrs.existing_version.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let source = attrs.existing_source.unwrap_or_default();
    if source != "@navori/core"
        || is_downgrade(Some(&version), Some(STAMP_VERSION))
        || is_downgrade(
            harness_version(input.config).as_deref(),
            Some(STAMP_VERSION),
        )
    {
        return Ok(None);
    }
    let asset = asset_text(&hook.asset).map_err(|_| NativeHooksDelegate)?;
    let expanded = expand_hook_includes(&asset).map_err(|_| NativeHooksDelegate)?;
    if descriptor.blocks.get(&hook.managed_id) != Some(&sha256(expanded.as_bytes())) {
        return Ok(None);
    }
    let mut reference = render_managed_file(&RenderManagedFileInput {
        asset: &asset,
        style: CommentStyle::Shell,
        existing: None,
        managed_id: &hook.managed_id,
        source: &source,
        version: &version,
        config: input.config,
        extra_vars: placement_extra_vars(target, input.owned_paths).unwrap_or_default(),
        transform: None,
        engine: Some("claude"),
        force_overwrite: false,
        ambient_floor: input.ambient_floor,
    })
    .map_err(|_| NativeHooksDelegate)?
    .content;
    let mut seen: BTreeSet<&str> = BTreeSet::from([hook.managed_id.as_str()]);
    for plugin in input.plugins {
        for extension in &plugin.hook_extension_assets {
            if extension.target != target {
                continue;
            }
            if plugin
                .script_assets
                .iter()
                .any(|s| !descriptor.deps.contains_key(&format!("scripts/{}", s.dest)))
            {
                return Ok(None);
            }
            let body = plugin_text(plugin, &extension.path).map_err(|_| NativeHooksDelegate)?;
            let expanded = expand_hook_includes(body).map_err(|_| NativeHooksDelegate)?;
            if descriptor.blocks.get(&extension.id) != Some(&sha256(expanded.as_bytes())) {
                return Ok(None);
            }
            let Some(meta) = read_marker_attrs(script, &extension.id, CommentStyle::Shell) else {
                return Ok(None);
            };
            let Some(ext_version) = meta.existing_version.filter(|v| !v.is_empty()) else {
                return Ok(None);
            };
            let ext_source = meta.existing_source.unwrap_or_default();
            if ext_source != format!("@navori/plugin-{}", plugin.manifest_id())
                || is_downgrade(Some(&ext_version), Some(STAMP_VERSION))
            {
                return Ok(None);
            }
            reference = shell_inject(
                &reference,
                &extension.id,
                body,
                &ext_source,
                &ext_version,
                input.ambient_floor,
            );
            seen.insert(extension.id.as_str());
        }
    }
    Ok(descriptor
        .blocks
        .keys()
        .all(|id| seen.contains(id.as_str()))
        .then_some(reference))
}

/// `depsFor`: each dependency is a plugin script whose source asset `deps` pins; the deployed
/// copy (the planned write, else the file on disk) must be that asset's fresh render under its
/// own marker. The deployed bytes, in sorted path order; `None` when any check fails.
fn deps_for(
    input: &NativeHooksInput<'_>,
    descriptor: &Hook,
    pending: &[PendingWrite],
) -> Result<Option<Vec<Vec<u8>>>, NativeHooksDelegate> {
    let mut deps = Vec::new();
    for (path, expected) in &descriptor.deps {
        let Some(resolved) = native_dependency_path(NativeEngine::Claude, path) else {
            return Ok(None);
        };
        if !native_path_contained(input.view, &resolved) {
            return Ok(None);
        }
        let Some(script) = input
            .plugins
            .iter()
            .flat_map(|plugin| plugin_script_placements(plugin, ScriptEngine::Claude))
            .find(|placement| format!("scripts/{}", placement.script.dest) == *path)
        else {
            return Ok(None);
        };
        let raw =
            assets::plugin(&script.plugin_dir, &script.script.src).ok_or(NativeHooksDelegate)?;
        if &sha256(raw) != expected {
            return Ok(None);
        }
        let content = match pending.iter().find(|w| w.rel_path == resolved) {
            Some(planned) => Some(planned.content.clone()),
            None => read_if_exists(input.view, &resolved).map_err(|_| NativeHooksDelegate)?,
        };
        let Some(content) = content else {
            return Ok(None);
        };
        let Some(meta) = read_marker_attrs(&content, &script.managed_id, CommentStyle::Shell)
        else {
            return Ok(None);
        };
        let (Some(source), Some(version)) = (
            meta.existing_source.filter(|s| *s == script.source),
            meta.existing_version.filter(|v| !v.is_empty()),
        ) else {
            return Ok(None);
        };
        let template = script.template().ok_or(NativeHooksDelegate)?;
        let fresh = render_managed_file(&RenderManagedFileInput {
            asset: template,
            style: CommentStyle::Shell,
            existing: None,
            managed_id: &script.managed_id,
            source: &source,
            version: &version,
            config: input.config,
            extra_vars: BTreeMap::new(),
            transform: None,
            engine: Some("claude"),
            force_overwrite: false,
            ambient_floor: input.ambient_floor,
        })
        .map_err(|_| NativeHooksDelegate)?
        .content;
        if fresh != content {
            return Ok(None);
        }
        deps.push(content.into_bytes());
    }
    Ok(Some(deps))
}

/// `finalizeNativeHooks(input)` over `pending` for the Claude engine: the eligible hooks, by
/// target, for `applyNativeClaudeSettings`.
///
/// # Errors
/// [`NativeHooksDelegate`] where the TS throws or Rust cannot reproduce what it reads.
pub fn finalize_native_hooks(
    input: &NativeHooksInput<'_>,
    pending: &mut Vec<PendingWrite>,
) -> Result<BTreeMap<String, Hook>, NativeHooksDelegate> {
    let mut eligible = BTreeMap::new();
    if input.manifest.is_empty()
        && !pending
            .iter()
            .any(|w| w.content.starts_with(INTEGRITY_PREFIX))
    {
        return Ok(eligible);
    }
    for hook in input.hooks {
        let target = format!(".claude/hooks/{}.sh", hook.id);
        if !native_path_contained(input.view, &target) {
            continue;
        }
        let index = pending.iter().position(|w| w.rel_path == target);
        let existing = read_if_exists(input.view, &target).map_err(|_| NativeHooksDelegate)?;
        let Some(mut candidate) = index
            .map(|i| pending[i].content.clone())
            .or_else(|| existing.clone())
        else {
            continue;
        };
        if index.is_some() && candidate.starts_with(INTEGRITY_PREFIX) {
            candidate = strip_signature(&candidate).to_owned();
        }
        let Some(descriptor) = input.manifest.get(&hook.id) else {
            if let Some(i) = index {
                pending[i].content = candidate;
            }
            continue;
        };
        let wrapper = native_runner_shell(&NativeShell {
            engine: NativeEngine::Claude,
            hook: &hook.id,
            mode: descriptor.mode,
            gating: descriptor.gating,
            invocation: "--via-script \"$0\"",
            args: Some("\"$@\""),
        });
        let unsigned = strip_signature(&candidate);
        let mut without = unsigned.replacen(&format!("{wrapper}\n"), "", 1);
        if without != unsigned {
            let close = format!("# navori:managed end id=\"{}\"", hook.managed_id);
            let attrs = read_marker_attrs(unsigned, &hook.managed_id, CommentStyle::Shell);
            let body_start = after_first_line(&without);
            let body_end = index_from(&without, &close, body_start);
            let original_start = after_first_line(unsigned);
            let original_end = index_from(unsigned, &close, original_start);
            let (Some(attrs), Some(body_end), Some(original_end)) = (attrs, body_end, original_end)
            else {
                continue;
            };
            if attrs.existing_hash.as_deref()
                != Some(compute_managed_hash(&unsigned[original_start..original_end]).as_str())
            {
                continue;
            }
            let hash = compute_managed_hash(&without[body_start..body_end]);
            without = format!(
                "{}{}",
                replace_first_hash(&without[..body_start], &hash),
                &without[body_start..]
            );
        }
        let reference = reference_for(input, hook, &without, descriptor, &target)?;
        let dependencies = deps_for(input, descriptor, pending)?;
        let (Some(reference), Some(dependencies)) = (reference, dependencies) else {
            if let Some(i) = index {
                pending[i].content = candidate;
            }
            continue;
        };
        if without != reference {
            if let Some(i) = index {
                pending[i].content = candidate;
            }
            continue;
        }
        let Some(body) = read_marker_attrs(&reference, &hook.managed_id, CommentStyle::Shell)
        else {
            continue;
        };
        let start = after_first_line(&reference);
        let shebang = if reference[start..].starts_with("#!") {
            index_from(&reference, "\n", start).map_or(0, |at| at + 1)
        } else {
            start
        };
        let with_wrapper = format!(
            "{}{wrapper}\n{}",
            &reference[..shebang],
            &reference[shebang..]
        );
        let close = format!("# navori:managed end id=\"{}\"", hook.managed_id);
        let Some(close_at) = index_from(&with_wrapper, &close, start) else {
            continue;
        };
        let inner = &with_wrapper[start..close_at];
        let inner = inner.strip_suffix('\n').unwrap_or(inner);
        let source = body
            .existing_source
            .unwrap_or_else(|| "@navori/core".to_owned());
        let wrapped = shell_inject(
            &reference,
            &hook.managed_id,
            inner,
            &source,
            STAMP_VERSION,
            input.ambient_floor,
        );
        let dep_slices: Vec<&[u8]> = dependencies.iter().map(Vec::as_slice).collect();
        let signed = sign_native_script(&wrapped, &descriptor.r#impl, &dep_slices);
        eligible.insert(target.clone(), descriptor.clone());
        if existing.as_deref() == Some(signed.as_str()) {
            if let Some(i) = index {
                pending.remove(i);
            }
        } else if let Some(i) = index {
            pending[i].content = signed;
        } else {
            pending.push(PendingWrite {
                rel_path: target,
                content: signed,
                status: InjectStatus::Updated,
                chmod_exec: true,
            });
        }
    }
    Ok(eligible)
}

// --- applyNativeClaudeSettings ---------------------------------------------------------------

const SETTINGS: &str = ".claude/settings.json";

/// `/^f="\$CLAUDE_PROJECT_DIR\/([^"\n]+)"; /.exec(command)?.[1]`.
fn command_script(command: &str) -> Option<&str> {
    let rest = command.strip_prefix("f=\"$CLAUDE_PROJECT_DIR/")?;
    let end = rest.find(['"', '\n'])?;
    (end > 0 && rest[end..].starts_with("\"; ")).then(|| &rest[..end])
}

/// `/exec bash "\$f"([^;]*); /.exec(command)?.[1]`: the first literal whose maximal run of
/// non-`;` is followed by `"; "`.
fn command_args(command: &str) -> Option<&str> {
    const LITERAL: &str = "exec bash \"$f\"";
    let mut from = 0;
    while let Some(at) = index_from(command, LITERAL, from) {
        let start = at + LITERAL.len();
        let run = command[start..]
            .find(';')
            .map_or(command.len(), |i| start + i);
        if command[run..].starts_with("; ") {
            return Some(&command[start..run]);
        }
        from = at + 1;
    }
    None
}

fn variant(mode: crate::manifest::HookMode, gating: bool) -> Hook {
    Hook {
        mode,
        gating,
        blocks: BTreeMap::new(),
        deps: BTreeMap::new(),
        r#impl: format!("sha256:{}", "0".repeat(64)),
        divergences: Vec::new(),
    }
}

/// The desired command for a recognizable generated `command`, or `None` to leave it.
fn rewired(event: &str, command: &str, eligible: &BTreeMap<String, Hook>) -> Option<String> {
    use crate::manifest::HookMode;
    use crate::render::claude_settings::claude_hook_command;
    let script = command_script(command)?;
    let args = command_args(command)?;
    let args =
        crate::integrity::js_trim_end(args.trim_start_matches(crate::integrity::is_js_whitespace));
    let args = (!args.is_empty()).then_some(args);
    let mut variants = vec![claude_hook_command(event, script, args, None)];
    for mode in [HookMode::Shadow, HookMode::Active] {
        for gating in [false, true] {
            variants.push(claude_hook_command(
                event,
                script,
                args,
                Some(&variant(mode, gating)),
            ));
        }
    }
    variants
        .iter()
        .any(|v| v == command)
        .then(|| claude_hook_command(event, script, args, eligible.get(script)))
}

/// `new Set(values)` over parsed JSON: primitives dedupe by value, objects and arrays never.
fn dedupe(values: Vec<JsValue>) -> Vec<JsValue> {
    let mut out: Vec<JsValue> = Vec::new();
    for value in values {
        let primitive = !matches!(value, JsValue::Object(_) | JsValue::Array(_));
        if primitive && out.contains(&value) {
            continue;
        }
        out.push(value);
    }
    out
}

/// `applyNativeClaudeSettings(cwd, pending, eligible, decision, floor, force)`: rewrites only
/// the generated hook commands to their native form for `eligible` hooks (or back to the shell
/// form), drops duplicates that leaves, and restamps a managed file (`force` skips the
/// anti-rollback check).
///
/// # Errors
/// [`NativeHooksDelegate`] when `settings.json` exists but cannot be read.
pub fn apply_native_claude_settings(
    view: &dyn RepoView,
    pending: &mut Vec<PendingWrite>,
    eligible: &BTreeMap<String, Hook>,
    skipped: bool,
    floor: Option<&str>,
    force: bool,
) -> Result<(), NativeHooksDelegate> {
    use crate::render::settings_file::{StampedPlan, plan_stamped_json, pretty};
    if skipped || !native_path_contained(view, SETTINGS) {
        return Ok(());
    }
    let index = pending.iter().position(|w| w.rel_path == SETTINGS);
    let existing = read_if_exists(view, SETTINGS).map_err(|_| NativeHooksDelegate)?;
    let Some(content) = index
        .map(|i| pending[i].content.clone())
        .or_else(|| existing.clone())
    else {
        return Ok(());
    };
    if eligible.is_empty() && !content.contains("# navori:native-runtime start") {
        return Ok(());
    }
    let Some(JsValue::Object(mut settings)) = crate::js_json::parse(&content) else {
        return Ok(());
    };
    let Some(JsValue::Object(mut hooks)) = settings.get("hooks").cloned() else {
        return Ok(());
    };
    let mut changed = false;
    let mut replacements: Vec<(String, String)> = Vec::new();
    let events: Vec<_> = hooks
        .ordered()
        .into_iter()
        .map(|(k, _)| k.clone())
        .collect();
    for event in events {
        let Some(name) = event.to_rust() else {
            return Err(NativeHooksDelegate);
        };
        let Some(JsValue::Array(mut buckets)) = hooks.get(&name).cloned() else {
            continue;
        };
        for bucket in &mut buckets {
            let JsValue::Object(bucket) = bucket else {
                continue;
            };
            let Some(JsValue::Array(entries)) = bucket.get("hooks").cloned() else {
                continue;
            };
            let mut seen: Vec<String> = Vec::new();
            let mut kept = Vec::new();
            for entry in entries {
                let JsValue::Object(mut object) = entry else {
                    kept.push(entry);
                    continue;
                };
                let command = match object.get("command") {
                    Some(JsValue::String(text)) => text.to_rust().ok_or(NativeHooksDelegate)?,
                    _ => {
                        kept.push(JsValue::Object(object));
                        continue;
                    }
                };
                let Some(desired) = rewired(&name, &command, eligible) else {
                    kept.push(JsValue::Object(object));
                    continue;
                };
                changed |= desired != command;
                match replacements.iter_mut().find(|(from, _)| *from == command) {
                    Some(slot) => slot.1.clone_from(&desired),
                    None => replacements.push((command, desired.clone())),
                }
                object.insert("command", JsValue::string(&desired));
                let key = JsValue::Object(object.clone())
                    .stringify(None)
                    .ok_or(NativeHooksDelegate)?;
                if seen.contains(&key) {
                    changed = true;
                    continue;
                }
                seen.push(key);
                kept.push(JsValue::Object(object));
            }
            bucket.insert("hooks", JsValue::Array(kept));
        }
        hooks.insert(event, JsValue::Array(buckets));
    }
    if !changed {
        return Ok(());
    }
    settings.insert("hooks", JsValue::Object(hooks));
    let managed = match settings.get_mut("$navori") {
        Some(JsValue::Object(ownership)) => {
            if let Some(JsValue::Array(list)) = ownership.get("managedHooks").cloned() {
                let mapped = list
                    .into_iter()
                    .map(|value| match &value {
                        JsValue::String(text) => text
                            .to_rust()
                            .and_then(|t| replacements.iter().find(|(from, _)| *from == t))
                            .map_or(value.clone(), |(_, to)| JsValue::string(to)),
                        _ => value,
                    })
                    .collect();
                ownership.insert("managedHooks", JsValue::Array(dedupe(mapped)));
            }
            let managed = ownership.get("managed") == Some(&JsValue::Bool(true));
            if managed {
                ownership.insert("version", JsValue::string(STAMP_VERSION));
            }
            managed
        }
        _ => false,
    };
    let mut output = pretty(&JsValue::Object(settings));
    if managed && let Some(current) = existing.as_deref() {
        match plan_stamped_json(current, &output, floor, force) {
            StampedPlan::Downgrade(_) => return Ok(()),
            StampedPlan::Noop => current.clone_into(&mut output),
            StampedPlan::Write(content) => output = content,
        }
    }
    if existing.as_deref() == Some(output.as_str()) {
        if let Some(i) = index {
            pending.remove(i);
        }
    } else if let Some(i) = index {
        pending[i].content = output;
    } else {
        pending.push(PendingWrite {
            rel_path: SETTINGS.to_owned(),
            content: output,
            status: InjectStatus::Updated,
            chmod_exec: false,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEX_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn strip_signature_drops_only_a_leading_well_formed_header() {
        let header = format!("{INTEGRITY_PREFIX}{HEX_A} impl=sha256:{HEX_B}\n");
        assert_eq!(strip_signature(&format!("{header}body\n")), "body\n");
        // Not at the start, uppercase hex, short hash, no newline, trailing junk: kept.
        for kept in [
            format!("x\n{header}"),
            format!(
                "{INTEGRITY_PREFIX}{} impl=sha256:{HEX_B}\n",
                HEX_A.to_uppercase()
            ),
            format!("{INTEGRITY_PREFIX}{} impl=sha256:{HEX_B}\n", &HEX_A[1..]),
            format!("{INTEGRITY_PREFIX}{HEX_A} impl=sha256:{HEX_B}"),
            format!("{INTEGRITY_PREFIX}{HEX_A} impl=sha256:{HEX_B} x\n"),
        ] {
            assert_eq!(strip_signature(&kept), kept);
        }
    }

    #[test]
    fn replace_first_hash_rewrites_the_first_well_formed_attribute() {
        let header = "# start id=\"x\" hash=\"0123abcd\" hash=\"ffffffff\"\n";
        assert_eq!(
            replace_first_hash(header, "deadbeef"),
            "# start id=\"x\" hash=\"deadbeef\" hash=\"ffffffff\"\n"
        );
        // Malformed ones (uppercase, short, unterminated) are skipped over.
        assert_eq!(
            replace_first_hash(
                "hash=\"ABCDEF01\" hash=\"abc\" hash=\"12345678\"",
                "deadbeef"
            ),
            "hash=\"ABCDEF01\" hash=\"abc\" hash=\"deadbeef\""
        );
        assert_eq!(
            replace_first_hash("hash=\"1234567\"x", "deadbeef"),
            "hash=\"1234567\"x"
        );
    }

    #[test]
    fn command_patterns_follow_the_ts_regexes() {
        // Expected values come from running the TS regexes in Node.
        let cases: [(&str, Option<&str>, Option<&str>); 10] = [
            (
                "f=\"$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh\"; bash -n \"$f\" 2>/dev/null && exec bash \"$f\" a b; printf",
                Some(".claude/hooks/x.sh"),
                Some(" a b"),
            ),
            ("f=\"$CLAUDE_PROJECT_DIR/\"; x", None, None),
            ("f=\"$CLAUDE_PROJECT_DIR/a\nb\"; x", None, None),
            (" f=\"$CLAUDE_PROJECT_DIR/a\"; x", None, None),
            ("f=\"$CLAUDE_PROJECT_DIR/a\";x", None, None),
            ("exec bash \"$f\"; ", None, Some("")),
            ("exec bash \"$f\" x;y; ", None, None),
            ("exec bash \"$f\" x;exec bash \"$f\" y; z", None, Some(" y")),
            ("exec bash \"$f\" x", None, None),
            ("exec bash \"$f\"\tq ; ", None, Some("\tq ")),
        ];
        for (command, script, args) in cases {
            assert_eq!(command_script(command), script, "{command:?}");
            assert_eq!(command_args(command), args, "{command:?}");
        }
    }

    #[test]
    fn dedupe_keeps_first_primitives_and_every_object() {
        let values = [
            "\"a\"", "\"b\"", "\"a\"", "1", "1", "-0", "0", "{}", "{}", "[]", "[]", "null", "null",
        ]
        .iter()
        .filter_map(|t| crate::js_json::parse(t))
        .collect();
        let out: Vec<String> = dedupe(values)
            .iter()
            .filter_map(|v| v.stringify(None))
            .collect();
        assert_eq!(
            out,
            ["\"a\"", "\"b\"", "1", "0", "{}", "{}", "[]", "[]", "null"]
        );
    }

    #[test]
    fn index_helpers_follow_index_of() {
        assert_eq!(after_first_line("no newline"), 0);
        assert_eq!(after_first_line("a\nb"), 2);
        assert_eq!(index_from("abcabc", "c", 3), Some(5));
        assert_eq!(index_from("abc", "c", 9), None);
    }

    /// Symlinks at `links`, `lstat` failures at `broken`, everything else a plain path.
    struct Links {
        links: &'static [&'static str],
        broken: &'static [&'static str],
    }

    impl RepoView for Links {
        fn read(&self, _rel: &str) -> Option<String> {
            None
        }

        fn read_regular(&self, _rel: &str) -> Option<String> {
            None
        }

        fn exists(&self, _rel: &str) -> bool {
            false
        }

        fn lexists(&self, _rel: &str) -> bool {
            false
        }

        fn list_dir(&self, _rel: &str) -> Option<Vec<String>> {
            None
        }

        fn symlink(&self, rel: &str) -> Option<bool> {
            if self.broken.contains(&rel) {
                None
            } else {
                Some(self.links.contains(&rel))
            }
        }
    }

    #[test]
    fn containment_rejects_any_symlinked_component_or_lstat_failure() {
        let plain = Links {
            links: &[],
            broken: &[],
        };
        assert!(native_path_contained(&plain, ".claude/hooks/x.sh"));
        assert!(!native_path_contained(&plain, "../x.sh"));
        for (links, broken) in [
            (&[".claude"][..], &[][..]),
            (&[".claude/hooks"][..], &[][..]),
            (&[".claude/hooks/x.sh"][..], &[][..]),
            (&[][..], &[".claude/hooks"][..]),
        ] {
            assert!(!native_path_contained(
                &Links { links, broken },
                ".claude/hooks/x.sh"
            ));
        }
    }
}
