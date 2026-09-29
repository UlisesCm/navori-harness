# Spec 0037 — Challenge y veredicto

**Fecha:** 2026-09-28. Architect propuso; auditor en contexto fresco desafió una vez; orchestrator
sintetizó. La excepción de preflight autorizada por el usuario solo cubrió esos dos encargos.
Estos encargos explícitos no certifican que el host seleccionara perfiles TOML nativos: eso se
medirá en L03, no se deduce de nombres de tareas de esta sesión.

## Resultado de la ronda independiente

**0 BLOCKER · 3 CONCERN · 1 NOTE.** El auditor no emitió veredicto. Su artefacto original es
`.codex/progress/solution_review_spec0037.md`; esta síntesis conserva el resultado útil en git.

| ID | Evidencia y riesgo | Resolución en la spec |
|---|---|---|
| C1 | `check-semgrep.sh`/`check-jscpd.sh` — `navori_audit_on_exit`: todo no cero se registra block aunque error distinguible permite. Trap jscpd ejecuta cleanup antes de capturar exit, puede registrar allow tras bloqueo | D3 exige preservar exit original, separar resultado/decisión y validar terminal además de sentinel. V05 y T6 incluyen casos negativos. Sin alterar #510 |
| C2 | `engines/claude/agent-mcp-tools.ts` — `rewriteAgentTools`: ausencia de `tools` significa herencia; ausencia de grant no basta para denegar | D6 distingue asset heredado de allowlist explícita. V11 y T10 cubren campo ausente/lista/wildcard. Sin restricción silenciosa al portarlo |
| C3 | D6 emitía allowlist por perfil sin demostrar composición con filtros restrictivos de usuario/padre | D6, V11 y T9 condicionan habilitación a config efectiva sin ampliaciones. Si no representable, no habilitar traducción de ese caso y publicar limitación; no merger global improvisado |
| N1 | D1/D3/D4/D5/D8 ya separan declaración/runtime, preservan errores Claude, evitan orchestrator spawnable y no confunden etiqueta con perfil | Mantener esas decisiones y la exclusión de plan-gate selectivo; no repetir #1082 |

Rutas de C1 relativas a `packages/plugins/{semgrep,jscpd}/scripts/`; ruta C2 relativa a
`packages/cli/src/`. El riesgo C3 no se declara resuelto en runtime por haber añadido una prueba
a un documento: queda como dependencia explícita de aceptación.

## Veredicto del orchestrator

**CONCERNS.** No hay bloqueo para terminar la spec ni para iniciar los lotes independientes una vez
autorizada la implementación. C1/C2 tienen corrección y pruebas concretas en el diseño; C3 necesita
evidencia de host antes de habilitar traducción de permisos. Si falla esa viabilidad, el resultado
es brecha documentada/no soportada, no una promesa de paridad ni una relajación de restricciones.

Los cambios de política de scanners, sandbox/trust global, modelos por defecto y nuevos subsistemas
quedan fuera de esta autorización. La finalización documental **no** marca realizadas las tareas,
no sustituye el quality gate y no autoriza campañas pagadas ni publicación.
