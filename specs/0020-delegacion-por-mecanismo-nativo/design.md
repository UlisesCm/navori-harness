# Delegación por mecanismo nativo — Design

## Approach

Dejar de reforzar el canal de arranque y usar las tres palancas que el host diseñó
para este problema. La escalera se queda donde está: lo que cambia es que deja de
ser el **único** portador de la decisión de delegar.

**Descartado: hacer el aviso bloqueante.** Un `PreToolUse` con `permissionDecision:
"deny"` sí podría impedir la edición número 5 hasta que se delegue. Se descarta por
dos razones medidas, no teóricas. Una: a veces inline **es** lo correcto —en la
sesión `4935c4d7` las instrucciones del operador prohibían explícitamente delegar, y
un bloqueo habría dejado la sesión sin salida—. Dos: un mecanismo que se ignora
erosiona la autoridad de los que sí se obedecen, que es el efecto de segundo orden
que la doctrina de este repo llama el peor. El aviso convierte una decisión
invisible en una decisión explícita; eso es lo que falta, no una prohibición.

**Descartado: reescribir los `description` de las skills.** Ya cumplen, 40 de 40. La
spec toca solo lo que está roto.

**Descartado: `when_to_use` en frontmatter de skills.** El host lo acepta y lo
concatena al `description`, pero como el `description` ya lleva el disparador, sería
una segunda copia del mismo dato — exactamente la clase de duplicación que se
desincroniza. Queda fuera de alcance.

## Components

- `packages/core/core-assets/agents/*.md` — el `description` de los 8 agentes pasa a
  la forma "qué hace · cuándo dispararlo". Cubre R1.
- `packages/cli/src/lib/__tests__/agent-descriptions.test.ts` — fija la convención
  sobre los assets enviados, no sobre un ejemplo. Cubre R1.
- `packages/core/core-assets/hooks/routing-watch.sh` — hook nuevo en `PostToolUse`:
  cuenta archivos distintos del hilo principal, detecta si hubo delegación, emite el
  aviso una sola vez. Cubre R2, R3, R5.
- `packages/cli/src/engines/claude/build-settings.ts` — lo registra en `PostToolUse`
  junto a `managed-drift-watch`. Cubre R2.
- `packages/cli/src/engines/shared/harness-plan.ts` — lo agrega al plan para que se
  materialice en todo repo onboardeado. Cubre R2.
- `packages/cli/src/lib/audit/parse.ts` — lee la línea nueva del log. Cubre R5.
- `packages/cli/src/engines/claude/__tests__/claude-md-budget.test.ts` — fija el
  presupuesto de líneas del `CLAUDE.md` renderizado. Cubre R4.

## Decisions

- **`PostToolUse` y no `UserPromptSubmit`.** El umbral lo cruza una **edición**, no
  un prompt. `PostToolUse` dispara justo después de la edición que lo cruza, que es
  el momento de la decisión; `UserPromptSubmit` dispara antes de que el modelo haya
  hecho nada ese turno, o sea a destiempo. Verificado en la doc del host: el evento
  soporta `additionalContext` y "Claude Code adds `additionalContext` as context that
  Claude can see and act on".

- **El umbral es 4 archivos distintos, no "2+ no triviales".** La escalera define R2
  con las dos condiciones, pero "no trivial" es un juicio sobre el contenido del
  diff y un hook no puede emitirlo sin adivinar. Se toma la mitad objetiva. Un hook
  que adivina es ruido, y el ruido erosiona.

- **No hace falta distinguir hilo principal de subagente**, y esto simplifica el
  script entero. La condición es "N archivos **y** cero delegación": si un subagente
  editó algo, entonces hubo delegación, y la condición ya es falsa por su segunda
  mitad. Contar de más es inofensivo por construcción. Esto importa porque el
  payload de `PostToolUse` **no** trae identificador de agente —el campo `agentId`
  que hoy escribe el log de audit es en realidad el `cwd`— así que la alternativa
  habría sido inventar una heurística.

- **La delegación se marca por dos vías, ambas ya disponibles**: un `PostToolUse`
  cuyo `tool_name` sea `Agent`, y el evento `SubagentStop`, que navori ya engancha.
  La segunda es la garantía: dispara cuando un subagente termina, pase lo que pase
  con la primera.

- **Estado en disco, con la forma que ya existe.** `managed-drift-watch` mantiene su
  sello en `.claude/.managed-drift-stamp`; este hook usa el mismo patrón, con el
  `session_id` del payload en el nombre para que dos sesiones simultáneas no se
  pisen. El archivo entra a `EPHEMERAL_HARNESS_PATHS` — que es la lista única de
  "esto nunca se versiona" — así que hereda el `.gitignore`, la exclusión del backup
  y el check de `doctor` sin tocar tres sitios.

- **El texto del aviso nombra la salida, no solo la regla.** Un aviso que solo dice
  "deberías delegar" invita a ignorarlo en silencio, que es el estado actual. El
  texto cierra pidiendo que, si inline es deliberado, se diga — así el override
  queda escrito en la sesión y no desaparece.

## Failure modes

- **El hook no puede leer o escribir su sello** (FS de solo lectura, `$HOME` raro):
  sale 0 sin emitir nada. Un hook de `PostToolUse` corre después de **cada**
  herramienta; fallar ruidoso ahí es peor que no avisar.
- **El aviso llega tarde** porque el umbral se cruzó dentro de un subagente: no
  aplica — ese caso ya delegó y la condición es falsa.
- **La sesión se compacta** y el aviso se pierde del contexto: el sello sigue en
  disco, así que no se re-emite. Es deliberado: repetir es lo que erosiona. El
  registro en el log de audit (R5) es el que sobrevive para la medición.

## Testing strategy

Cada test responde a un riesgo nombrado arriba, no a una cuota:

- *La convención se revierte al editar un agente* → test sobre los 8 assets enviados.
- *El aviso nunca dispara* → secuencia sintética de payloads `PostToolUse` que cruza
  el umbral, se espera una emisión.
- *El aviso repite y se vuelve ruido* → la misma secuencia continuada, se espera
  exactamente una.
- *El aviso dispara habiendo delegado* → secuencia con un `tool_name: "Agent"` en
  medio, se espera cero.
- *El aviso bloquea* → se verifica exit 0 y ausencia de `permissionDecision`.
- *El `CLAUDE.md` vuelve a crecer* → test de presupuesto sobre el render.

## Migration

Ninguna. El hook es nuevo y su sello es efímero; un repo ya onboardeado lo recibe en
el siguiente `render --apply` sin tocar nada suyo. Los `description` reescritos
viajan por el mismo camino managed que el resto de los agentes.

## NOT in scope

- **Hacer el aviso bloqueante.** Ver Approach. Si la tasa de activación no se mueve
  con el aviso consultivo, esa es la conversación siguiente — y la regla que este
  repo ya se puso aplica: si el número no se mueve, la respuesta no es más prosa.
- **Mover bloques a `.claude/rules/` con `paths:`.** Es una herramienta válida para
  R4 y el host la documenta, pero la mayoría de los bloques de navori son doctrina
  genuinamente always-on; path-scoping solo aplica limpio a `tipado-fuerte`. La
  dieta de R4 se hace recortando y moviendo profundidad a skills —que cargan bajo
  demanda y no cuestan nada hasta usarse—, y `rules/` se evalúa después con el dato
  de cuánto faltó.
- **Los otros motores.** El hook se registra para Claude. Codex y los motores de
  prosa no tienen el evento; extenderlo requiere su propio análisis.
