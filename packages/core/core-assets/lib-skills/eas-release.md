---
name: eas-release
description: Use when touching eas.json build/submit profiles, deciding between an OTA update and a new native build, wiring per-environment env vars/secrets for a build, or preparing a store submission. Only applies to a repo that actually has eas.json — an Expo app without it doesn't use EAS and this skill doesn't apply. Not for expo-router (routing) or Uniwind (styling).
metadata:
  type: reference
---

# EAS Build/Submit/Update

EAS CLI flags move between minors, so confirm any command against `eas --help` / the installed CLI version before relying on it. Not every Expo project uses EAS — check `eas.json` exists before applying anything here.

## `eas.json` shape

- `cli.version` pins the minimum EAS CLI version; `cli.appVersionSource: "remote"` means the store version is tracked by EAS, not read from the local Expo config.
- `build.<profile>` — one block per build profile (e.g. `development`, `preview`, `production`). Fields seen in practice: `developmentClient`, `distribution` (`internal` vs store), `channel` (the EAS Update channel this build's runtime binds to), `autoIncrement`.
- `submit.<profile>` — store submission config, keyed by the same profile names.

## Channels, branches, and runtime compatibility

- A **channel** is what a built binary listens on for OTA updates; an **update** is published to a **branch**, and a channel maps to a branch (by default, same name). A build's `channel` decides which branch its installs pull from.
- **runtimeVersion** is the real compatibility gate, not the channel name: an OTA update only reaches a binary whose `runtimeVersion` matches. Three policies — `appVersion` (from the app's version string), `nativeVersion` (from native fields like `CFBundleVersion`/`versionCode`), `fingerprint` (a hash of the native project — a native-dependency change bumps it automatically, so a JS-only change stays compatible). No default; pick one explicitly.

## OTA update vs new native build

- **Safe as an OTA update**: JS/TS changes, assets, most React Native code — anything that doesn't touch native modules, permissions, `app.json`/`app.config.ts` native fields, or the Expo SDK version.
- **Needs a new native build**: a new/updated native module, a config plugin change, a permission, an SDK upgrade. Under `fingerprint` this is automatic; under `appVersion`/`nativeVersion` it's a manual call — get it wrong and the update either misses everyone or crashes a binary that can't support it.

## Env vars, secrets, and source maps

- Per-environment values inject at build time via `eas.json`'s per-profile `env` block or EAS's environment-variable store, managed with `eas env:set`/`get`/`list`/`pull`/`push`/`delete`/`exec` — creating a variable goes through `env:set`, there is no `env:create`. Default environments: `development`, `preview`, `production`. Visibility: plain text, sensitive, or secret (secret never readable outside EAS's servers).
- Source maps (e.g. Sentry) upload as a build/update step so stack traces resolve to real source — wire into CI, not a manual local step.

## Store submission basics

`submit.<profile>` in `eas.json` holds store-specific fields (e.g. an Apple/Google service account reference) — never a raw credential committed to the repo. A submission consumes a build already produced by `build.<profile>`; it doesn't rebuild.

## Before declaring done

Copy and check off:

- [ ] `eas.json` actually exists in this repo before applying any of the above.
- [ ] The change is classified correctly as OTA-safe vs native-build-required.
- [ ] No secret/API key is hardcoded per environment — it goes through EAS env or the profile's `env` block.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's release process (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The branch-to-channel-to-environment mapping in use.
     - The runtimeVersion policy chosen and why.
     - Where secrets are managed (EAS env, a secrets manager) and who can rotate them.
-->
