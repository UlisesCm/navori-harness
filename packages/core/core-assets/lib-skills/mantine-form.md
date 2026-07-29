---
name: mantine-form
description: Use when creating or touching forms with Mantine — @mantine/form patterns: useForm, getInputProps, validation with zodResolver, nested fields, and lists.
type: reference
---

# Mantine Form — conventions

## When to use this skill

When creating or touching a form with `@mantine/form`: wiring Mantine inputs, validating, handling submit, or nested/list fields. `useForm` is the form's source of truth — don't mirror its values in `useState`, and validate with a Zod schema (via `mantine-form-zod-resolver`), not with loose per-field functions.

## The pattern

`useForm` + `getInputProps` (spreads value/onChange/error in one shot) + `zodResolver` for the schema:

```tsx
const schema = z.object({
  email: z.string().email(),
  role: z.enum(['coach', 'coachee']),
});

const form = useForm({
  mode: 'uncontrolled',                 // fewer re-renders; the recommended default
  initialValues: { email: '', role: 'coachee' },
  validate: zodResolver(schema),        // from 'mantine-form-zod-resolver'
});

<form onSubmit={form.onSubmit((values) => save(values))}>
  <TextInput {...form.getInputProps('email')} />
  <Select data={['coach', 'coachee']} {...form.getInputProps('role')} />
  <Button type="submit">Save</Button>
</form>
```

## Gotchas that bite

- **`getInputProps('field')` wires everything; don't take it apart.** It already brings `value`/`onChange`/`error`/`onBlur`. Passing `value`/`onChange` by hand on top breaks the binding — let the spread rule.
- **`mode: 'uncontrolled'` changes how you read values.** In uncontrolled, `form.values` doesn't re-render on keystroke; to reflect a field in the UI use `form.watch('field')` or `form.getValues()`. In `controlled` it does re-render on every keystroke (more expensive in large forms).
- **Validation with `zodResolver`, not per-field functions.** `validate: { email: (v) => … }` scatters rules and types. A Zod schema + `zodResolver` gives a single source and the type via `z.infer`. Requires the `mantine-form-zod-resolver` package.
- **Nested/list fields with path notation.** `getInputProps('address.city')`, and lists with `form.insertListItem('items', {...})` / `form.removeListItem('items', i)` + `getInputProps('items.0.name')`. Don't manage the array in a separate `useState`.
- **`initialValues` defines the shape; fill it completely.** A missing field starts `undefined` → uncontrolled→controlled warning. For async editing use `form.setValues(data)` / `form.initialize(data)` in an effect, not hand-set values per render.
- **Submit with `form.onSubmit(handler)`.** It runs validation and only calls your handler if it passes; it also exposes a second callback `(errors) => …` to focus the first invalid field. Don't validate "by hand" before sending.

## Hard rules

1. `useForm` is the single source of the form state; no mirror `useState`.
2. Inputs wired with `getInputProps`; don't duplicate `value`/`onChange`.
3. Validation with a Zod schema via `zodResolver`; type via `z.infer`, no per-field rules.
4. Complete `initialValues`; async editing with `setValues`/`initialize`.
5. Submit via `form.onSubmit`; lists/nested with the path API, not loose arrays.

## Before declaring done

- All inputs use `getInputProps`; no mirror state or duplicated handlers.
- Validation centralized in a Zod schema with `zodResolver`; types via `z.infer`.
- `initialValues` set; no uncontrolled→controlled warnings. Submit with `form.onSubmit`.
- `{{qualityGate.fast}}` green.
