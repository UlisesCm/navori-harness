# Codex: resultados equivalentes y perfiles actuales — Requirements

**Estado:** E1/M1, E2/M2 y E3/T7 están integrados. E4/M4 (T8–T10, resolución/render/doctor deterministas) se envió como entrega parcial en PR #1320; el PR no completó las obligaciones E3/E4. T6, T11 y T12 permanecen pendientes para el cierre final de E4 en un PR, sujeto a workplan clasificado/aprobado, aceptación y verificación de envío.

## Contexto

Esta spec extiende el spine existente para comparar resultados de trabajo entre Claude Code y Codex, usando las capacidades nativas de cada motor. Define perfiles de modelo y esfuerzo para el principal y todos los subagentes habilitados. No promete igualdad de razonamiento, herramientas, hooks, diffs, costo ni resultados futuros para cualquier tarea.

## Requisitos (EARS)

- **R1** — El sistema SHALL expresar para cada ciclo los resultados requeridos: alcance autorizado, revisión independiente, evidencia actual de aceptación, autorización de acción y continuidad, separados del mecanismo de cada motor.
- **R2** — WHEN se publique una capacidad de Codex, el sistema SHALL vincular su estado a versión del host, superficie y evidencia reproducible, distinguiendo enforcement, advisory y ausencia de soporte, sin generalizar una sonda a hosts no verificados.
- **R3** — WHEN un criterio de aceptación se marque cumplido, el sistema SHALL exigir evidencia de una ejecución exitosa vinculada al criterio y al estado actual del trabajo; una declaración textual no SHALL bastar.
- **R4** — WHEN cambien bytes relevantes, comando de validación, inputs del gate o contexto del criterio, el sistema SHALL invalidar la evidencia afectada hasta ejecutar de nuevo la verificación pertinente.
- **R5** — WHEN un ciclo reclame revisión aprobada, el sistema SHALL exigir una revisión en contexto independiente del productor sobre el estado identificado del diff e invalidarla cuando ese estado cambie.
- **R6** — WHEN una acción requiera aprobación, el sistema SHALL vincular la autorización humana o del host a la acción, destino y estado del diff, impedir su reutilización para otro alcance y rechazar un registro del principal que carezca de una fuente autorizante aplicable.
- **R7** — IF un subagente no puede obtener o demostrar la autorización exigida, THEN el sistema SHALL devolver al principal una solicitud pendiente y prohibir que ese contexto ejecute la acción; el principal solo SHALL tramitar o acreditar autorización humana o del host previamente concedida para esa acción y alcance.
- **R8** — WHEN una sesión se reanude o cambie de contexto, el sistema SHALL recuperar la tarea y el siguiente paso sin considerar vigentes aprobaciones, revisiones o evidencia cuyo vínculo al estado actual no pueda comprobarse.
- **R9** — WHEN el perfil Codex use mappings predeterminados, el sistema SHALL resolver Opus a Sol y Sonnet/Haiku a Luna; únicamente Sonnet medium SHALL elevarse a Luna high y los demás esfuerzos SHALL conservarse.
- **R10** — WHEN se resuelva una familia, el sistema SHALL elegir la versión numérica compatible más alta del catálogo local disponible y SHALL distinguir latest-known candidate de disponibilidad runtime verificada.
- **R11** — WHEN el usuario configure un pin de modelo o un override explícito de esfuerzo para Codex, el sistema SHALL priorizar ese campo sobre el mapping predeterminado y conservarlo al actualizar familias.
- **R12** — WHEN se renderice o inicie una sesión Codex, el sistema SHALL reevaluar el perfil del principal y de cada subagente habilitado —core, extra y local—, indicando los perfiles faltantes y manteniendo explícita la herencia.
- **R13** — WHEN vaya a comenzar un nuevo dispatch Codex, el sistema SHALL comprobar la vigencia de su preparación y actualizarla mediante el mecanismo nativo disponible, o dejarla pendiente si el host no permite aplicarla; cada identidad de preparación SHALL tener un solo consumidor, sin consumo cruzado entre rol o acción.
- **R14** — El sistema SHALL distinguir por perfil intención configurada, resolución, representación renderizada y selección efectiva observada, indicando fuente y esfuerzo en cada etapa; renderizar SHALL NOT probar observación runtime.
- **R15** — IF el catálogo es inexistente, inválido, obsoleto o carece de una fuente verificable de frescura, THEN el sistema SHALL declarar estado degraded o unknown, nunca latest vigente; el último perfil conocido puede mostrarse como candidato, sin downgrade ni sustitución silenciosa.
- **R16** — El sistema SHALL limitar los cambios de perfil al ámbito project-managed autorizado, preservar pins, contenido del usuario, configuración global y trust, y no cambiar silenciosamente al principal ni a subagentes que ya están en curso.
- **R17** — WHEN se proponga aceptar los resultados de la feature, el sistema SHALL aportar una evaluación comparativa Claude/Codex con tareas fijadas, todos los controles obligatorios satisfechos y fallas, reintentos, duración y consumo registrados cuando estén disponibles; la evaluación futura y sus resultados son condicionales, no una garantía causal del modelo.
- **R18** — WHEN el host activo no soporte el modelo o esfuerzo solicitado, el sistema SHALL detener su nueva selección y presentar una alternativa concreta para decisión humana, sin degradar esfuerzo ni cambiar de familia automáticamente.

## Alcance y aceptación

La evaluación cubre un conjunto acotado de escenarios reproducibles; no demuestra equivalencia universal. “Latest-known” significa el candidato compatible más alto del catálogo cuya actualidad pueda acreditarse con evidencia del host/contexto. Sin fuente de frescura, la actualidad es unknown/degraded. Configurado o renderizado no equivale a observado. Los perfiles nuevos aplican a inicios y dispatches futuros; no modifican trabajo ya iniciado.

## Alcance aprobado de la entrega final

La entrega final puede añadir, con opt-in explícito por proyecto, una integración nativa
Codex acotada a autorización de una publicación fija de PR y observación de catálogo,
perfiles y evaluación del host. La ejecución ordinaria sigue bajo control del engine. El
diseño permite implementar un controlador de navegador del host operado por una persona y
una frontera de efecto fija; la aprobación de alcance no acredita que ese controlador, el
efecto o la observación de perfiles ya existan o funcionen. No se autoriza una API genérica
de ejecución, runner, broker de modelos, dependencia nueva, superficie always-on ni cambios
globales de permisos, configuración o trust. La integración no reduce ni sustituye las
garantías R6, R9 o R10.

Para R14, una selección de contexto Codex observada al inicio puede servir como evidencia
del perfil principal si queda vinculada a ese contexto real. No se exige telemetría de
inferencia por turno ni se acepta un hilo de rol ajeno. La observación faltante, desconocida
o discordante mantiene A9 pendiente. R1–R18 y sus garantías EARS anteriores permanecen sin
cambio. La evaluación R17 exige los controles definidos y ocho resultados vivos acotados;
no establece equivalencia universal ni causalidad atribuible al modelo.

E1 y E2 están integrados; E4/M4 fue una entrega parcial en PR #1320, sin completar E4.
E3/T6 y E4/M5 conservan evidencia parcial o pendiente según `tasks.md`. El cierre final de
E4 entregará T6, T11 y T12 junto con A5/A6/A9/A10 originales en un PR, tras workplan
clasificado/aprobado, revisión independiente y verificación de envío. Esta enmienda
documental no cierra esos requisitos ni convierte la evidencia histórica en aceptación
actual.
