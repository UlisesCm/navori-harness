# S01 — Cuenta por correo

Etapa `02-mvp-slices` · Entrega E1 · Parte P1 · Estado: existe en qa, falta aceptarla.

## Resultado

Un miembro nuevo instala la app, crea su cuenta con correo y contraseña, verifica su correo desde el enlace que recibe, entra a Inicio y, si olvida su contraseña, la recupera sin ayuda.

## Guion de aceptación (A1)

Sobre qa, con el APK preview en un Android físico y un correo real que nunca se haya usado en qa.

1. Abre la app y toca "Crear cuenta". Escribe nombre, correo y una contraseña válida, y completa la verificación de seguridad. **Esperado:** llegas a Inicio con tu nombre y un aviso de que falta verificar el correo.
2. Abre el correo de verificación en el mismo teléfono. **Esperado:** llega en menos de 2 minutos, en español, con el remitente de JEY.
3. Toca el enlace del correo. **Esperado:** se abre la app en "Correo verificado"; al continuar, el aviso de verificación ya no aparece.
4. Cierra sesión desde Perfil y vuelve a entrar con el correo y la contraseña. **Esperado:** llegas a Inicio.
5. Cierra sesión y entra con una contraseña incorrecta. **Esperado:** un mensaje claro de credenciales incorrectas, sin revelar si el correo existe.
6. Toca "¿Olvidaste tu contraseña?", escribe tu correo y completa la verificación de seguridad. **Esperado:** confirmación neutral y un correo de recuperación en menos de 2 minutos.
7. Toca el enlace de recuperación y define una contraseña nueva. **Esperado:** se abre la app en "Nueva contraseña" y al guardar te pide iniciar sesión.
8. Entra con la contraseña nueva. **Esperado:** llegas a Inicio; la contraseña anterior ya no funciona.
9. Activa el modo avión e intenta entrar. **Esperado:** un aviso de sin conexión, sin pantalla de error genérica.
10. Repite el paso 1 con el teléfono en inglés. **Esperado:** pantallas y correos en inglés.

## Reglas aplicables

- RF-1: registro, verificación, login y recuperación por correo en la app.
- RNF-15: contraste de los tokens y objetivos táctiles de al menos 44 pt.
- Transversales de toda la etapa: RNF-10 (contrato GraphQL aditivo), RNF-11 (migraciones válidas) y RNF-16 (quality gate en cada PR).
- Anti-enumeración: registro, login y recuperación nunca revelan si un correo existe.

## Estados

| Estado | Qué ve el miembro |
|---|---|
| Sin conexión | Aviso de sin conexión con opción de reintentar; nunca un error genérico |
| Error del servidor | Mensaje con la referencia del error; el error llega a PostHog |
| Enlace vencido o inválido | "El enlace venció" o "El enlace no es válido", con acción para pedir otro |
| Cuenta bloqueada | Mensaje de cuenta bloqueada al entrar |
| Correo sin verificar | Aviso persistente en Inicio con acción para reenviar el correo |

## Entorno y datos

- **API qa:** Resend verificado para el dominio del remitente, `EMAIL_FROM`, `PORTAL_APP_URL` y las claves reales de Turnstile con los hostnames de qa.
- **APK preview:** `EXPO_PUBLIC_API_URL` de qa y la llave de Turnstile; lo verifica `scripts/verify-preview-apk.sh`.
- **Datos:** ninguno sembrado; el guion crea su propia cuenta. Para repetir el guion, usa otro correo o un alias (`nombre+s01b@…`).

## Fuera de alcance

- Login con Google y Apple (S09).
- Eliminar la cuenta (S17).
- Cambiar el correo de una cuenta existente.

## Tareas

1. Ejecutar el guion en qa y registrar cada paso fallido como hallazgo, con captura y referencia del error.
2. Corregir los hallazgos del guion en `dev`, un PR por causa, y promover a qa.
3. Comprobar que los errores de registro, login y recuperación llegan a PostHog con su referencia.
4. Correr A2 (`bun run test:e2e:local -- tests/e2e/local-auth.spec.ts tests/e2e/local-email.spec.ts`) sobre el SHA promovido.
5. Repetir el guion completo y pedir "Aprobado".
