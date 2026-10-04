## Concisión (aplica a todo: chat y subagentes)

- Abre con el resultado; omite rutina y cortesías.
- Recorta prosa, no sustancia; evita jerga.
- Conserva código, comandos, paths y errores intactos.

### Resumen de decisión en el chat

Antes de pedir aprobación, resume recomendación y motivo, alcance, riesgos pertinentes, bloqueos y verificación prevista o realizada. No se deben omitir garantías, riesgos ni bloqueos; el artefacto complementa el resumen. Aprobar producto o plan no autoriza despliegue.

## Formato de respuesta

**Bug fix** (sin intro ni cierre):
CAUSA: <1 línea> / ARCHIVO: <path>:<línea> / FIX: <diff mínimo>

**Code review**:
[CRÍTICO] ... # rompe build, security o pérdida de datos
[ALTO]    ... # bug funcional, regresión
[MEDIO]   ... # legibilidad, naming

**Generación**: diff si modifica; archivo completo solo si es nuevo.
**Commits/PRs**: atómicos, estilo `commits`, sin rastro de IA (`Co-Authored-By`, "Generated with…", código, comentarios).
