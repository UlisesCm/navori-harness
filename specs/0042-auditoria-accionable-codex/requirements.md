# Auditoría accionable con paridad Codex — Requirements

## Contexto

La auditoría debe permitir iterar el harness hacia menor consumo, mayor velocidad o mejor calidad sin confundir ausencia de datos con éxito. La evaluación de v0.11.2 identificó errores de captura Codex, privacidad y lifecycle, además de comparaciones sin resultados de trabajo. El usuario aceptó SDD e implementación el 2026-10-03; autorizó base `release/v0.11.2` y rebase sobre `main` tras su publicación.

## Alcance y restricciones

- Extender `navori audit`, sus adaptadores y fuentes existentes; no crear otro board, una base de datos ni un daemon nuevo.
- Claude y Codex comparten significados y estados de disponibilidad, no contadores ficticiamente iguales. Los formatos locales no documentados se adaptan con fixtures y procedencia.
- Preservar invariantes y gates del harness. No ejecutar scripts de transcripts para inferir herramientas.
- Ninguna migración, chmod, borrado de logs existentes, instalación/desinstalación de servicios reales o llamada remota se autoriza por esta spec. Solo escritores nuevos seguros y pruebas aisladas; operaciones existentes permanecen explícitas.
- Reusar los requisitos de medición preregistrados de Spec 0039; no rebajar su muestra ni declarar T44 completo.

## Requisitos (EARS)

- **R1** — WHEN un hook de Claude o Codex inicia audit, el sistema SHALL registrar el host y la identidad de sesión autoritativos en todos los caminos de activación, sin seleccionar una sesión por recencia.
- **R2** — WHEN descubre un transcript o rollout, el sistema SHALL validar formato e identidad antes de seleccionar el adaptador, reportando formato incorrecto o fuente no disponible en vez de una sesión vacía válida.
- **R3** — WHEN procesa logs históricos sin host, el sistema SHALL recuperar el host solo desde evidencia verificable con procedencia explícita, sin modificar el log original ni inferir identidad por nombre de repositorio.
- **R4** — WHEN una fuente ofrece usage numérico, el sistema SHALL contabilizar input, output y componentes de caché observados con semántica por proveedor, separando contadores acumulados de deltas y sin sumar reasoning dos veces.
- **R5** — WHEN hay subagentes, fork, resume o registros repetidos, el sistema SHALL atribuir actividad ejecutada a su thread/request y deduplicar identidades estables, excluyendo historia heredada y marcando atribución insuficiente como parcial o desconocida.
- **R6** — WHEN una métrica no fue observada, el sistema SHALL representar disponibilidad y procedencia explícitas en JSON, texto y agregados, sin contar ausencia como cero ni incluirla en su denominador.
- **R7** — WHEN calcula ventana y salud de sesión, el sistema SHALL incorporar timestamps confiables y errores de cada fuente, distinguir tiempo calendario de tiempo activo y evitar duración cero cuando existe una ventana observada no nula.
- **R8** — WHEN calcula cobertura de un rango, el sistema SHALL mostrar población y captura por host con una regla temporal coherente, separando sesiones raíz y children y declarando denominador desconocido cuando no sea enumerable.
- **R9** — WHEN un comando CLI emite un evento audit, el sistema SHALL unirlo a la sesión exacta mediante contexto explícito validado y preservar el fallback Claude existente, sin usar latest ni aceptar IDs/path symlinks inseguros.
- **R10** — WHEN crea archivos o directorios de audit, el sistema SHALL aplicar permisos privados desde su creación, cubriendo logs, spools y reportes; IF encuentra archivos existentes no privados THEN SHALL advertir sin cambiarlos automáticamente.
- **R11** — WHEN persiste metadatos nuevos o emite ejemplos diagnósticos, el sistema SHALL minimizar contenido sensible y no incorporar prompts, outputs o scripts de Codex para recuperar usage o herramientas; la inclusión de contenido humano en reportes SHALL ser explícita y protegida.
- **R12** — IF descarga de un job launchd falla THEN el sistema SHALL preservar su declaración y reportar error, sin anunciar desinstalación exitosa ni reemplazar un job activo silenciosamente.
- **R13** — WHEN recibe OTLP, el sistema SHALL validar eventos y atributos permitidos con tamaños acotados, rechazar entradas inválidas y conservar evidencia de pérdida o captura parcial sin guardar contenido arbitrario.
- **R14** — WHEN evalúa el piso reviewer/gate, el sistema SHALL contar unidades y duraciones únicamente de la población correlacionada correspondiente; sesiones sin gates SHALL NOT hacer suficiente una muestra insuficiente.
- **R15** — WHEN agrega duración de hooks, el sistema SHALL distinguir trabajo acumulado del peaje bloqueante observable, considerar paralelismo por evento y mostrar cobertura de llamadas de herramientas sin equiparar wrappers Codex con operaciones internas.
- **R16** — WHEN dispone de sidecars review, findings y receipts verificables, el sistema SHALL unir resultado de revisión y gate a feature/diff con deduplicación y procedencia, distinguiendo revisión ausente de aprobada y preservando outcomes mínimos antes de perder sus fuentes efímeras.
- **R17** — WHEN dispone de ejecuciones y resultados de una tarea, el sistema SHALL presentar consumo por tarea aceptada, rondas de revisión, primera aprobación y fallos de gate con N y cobertura, sin premiar menor output como mejor calidad.
- **R18** — WHEN dispone de lifecycle de tarea/etapas, el sistema SHALL mostrar tiempo hasta aceptación, tiempo activo y esperas identificables por separado; tareas abiertas o fuentes incompletas SHALL permanecer censuradas/parciales, no éxitos rápidos.
- **R19** — WHEN compara snapshots, el sistema SHALL validar cohortes y cobertura por repo, host, modelo, régimen y tipo/unidad de trabajo antes de señalar mejora, manteniendo diferencias no comparables como descriptivas/inconclusas y leyendo snapshots anteriores sin inventar dimensiones.
- **R20** — WHEN genera recomendaciones, el sistema SHALL ordenar causas observadas de fricción, errores, repetición y peaje con evidencia y alcance de impacto, separando hechos de hipótesis y sin atribuir causalidad solo a una diferencia de medianas.
- **R21** — WHEN descubre y analiza rangos grandes, el sistema SHALL filtrar antes de resolver fallbacks repetidos, limitar materialización de entradas y exponer truncamiento/presupuestos, con benchmark reproducible de tiempo y memoria en datos sintéticos sin contenido real.
- **R22** — WHILE el receptor permanece activo, el sistema SHALL acotar cachés/estado transitorio y cierre de conexiones/listeners; WHEN informa salud operativa SHALL mostrar recursos y estado observado sin llamar fuga al KeepAlive intencional ni borrar historial sin opt-in.

## Fuera de alcance

- Facturación exacta o cuotas de suscripciones inferidas desde tokens ponderados.
- Una puntuación única de calidad, causalidad garantizada o un benchmark universal de modelos.
- Recolección remota de Jira/GitHub o atribución automática de toda regresión posterior; datos externos se mantendrán opcionales/no disponibles hasta que una integración explícita los autorice.
- Reescritura histórica, retención destructiva automática o cambios en services del operador.
- Cambios de metodología dual/master-plan y publicación de la release, que viven en otras ramas.

## Evidencia de entrada

- `.navori/state/handoffs/audit_deep_audit.md` — síntesis de bugs, reproducciones y prioridades.
- Informes de captura, métricas y runtime del mismo directorio.
- Baseline `72332f7b`; suite audit 438/438 bajo Node; fallos nuevos reproducidos con fixtures/controladores falsos.
