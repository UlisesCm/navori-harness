# navori master template ux

Functional UX contract for design-system tools such as Navori Heron. Each section carries a `<!-- ux-kind: … -->` marker that `navori master check` uses to validate it.

## Metadata
<!-- ux-kind: metadata -->

Project, master-plan stage, date, mode (`template`, `en-curso` or `desde-cero`), surfaces included, relevant actors, source files used.

## Sources and authority
<!-- ux-kind: sources -->

Base documents: `DECISIONS.md`, `MASTER.md`, `parts.json`, `context/DIGEST.md`, `context/CODEBASE.md`, `context/md/*`. Auxiliary plans: `plan1.md`, `plan2.md`, `plan3.md`. Priority: explicit decision in `DECISIONS.md` over UX inferences.

## Surfaces
<!-- ux-kind: surfaces -->

List all human-facing interfaces. For each surface: ID (`MOBILE`, `DASHBOARD`, etc.), name, actors using it, purpose, main capabilities, Master Plan constraints, related requirements (`RN-*`, `RF-*`, `RNF-*`, `P<n>`).

## Actors
<!-- ux-kind: actors -->

Per actor: ID (`ACT-<NAME>`), name, main goal, capabilities, constraints, surfaces used, forbidden actions, relationships with other actors.

## Journeys
<!-- ux-kind: journeys -->

A Journey (`J<nn>`) represents an end-to-end user goal. Include: ID, name, actor, goal, trigger, initial state, expected result, involved flows (`F<nn>`), related requirements, relevant exceptions.

## Flows
<!-- ux-kind: flows -->

A Flow (`F<nn>`) is a concrete interaction sequence. Include: ID, name, actor, purpose, trigger, preconditions, main steps, decision points, alternate states, errors, final result, related screens (`SCR-*`), related requirements (`RN-*`, `RF-*`, `RNF-*`).

## Information architecture
<!-- ux-kind: information-architecture -->

Conceptual organization of each surface. Do not decide visual components. Include sections, subsections, logical hierarchy reflecting real Master Plan capabilities.

## Screen inventory
<!-- ux-kind: screens -->

Each screen (`SCR-<SURFACE>-<nn>`): ID, name, surface, actor, purpose (single sentence), related requirements (`RN-*`, `RF-*`, `RNF-*`, `P<n>`), related journeys and flows, needed information, actions (primary, secondary, destructive), states, conditions, navigation, permissions, important events.

## Functional components
<!-- ux-kind: components -->

Reusable conceptual components (`C<nn>`), not framework-specific. Include: ID, name, responsibility, required information, available actions, states, screens where it appears, functional variations.

## Functional patterns
<!-- ux-kind: patterns -->

Recurring behaviors (`PT<nn>`): search, filters, pagination, infinite lists, forms, confirmation, authentication, onboarding, empty states, error recovery, tables, detail views, QR, etc. Per pattern: ID, name, purpose, screens using it, needed states, functional rules, related requirements.

## Global states
<!-- ux-kind: global-states -->

States Heron should consider: `loading`, `empty`, `error`, `offline`, `unauthorized`, `forbidden`, `success`, `disabled`, `partial data`. Add domain-specific states (e.g. `membership-expired`, `benefit-exhausted`). Not every screen needs every state.

## UX requirements
<!-- ux-kind: ux-requirements -->

Observable, identifiable requirements (`UX-<n>`): must derive from product needs, not be purely aesthetic. E.g. "User must know membership status before starting redemption", "Relevant constraints must be available before confirming".

## Navigation
<!-- ux-kind: navigation -->

Conceptual navigation model per surface: root screens, secondary screens, screen-to-screen navigation, relevant deep links, back behavior, entry points, cross-surface flows. Do not decide concrete tabs, sidebar, drawer unless functional requirement mandates it.

## Cross-surface flows
<!-- ux-kind: cross-surface -->

When a process spans multiple applications: which actor acts, in which surface, what information transfers, what results can occur. E.g. Client mobile → Partner → Backend → Client result.

## Traceability matrix
<!-- ux-kind: traceability -->

Table relating: Requirement → Journey → Flow → Screens → Patterns. Every functional requirement with visible impact should appear at least once. Format: table with columns `Requirement`, `Journey`, `Flow`, `Screens`, `Patterns`.

## Screen coverage
<!-- ux-kind: screen-coverage -->

Per screen: why does it exist? What requirement does it cover? Which actor uses it? What information does it need? What actions does it allow? What states does it handle? Which flow does it participate in? If any answer is missing, reconsider if the screen is truly necessary.

## Open UX questions
<!-- ux-kind: open-questions -->

None

## Out of scope
<!-- ux-kind: out-of-scope -->

Explicitly state UX deliberately out of this stage (e.g. corporate onboarding, review system, advanced campaign management). This prevents Heron from designing features not yet part of the product.

## UX Contract validation
<!-- ux-kind: checklist -->

- [ ] All human surfaces are declared.
- [ ] All relevant actors have a surface.
- [ ] Each actor's main goals have a Journey.
- [ ] Every Journey is composed of Flows.
- [ ] Every Flow references screens.
- [ ] Every screen has a purpose.
- [ ] Every screen has related requirements.
- [ ] Every screen declares information, actions and states.
- [ ] Critical errors and alternate states are covered.
- [ ] Cross-surface flows are defined.
- [ ] Recurring patterns are identified.
- [ ] No arbitrary visual decisions present.
- [ ] No UI framework dependencies present.
- [ ] Does not contradict MASTER.md or DECISIONS.md.
- [ ] Does not repeat already-resolved questions.
- [ ] Requirement → Journey → Flow → Screen traceability exists.
- [ ] No open UX questions blocking design.

## Heron constraints
<!-- ux-kind: heron-handoff -->

### Heron MUST preserve

Business rules, roles, permissions, requirements, explicit decisions, required capabilities, business states, mandatory flows.

### Heron MAY improve

Screen grouping, information architecture, navigation, step reduction, pattern reuse, UX naming, functional composition — as long as requirements are preserved.

### Heron owns

Layout, visual hierarchy, art direction, brand-derived palette, typography, spacing, grid, density, iconography, responsive behavior, motion, component visual design, Design System, visual accessibility, Penpot implementation.
