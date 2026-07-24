---
name: dashboard-ia
description: "Trigger: dashboard IA, admin panel information architecture, back-office UX, operator tool layout, organize a dashboard, admin navigation. Information architecture for operator/admin tools — entity-centric, dense, action-fast."
license: Apache-2.0
metadata:
  author: "ricardomarin"
  version: "1.0"
---

# Dashboard Information Architecture

## Activation Contract

Apply when structuring an admin / back-office / operator tool — where staff manage the records end users consume. For consumer products (web or mobile), use `app-ia` instead; the register is different.

## Hard Rules

- **Organize by ENTITY, not by action.** The operator thinks in records ("this customer"), not verbs ("payments"). A roster row opens the record's DETAIL page; every action on that record (edit, charge, promote, deactivate) lives on its detail — never on a separate action-page that forces re-finding the record.
- **See state, then act.** The landing view surfaces what needs attention (overdue, pending, failures) with quick counts — not an empty welcome screen.
- **Density over drama.** Tables are the primary surface: sortable, filterable, paginated, with real empty/loading/error states. Restrained register — no delight motion.
- **Status is computed, never hand-typed** — derive from domain rules, render as a Badge.
- **Selection from a growing set is searchable** (combobox), never a plain dropdown.
- **Always show the current operator** (identity + sign-out) so no one acts on the wrong account.
- **Enforcement is server-side.** Hiding a button is convenience; back every permission with a real policy.
- **Omit dead ends.** If an operator lacks read permission for an entity, remove it from the navigation entirely. "Access Denied" empty states should only catch direct URL navigation, never normal click paths.
- **Global search is mandatory.** Power users bypass click-navigation. Provide a global search or command palette (`Cmd + K`) to jump directly to a record's detail hub using unique identifiers (ID, email, reference number).
- **Sub-entities live inside the parent.** If a record has heavy 1-to-many relationships (e.g., a customer's payment history), organize them via tabs or sub-routes within the parent's detail page (e.g., `/customers/[id]/payments`). Never create floating, disconnected pages for dependent records.

## Decision Gates

| Situation                                     | Structure                                                     |
| --------------------------------------------- | ------------------------------------------------------------- |
| Acting on one record                          | Its detail page — actions inline                              |
| Acting on multiple records at once            | Table selection + Bulk action bar + Impact confirmation modal |
| Seeing activity across all records            | A read-only global log/table                                  |
| Deep 1-to-many relationships (child entities) | Tabs or sub-routes within the parent entity's detail hub      |
| A closed fixed set (≤7, never grows)          | Plain select                                                  |
| A growing set (records, people)               | Searchable combobox                                           |
| Destructive / irreversible                    | Confirm step; prefer append-only correction                   |

## Execution Steps

1. List the core ENTITIES; make each one's detail the hub for its actions + history.
2. Make the landing an at-a-glance "needs attention" view that links into the relevant detail.
3. Map every nav item to an entity or an overview — never to a verb.
4. Push business rules to a shared layer; the dashboard reads/writes, it does not redefine them.
5. Map out batch operations early (e.g., bulk approvals, reassignments); handle them on the landing table via row selection, followed by a summary confirmation step.
6. Structure nested routing to strictly reflect your database hierarchy (e.g., `/entities/:id/sub-entities`) so URLs remain shareable and preserve context.

## Output Contract

An IA where: nav items are entities/overviews (not actions), each record has one detail hub, the landing shows state first, and no flow forces re-selecting a record you already had.

## References

- Complement: `app-ia` for consumer products; `app-builder/references/dashboard-playbook.md` for build-time stack specifics.
