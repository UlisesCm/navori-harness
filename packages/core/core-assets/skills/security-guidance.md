---
name: security-guidance
description: Usar al correr /security-review o al auditar seguridad. Documenta las invariantes de seguridad de NEGOCIO que el scanner estático (semgrep) y el review built-in no infieren del código solo — autorización server-side, acceso a objetos (IDOR), secretos y env expuesto al cliente, fronteras de confianza, PII en logs. El esqueleto es universal; las reglas de tu stack van en la user-section.
type: reference
maxWords: 1200
---

# Security guidance — capa de seguridad de negocio

Alimenta el flujo `/security-review`. Los patrones genéricos de vuln web (XSS, SSRF, secretos hardcodeados, deserialización insegura, inyección) ya los cubren semgrep y el reviewer built-in. Aquí va lo que el modelo **no puede inferir del código solo**: las invariantes de autorización y confianza que dependen del dominio.

Reporta con severidad `[CRÍTICO]`/`[ALTO]`/`[MEDIO]` y `archivo:línea`, como en `review-diff`. Un bypass de autorización o un secreto expuesto es CRÍTICO.

## 1. Autorización — se enforcea en el servidor

- Toda ruta / endpoint / acción que expone datos o efectos protegidos DEBE verificar el rol o permiso **en el servidor**, antes de la query o el efecto. Falta de guard server-side = **bypass de autorización, CRÍTICO**.
- Los guards de cliente (render condicional, checks en el componente, un `useAuth()`) **nunca alcanzan solos** — son UX, no enforcement. Una vista protegida que solo confía en el cliente es CRÍTICO.
- La config de navegación / UI (menús, un `allowedRoles` en el array de nav) filtra la UI, **no** controla acceso. Agregar una entrada ahí sin el guard server-side correspondiente es un hallazgo.
- El guard debe **fallar cerrado**: sin sesión o backend caído → deniega / redirige, nunca "deja pasar por las dudas". No agregues un path que corte en error hacia el lado permisivo.

## 2. Acceso a objetos (IDOR)

- Un id que viene del input (URL, body, query) NO autoriza por existir. La **propiedad / alcance se verifica server-side** (idealmente en el backend o la capa de acceso), no en el cliente.
- Una vista que trae un registro por id-de-URL debe confiar en el error de acceso del backend (`ACCESS_DENIED` / 403), no inventar su propio check de ownership ni asumir que el id es válido.
- Las listas de entidades sensibles nunca se consultan desde el cliente con filtros amplios — van por el servidor con la sesión autenticada.

## 3. Manejo de errores de auth

- Los errores de autenticación / autorización (sesión expirada, cuenta bloqueada, 401/403) se manejan **de forma global y fail-closed** (logout / redirect), no se tragan localmente ni se muestran inline como error de formulario.
- Define el contrato de códigos de error del backend (ej. 401 sesión, 423 bloqueo, 429 rate-limit) y respétalo. Manejo custom de esos códigos en un componente puntual es un hallazgo.

## 4. Secretos y variables de entorno

- Cero secretos / tokens / URLs internas hardcodeados — **incluido tests y archivos `.env.example`** (usa placeholders). Un secreto en código es CRÍTICO.
- Las vars que se **bundlean al cliente** (prefijos como `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) DEBEN ser seguras de filtrar: nada de API keys, tokens ni URLs internas detrás de ese prefijo. Poner un valor sensible ahí es CRÍTICO.

## 5. Fronteras de confianza / flujo de datos

- Todo dato de fuente externa (backend, red, input) se **valida y normaliza en la frontera** antes de entrar al dominio. No pases valores crudos del backend directo a la UI.
- Fallbacks de enums / estados desconocidos → a un valor seguro conocido, nunca passthrough crudo ni throw (un enum no confiable crudo en la UI = confusión de estado o potencial XSS).
- Respeta las fronteras arquitectónicas que declare el repo (qué capa puede importar tipos generados o hablar con qué backend).

## 6. Logging y PII

- Nada de `console.log` / print de datos de usuario, tokens, cookies de sesión o PII (email, teléfono, documentos) en paths de producción. Logs de debug solo detrás de un guard de entorno (ej. `NODE_ENV === 'development'`).

## Cómo usarlo en el review

1. Recorre el diff o el área con estas 6 categorías como checklist.
2. Reporta con severidad y `archivo:línea`.
3. Cruza con las **reglas específicas de tu stack** (abajo): los nombres concretos de tus guards, códigos de error y prefijos de env viven ahí — sin eso, el review solo cubre la capa universal.

<!-- navori:user-section -->
## Invariantes de seguridad de tu stack

<!-- user: documenta aquí lo que el modelo NO puede inferir del código — las reglas concretas de TU dominio. Sugerencias:
     - AUTORIZACIÓN: nombre y firma del guard server-side obligatorio (ej. `requireRole([...])`), dónde va, sus paths terminales, y qué rutas lo exigen.
     - IDOR: cómo se identifican los recursos (UUID / CUID / slug), el helper de validación, y qué entidades son sensibles.
     - ERRORES: el contrato exacto de códigos de tu backend (401/403/423/429…) y el handler global.
     - ENV: el gestor de secretos (Infisical / Vault / …), el prefijo de vars cliente de tu framework, y qué NUNCA lleva ese prefijo.
     - FRONTERAS: qué capa puede importar qué (tipos generados, clientes de backend), reglas de adapters y sanitización.
     - Anti-patterns de tu repo que son auto-CRÍTICO.
-->
