---
name: shadcn-base-ui
description: Use when adding or editing a shadcn/ui component built on Base UI (@base-ui/react) — copied-in primitives, the `render` prop instead of `asChild`, variant/cn patterns. Not for the Radix flavor of shadcn/ui (different API).
metadata:
  type: reference
---

# shadcn/ui (Base UI flavor) — conventions

## When to use this skill

When adding a component with the shadcn CLI or editing one already copied into `src/components/ui/`. Target version: shadcn CLI 4.21 generating components on top of `@base-ui/react` 1.8. shadcn/ui ships in two flavors — Radix and Base UI — with different primitive APIs; **check `components.json` first**: `@base-ui/react` in dependencies/aliases means this skill applies, `@radix-ui/*` means the Radix flavor and these notes don't apply. On a different major of either package, recheck the API before applying — `render` vs `asChild` and the part names below are exactly the kind of thing that shifts across majors.

## The pattern

Components are copied into the repo via `npx shadcn add <component>` and owned by the app from then on — they are not an npm dependency you bump, they're code you maintain like any other file. `components.json` drives the CLI: style, the Tailwind CSS path, and aliases (e.g. `#components/ui`, `#lib/utils`).

```tsx
// src/components/ui/button.tsx
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva } from 'class-variance-authority';
import { cn } from '#lib/utils';

const buttonVariants = cva('base classes...', {
  variants: { variant: { default: '...', destructive: '...' }, size: { default: '...', sm: '...' } },
});

function Button({ variant, size, className, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
```

## Gotchas that bite

- **`render`, not `asChild`.** Base UI's mechanism for "render as a different element/component" is a `render` prop — `render={<a href="..." />}` or `render={(props) => <CustomEl {...props} />}`. `asChild` does not exist in Base UI's types at all; a ported Radix pattern that assumes `asChild` will not type-check.
- **Part names differ from Radix.** Each primitive splits into subcomponents, e.g. `AlertDialogPrimitive.Root/Trigger/Portal/Backdrop/Popup`. Base UI calls the overlay `Backdrop` and the content `Popup` where Radix calls them `Overlay`/`Content` — a Radix example copied by name references parts that don't exist here.
- **Type each part from its own namespace, not by hand.** Use `AlertDialogPrimitive.Popup.Props` (per-part `.Props`) rather than writing the prop shape yourself.
- **Open/closed state drives styling through data-attributes, not a boolean prop.** Base UI sets `data-open`/`data-closed`; the Tailwind convention is `data-open:animate-in data-closed:animate-out`, not `className={open ? 'a' : 'b'}`.
- **`data-slot="..."` on every primitive wrapper is this codebase's own convention**, used as a styling hook (`group-data-[slot=...]`) and for tests — keep it when adding a new primitive.
- **Never re-implement a modal/select/combobox with raw `div`s and manual `onKeyDown`.** Base UI primitives ship correct ARIA roles, focus trap, and keyboard nav out of the box; hand-rolling one silently drops that contract.

## Hard rules

1. Check `components.json` for `@base-ui/react` vs `@radix-ui/*` before writing or porting a component; the APIs are not interchangeable.
2. Composition via `render`, never `asChild` — it doesn't exist on this flavor.
3. Part props are typed via the primitive's own `*.Props` namespace, never hand-declared.
4. `data-slot` is set on every new primitive wrapper.
5. No raw-div reimplementation of a primitive that already exists in `components/ui/`.

## Before declaring done

- No `asChild` usage anywhere in touched files; composition goes through `render`.
- New/edited primitives keep `data-slot` and use `cva`/`cn` for variants like the existing components.
- Part prop types come from the primitive's own namespace, not hand-written interfaces.
- `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's UI primitives (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The theming setup: base color, CSS variables, dark mode toggle.
     - Which components have been customized beyond the CLI's generated output.
     - The alias convention (`#components/ui`, etc.) and where it's configured.
     - Any house rule for when to add a new shadcn component vs. reuse an existing one.
-->
