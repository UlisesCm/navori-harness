---
name: verify-before-done
description: Iron Law del cierre de tarea — no afirmar éxito sin evidencia fresca del comando que respalda el claim. Aplica a implementer, reviewer, commit-pr-pilot y a cualquier respuesta que declare "listo".
type: behavior
maxWords: 1000
---

# Verify Before Done

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

Si no corriste el comando de verificación EN ESTE TURNO, no puedes afirmar el claim. "Should work", "previous run was green", "looks fine" NO son evidencia.

## Por qué este skill existe

El bug recurrente es declarar "listo" en base a inferencia:

- "corrí el check hace 2 cambios atrás, debería seguir verde"
- "el código compila, la UI debería andar"
- "el adapter está bien, el render debe funcionar"

Inferencia ≠ evidencia. Este skill fuerza el rigor.

## Gate function

ANTES de afirmar cualquier "listo / done / completed / approved":

1. **IDENTIFY**: ¿qué comando prueba este claim?
2. **RUN**: ejecuta el comando COMPLETO en este turno (no parcial, no cached).
3. **READ**: output completo, exit code, contar failures.
4. **VERIFY**: ¿el output confirma el claim?
   - NO → declara el estado real con evidencia.
   - SÍ → afirma el claim CON el evidence visible.
5. **ONLY THEN**: haz el claim.

Saltarse cualquier step = mentira, no verificación.

## Tabla claim → required output → not sufficient

| Claim | Required output | Not sufficient |
|---|---|---|
| `{{qualityGate.fast}}` verde | Comando completo corrido en este turno con exit 0 | "corrí antes", "should be green", "lint pasaba ayer" |
| `{{qualityGate.full}}` verde | Mismo — exit 0 fresco en este turno | "vite/dev anda", "build pasó hace rato" |
| Cero errores nuevos vs baseline | `git stash` → re-run → comparar conteos → `git stash pop` | "lint dijo OK" sin comparar baseline |
| UI validada (golden path) | Repro step + comportamiento observado en navegador con dev server vivo en este turno | "se ve bien en código", "should render correctly" |
| Bug fixed | Reproducir síntoma original y verlo NO ocurrir | "code changed, assumed fixed", "el diff cubre el caso" |
| Filtro / feature funciona | Click real + descripción del resultado | "el handler está bien escrito" |
| Migración estructural completa | Lectura Y escritura van al mismo destino en el flujo afectado, validado en navegador o test | "cambié el service, debería andar" |
| PR creable | Pre-flight verde (status limpio, no en `{{branchBase}}`, gh auth ok, quality gate verde) EN ESTE TURNO | "el branch tiene commits, podemos crear" |
| Tests pasan | Suite corrida fresca con exit 0 en este turno + conteo de tests | "no tocamos tests", "deberían seguir verdes" |
| Type-check limpio | `tsc --noEmit` (o equivalente del runtime) exit 0 en este turno | "TS no se quejó cuando lo guardé" |

## Red flags (PARA)

- Estás por escribir "listo" / "done" / "perfect" / "should work".
- Estás por hacer `git commit` sin haber corrido `{{qualityGate.fast}}` en este turno.
- Estás por marcar `APPROVED` un review sin haber leído el diff completo.
- Estás cansado y quieres cerrar.
- "Just this once" — NO. Cero excepciones.
- Confías en el reporte de un subagente sin verificar el diff tú mismo.

## Rationalization prevention

| Excusa | Realidad |
|---|---|
| "Tengo confianza" | Confianza ≠ evidencia. |
| "Si compila, anda" | TS con `strict: false` no atrapa undefined runtime. Verifica UI / runtime. |
| "El check pasó hace 10 min" | Re-corre. Fresh. |
| "Es trivial, no hace falta" | Trivialidad no exime de verificación. |
| "El subagente dijo done" | Mira el diff tú mismo. Trust pero verify. |
| "El usuario tiene prisa" | Prisa ≠ excusa. Verificación rápida es más rápida que rollback. |
| "Same words diferentes = la regla no aplica" | Spirit > letter. |

## Cuándo se invoca este skill

- **`implementer`**: antes de devolver `done -> .claude/progress/impl_<feature>.md`. Antes de pasar al `reviewer`.
- **`reviewer`**: antes de marcar `APPROVED`.
- **`commit-pr-pilot`**: antes de `gh pr create`.
- **Cualquier agent**: antes de decir "listo" al usuario en cualquier respuesta de tarea de código.

## Conexión con el resto del harness

- `CLAUDE.md` § Cierre menciona `{{qualityGate.full}}` verde. Este skill añade rigor "fresh evidence" + cubre dimensiones UI / bug-fixed que el quality gate no toca.
- El `implementer` referencia este skill en su "Evidence-based completion".
- El `reviewer` debe citar este skill cuando marca `APPROVED`.
- El `commit-pr-pilot` lo aplica en su pre-flight antes de tocar `gh`.

## Anti-patterns

- ❌ Mostrar output cached de hace 5 mensajes y decir "ya está verde" — fresh, no cached.
- ❌ Inferir UI desde el código — la UI necesita repro en navegador.
- ❌ "Trust me, runs locally" — no es claim válido sin evidence en el chat.
- ❌ Hacer el claim ANTES del comando ("voy a correr X y debería estar verde").
- ❌ Marcar `[x]` un step del plan atómico sin haber corrido la verificación que respalda ese step.
- ❌ Aceptar el reporte de un subagente sin abrir el diff y validar al menos los archivos críticos.

## Cierre

Skill **siempre activa** durante cualquier flow de implementación. No requiere invocación explícita — es principio que aplica a todo claim de "listo".

Al aplicarla, el output al usuario debe incluir:

1. El claim explícito (qué se logró).
2. El output completo (o referencia al comando corrido) que lo respalda.
3. Si algún sub-claim NO pudo verificarse (ej. UI sin browser disponible), decirlo EXPLÍCITO — no inferir.

<!-- navori:user-section -->
## Checks específicos del proyecto

<!-- user: agrega acá claims específicos de tu repo y su evidencia requerida. Sugerencias:
     - Migraciones de DB: comando para validar el estado (ej. `prisma migrate status`).
     - Áreas críticas: {{project.criticalAreas}} → checks específicos por área.
     - Scripts del repo que cuentan como "evidencia válida" (ej. `pnpm e2e:smoke`).
     - Comandos prohibidos como evidencia (ej. "el preview de Vercel" si no es repro real).
     - Patrones de bug recurrentes del repo donde la inferencia históricamente falló.
-->
