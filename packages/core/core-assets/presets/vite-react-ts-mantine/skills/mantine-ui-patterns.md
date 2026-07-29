---
name: mantine-ui-patterns
description: Use when creating or modifying React components with Mantine — rules for UI: use the lib's components instead of raw HTML, theming, responsive.
type: reference
---

# Mantine UI patterns — project conventions

## When to use this skill

Before writing a new React component or modifying an existing one. Mantine already provides 100+ components with accessibility, theming, and dark mode built in; reinventing one with `<div>` breaks visual consistency and adds a11y bugs.

## Hard rules

1. **`<Button>` over `<button>`.** Same with `<TextInput>` (not `<input>`), `<Stack>` (not `<div style={{ display: 'flex', flexDirection: 'column' }}>`), `<Group>` (not horizontal flex), `<Title>` (not `<h1>`). If the Mantine component doesn't cover your case, first confirm it doesn't exist — the lib is huge.
2. **Theming centralized in `theme.ts`.** Colors, spacing, radii, breakpoints live in the `MantineThemeOverride` object. Don't hardcode `#3b82f6` or `padding: 12px` in components — use `var(--mantine-color-blue-6)`, `theme.spacing.sm`, or the `c="blue.6"` prop.
3. **Props over `style={{ ... }}`.** Mantine accepts `mt`, `mb`, `p`, `gap`, `c`, `bg`, etc. as direct props. They follow the theme's token system. `style={{ marginTop: 16 }}` breaks responsive + theming.
4. **Responsive with `visibleFrom` / `hiddenFrom` or a responsive prop.** Don't gate rendering with `window.innerWidth`. Mantine already has breakpoints + hooks (`useMediaQuery`).
5. **Forms with `@mantine/form` in `mode: 'uncontrolled'` (recommended in v8), not hand-rolled state.** It stores values in a ref (no re-render per keystroke), but it requires `key={form.key('field')}` on each input or `setFieldValue`/`setValues` won't refresh (silent bug), and you read with `form.getValues()`, not `form.values`.

## Typical pattern

```tsx
import { Stack, TextInput, Button, Title, Group } from "@mantine/core";
import { useForm } from "@mantine/form";

export function CreateUserForm({ onSubmit }: Props) {
  const form = useForm({
    mode: "uncontrolled",                    // recommended in v8
    initialValues: { email: "", name: "" },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : "Email inválido"),
      name: (v) => (v.length < 2 ? "Mínimo 2 caracteres" : null),
    },
  });

  return (
    <form onSubmit={form.onSubmit(onSubmit)}>
      <Stack gap="md">
        <Title order={3}>Crear usuario</Title>
        <TextInput
          label="Email"
          placeholder="user@example.com"
          required
          key={form.key("email")}
          {...form.getInputProps("email")}
        />
        <TextInput label="Nombre" required key={form.key("name")} {...form.getInputProps("name")} />
        <Group justify="flex-end">
          <Button type="submit" loading={form.submitting}>Guardar</Button>
        </Group>
      </Stack>
    </form>
  );
}
```

## Quick table

| I need | Mantine component |
|---|---|
| Button | `<Button>` (variants: filled/outline/light/subtle) |
| Text input | `<TextInput>` |
| Select | `<Select>` (single) / `<MultiSelect>` |
| Date picker | `@mantine/dates` → `<DatePicker>` / `<DateInput>` |
| Vertical layout | `<Stack gap="md">` |
| Horizontal layout | `<Group justify="space-between">` |
| Responsive grid | `<Grid>` or `<SimpleGrid cols={{ base: 1, md: 2 }}>` |
| Card / container | `<Paper p="md" radius="md" shadow="sm">` |
| Modal | `<Modal opened={x} onClose={...}>` (use `useDisclosure`) |
| Loading / Tooltip | `<Loader>` or `loading` on `<Button>` / `<Tooltip label>` |
| Toast notif | `notifications.show({ message })` from `@mantine/notifications` |

## Before calling the change "done"

- `{{qualityGate.fast}}` green; tested in dark mode (if it breaks, you used a hardcoded color) and responsive (mobile < 768px).
- Zero `<div style>` with flex/grid → `<Stack>`/`<Group>`/`<SimpleGrid>`; zero hex in components → `theme.colors`.
