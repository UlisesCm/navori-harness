---
name: debug-error
description: Usar cuando un comando (tsc, lint, build, test) o el runtime escupe un muro de errores. Antes de tocar código: filtra el ruido, clasifica el tipo de error, y arregla la CAUSA RAÍZ, no los síntomas en cascada. Los patrones de error de tu stack van en la user-section.
type: behavior
maxWords: 600
---

# Debug error — triage antes de arreglar

Cuando un comando falla con muchas líneas, el error es reaccionar al primero (o al más ruidoso) y tirar un fix. Este skill fuerza el triage previo.

## El protocolo (en orden)

1. **Filtra el ruido.** Aísla los errores reales del chatter de la herramienta: líneas de progreso/éxito (`compiled`, `generating…`), warnings (no son errores) y logs sin stack. Quédate solo con las líneas que son un error de verdad.
2. **Clasifica el tipo.** Antes de arreglar, identifica la categoría — cada una tiene una forma de causa distinta:
   - **Tipos / compilador** (tsc): tipo esperado vs recibido; a menudo un tipo desactualizado o una regeneración pendiente (codegen / schema).
   - **Lint**: mecánico, casi siempre auto-fixable; no lo trates como bug de lógica.
   - **Build**: config, env, o boundary (server/client, dynamic) — no es el código de negocio.
   - **Runtime**: `undefined` / `null` no manejado, red, o auth / sesión.
3. **Encuentra la causa RAÍZ.** Un solo error raíz suele cascadear en 10-20 downstream (un import o tipo faltante rompe todo lo que lo usa). **Arregla la raíz, re-corre y RE-CLASIFICA** — no dispares varios fixes a la vez contra los síntomas.
4. **Reporta / arregla** con el formato de `formato-respuesta` (`CAUSA` + `archivo:línea` + `FIX` mínimo). Sin preámbulo.

## Reglas

- **Un fix a la vez** contra la raíz, luego re-corre. Si el mismo error persiste tras el fix → cambia a `loop-back-debug` (re-valida la hipótesis, no sigas patcheando).
- **No arregles síntomas** que van a desaparecer solos al arreglar la raíz.
- **Warning ≠ error** — un warning no bloquea; no gastes el turno en él salvo que lo pidan.

<!-- navori:user-section -->
## Patrones de error de tu stack

<!-- user: documenta aquí los errores recurrentes de TU toolchain y su fix, para triage instantáneo. Sugerencias:
     - Filtros de ruido específicos (líneas del build/runner que NO son errores).
     - Errores típicos con su causa + fix (ej. codegen no corrido, boundary server/client, import path/alias, env faltante).
     - Comandos de regeneración/validación (codegen, migrations) que resuelven categorías enteras de errores.
-->
