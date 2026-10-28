//! Step 2 of `prepareClaudeEngine` (spec 0058 T15): `planSettings` decides what happens to
//! `.claude/settings.json` — created, regenerated under its `$navori.version` stamp with the
//! anti-rollback rule of `planStampedJson` (`lib/primitives/json-ownership.ts`), or merged into a
//! file navori does not own (`mergeCoexistSettings`, `engines/claude/coexist-settings.ts`).
//!
//! An existing file that does not parse (or cannot be read) is delegated without `force`: the TS
//! skips it with the V8 parser message, which Rust does not reproduce.

use crate::STAMP_VERSION;
use crate::i18n;
use crate::js_json::{self, JsObject, JsValue};
use crate::markers::InjectStatus;
use crate::render::collect::{RepoView, read_if_exists};
use crate::render::context::Lang;
use crate::semver::is_downgrade;

/// `NAVORI_OWNERSHIP_KEY`.
pub(crate) const OWNERSHIP_KEY: &str = "$navori";

/// The settings path.
pub const SETTINGS_PATH: &str = ".claude/settings.json";

/// The TS reports something Rust does not reproduce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsFileDelegate;

/// `SettingsPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsPlan {
    /// Nothing to write.
    Noop,
    /// Kept, with the reason and, for a newer stamp, `downgrade-skipped`.
    Skip {
        /// Localized reason.
        reason: String,
        /// `Some(DowngradeSkipped)` for a newer stamp.
        status: Option<InjectStatus>,
    },
    /// The file's next content.
    Write {
        /// Full content.
        content: String,
        /// `created` or `updated`.
        status: InjectStatus,
    },
}

/// `parseNavoriOwnership(parsed)`: `(managed, version)` when `$navori` is a plain object.
fn ownership(value: &JsValue) -> Option<(bool, Option<String>)> {
    let JsValue::Object(object) = value else {
        return None;
    };
    let JsValue::Object(navori) = object.get(OWNERSHIP_KEY)? else {
        return None;
    };
    let version = match navori.get("version") {
        Some(JsValue::String(v)) => v.to_rust().filter(|v| !v.is_empty()),
        _ => None,
    };
    Some((navori.get("managed") == Some(&JsValue::Bool(true)), version))
}

pub(crate) fn pretty(value: &JsValue) -> String {
    format!("{}\n", value.stringify(Some(2)).unwrap_or_default())
}

/// `StampedJsonPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampedPlan {
    /// Identical once the candidate carries the existing stamp.
    Noop,
    /// Write the candidate.
    Write(String),
    /// A real change under a newer stamp or floor.
    Downgrade(String),
}

/// `planStampedJson(current, candidate, cliVersion, floor, force)`.
#[must_use]
pub fn plan_stamped_json(
    current: &str,
    candidate: &str,
    floor: Option<&str>,
    force: bool,
) -> StampedPlan {
    if current == candidate {
        return StampedPlan::Noop;
    }
    let existing = js_json::parse(current)
        .as_ref()
        .and_then(ownership)
        .and_then(|(_, version)| version);
    if let Some(existing) = existing.as_deref()
        && let Some(JsValue::Object(mut record)) = js_json::parse(candidate)
        && let Some(JsValue::Object(navori)) = record.get(OWNERSHIP_KEY).cloned()
    {
        let mut navori = navori;
        navori.insert("version", JsValue::string(existing));
        record.insert(OWNERSHIP_KEY, JsValue::Object(navori));
        if pretty(&JsValue::Object(record)) == current {
            return StampedPlan::Noop;
        }
    }
    if !force {
        if is_downgrade(existing.as_deref(), Some(STAMP_VERSION)) {
            return StampedPlan::Downgrade(existing.unwrap_or_default());
        }
        if let Some(floor) = floor
            && is_downgrade(Some(floor), Some(STAMP_VERSION))
        {
            return StampedPlan::Downgrade(floor.to_owned());
        }
    }
    StampedPlan::Write(candidate.to_owned())
}

// --- coexist ------------------------------------------------------------------------------

fn string_list(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(text) => text.to_rust(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn command_of(hook: &JsValue) -> Option<String> {
    match hook {
        JsValue::Object(object) => match object.get("command") {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

/// `{ event, matcher, hook }` of every navori hook with a string command.
fn collect_hooks(settings: &JsObject) -> Vec<(String, Option<String>, JsValue)> {
    let mut out = Vec::new();
    let Some(JsValue::Object(hooks)) = settings.get("hooks") else {
        return out;
    };
    for (event, entries) in hooks.ordered() {
        let JsValue::Array(entries) = entries else {
            continue;
        };
        let Some(event) = event.to_rust() else {
            continue;
        };
        for entry in entries {
            let JsValue::Object(entry) = entry else {
                continue;
            };
            let Some(JsValue::Array(inner)) = entry.get("hooks") else {
                continue;
            };
            let matcher = match entry.get("matcher") {
                Some(JsValue::String(m)) => m.to_rust(),
                _ => None,
            };
            for hook in inner {
                if matches!(hook, JsValue::Object(_)) && command_of(hook).is_some() {
                    out.push((event.clone(), matcher.clone(), hook.clone()));
                }
            }
        }
    }
    out
}

fn permission_list(settings: &JsObject, key: &str) -> Vec<String> {
    match settings.get("permissions") {
        Some(JsValue::Object(perms)) => string_list(perms.get(key)),
        _ => Vec::new(),
    }
}

fn strip_tracked_hooks(obj: &mut JsObject, commands: &[String]) {
    if commands.is_empty() {
        return;
    }
    let Some(JsValue::Object(hooks)) = obj.get_mut("hooks") else {
        return;
    };
    let events: Vec<_> = hooks
        .ordered()
        .into_iter()
        .map(|(k, _)| k.clone())
        .collect();
    for event in events {
        let Some(name) = event.to_rust() else {
            continue;
        };
        let Some(JsValue::Array(entries)) = hooks.get(&name).cloned() else {
            continue;
        };
        let mut kept = Vec::new();
        for entry in entries {
            match entry {
                JsValue::Object(mut bucket)
                    if matches!(bucket.get("hooks"), Some(JsValue::Array(_))) =>
                {
                    let Some(JsValue::Array(inner)) = bucket.get("hooks").cloned() else {
                        continue;
                    };
                    let remaining: Vec<JsValue> = inner
                        .into_iter()
                        .filter(|h| {
                            !(matches!(h, JsValue::Object(_))
                                && command_of(h).is_some_and(|c| commands.contains(&c)))
                        })
                        .collect();
                    let keep = !remaining.is_empty();
                    bucket.insert("hooks", JsValue::Array(remaining));
                    if keep {
                        kept.push(JsValue::Object(bucket));
                    }
                }
                other => kept.push(other),
            }
        }
        hooks.insert(event, JsValue::Array(kept));
    }
}

fn prune_empty_hooks(obj: &mut JsObject) {
    let Some(JsValue::Object(hooks)) = obj.get_mut("hooks") else {
        return;
    };
    let empty: Vec<String> = hooks
        .entries()
        .iter()
        .filter(|(_, v)| matches!(v, JsValue::Array(items) if items.is_empty()))
        .filter_map(|(k, _)| k.to_rust())
        .collect();
    for key in &empty {
        hooks.remove(key);
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
}

fn strip_from_permission_list(obj: &mut JsObject, key: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    let Some(JsValue::Object(perms)) = obj.get_mut("permissions") else {
        return;
    };
    let Some(JsValue::Array(list)) = perms.get(key).cloned() else {
        return;
    };
    let filtered: Vec<JsValue> = list
        .into_iter()
        .filter(|v| {
            !matches!(v, JsValue::String(s) if s.to_rust().is_some_and(|s| values.contains(&s)))
        })
        .collect();
    if filtered.is_empty() {
        perms.remove(key);
    } else {
        perms.insert(key, JsValue::Array(filtered));
    }
}

/// `obj[key]` when it is a plain object, else a fresh `{}` assigned to `obj[key]`.
fn object_slot<'a>(obj: &'a mut JsObject, key: &str) -> &'a mut JsObject {
    if !matches!(obj.get(key), Some(JsValue::Object(_))) {
        obj.insert(key, JsValue::Object(JsObject::new()));
    }
    match obj.get_mut(key) {
        Some(JsValue::Object(inner)) => inner,
        _ => unreachable!("just inserted an object"),
    }
}

/// `obj[key]` when it is an array, else a fresh `[]` assigned to `obj[key]`.
fn array_slot<'a>(obj: &'a mut JsObject, key: &str) -> &'a mut Vec<JsValue> {
    if !matches!(obj.get(key), Some(JsValue::Array(_))) {
        obj.insert(key, JsValue::Array(Vec::new()));
    }
    match obj.get_mut(key) {
        Some(JsValue::Array(items)) => items,
        _ => unreachable!("just inserted an array"),
    }
}

fn inject_hooks(obj: &mut JsObject, desired: &[(String, Option<String>, JsValue)]) {
    if desired.is_empty() {
        return;
    }
    let hooks = object_slot(obj, "hooks");
    for (event, matcher, hook) in desired {
        let entries = array_slot(hooks, event);
        let found = entries.iter().position(|e| match e {
            JsValue::Object(bucket) => {
                let same = match (bucket.get("matcher"), matcher) {
                    (None | Some(JsValue::Undefined), None) => true,
                    (Some(JsValue::String(m)), Some(want)) => m.is(want),
                    _ => false,
                };
                same && matches!(bucket.get("hooks"), Some(JsValue::Array(_)))
            }
            _ => false,
        });
        let at = found.unwrap_or_else(|| {
            let mut group = JsObject::new();
            if let Some(matcher) = matcher {
                group.insert("matcher", JsValue::string(matcher));
            }
            group.insert("hooks", JsValue::Array(Vec::new()));
            entries.push(JsValue::Object(group));
            entries.len() - 1
        });
        let Some(JsValue::Object(group)) = entries.get_mut(at) else {
            continue;
        };
        let group_hooks = array_slot(group, "hooks");
        let command = command_of(hook);
        if !group_hooks
            .iter()
            .any(|h| matches!(h, JsValue::Object(_)) && command_of(h) == command)
        {
            group_hooks.push(hook.clone());
        }
    }
}

fn inject_permission_list(obj: &mut JsObject, key: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    let perms = object_slot(obj, "permissions");
    let list = array_slot(perms, key);
    for value in values {
        let value = JsValue::string(value);
        if !list.contains(&value) {
            list.push(value);
        }
    }
}

fn strings(values: &[String]) -> JsValue {
    JsValue::Array(values.iter().map(|v| JsValue::string(v)).collect())
}

/// `mergeCoexistSettings(existing, navoriSettings)`.
#[must_use]
pub fn merge_coexist_settings(existing: &JsObject, navori: &JsObject) -> JsObject {
    let mut result = existing.clone();
    let (prior_hooks, prior_deny, prior_ask) = match result.get(OWNERSHIP_KEY) {
        Some(JsValue::Object(t)) => (
            string_list(t.get("managedHooks")),
            string_list(t.get("managedDeny")),
            string_list(t.get("managedAsk")),
        ),
        _ => (Vec::new(), Vec::new(), Vec::new()),
    };
    strip_tracked_hooks(&mut result, &prior_hooks);
    strip_from_permission_list(&mut result, "deny", &prior_deny);
    strip_from_permission_list(&mut result, "ask", &prior_ask);

    let desired = collect_hooks(navori);
    let deny = permission_list(navori, "deny");
    let ask = permission_list(navori, "ask");
    inject_hooks(&mut result, &desired);
    inject_permission_list(&mut result, "deny", &deny);
    inject_permission_list(&mut result, "ask", &ask);
    prune_empty_hooks(&mut result);

    let tracking = object_slot(&mut result, OWNERSHIP_KEY);
    let commands: Vec<String> = desired
        .iter()
        .filter_map(|(_, _, h)| command_of(h))
        .collect();
    tracking.insert("managedHooks", strings(&commands));
    tracking.insert("managedDeny", strings(&deny));
    tracking.insert("managedAsk", strings(&ask));
    tracking.insert(
        "note",
        JsValue::string(
            "Bloques 'managed*' inyectados por navori (coexist). El resto es tuyo. Se re-sincronizan en cada 'navori render'.",
        ),
    );
    result
}

/// `planSettings(cwd, config, inventory, force)` over the settings `buildClaudeSettings` built.
///
/// # Errors
/// [`SettingsFileDelegate`] when the existing file does not parse (or cannot be read) and
/// `force` is off.
pub fn plan_settings(
    view: &dyn RepoView,
    settings: &JsValue,
    floor: Option<&str>,
    force: bool,
    lang: Lang,
) -> Result<SettingsPlan, SettingsFileDelegate> {
    let new_json = pretty(settings);
    let current = match read_if_exists(view, SETTINGS_PATH) {
        Ok(None) => {
            return Ok(SettingsPlan::Write {
                content: new_json,
                status: InjectStatus::Created,
            });
        }
        Ok(Some(text)) => Some(text),
        Err(_) => None,
    };
    let parsed = current.as_deref().and_then(js_json::parse);
    let (Some(current), Some(parsed)) = (current, parsed) else {
        return if force {
            Ok(SettingsPlan::Write {
                content: new_json,
                status: InjectStatus::Updated,
            })
        } else {
            Err(SettingsFileDelegate)
        };
    };
    if ownership(&parsed).is_none_or(|(managed, _)| !managed) {
        if force {
            return Ok(SettingsPlan::Write {
                content: new_json,
                status: InjectStatus::Updated,
            });
        }
        let (JsValue::Object(existing), JsValue::Object(navori)) = (&parsed, settings) else {
            return Ok(SettingsPlan::Skip {
                reason: i18n::settings_not_object(lang).to_owned(),
                status: None,
            });
        };
        let merged = pretty(&JsValue::Object(merge_coexist_settings(existing, navori)));
        return Ok(if merged == current {
            SettingsPlan::Noop
        } else {
            SettingsPlan::Write {
                content: merged,
                status: InjectStatus::Updated,
            }
        });
    }
    Ok(match plan_stamped_json(&current, &new_json, floor, force) {
        StampedPlan::Noop => SettingsPlan::Noop,
        StampedPlan::Downgrade(version) => SettingsPlan::Skip {
            reason: i18n::block_from_newer_navori(lang, Some(&version)),
            status: Some(InjectStatus::DowngradeSkipped),
        },
        StampedPlan::Write(content) => SettingsPlan::Write {
            content,
            status: InjectStatus::Updated,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.claude/settings.json` absent, unreadable (`None`) or with this content.
    enum Settings {
        Absent,
        Unreadable,
        Text(String),
    }

    impl RepoView for Settings {
        fn read(&self, rel: &str) -> Option<String> {
            match self {
                Self::Text(text) if rel == SETTINGS_PATH => Some(text.clone()),
                _ => None,
            }
        }

        fn read_regular(&self, rel: &str) -> Option<String> {
            self.read(rel)
        }

        fn exists(&self, rel: &str) -> bool {
            rel == SETTINGS_PATH && !matches!(self, Self::Absent)
        }

        fn lexists(&self, rel: &str) -> bool {
            self.exists(rel)
        }

        fn list_dir(&self, _rel: &str) -> Option<Vec<String>> {
            None
        }

        fn symlink(&self, _rel: &str) -> Option<bool> {
            Some(false)
        }
    }

    fn settings(version: &str) -> JsValue {
        js_json::parse(&format!(
            r#"{{"$navori":{{"managed":true,"version":"{version}"}},"permissions":{{"deny":["R1"]}}}}"#
        ))
        .unwrap_or(JsValue::Null)
    }

    fn plan(view: &Settings, force: bool) -> Result<SettingsPlan, SettingsFileDelegate> {
        plan_settings(view, &settings(STAMP_VERSION), None, force, Lang::En)
    }

    fn write(content: String, status: InjectStatus) -> Result<SettingsPlan, SettingsFileDelegate> {
        Ok(SettingsPlan::Write { content, status })
    }

    #[test]
    fn absent_file_is_created() {
        assert_eq!(
            plan(&Settings::Absent, false),
            write(pretty(&settings(STAMP_VERSION)), InjectStatus::Created)
        );
    }

    #[test]
    fn unparseable_or_unreadable_delegates_unless_forced() {
        for view in [Settings::Unreadable, Settings::Text("{oops".to_owned())] {
            assert_eq!(plan(&view, false), Err(SettingsFileDelegate));
            assert_eq!(
                plan(&view, true),
                write(pretty(&settings(STAMP_VERSION)), InjectStatus::Updated)
            );
        }
    }

    #[test]
    fn foreign_non_object_is_skipped_unless_forced() {
        let view = Settings::Text("[1]\n".to_owned());
        assert_eq!(
            plan(&view, false),
            Ok(SettingsPlan::Skip {
                reason: i18n::settings_not_object(Lang::En).to_owned(),
                status: None,
            })
        );
        assert_eq!(
            plan(&view, true),
            write(pretty(&settings(STAMP_VERSION)), InjectStatus::Updated)
        );
    }

    #[test]
    fn foreign_object_is_merged_and_idempotent() {
        // `managed` must be the boolean `true`; a string keeps the file foreign.
        let view =
            Settings::Text("{\"$navori\":{\"managed\":\"true\"},\"model\":\"opus\"}\n".to_owned());
        let Ok(SettingsPlan::Write { content, status }) = plan(&view, false) else {
            panic!("expected a merge write");
        };
        assert_eq!(status, InjectStatus::Updated);
        assert!(
            content.contains("\"managedDeny\": [\n      \"R1\"\n    ]"),
            "{content}"
        );
        assert!(!content.contains(STAMP_VERSION), "{content}");
        assert_eq!(
            plan(&Settings::Text(content), false),
            Ok(SettingsPlan::Noop)
        );
    }

    #[test]
    fn owned_file_follows_the_stamp() {
        let same = Settings::Text(pretty(&settings("0.0.1")));
        // Same content under an older stamp: the stamp alone never forces a write.
        assert_eq!(
            plan_settings(&same, &settings(STAMP_VERSION), None, false, Lang::En),
            Ok(SettingsPlan::Noop)
        );
        let changed = js_json::parse(r#"{"$navori":{"managed":true,"version":"x"},"a":1}"#)
            .unwrap_or(JsValue::Null);
        assert_eq!(
            plan_settings(&same, &changed, None, false, Lang::En),
            write(pretty(&changed), InjectStatus::Updated)
        );
        let newer = Settings::Text(pretty(&settings("999.0.0")));
        assert_eq!(
            plan_settings(&newer, &changed, None, false, Lang::En),
            Ok(SettingsPlan::Skip {
                reason: i18n::block_from_newer_navori(Lang::En, Some("999.0.0")),
                status: Some(InjectStatus::DowngradeSkipped),
            })
        );
        assert_eq!(
            plan_settings(&same, &changed, Some("999.0.0"), false, Lang::En),
            Ok(SettingsPlan::Skip {
                reason: i18n::block_from_newer_navori(Lang::En, Some("999.0.0")),
                status: Some(InjectStatus::DowngradeSkipped),
            })
        );
        assert_eq!(
            plan_settings(&newer, &changed, None, true, Lang::En),
            write(pretty(&changed), InjectStatus::Updated)
        );
    }
}
