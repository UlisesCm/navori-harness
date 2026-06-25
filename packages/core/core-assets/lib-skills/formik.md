---
name: formik
description: Patrones de Formik en React+TS — schema de validación, estado de form, submit, errores por campo. Aplica al crear o tocar formularios con Formik.
type: reference
---

# Formik — convenciones

## Cuándo usar este skill

Al crear o tocar un formulario con Formik: definir initial values, validación, submit, o pintar errores. Formik es la fuente de verdad del estado del form — no dupliques sus valores en `useState` paralelos.

## El patrón

Validación declarativa con un schema (Yup/Zod), no a mano en `validate`:

```ts
const formik = useFormik({
  initialValues: { email: '', role: 'coachee' },
  validationSchema: toFormikValidationSchema(loginSchema), // zod, o un Yup schema
  onSubmit: async (values, { setSubmitting, setStatus }) => {
    try {
      await api.login(values);
    } catch (err) {
      setStatus(toFormError(err)); // error de servidor, no de campo
    } finally {
      setSubmitting(false);
    }
  },
});
```

En el JSX: `formik.getFieldProps('email')` cablea value/onChange/onBlur; el error se muestra solo si el campo fue tocado: `formik.touched.email && formik.errors.email`.

## Gotchas que muerden

- **Una sola fuente de verdad.** Los valores viven en Formik; nada de `useState` espejo que se desincroniza.
- **`touched` antes de mostrar error** — pintar errores antes del primer blur frustra al usuario; usa `touched.<campo> && errors.<campo>`.
- **`isSubmitting`** deshabilita el botón y evita doble submit; resetéalo siempre en `finally`.
- **Errores de campo vs de servidor**: un fallo de validación va a `errors` (vía schema); un fallo de API va a `setStatus`/`setFieldError`, no se inventa como error de campo.
- **Forms grandes** re-renderizan todo en cada tecla; aísla con `<Field>`/componentes memoizados si pesa.
- **`enableReinitialize`** cuando los initial values llegan async (editar un recurso cargado), o el form arranca vacío.

## Reglas duras

1. Validación en un schema (Yup/Zod), nunca lógica suelta en `validate` inline.
2. Estado del form solo en Formik; sin `useState` paralelos a sus valores.
3. Error de campo solo tras `touched`; error de servidor vía `setStatus`/`setFieldError`.
4. `isSubmitting` controla el botón y se limpia en `finally`.
5. `enableReinitialize` para formularios de edición con carga async.

## Antes de declarar listo

- El form valida contra un schema y muestra errores solo tras blur.
- El submit deshabilita el botón y maneja el error de servidor aparte.
- No hay estado del form duplicado fuera de Formik.
- `{{qualityGate.fast}}` en verde.
