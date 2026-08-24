---
name: i18next
description: Use when touching user-facing copy — i18next: zero hardcoded strings, keys present in every locale, plurals with count, and translating outside components.
type: reference
---

# i18next — conventions

## When to use this skill

When adding or changing any text the user reads. In a repo with i18next a literal string in JSX is not a shortcut: it's a string that will never be translated and that nobody will find again.

## The pattern

Key with a namespace, and interpolation instead of concatenation:

```tsx
const { t } = useTranslation("sessions");

<Text>{t("detail.title")}</Text>
<Text>{t("detail.remaining", { count: remaining })}</Text>
```

```json
// locales/en/sessions.json
{
  "detail": {
    "title": "Session detail",
    "remaining_one": "{{raw:count}} session left",
    "remaining_other": "{{raw:count}} sessions left"
  }
}
```

## Gotchas that bite

- **A key added to one locale only.** i18next falls back and shows the other language — or the raw key — with no error. Every key lands in EVERY locale in the same commit, even if the translation is provisional.
- **Concatenating translated fragments produces unusable sentences.** `t("hello") + " " + name` breaks in any language with a different word order. One key for the whole sentence with `{{raw:interpolation}}`.
- **Plurals go through `count`, not an `if`.** The `_one`/`_other` suffixes are resolved by i18next per locale (some have more than two forms). A hand-rolled ternary is wrong outside English.
- **`useTranslation` doesn't work outside a component.** In a util/service/thunk, use the `i18n.t` instance — but beware: a module evaluated at import time captures the language BEFORE it's initialized. Translate at call time, never at module scope.
- **A key is not a sentence.** `t("The user has no sessions")` as the key works until the copy changes and every locale silently loses its entry. Structured keys (`sessions.empty.title`).
- **Changing the language does not re-render what isn't subscribed.** Text read outside the hook (or memoized) stays in the previous language until a remount.
- **Interpolated HTML gets escaped.** For copy with a link or bold, use `<Trans>`, not `dangerouslySetInnerHTML`.

## Hard rules

1. Zero literal strings in the UI — everything goes through `t`.
2. A new key lands in ALL locales in the same commit.
3. Whole sentences with interpolation; never concatenated fragments.
4. Plurals with `count` and the `_one`/`_other` forms.
5. Outside a component, `i18n.t` at call time, never captured at module scope.

## Before declaring done

- Switching the language changes every added text.
- No key is missing in any locale (a lint/script check, if the repo has one).
- Sentences with variables read correctly in both languages.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's translations (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The supported locales and which one is the fallback.
     - Namespaces and what each covers — plus where the key files live.
     - The key naming convention (and whether a key missing in one locale breaks the build).
     - How the language is chosen and persisted for the user.
-->
