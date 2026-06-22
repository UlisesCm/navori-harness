---
name: mantine-ui-patterns
description: Reglas para UI con Mantine — usar componentes del lib en vez de raw HTML, theming, responsive. Aplica al crear o modificar componentes React.
type: reference
---

# Mantine UI patterns — convenciones del proyecto

## Cuándo usar este skill

Antes de escribir un componente React nuevo o modificar uno existente. Mantine ya provee 100+ componentes con accesibilidad, theming y dark mode integrados; reinventar uno con `<div>` rompe la consistencia visual y agrega bugs de a11y.

## Reglas duras

1. **`<Button>` antes que `<button>`.** Lo mismo con `<TextInput>` (no `<input>`), `<Stack>` (no `<div style={{ display: 'flex', flexDirection: 'column' }}>`), `<Group>` (no flex horizontal), `<Title>` (no `<h1>`). Si el componente Mantine no cubre tu caso, primero confirma que no exista — la lib es enorme.
2. **Theming centralizado en `theme.ts`.** Colores, espacios, radios, breakpoints viven en el objeto `MantineThemeOverride`. No hardcodear `#3b82f6` o `padding: 12px` en componentes — usa `var(--mantine-color-blue-6)`, `theme.spacing.sm` o el prop `c="blue.6"`.
3. **Props sobre `style={{ ... }}`.** Mantine acepta `mt`, `mb`, `p`, `gap`, `c`, `bg`, etc. como props directos. Siguen el sistema de tokens del theme. `style={{ marginTop: 16 }}` rompe responsive + theming.
4. **Responsive con `visibleFrom` / `hiddenFrom` o `responsive prop`.** No condicionar render con `window.innerWidth`. Mantine ya tiene breakpoints + hooks (`useMediaQuery`).
5. **Forms con `@mantine/form`, no estado a mano.** Validación, dirty/pristine, errores granulares vienen incluidos. `useState` para cada input es bug-prone.

## Patrón típico

```tsx
import { Stack, TextInput, Button, Title, Group } from "@mantine/core";
import { useForm } from "@mantine/form";

export function CreateUserForm({ onSubmit }: Props) {
  const form = useForm({
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
          {...form.getInputProps("email")}
        />
        <TextInput label="Nombre" required {...form.getInputProps("name")} />
        <Group justify="flex-end">
          <Button type="submit" loading={form.submitting}>Guardar</Button>
        </Group>
      </Stack>
    </form>
  );
}
```

## Tabla rápida

| Necesito | Componente Mantine |
|---|---|
| Botón | `<Button>` (variants: filled/outline/light/subtle) |
| Input texto | `<TextInput>` |
| Select | `<Select>` (single) / `<MultiSelect>` |
| Date picker | `@mantine/dates` → `<DatePicker>` / `<DateInput>` |
| Layout vertical | `<Stack gap="md">` |
| Layout horizontal | `<Group justify="space-between">` |
| Grilla responsive | `<Grid>` o `<SimpleGrid cols={{ base: 1, md: 2 }}>` |
| Card / contenedor | `<Paper p="md" radius="md" shadow="sm">` |
| Modal | `<Modal opened={x} onClose={...}>` (usar `useDisclosure`) |
| Tooltip | `<Tooltip label="...">` envolviendo el target |
| Loading | `<Loader>` o `loading={true}` prop en `<Button>` |
| Notif toast | `notifications.show({ message: "..." })` de `@mantine/notifications` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Prueba el componente en dark mode (toggle Mantine ColorScheme) — si rompe, usaste color hardcoded.
- Prueba responsive: ancho mobile (< 768px) y desktop. Si requiere breakpoint manual, usa `useMediaQuery` o `visibleFrom`.
- Cero `<div style={{...}}>` con flex/grid: convierte a `<Stack>` / `<Group>` / `<SimpleGrid>`.
- Cero strings hex en código de componente: si necesitas un color custom, súmalo al `theme.colors`.
