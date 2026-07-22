---
name: mantine-form
description: Patrones de @mantine/form — useForm, getInputProps, validación con zodResolver, campos anidados y listas. Aplica al crear o tocar formularios con Mantine.
type: reference
---

# Mantine Form — convenciones

## Cuándo usar este skill

Al crear o tocar un formulario con `@mantine/form`: cablear inputs de Mantine, validar, manejar submit, o campos anidados/listas. `useForm` es la fuente de verdad del form — no espejees sus valores en `useState`, y valida con un schema Zod (vía `mantine-form-zod-resolver`), no con funciones sueltas por campo.

## El patrón

`useForm` + `getInputProps` (esparce value/onChange/error de un jalón) + `zodResolver` para el schema:

```tsx
const schema = z.object({
  email: z.string().email(),
  role: z.enum(['coach', 'coachee']),
});

const form = useForm({
  mode: 'uncontrolled',                 // menos re-renders; el default recomendado
  initialValues: { email: '', role: 'coachee' },
  validate: zodResolver(schema),        // desde 'mantine-form-zod-resolver'
});

<form onSubmit={form.onSubmit((values) => save(values))}>
  <TextInput {...form.getInputProps('email')} />
  <Select data={['coach', 'coachee']} {...form.getInputProps('role')} />
  <Button type="submit">Guardar</Button>
</form>
```

## Gotchas que muerden

- **`getInputProps('campo')` cablea todo; no lo desarmes.** Ya trae `value`/`onChange`/`error`/`onBlur`. Pasar `value`/`onChange` a mano encima rompe el binding — deja que el spread mande.
- **`mode: 'uncontrolled'` cambia cómo lees valores.** En uncontrolled, `form.values` no re-renderiza al teclear; para reflejar un campo en la UI usa `form.watch('campo')` o `form.getValues()`. En `controlled` sí re-renderiza cada tecla (más caro en forms grandes).
- **Validación con `zodResolver`, no funciones por campo.** `validate: { email: (v) => … }` disemina reglas y tipos. Un schema Zod + `zodResolver` da una fuente única y el tipo por `z.infer`. Requiere el paquete `mantine-form-zod-resolver`.
- **Campos anidados/listas con notación de path.** `getInputProps('address.city')`, y listas con `form.insertListItem('items', {...})` / `form.removeListItem('items', i)` + `getInputProps('items.0.name')`. No manejes el array en `useState` aparte.
- **`initialValues` define el shape; llénalo completo.** Un campo ausente arranca `undefined` → warning uncontrolled→controlled. Para edición async usa `form.setValues(data)` / `form.initialize(data)` en un efecto, no valores a mano por render.
- **Submit con `form.onSubmit(handler)`.** Corre la validación y solo llama tu handler si pasa; además expone el segundo callback `(errors) => …` para enfocar el primer inválido. No valides "a mano" antes de enviar.

## Reglas duras

1. `useForm` es la única fuente del estado del form; nada de `useState` espejo.
2. Inputs cableados con `getInputProps`; no dupliques `value`/`onChange`.
3. Validación con schema Zod vía `zodResolver`; tipo por `z.infer`, sin reglas por campo.
4. `initialValues` completo; edición async con `setValues`/`initialize`.
5. Submit vía `form.onSubmit`; listas/anidados con la API de path, no arrays sueltos.

## Antes de declarar listo

- Todos los inputs usan `getInputProps`; sin estado espejo ni handlers duplicados.
- Validación centralizada en un schema Zod con `zodResolver`; tipos por `z.infer`.
- `initialValues` seteado; sin warnings uncontrolled→controlled. Submit con `form.onSubmit`.
- `{{qualityGate.fast}}` en verde.
