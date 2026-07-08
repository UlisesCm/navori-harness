---
name: loop-back-debug
description: Protocolo para cuando un fix no funciona la primera vez. Forza re-leer el síntoma original, validar la hipótesis vs el diff aplicado, y NO tirar más patches sin entender qué falló.
type: behavior
maxWords: 1000
---

# Loop-Back Debug

## El anti-pattern que este skill ataca

Patrón recurrente cuando un bug es persistente:

1. Intento de fix #1 → "debería andar" → no anda.
2. Intento de fix #2 → "ahora sí" → no anda.
3. Intento de fix #3 → cambio random → no anda.
4. Eventualmente el código está peor que al inicio y el bug sigue.

El error de raíz es **escalar el cambio sin re-validar la hipótesis**. Cada intento asume que el anterior estaba "casi bien", cuando en realidad el modelo mental del bug estaba mal desde el #1.

## The Rule

```
SI UN FIX NO ARREGLÓ EL SÍNTOMA EN EL PRIMER REPRO POST-FIX,
PARAS DE PATCHEAR Y RE-VALIDAS LA HIPÓTESIS.
```

No más patches encima del patch anterior. Vuelves al síntoma original y al diff actual, comparas contra la hipótesis. Si la hipótesis era correcta y el síntoma persiste, el fix no es completo. Si la hipótesis era incorrecta, ningún patch sobre esta línea va a funcionar — cambia la hipótesis.

## Gate function (post-fix)

DESPUÉS de aplicar un fix y ANTES de afirmar "arreglado":

1. **REPRO**: corre el repro exacto que producía el síntoma original. En este turno. No "asumiendo que".
2. **OBSERVE**: ¿el síntoma sigue / cambió / desapareció?
3. **CLASSIFY**:
   - **Desapareció** → aplica `verify-before-done` para confirmar y declarar fix completo.
   - **Persiste exactamente igual** → hipótesis estaba mal. NO patchees encima. Vuelve a § Reset hipótesis.
   - **Cambió de forma** → el fix tocó algo real pero no era la causa raíz. Vuelve a § Reset hipótesis con la nueva info.

## Reset hipótesis (cuando el fix no funcionó)

NO aplicar otro fix hasta completar estos pasos:

1. **Lee de vuelta el síntoma original**, literal del ticket / bug report / repro inicial. No el síntoma de tu cabeza, el escrito.
2. **Lista el diff aplicado** (`git diff HEAD~1`) y descríbelo en una frase: "Cambié X en archivo:línea de Y a Z porque hipótesis era W".
3. **Valida lógicamente**: si la hipótesis W fuera cierta, ¿el cambio Y→Z debería haber arreglado el síntoma?
   - Si la respuesta es "sí debería", pero el síntoma persiste → tu modelo del flujo está incompleto. Hay un step intermedio que no estás viendo.
   - Si la respuesta es "no necesariamente", la hipótesis era débil desde el inicio.
4. **Genera 2–3 hipótesis alternativas** antes de tocar código:
   - ¿Hay caching? (browser, build, CDN, redis).
   - ¿El código que cambiaste es el que se ejecuta? (path resolution, dynamic imports, env-gated branches).
   - ¿El cambio fue al server o al cliente cuando el bug está del otro lado?
   - ¿Hay un middleware / interceptor entre lo que cambiaste y donde se observa el síntoma?
   - ¿El estado en memoria / DB ya estaba en un estado inválido y tu fix solo cubre el path "nuevo"?
5. **Elige UNA hipótesis nueva** con evidence-based reasoning. Documéntala antes de tocar código.
6. **Aplica el siguiente intento** sabiendo qué estás probando.

## Cuándo escalar / pedir ayuda al usuario

Si llevas **2 intentos fallidos** sobre el mismo bug, paras y reportas al usuario:

- Síntoma original.
- Hipótesis #1, fix aplicado, resultado del repro.
- Hipótesis #2, fix aplicado, resultado del repro.
- Hipótesis #3 que piensas probar, con evidencia que la sustenta.
- Pregunta concreta: "¿conoces más contexto que apoye / refute esta hipótesis?"

No es debilidad — es eficiencia. 3 intentos a ciegas valen menos que 1 conversación con quien tiene contexto.

## Red flags (PARA)

- Estás por hacer un segundo cambio sobre la misma línea sin haber re-corrido el repro.
- Estás por escribir "ahora sí debería andar" sin evidence fresca.
- Estás revertiendo y re-aplicando variaciones del mismo cambio.
- Estás agregando logs / try-catch / fallbacks para "cubrir" en vez de entender.
- El diff acumula >3 commits sobre el mismo archivo intentando arreglar la misma cosa.

## Anti-patterns

- ❌ "Voy a probar esto otro fix" sin haber corrido el repro del fix anterior.
- ❌ Patches defensivos: try-catch alrededor del código sospechoso para "que no rompa". Eso oculta el bug, no lo arregla.
- ❌ "Es flaky" como excusa sin evidencia de flakiness real.
- ❌ Cambiar lib / framework / approach porque "tal vez con X andaría" — eso es ducha caliente, no debugging.
- ❌ Pedirle al usuario "pruébalo de nuevo" sin haber cambiado nada relevante.

## Conexión con el resto del harness

- `implementer`: invoca este skill cuando el primer fix no resuelve el síntoma. NO devuelve `done` hasta haber pasado por Reset hipótesis si el repro inicial falla.
- `verify-before-done`: este skill se aplica ANTES de verify-before-done — primero validas que el fix realmente arregló el síntoma (esto), luego validas que el resto del quality gate sigue verde (verify-before-done).
- `ticket-audit`: cuando un bug entra al agente ticket-audit, la "Hipótesis de causa raíz" es el primer candidate del loop. Si el fix de esa hipótesis no funciona, ticket-audit puede ser reinvocado con la info nueva.

## Cierre

Al aplicar este skill, el output al usuario incluye:

1. Hipótesis que se probó.
2. Cambio aplicado (archivo:línea + descripción).
3. Resultado del repro post-fix (en este turno).
4. Si funcionó → aplicar `verify-before-done` para cierre.
5. Si no funcionó → próxima hipótesis a probar O escalación al usuario (según conteo de intentos).

<!-- navori:user-section -->
## Patrones de bug recurrentes del proyecto

<!-- user: agrega acá patrones de bug específicos de tu repo donde la hipótesis típica falla. Sugerencias:
     - Caches que el dev olvida invalidar (CDN, redis, browser SW, build cache).
     - Race conditions conocidas en módulos específicos.
     - Áreas donde "lo obvio" no es la causa raíz históricamente.
     - Migraciones a medias (legacy/{{project.legacyPaths}} → nuevo backend) que crean estados inconsistentes.
     - Comandos de repro estandarizados para bugs frecuentes (ej. `pnpm dev:e2e:auth-flow`).
-->
