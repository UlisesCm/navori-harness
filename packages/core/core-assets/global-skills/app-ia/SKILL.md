---
name: app-ia
description: "Trigger: app information architecture, mobile app IA, consumer app UX, navigation model, onboarding flow, core loop, screen hierarchy, web app IA. Information architecture for consumer products (web + mobile) — flow-centric, one primary action, low cognitive load."
license: Apache-2.0
metadata:
  author: "ricardomarin"
  version: "1.0"
---

# App Information Architecture

## Activation Contract

Apply when structuring a consumer product (mobile or web app) — something a user adopts for their own goal. For operator/admin tools, use `dashboard-ia` instead. Covers web and mobile together; platform differences are execution, not IA.

## Hard Rules

- **Organize around the CORE LOOP.** Identify the one repeated action that IS the product; the home/hero screen is that loop, reachable in zero taps.
- **One primary action per screen.** Every screen has a single obvious next step; secondary actions recede. Ambiguity is cognitive load.
- **Progressive disclosure.** Show the minimum needed to act now; reveal depth on demand. Never front-load settings, edge cases, or rare flows.
- **Onboarding drives to first value fast** — the shortest path to the user's first "it worked" moment, with minimum questions.
- **Navigation mirrors the user's TASKS,** not your data model or org chart. Name sections by what the user does, not by backend tables.
- **Match the user's mental model and language** — labels are the user's words, not internal jargon.
- **Empty states are conversion ramps.** A blank screen on day 1 is not an error; it must feature a clear Call to Action (CTA) that instantly triggers the core loop. Never show a dead end.
- **Ask for permissions in context (Just-in-Time).** Request access to camera, location, or notifications only when the user initiates an action that explicitly requires them — never front-load them in the onboarding flow.
- **Design the core loop for Optimistic UI.** Consumer apps face spotty connectivity. Assume success on primary actions instantly on the client to avoid blocking the user, syncing with the server in the background.

## Decision Gates

| Signal                             | Nav model                                  |
| ---------------------------------- | ------------------------------------------ |
| 3–5 peer areas, frequent switching | Bottom tabs (mobile) / top nav (web)       |
| One dominant loop + shallow extras | Single home + push/modals                  |
| Deep hierarchy, browse-heavy       | Drill-down stack + search                  |
| Rare / one-off flow                | Modal or dedicated route, off the main nav |

## Platform Notes

- **Mobile:** thumb reach (primary actions low), bottom tabs, gestures, one column, respect safe-area insets.
- **Web:** more space plus hover/keyboard, top or side nav, multi-column where it aids scanning — but keep the core loop unmistakable.

## Execution Steps

1. Name the core loop in one sentence; make it the home screen.
2. For each screen, state its ONE primary action; demote everything else.
3. Map top-level nav to user tasks; park rare flows off the main nav.
4. Design onboarding backward from the first-value moment.
5. Map the logical back-stack for deep links. Ensure users entering deep into the app via a URL or push notification can navigate up to the app's root via the "back" button, rather than getting trapped or exiting the app.

## Output Contract

An IA where: the core loop is the home, each screen has one clear primary action, nav is task-named, onboarding reaches first value in the fewest steps, deep links have a logical back-stack, and empty states drive immediate action.

## References

- Complement: `dashboard-ia` for operator tools; `app-builder/references/not-boring-mobile` for the delight visual register on mobile.
