---
name: react-hook-form
description: Use when creating or touching forms with RHF — React Hook Form patterns in React+TS: register vs Controller, zodResolver, per-field errors, re-renders.
type: reference
---

# React Hook Form — conventions

## When to use this skill

When creating or touching a form with RHF: validation with Zod, submit, errors, or wiring inputs from a controlled lib (Mantine/MUI `Select`, `DatePicker`). RHF is the form's source of truth — don't duplicate its values in `useState`. Advantage over Formik: native inputs are **uncontrolled** (via refs), so typing doesn't re-render the whole form.

## The pattern

Uncontrolled by default + Zod as the schema + `Controller` **only** where the input doesn't emit a native DOM event.

```tsx
const schema = z.object({ email: z.string().email(), role: z.enum(['coach', 'coachee']) });
type FormValues = z.infer<typeof schema>;

const { register, control, handleSubmit, formState: { errors, isSubmitting } } =
  useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', role: 'coachee' } });

<TextInput error={errors.email?.message} {...register('email')} />  // native → register
// Mantine Select (onChange gives the value, not an event) → Controller:
<Controller control={control} name="role" render={({ field, fieldState }) => (
  <Select data={['coach','coachee']} error={fieldState.error?.message} {...field} />
)} />
```

## Gotchas that bite

- **`register` by default; `Controller` is the exception.** An input that forwards `ref` and fires `onChange` with a DOM event (text, textarea, native checkbox, Mantine's `<TextInput>`) goes with `{...register('field')}`. Wrapping it in `Controller` reintroduces the per-keystroke re-render RHF exists to avoid.
- **When `Controller` IS needed:** components whose `onChange` delivers the **value directly** — Mantine `Select`/`MultiSelect`/`NumberInput`/`DateInput`, all of MUI, `react-select`. Wire `field.value`/`onChange`/`onBlur`/`ref`; the error comes from `fieldState.error?.message`.
- **`defaultValues` is not optional.** Without it, a field starts `undefined` → "uncontrolled to controlled" warning (`Controller` with `undefined` is invalid: use `null`/`''`). For async editing use `reset(data)` in a `useEffect`, not hand-set values on every render.
- **`watch()` re-renders everything.** To read on submit use `getValues('field')`; for a child to depend on a field, `useWatch({ control, name })` in that child. A global `watch()` in a large form is an anti-pattern.
- **Numbers: `register('age', { valueAsNumber: true })`.** Without it a `type="number"` delivers a **string** and your `z.number()` fails. It runs before the resolver, so you validate with `z.number()` directly.
- **`useFieldArray` with `key={field.id}`, never the index** (corrupts the state on reorder). Server error with `setError('root.server', …)`, not on a field.

## Hard rules

1. Validation in a Zod schema via `zodResolver`; type via `z.infer`. No inline `rules` or parallel types.
2. `register` by default; `Controller` only for inputs without a native DOM event.
3. `defaultValues` always; async editing with `reset(data)`, no mirror `useState`.
4. `getValues`/`useWatch` to read without re-render; `isSubmitting` disables the button.

## Quick table

| Input | How to wire |
|---|---|
| Text / textarea / native checkbox | `{...register('field')}` |
| Number | `register('n', { valueAsNumber: true })` |
| Mantine/MUI Select / Date / Number | `<Controller>` + `{...field}` |
| Dynamic list | `useFieldArray` + `key={field.id}` |

## Before declaring done

- Zod + `zodResolver`, type via `z.infer`; `Controller` for controlled inputs, `register` for text; no mirror `useState`.
- `defaultValues` set; no "uncontrolled to controlled" warnings. Submit with `handleSubmit` + `isSubmitting`.
- `{{qualityGate.fast}}` green.
</content>
