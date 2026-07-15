---
name: react-hook-form
description: Patrones de React Hook Form en React+TS — register vs Controller, zodResolver, errores por campo, re-renders. Aplica al crear o tocar formularios con RHF.
type: reference
---

# React Hook Form — convenciones

## Cuándo usar este skill

Al crear o tocar un formulario con RHF: validación con Zod, submit, errores, o cablear inputs de una lib controlada (Mantine/MUI `Select`, `DatePicker`). RHF es la fuente de verdad del form — no dupliques sus valores en `useState`. Ventaja sobre Formik: los inputs nativos van **uncontrolled** (vía refs), así que teclear no re-renderiza el form entero.

## El patrón

Uncontrolled por defecto + Zod como schema + `Controller` **solo** donde el input no emite un evento DOM nativo.

```tsx
const schema = z.object({ email: z.string().email(), role: z.enum(['coach', 'coachee']) });
type FormValues = z.infer<typeof schema>;

const { register, control, handleSubmit, formState: { errors, isSubmitting } } =
  useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', role: 'coachee' } });

<TextInput error={errors.email?.message} {...register('email')} />  // nativo → register
// Select de Mantine (onChange da el valor, no un event) → Controller:
<Controller control={control} name="role" render={({ field, fieldState }) => (
  <Select data={['coach','coachee']} error={fieldState.error?.message} {...field} />
)} />
```

## Gotchas que muerden

- **`register` por defecto; `Controller` es la excepción.** Un input que reenvía `ref` y dispara `onChange` con un evento DOM (texto, textarea, checkbox nativo, `<TextInput>` de Mantine) va con `{...register('campo')}`. Envolverlo en `Controller` re-introduce el re-render por tecla que RHF existe para evitar.
- **Cuándo SÍ va `Controller`:** componentes cuyo `onChange` entrega el **valor directo** — Mantine `Select`/`MultiSelect`/`NumberInput`/`DateInput`, todo MUI, `react-select`. Cablea `field.value`/`onChange`/`onBlur`/`ref`; el error sale de `fieldState.error?.message`.
- **`defaultValues` no es opcional.** Sin él, un campo arranca `undefined` → warning "uncontrolled to controlled" (`Controller` con `undefined` es inválido: usa `null`/`''`). Para edición async usa `reset(data)` en un `useEffect`, no valores a mano en cada render.
- **`watch()` re-renderiza todo.** Para leer en submit usa `getValues('campo')`; para que un hijo dependa de un campo, `useWatch({ control, name })` en ese hijo. `watch()` global en un form grande es anti-patrón.
- **Números: `register('age', { valueAsNumber: true })`.** Sin esto un `type="number"` entrega **string** y tu `z.number()` falla. Corre antes del resolver, así validas con `z.number()` directo.
- **`useFieldArray` con `key={field.id}`, nunca el índice** (corrompe el estado al reordenar). Error de servidor con `setError('root.server', …)`, no en un campo.

## Reglas duras

1. Validación en schema Zod vía `zodResolver`; tipo por `z.infer`. Nada de `rules` inline ni tipos paralelos.
2. `register` por defecto; `Controller` solo para inputs sin evento DOM nativo.
3. `defaultValues` siempre; edición async con `reset(data)`, sin `useState` espejo.
4. `getValues`/`useWatch` para leer sin re-render; `isSubmitting` deshabilita el botón.

## Tabla rápida

| Input | Cómo cablear |
|---|---|
| Texto / textarea / checkbox nativo | `{...register('campo')}` |
| Número | `register('n', { valueAsNumber: true })` |
| Select / Date / Number de Mantine/MUI | `<Controller>` + `{...field}` |
| Lista dinámica | `useFieldArray` + `key={field.id}` |

## Antes de declarar listo

- Zod + `zodResolver`, tipo por `z.infer`; `Controller` para inputs controlados, `register` para texto; sin `useState` espejo.
- `defaultValues` seteado; sin warnings "uncontrolled to controlled". Submit con `handleSubmit` + `isSubmitting`.
- `{{qualityGate.fast}}` en verde.
</content>
