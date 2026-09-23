---
name: dashboard-patterns
description: Use when building or changing an admin or back-office screen — a data table, a record detail, a record picker, a create/edit form, a destructive action, or who may see or do what. Library-agnostic rules for staff-facing CRUD, whatever the UI kit. Not for component APIs (see the UI library's skill) or charts.
metadata:
  type: reference
---

# Admin dashboards — patterns that hold across stacks

Each rule is an outcome to verify, not an API — map it to the repo's UI kit, table, and router.

## Lists

- **One shared table component per repo;** new lists reuse it.
- **Screen state lives in the URL** (search, filters, sort, page, tab), so reload, links, and Back restore the view. Typing replaces the entry (debounced); discrete filters push one. A filter change resets to page 1.
- **Server pagination means server sort and filter too** — otherwise they only act on the loaded page.
- **Three distinct non-data states:** first use (with the create action), no results (with "clear filters"), and error (with retry). A failed request is never rendered as an empty list.

## Records

- **A record is reachable by URL** (`/entity/<id>`, or a URL param that opens its drawer); rows link to it with a real link.
- **Actions live with the record** — its detail page, or one or two inline in the row — never on a separate page that makes the operator re-find it. Bulk actions start from row selection.
- **Status label and color come from one shared domain function**, never from strings repeated per screen.

## Pickers and forms

- **Choosing a record from a growing set** (a person, a company) uses a searchable picker that queries the server. If results are capped, say so in the UI.
- Up to ~5 fixed options: radios or a segmented control; larger fixed sets: a select. Date picker, except dates the person already knows (birth date): a typed field. Free text only for open values.
- Schema validation at the boundary, errors on the field.

## Destructive actions

- **Confirm only what can't be undone.** The dialog names the record and the consequence, the confirm button states the action ("Delete coachee"), and focus starts on the safe option.
- When the backend can revert it (soft delete, deferred commit), offer undo instead of a confirm.

## Authorization and export

- Hiding a button is convenience, not security: the API enforces every permission (see `security-invariants`).
- CSV export: text cells starting with `=`, `+`, `-`, `@`, tab, or CR get a leading `'`; quote every field and escape `"`. Leave numbers alone.

## Shell

- Navigation collapses and works at phone width; the signed-in operator is always visible, with sign-out.

## Before declaring done

Copy and check off:

- [ ] Reload and Back restore filters, sort, page, and tab.
- [ ] The list shows distinct first-use, no-results, and error states — force the error once.
- [ ] With server pagination, sort and filter change the request, not just the visible page.
- [ ] Record pickers search the server; no silent cap.
- [ ] The API rejects the action with a low-role token — tested, not just hidden.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's dashboard (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The shared table, picker, and confirm components, with their paths.
     - How URL state is kept (router search params, nuqs…).
     - Roles, where the API enforces them, and the audit log.
     - Domain policy, e.g. financial records corrected with a new entry, never edited in place.
     - Status helpers and the domain module they live in.
-->
