# Auditoría profunda de agentes, skills y sinergia de Navori

**Fecha:** 2026-09-23 · **Versión renderizada:** 0.10.0 · **Snapshot:** `6edc58b4f5750918fc8ee93c4aa5869f718d3c99`.

**Naturaleza:** revisión en frío, inspección de contratos y código, pruebas locales y contraste con documentación oficial. No es un experimento A/B de productividad. Las propuestas de este documento no autorizan ni implementan cambios al harness.

## 1. Dictamen ejecutivo

**Navori tiene una base sólida para controlar calidad, pero todavía no hay evidencia suficiente para llamarlo la configuración óptima de calidad, tokens o tiempo.** Sus mejores componentes son la revisión independiente, las fronteras de responsabilidad, el render reproducible y los contratos verificables. El problema principal no es que falten más agentes o skills: es la coherencia entre instrucciones, la portabilidad de sus controles y la medición del beneficio neto.

- **Agentes:** ocho roles evaluados individualmente; buena especialización, con oportunidades claras en economía de contexto y validación de handoffs.
- **Skills:** se distingue el catálogo distribuible, lo instalado en este proyecto y las extensiones de plugins. Una skill inactiva aquí no se considera defectuosa por esa razón.
- **Sinergia:** la separación de funciones es mayormente intencional, pero hay dos contradicciones concretas en el contrato de evidencia y diferencias de enforcement entre hosts.
- **Visión:** `docs/DIRECTION.md:47-78` prioriza **calidad > tokens > velocidad**. No corresponde retirar revisión o guardrails únicamente porque agreguen tokens; sí exigir que su costo y beneficio sean observables.
- **Primera inversión recomendada:** corregir contradicciones pequeñas y descubribilidad de skills locales; después medir variantes. No agregar otro agente ni otro nivel de proceso como respuesta inicial.

### Tablero de resultados

| Cohorte | N | Nota estática /100 | Interpretación |
|---|---:|---:|---|
| Agentes | 8 | 85.2 | Roles sólidos; no califica modelos por rendimiento real. |
| Skills activas nativas en Codex | 20 | 83.9 | Core/workflow y cuatro bibliotecas. |
| Todo el catálogo standalone, incluidos locales | 82 | 79.0 | No ponderado por uso; no equivale a huella de una sesión. |
| Fragmentos de plugin | 8 | 81.3 | Se evalúan aparte de las skills invocables. |
| Sinergia agente–agente | — | 71.3 | Contratos buenos, economía y equivalencia de controles parciales. |
| Sinergia agente–skill | — | 71.3 | Dependencias de host, capacidades y discovery local. |
| Sinergia skill–skill | — | 75.0 | Composición mayormente válida; contradicciones puntuales. |

**Estos números son calificaciones editoriales del diseño, no tasas de éxito ni porcentajes de mejora.** Un 85 no significa “85% de bugs detectados”. No se calcula una nota global que mezcle componentes activos, catálogo inactivo y efectividad todavía no medida.

## 2. Método, pesos y límites

Tres lecturas especializadas cubrieron agentes, skills y relaciones; la síntesis contrastó sus afirmaciones esenciales y descartó falsos positivos. En particular, se retiró como defecto la ausencia de hard gate de planificación en Codex: el código ya comunica esa degradación mediante `doctor`.

### Rúbrica común

| Eje | Peso | Qué se evalúa |
|---|---:|---|
| C — Claridad y activación | 20% | Responsabilidad, disparador, exclusiones y salida inequívocos. |
| W — Cableado y portabilidad | 25% | Registro, rutas, referencias, capacidades y comportamiento entre hosts. |
| Q — Calidad y seguridad | 25% | Verificación, manejo de errores, límites de escritura y controles pertinentes. |
| E — Economía | 15% | Contexto proporcional, ausencia de trabajo duplicado y paralelismo justificado. |
| V — Evidencia | 15% | Qué tan probado está el contrato, distinguiendo render de conducta real. |

Cada eje usa enteros de **0 a 4**: 0 ausente/inválido; 1 deficiente; 2 parcial; 3 sólido con brechas; 4 sólido y demostrado dentro del alcance. Para V, 4 requiere evaluación conductual comparativa repetible; 3 admite contratos/tests sólidos; 2 evidencia parcial; 1 sólo afirmaciones; 0 ninguna.

`Puntuación = 5C + 6.25W + 6.25Q + 3.75E + 3.75V`.

Los totales se calculan con esa fórmula y se presentan con un decimal. Las medias usan valores sin redondear. Cada ítem pesa igual dentro de su cohorte; **no** se pondera por frecuencia de uso porque no hay un censo actual comparable. Diferencias de pocos puntos no deben interpretarse como un ranking estadísticamente significativo. Subir un punto en W/Q cambia 6.25 puntos el total; en C, 5; en E/V, 3.75.

### Tipos de afirmación

- **Verificado:** evidencia textual, estructural o salida ejecutada en este snapshot.
- **Riesgo:** hay un mecanismo plausible, pero no se reprodujo un incidente.
- **Brecha de evidencia:** no se puede probar una ventaja o equivalencia con lo inspeccionado.
- **Histórico:** observación de otra versión, útil para formular experimentos, no para describir causalmente 0.10.0.

La severidad describe impacto potencial, no probabilidad medida. Confianza alta significa evidencia directa; media significa inferencia dependiente del host/uso. No se asignan porcentajes inventados de confianza.

## 3. Inventario y alcance

| Grupo | Artefactos | Materializados nativamente en Codex aquí | Nota media |
|---|---:|---:|---:|
| Core/workflow | 16 | 16 | 87.0 |
| Bibliotecas | 36 | 4 | 73.9 |
| Presets | 26 | 0 | 82.1 |
| Locales del repo | 4 | 0 | 72.5 |
| **Standalone** | **82** | **20** | — |
| Extensiones de plugins | 8 | Se componen en destinos, no como slugs autónomos | — |

**Cobertura:** 90 artefactos de skill/extensión y ocho roles. Las 26 skills de preset no se instalan aquí porque el preset es `custom`; 32 de las 36 bibliotecas tampoco se seleccionan. Claude tiene las 20 comunes más cuatro locales.

Los ocho roles fuente son `orchestrator`, `architect`, `auditor`, `scout`, `implementer`, `scribe`, `reviewer` y `publisher`. Claude materializa ocho fichas; Codex siete: el principal incorpora orquestación mediante `AGENTS.md`. **No es un agente faltante** (`packages/cli/src/engines/codex/index.ts:396-412`).

Se excluyen skills personales externas, Cloudflare y plugins bundled de OpenAI: aparecen en el entorno del operador, pero no son producto de Navori. Se incluyen las cuatro skills locales declaradas por este repo. Los renders duplicados no cuentan como nuevas skills.

## 4. Calidad individual de los agentes

| Agente | C | W | Q | E | V | Total | Tamaño/rango | Fortaleza | Mejora específica | Evidencia principal |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|
| architect | 4 | 3 | 3 | 4 | 3 | **83.8** | 676 fuente / 721 Claude / 636 Codex palabras | Separa diseño, veredicto y descomposición; exige alternativas reales. | Añadir un contrato ejecutable que compruebe opciones, decisión y citas en `solution_*.md`; declarar explícitamente qué hacer si `origin/main` no está disponible. | `packages/core/core-assets/agents/architect.md:13-42`; `packages/cli/src/engines/codex/compat.ts:141-152`; `packages/cli/src/lib/__tests__/agents-assets.test.ts:345-365` |
| auditor | 4 | 4 | 4 | 2 | 3 | **88.8** | 1,760 / 2,065 / 1,823 | Plantillas y reglas para evidencia, seguridad y performance son las más completas. | Dividir el encargo "area" en modo rápido/profundo configurable; instrumentar cobertura real de ejes, no solo secciones escritas. | `packages/core/core-assets/agents/auditor.md:48-55,72-141`; `.claude/agents/auditor.md:4`; `packages/cli/src/lib/__tests__/mcp-capability-wiring.test.ts:362+` |
| implementer | 4 | 4 | 4 | 2 | 3 | **88.8** | 2,466 / 2,424 / 2,584 | Contrato de una tarea, gate propio, límite de scope, tipado y evidencia fresca. | Extraer el protocolo de fallos/gate a referencias normativas y medir si la prohibición absoluta de Markdown reduce o aumenta ciclos. | `packages/core/core-assets/agents/implementer.md:36-66,85-96,142-181`; `packages/cli/src/lib/__tests__/implementer-no-markdown.test.ts:63-178` |
| orchestrator (rol principal) | 3 | 4 | 4 | 2 | 3 | **83.8** | 3,184 / 3,705; Codex vía AGENTS | Impone secuencia implementer→reviewer, paralelismo sólo con scopes disjuntos y ownership claro. | Reducir duplicación entre bloque siempre cargado y playbook de profundidad; sustituir reglas históricas por un enlace/artefacto verificable y medir activaciones/esperas. | `packages/core/core-assets/managed/orquestacion.md:1-65`; `packages/core/core-assets/agents/orchestrator.md:12-16,45-109,127-155`; `packages/cli/src/engines/codex/index.ts:396-412` |
| publisher | 4 | 4 | 4 | 1 | 3 | **85.0** | 3,930 / 4,402 / 4,151 | Receipt, drift, base explícita y no force-push contienen fallos reales de publicación. | Modularizar el cuerpo de PR, comments y worktree como skill/función invocable; el prompt es el mayor coste por invocación. | `packages/core/core-assets/agents/publisher.md:54-109,111-186,188-300`; `packages/cli/src/lib/__tests__/commit-pr-pilot-contract.test.ts:89-529` |
| reviewer | 4 | 4 | 4 | 2 | 3 | **88.8** | 2,285 / 2,827 / 2,616 | Dos pases, base PR correcta, receipt firmado y gate completo son controles sólidos. | Añadir test/eval adversarial de revisión (bugs sembrados) y un límite explícito para no reabrir diseño; hoy el rendimiento real no está medido. | `packages/core/core-assets/agents/reviewer.md:16-47,65-110,112-194`; `packages/cli/src/lib/__tests__/reviewer-gate-ownership.test.ts:26-96` |
| scout | 4 | 4 | 3 | 4 | 3 | **90.0** | 1,151 / 1,160 / 1,045 | Encargo acotado, evidencia/cobertura negativa y uso de MCP de sólo lectura minimizan trabajo duplicado. | Añadir un formato de respuesta estructurado/validable para que el orquestador pueda fusionar N scouts sin relectura manual. | `packages/core/core-assets/agents/scout.md:12-45,47-110`; `.claude/agents/scout.md:4`; `packages/cli/src/lib/__tests__/mcp-capability-wiring.test.ts:362+` |
| scribe | 3 | 3 | 2 | 4 | 3 | **72.5** | 473 / 315 / 446 | Separar redacción de implementación reduce el riesgo de que un implementer altere docs sin evidencia. | Validar schema, worktree/branch, paths y que el diff Markdown coincida con `markdownRequests` antes de editar/committear. | `packages/core/core-assets/agents/scribe.md:27-43`; `packages/cli/src/__tests__/scribe-owns-markdown-contracts.test.ts:90-161`; `packages/core/core-assets/managed/orquestacion.md:21` |

**Lectura de las oportunidades:** las mejoras de la tabla son propuestas, no bugs reproducidos. En particular, un formato estructurado para scout o un perfil corto de auditor sólo se justifica si una prueba demuestra menos relectura/costo. No recomiendo sumar ambos de inmediato.

### Huella documental de los agentes

Las fichas Claude suman **17,619 palabras**, contadas como unidades separadas por espacios, incluyendo frontmatter/instrucciones y extensiones. No son tokens, ni se cargan todas en cada tarea. `publisher` tiene 4,402 palabras y `orchestrator` 3,705; representan aproximadamente **46%** de esa suma. Un rol corto puede ser caro por sus tools, contexto heredado o iteraciones; un rol largo puede amortizarse por caché. Por eso esta métrica sirve para localizar candidatos, no para calcular dinero o ahorro.

La configuración efectiva de modelos y esfuerzos se toma de `navori.config.json` y del render del host, no de la reputación del modelo. No se ejecutó una comparación entre modelos; no se recomienda reemplazarlos únicamente con estas notas.

## 5. Calidad individual de las skills

**Cómo leer las tablas:** “validar” o “añadir fixture” identifica una oportunidad de evidencia. No significa que el comportamiento esté roto. Las fortalezas evalúan el contenido; W evalúa su disponibilidad y composición. Las referencias identifican el asset y su sección pertinente.

### Core/workflow activos

| Skill | C/W/Q/E/V | Total | Fortaleza / mejora verificable | Evidencia |
|---|---:|---:|---|---|
| author-skill | 4/4/3/3/3 | 86.3 | Fortaleza: elige ubicación y frontmatter portable. Validar creación con nombre duplicado y referencias faltantes; comprobar carga en cada host, no sólo parseo. | `packages/core/core-assets/skills/author-skill.md:1-71` |
| debug-failure | 4/4/4/4/3 | 96.3 | Fortaleza: reproduce antes de editar y cambia una hipótesis a la vez. Evaluar con error truncado y síntoma que persiste; medir si evita el segundo parche especulativo. | `packages/core/core-assets/skills/debug-failure.md:1-59` |
| dominio | 3/3/3/3/2 | 71.3 | Fortaleza: distingue conocimiento transversal de memoria de sesión. Validar ausencia de Dominio/CLI y que un hecho local no se promueva innecesariamente. | `packages/core/core-assets/skills/dominio.md:1-68` |
| follow-up-prs | 4/3/3/3/3 | 80.0 | Fortaleza: convierte feedback en encargos. Probar comentario resuelto, repetido y nuevo tras push para evitar reabrir trabajo ya atendido. | `packages/core/core-assets/skills/follow-up-prs.md:1-71` |
| locate-code | 4/4/3/4/3 | 90.0 | Fortaleza: lectura acotada y fallback explícito. Evaluar recall de call sites y proveedor caído; no premiar sólo reducción de búsquedas. | `packages/core/core-assets/skills/locate-code.md:1-72` |
| plan-advanced | 4/4/4/3/3 | 92.5 | Fortaleza: architect y challenge antes del plan. Evaluar escalación tras dos rechazos sin repetir una decisión ya aceptada. | `packages/core/core-assets/skills/plan-advanced.md:1-48` |
| plan-simple | 4/4/4/3/3 | 92.5 | Fortaleza: classify/render/check enlazados. Probar cambio de scope después de aprobar: debe detectar plan desactualizado. | `packages/core/core-assets/skills/plan-simple.md:1-45` |
| quality-attributes | 3/3/3/3/2 | 71.3 | Fortaleza: convierte NFR en criterio, evidencia y dueño. Validar una fila sin criterio medible; no obligar NFR artificial en un cambio local. | `packages/core/core-assets/skills/quality-attributes.md:1-37` |
| resolve-ticket | 4/4/4/3/3 | 92.5 | Fortaleza: problema separado de solución propuesta. Evaluar ticket no reproducible y ticket multiarea; no abrir implementación sólo por recibir un ID. | `packages/core/core-assets/skills/resolve-ticket.md:1-42` |
| review-diff | 4/4/4/3/3 | 92.5 | Fortaleza: checklist con severidades y gate. Calibrar falsos positivos y bugs sembrados con revisión ciega, no sólo presencia de secciones. | `packages/core/core-assets/skills/review-diff.md:1-138` |
| scoped-gate | 4/4/4/3/3 | 92.5 | Fortaleza: higiene de deuda sin sustituir el gate completo. Ejecutar casos de archivo movido, consumidor no editado y baseline faltante. | `packages/core/core-assets/skills/scoped-gate.md:1-105` |
| secure-by-design | 3/4/4/3/2 | 83.8 | Fortaleza: diseña contra amenazas antes del diff. Evaluar que una amenaza termine en control y prueba concreta, no sólo una lista genérica. | `packages/core/core-assets/skills/secure-by-design.md:1-52` |
| security-invariants | 4/4/4/3/3 | 92.5 | Fortaleza: autorización, IDOR y PII que el scanner no decide. Calibrar severidad por contexto y añadir ejemplos cookie-session seguros frente a almacenamiento inseguro. | `packages/core/core-assets/skills/security-invariants.md:1-83` |
| solution-design | 4/4/4/3/3 | 92.5 | Fortaleza: alternativas reales y falsificación fresca. Medir cambios de decisión causados por evidencia del challenge; evitar alternativas de relleno. | `packages/core/core-assets/skills/solution-design.md:1-140` |
| spec-bootstrap | 4/4/4/3/3 | 92.5 | Fortaleza: EARS y trazabilidad R↔test. Validar requisito sin test y test que cita R pero no comprueba su conducta. | `packages/core/core-assets/skills/spec-bootstrap.md:1-98` |
| verify-before-done | 4/3/2/3/3 | 73.8 | Fortaleza: exige evidencia observada. Defectos F01/F02: atribución contradictoria y frescura por turno incompatible con reutilización; unificar contratos. | `packages/core/core-assets/skills/verify-before-done.md:1-72` |

### Biblioteca (catálogo; 4 activos)

| Skill | C/W/Q/E/V | Total | Fortaleza / mejora verificable | Evidencia |
|---|---:|---:|---|---|
| apollo-client | 3/3/3/3/2 | 71.3 | Fortaleza: cache, queries y mutations delimitadas. Validar actualización de entidad normalizada e invalidación; comprobar API contra versión declarada. | `packages/core/core-assets/lib-skills/apollo-client.md:1-73` |
| axios | 3/3/3/3/2 | 71.3 | Fortaleza: cliente común y errores consistentes. Evaluar cancelación, timeout y retry sólo cuando sea seguro; no duplicar interceptores por recurso. | `packages/core/core-assets/lib-skills/axios.md:1-73` |
| bullmq | 3/4/4/3/2 | 83.8 | Fortaleza: retries e idempotencia. Probar entrega repetida, job duplicado y fallo parcial para no confundir retry con exactly-once. | `packages/core/core-assets/lib-skills/bullmq.md:1-67` |
| citty | 3/3/3/3/2 | 71.3 | Fortaleza: defineCommand y argumentos tipados. Validar positional/string/boolean y hooks contra citty soportado; conservar errores de uso observables. | `packages/core/core-assets/lib-skills/citty.md:1-88` |
| clack | 3/3/3/3/2 | 71.3 | Fortaleza: cancelación y flujos de prompts. Probar cancelación en cada paso y ejecución sin TTY, sin efectos posteriores al cancel. | `packages/core/core-assets/lib-skills/clack.md:1-95` |
| cypress | 3/3/3/3/2 | 71.3 | Fortaleza: selectores y aislamiento E2E. Evaluar estado compartido entre tests y esperar condición observable, no pausas fijas. | `packages/core/core-assets/lib-skills/cypress.md:1-62` |
| dashboard-patterns | 3/2/3/3/2 | 65.0 | Fortaleza: tablas, filtros y paginación. Verificar cómo habilitarla en dashboard sin dependencia detectable; no asumir que ausencia de señal significa ausencia de dashboard. | `packages/core/core-assets/lib-skills/dashboard-patterns.md:1-67` |
| drizzle-orm | 3/3/3/3/2 | 71.3 | Fortaleza: queries tipadas y migraciones separadas. Probar transacción fallida y aprobación explícita antes de mutar schema. | `packages/core/core-assets/lib-skills/drizzle-orm.md:1-68` |
| expo-sqlite | 3/3/3/3/2 | 71.3 | Fortaleza: ciclo de conexión y listeners locales. Validar cierre/reapertura y transacción en SDK/dispositivo objetivo, no sólo un mock Node. | `packages/core/core-assets/lib-skills/expo-sqlite.md:1-63` |
| i18next | 3/3/3/3/2 | 71.3 | Fortaleza: claves, interpolación y fallback. Probar clave ausente, pluralización y contenido no confiable sin cambiar estrategia del proyecto. | `packages/core/core-assets/lib-skills/i18next.md:1-69` |
| jest | 3/3/3/3/2 | 71.3 | Fortaleza: mocks y setup de test. Evaluar reset de módulos/mocks y selección del runner si coexiste Vitest; no trasladar APIs por similitud. | `packages/core/core-assets/lib-skills/jest.md:1-75` |
| maestro | 3/3/3/3/2 | 71.3 | Fortaleza: flujos E2E móviles. Probar descubrimiento en workspace anidado y estado de app entre flujos. | `packages/core/core-assets/lib-skills/maestro.md:1-65` |
| mantine-form | 3/3/3/3/2 | 71.3 | Fortaleza: validación y estado de formularios. Explicitar dueño cuando coexiste React Hook Form; probar inputs controlados/no controlados usados por el repo. | `packages/core/core-assets/lib-skills/mantine-form.md:1-69` |
| mongoose | 3/4/4/3/2 | 83.8 | Fortaleza: modelado y ObjectId. Validar casting, actualización parcial y scope de tenant; el modelo no sustituye autorización. | `packages/core/core-assets/lib-skills/mongoose.md:1-78` |
| nativewind | 3/3/3/3/2 | 71.3 | Fortaleza: estilos React Native con utilidades. Probar clases dinámicas y compatibilidad del bundler/SDK declarado. | `packages/core/core-assets/lib-skills/nativewind.md:1-57` |
| playwright | 3/3/3/3/2 | 71.3 | Fortaleza: locators y E2E. Distinguir creación de tests de navegación manual con playwright-cli; validar aislamiento por contexto. | `packages/core/core-assets/lib-skills/playwright.md:1-77` |
| react-hook-form | 3/3/3/3/2 | 71.3 | Fortaleza: registro, validación y errores. Probar input controlado de librería UI y reset; definir ownership si hay Mantine Form. | `packages/core/core-assets/lib-skills/react-hook-form.md:1-71` |
| react-native-reusables | 3/3/3/3/2 | 71.3 | Fortaleza: componentes/primitivas locales. Verificar detección cuando el código se copió al repo sin dependencia que lo identifique. | `packages/core/core-assets/lib-skills/react-native-reusables.md:1-65` |
| react-navigation | 3/3/3/3/2 | 71.3 | Fortaleza: parámetros y lifecycle de navegación. Probar deep link, back y unmount con tipos de rutas reales. | `packages/core/core-assets/lib-skills/react-navigation.md:1-72` |
| react-router | 3/3/3/3/2 | 71.3 | Fortaleza: rutas y loaders. Probar API de la versión instalada y errores de navegación; no mezclar modos por inferencia. | `packages/core/core-assets/lib-skills/react-router.md:1-72` |
| redux-toolkit | 3/3/3/3/2 | 71.3 | Fortaleza: slices y lógica async. Separar estado cliente de cache remoto cuando coexiste TanStack Query; evitar dos fuentes de verdad. | `packages/core/core-assets/lib-skills/redux-toolkit.md:1-72` |
| socketio-client | 3/4/4/3/2 | 83.8 | Fortaleza: cleanup y conexión autenticada. Probar reconnect sin listeners duplicados y token vencido. | `packages/core/core-assets/lib-skills/socketio-client.md:1-65` |
| socketio-server | 3/4/4/3/2 | 83.8 | Fortaleza: handshake, rooms y autorización. Probar evento sobre room ajena y cambios de sesión; autenticación inicial no autoriza todo evento. | `packages/core/core-assets/lib-skills/socketio-server.md:1-70` |
| stripe | 3/4/4/3/2 | 83.8 | Fortaleza: secretos y webhooks. Probar firma, replay e idempotencia; no llamar a infraestructura real desde la evaluación de la skill. | `packages/core/core-assets/lib-skills/stripe.md:1-95` |
| supabase-edge-functions | 3/2/4/3/2 | 71.3 | Fortaleza: frontera de confianza de función edge. Verificar detección repo-root/workspace y autorización real dentro de la función. | `packages/core/core-assets/lib-skills/supabase-edge-functions.md:1-65` |
| supabase-postgres | 3/2/4/3/2 | 71.3 | Fortaleza: RLS y migraciones. Probar policy denegada/permitida y ubicación de señales en monorepo. | `packages/core/core-assets/lib-skills/supabase-postgres.md:1-57` |
| supabase-selfhost | 3/2/4/3/2 | 71.3 | Fortaleza: operación de stack self-hosted. Probar paths alternativos de configuración y separación lectura/propuesta frente a cambios de infraestructura. | `packages/core/core-assets/lib-skills/supabase-selfhost.md:1-63` |
| supabase | 3/4/4/3/2 | 83.8 | Fortaleza: auth y separación cliente/servidor. Probar que service-role no alcance frontend y que las queries dependan de RLS esperada. | `packages/core/core-assets/lib-skills/supabase.md:1-63` |
| supertest | 3/3/3/3/2 | 71.3 | Fortaleza: integración HTTP. Probar lifecycle del servidor y runner sin puertos disponibles; distinguir error de entorno de aserción funcional. | `packages/core/core-assets/lib-skills/supertest.md:1-80` |
| tamagui | 3/3/3/3/2 | 71.3 | Fortaleza: tokens y UI multiplataforma. Validar tema/responsive en web y nativo con versión declarada. | `packages/core/core-assets/lib-skills/tamagui.md:1-72` |
| tanstack-query | 3/3/3/3/2 | 71.3 | Fortaleza: cache e invalidación. Probar mutation y query-key; explicitar frontera con stores cliente, no duplicar resultados remotos. | `packages/core/core-assets/lib-skills/tanstack-query.md:1-70` |
| testing-library | 3/4/4/3/2 | 83.8 | Fortaleza: consultas orientadas al usuario. Distinguir DOM/RN y verificar async/cleanup sin assertions de implementación. | `packages/core/core-assets/lib-skills/testing-library.md:1-77` |
| vitest | 3/3/3/3/2 | 71.3 | Fortaleza: hoisting de mocks, entorno y timers. Validar ejemplos contra la versión instalada (esta corrida usa Vitest 5.0.1), no asumir versión por memoria. | `packages/core/core-assets/lib-skills/vitest.md:1-79` |
| winston-logging | 3/4/4/3/2 | 83.8 | Fortaleza: logging estructurado. Probar redacción de tokens/PII y serialización de errores; el entorno dev no vuelve inocuo un secreto. | `packages/core/core-assets/lib-skills/winston-logging.md:1-73` |
| zod-validation | 3/3/3/3/2 | 71.3 | Fortaleza: validación en trust boundary y DTO inferido. Probar input hostil, campos extra y transformación; conservar comportamiento de la versión Zod elegida. | `packages/core/core-assets/lib-skills/zod-validation.md:1-105` |
| zustand | 3/3/3/3/2 | 71.3 | Fortaleza: store pequeño y selectores. Probar actualización/reactividad y definir qué estado no pertenece aquí si existe cache remoto. | `packages/core/core-assets/lib-skills/zustand.md:1-81` |

### Preset (catálogo; inactivos por custom)

| Skill | C/W/Q/E/V | Total | Fortaleza / mejora verificable | Evidencia |
|---|---:|---:|---|---|
| astro-islands | 3/4/3/3/2 | 77.5 | Fortaleza: hidratación explícita. Medir JS enviado y probar isla no interactiva sin hidratar accidentalmente. | `packages/core/core-assets/presets/astro/skills/astro-islands.md:1-68` |
| job-scheduling | 3/4/4/3/2 | 83.8 | Fortaleza: scheduling con reintento/idempotencia. Probar disparo cron duplicado y recuperación tras caída. | `packages/core/core-assets/presets/background-worker/skills/job-scheduling.md:1-56` |
| queue-consumers | 3/4/4/3/2 | 83.8 | Fortaleza: ack, DLQ y backpressure. Probar poison message y fallo entre efecto y ack. | `packages/core/core-assets/presets/background-worker/skills/queue-consumers.md:1-58` |
| worker-lifecycle | 3/4/4/3/2 | 83.8 | Fortaleza: cierre ordenado. Probar SIGTERM con trabajo activo, drain y límite de espera. | `packages/core/core-assets/presets/background-worker/skills/worker-lifecycle.md:1-61` |
| keystone-access | 4/4/4/3/2 | 88.8 | Fortaleza: acceso restrictivo. Probar tenant ajeno y variantes de operación, no sólo la query nominal. | `packages/core/core-assets/presets/bun-keystone/skills/keystone-access.md:1-53` |
| keystone-graphql | 3/4/4/3/2 | 83.8 | Fortaleza: contexto y guard de resolver. Probar resolver custom que omite acceso del recurso. | `packages/core/core-assets/presets/bun-keystone/skills/keystone-graphql.md:1-57` |
| keystone-models | 3/4/4/3/2 | 83.8 | Fortaleza: modelo, hooks y contexto privilegiado. Probar afterOperation parcial y mantener sudo explícitamente acotado. | `packages/core/core-assets/presets/bun-keystone/skills/keystone-models.md:1-62` |
| keystone-rest | 3/4/4/3/2 | 83.8 | Fortaleza: controller delgado y validación. Definir precedencia con reglas Express y probar petición no autorizada. | `packages/core/core-assets/presets/bun-keystone/skills/keystone-rest.md:1-48` |
| keystone-testing | 3/4/4/3/2 | 83.8 | Fortaleza: unidad e integración del contexto. Validar contra Keystone/runner declarados y no sólo mocks del happy path. | `packages/core/core-assets/presets/bun-keystone/skills/keystone-testing.md:1-76` |
| prisma-keystone | 3/4/4/3/2 | 83.8 | Fortaleza: schema derivado y migraciones. Probar drift y no modificar directamente un artefacto generado. | `packages/core/core-assets/presets/bun-keystone/skills/prisma-keystone.md:1-58` |
| express-routes | 4/4/4/3/2 | 88.8 | Fortaleza: validación/error handling en rutas. Probar async failure y middleware de autorización antes del efecto. | `packages/core/core-assets/presets/express-mongoose/skills/express-routes.md:1-74` |
| mongo-aggregations | 3/4/4/3/2 | 83.8 | Fortaleza: casting y proyección. Probar fuga cross-tenant y campos sensibles en joins/projections. | `packages/core/core-assets/presets/express-mongoose/skills/mongo-aggregations.md:1-64` |
| new-endpoint | 4/3/3/3/2 | 76.3 | Fortaleza: secuencia acotada de endpoint. Declarar qué reglas hereda de express-routes en vez de reescribirlas. | `packages/core/core-assets/presets/express-mongoose/skills/new-endpoint.md:1-40` |
| new-resource (Express) | 4/3/3/3/2 | 76.3 | Fortaleza: recorrido recurso end-to-end. Probar convivencia con new-endpoint sin hacer dos veces modelo/ruta/test. | `packages/core/core-assets/presets/express-mongoose/skills/new-resource.md:1-45` |
| medusa-api-routes | 3/4/4/3/2 | 83.8 | Fortaleza: rutas store/admin y middleware. Probar auth por contexto de ruta y validación de entrada. | `packages/core/core-assets/presets/medusa/skills/medusa-api-routes.md:1-54` |
| medusa-modules | 3/4/4/3/2 | 83.8 | Fortaleza: entidad, servicio y workflow. Probar compensación ante fallo parcial, no sólo creación exitosa. | `packages/core/core-assets/presets/medusa/skills/medusa-modules.md:1-47` |
| turbo-workspaces | 3/4/3/3/2 | 77.5 | Fortaleza: comandos acotados al workspace. Probar filtro en workspace anidado sin ejecutar o saltar paquetes equivocados. | `packages/core/core-assets/presets/monorepo-turbopnpm/skills/turbo-workspaces.md:1-51` |
| nestjs-dtos-validation | 4/4/4/3/2 | 88.8 | Fortaleza: DTO en frontera. Probar whitelist/transform global y payload con campos no autorizados. | `packages/core/core-assets/presets/nestjs/skills/nestjs-dtos-validation.md:1-77` |
| nestjs-modules | 3/4/3/3/2 | 77.5 | Fortaleza: DI y límites de módulos. Probar provider scope y evitar dependencias circulares al extender el recurso. | `packages/core/core-assets/presets/nestjs/skills/nestjs-modules.md:1-57` |
| new-resource (Next.js) | 4/3/3/3/2 | 76.3 | Fortaleza: recurso Next end-to-end. Mantener límites Server/Client y probar identidad de skill si se combinan catálogos de presets. | `packages/core/core-assets/presets/nextjs/skills/new-resource.md:1-67` |
| nextjs-app-router | 4/4/4/3/2 | 88.8 | Fortaleza: frontera Server/Client. Probar acción de servidor con autorización y no arrastrar secretos al bundle. | `packages/core/core-assets/presets/nextjs/skills/nextjs-app-router.md:1-55` |
| nextjs-data-fetching | 4/4/4/3/2 | 88.8 | Fortaleza: fetch/cache/revalidate. Probar invalidación según versión efectiva de Next; no asumir defaults invariables. | `packages/core/core-assets/presets/nextjs/skills/nextjs-data-fetching.md:1-66` |
| expo-runtime | 3/4/3/3/2 | 77.5 | Fortaleza: CNG/EAS y restricciones runtime. Validar build nativo; que funcione en dev no prueba disponibilidad de módulo nativo. | `packages/core/core-assets/presets/react-native-expo/skills/expo-runtime.md:1-60` |
| rn-performance | 3/4/3/3/2 | 77.5 | Fortaleza: listas y trabajo de UI. Añadir perfil reproducible de scroll/render; no optimizar sólo por estilo de código. | `packages/core/core-assets/presets/react-native-expo/skills/rn-performance.md:1-51` |
| mantine-ui-patterns | 3/4/3/3/2 | 77.5 | Fortaleza: componentes y theming consistentes. Probar foco, teclado y responsive del componente generado. | `packages/core/core-assets/presets/vite-react-ts-mantine/skills/mantine-ui-patterns.md:1-78` |
| new-feature | 4/3/3/3/2 | 76.3 | Fortaleza: secuencia de capas del frontend. Evitar duplicar decisiones de solution-design y verificar tests de interacción, no sólo archivos creados. | `packages/core/core-assets/presets/vite-react-ts-mantine/skills/new-feature.md:1-46` |

### Locales declarados

| Skill | C/W/Q/E/V | Total | Fortaleza / mejora verificable | Evidencia |
|---|---:|---:|---|---|
| author-agent | 3/2/3/3/2 | 65.0 | Fortaleza: convención de fichas Navori. Corregir discovery local Codex (F03); validar tools/obligaciones del nuevo rol. | `.claude/skills/author-agent/SKILL.md:1-53` |
| playwright-cli | 3/2/3/3/2 | 65.0 | Fortaleza: navegación visual bajo demanda. Corregir F03 y separar referencia de comandos de workflow breve para no cargar 420 líneas cada vez. | `.claude/skills/playwright-cli/SKILL.md:1-420` |
| rebase-rerender | 4/2/4/3/3 | 80.0 | Fortaleza: regenerar managed tras resolver conflictos. Corregir F03 y probar conflicto real sin sobrescribir user-section. | `.claude/skills/rebase-rerender/SKILL.md:1-65` |
| worktree-hygiene | 4/2/4/3/3 | 80.0 | Fortaleza: evitar pérdida y bases stale. Corregir F03; probar dirty/unpushed/otra sesión activa antes de retirar o cambiar worktree. | `.claude/skills/worktree-hygiene/SKILL.md:1-82` |

## 6. Extensiones de plugins

Estas piezas se inyectan en agentes o skills; **no son ocho skills autónomas adicionales que siempre se carguen juntas**. Su efecto depende del plugin, destinatario y host.

| Fragmento | C/W/Q/E/V | Total | Rol y mejora | Evidencia |
|---|---:|---:|---|---|
| acli/acli-comment-channel | 3/4/3/3/2 | 77.5 | Fortaleza: canal definido para comentarios Jira. Verificar disponibilidad de acli y confirmación del borrador; no publicar por asumir aprobación. | `packages/plugins/acli/skills/acli-comment-channel.md:1-16` |
| codegraph/codegraph-access-v2 | 3/4/3/3/2 | 77.5 | Fortaleza: delega selección al routing y permite fallback. Probar índice ausente/stale sin reindexar ni interpretar indisponibilidad como cero matches. | `packages/plugins/codegraph/skills/codegraph-access-v2.md:1-11` |
| engram/engram-orchestrator | 3/4/4/3/3 | 87.5 | Fortaleza: memoria y ceremonias en dueño de sesión. Validar startup/resume y precedencia del lean close con las instrucciones del plugin externo. | `packages/plugins/engram/skills/engram-orchestrator.md:1-18` |
| engram/engram-subagent-readonly | 3/4/3/3/2 | 77.5 | Fortaleza: memoria sólo lectura para roles limitados. Testear que ningún bloque complementario les exija save sin capability. | `packages/plugins/engram/skills/engram-subagent-readonly.md:1-30` |
| engram/engram-subagent | 3/4/3/3/2 | 77.5 | Fortaleza: conserva hechos durables, no resumen duplicado. Validar binding de sesión y fallback CLI sin atribuir el registro a otra sesión. | `packages/plugins/engram/skills/engram-subagent.md:1-32` |
| gh/gh-comment-channel | 3/4/3/3/2 | 77.5 | Fortaleza: canal de comentarios PR explícito. Validar borrador confirmado y relación con follow-up-prs sin publicar dos veces. | `packages/plugins/gh/skills/gh-comment-channel.md:1-15` |
| jscpd/jscpd-review | 3/4/4/3/3 | 87.5 | Fortaleza: comando y scope canónicos, no copia de flags. Distinguir 0 archivos escaneados de cero clones detectados; mantener revisión semántica. | `packages/plugins/jscpd/skills/jscpd-review.md:1-25` |
| semgrep/semgrep-review | 3/4/4/3/3 | 87.5 | Fortaleza: scanner complementa invariantes. Reportar scanner ausente/0 archivos sin llamarlo auditoría verde; no sustituir autorización por scanner. | `packages/plugins/semgrep/skills/semgrep-review.md:1-24` |

## 7. Sinergia y cableado

### 7.1 Calificación de las tres relaciones

| Relación | C | W | Q | E | V | Total |
|---|---:|---:|---:|---:|---:|---:|
| Agente–agente | 3 | 3 | 3 | 2 | 3 | 71.3 |
| Agente–skill/mecanismo | 3 | 3 | 3 | 2 | 3 | 71.3 |
| Skill–skill | 3 | 3 | 3 | 3 | 3 | 75.0 |

La nota sistémica es menor que la individual porque una buena ficha no garantiza que llegue al consumidor correcto, con las capacidades necesarias y sin repetir trabajo. Las tablas siguientes enumeran las cadenas operativas identificadas; no son una prueba dinámica exhaustiva de todos los pares posibles de skills.

Referencias abreviadas **sólo en estas tres matrices**: `agents/`, `skills/`, `managed/`, `hooks/` y `subagent-stop-handoff.sh` parten de `packages/core/core-assets/` (el último dentro de `hooks/`); `lib/`, `plan/`, `roster.ts`, `codex/` y `build-config-toml.ts` corresponden respectivamente a `packages/cli/src/lib/`, `packages/cli/src/lib/plan/`, `packages/cli/src/engines/shared/roster.ts`, `packages/cli/src/engines/codex/` y `packages/cli/src/engines/codex/build-config-toml.ts`. Los nombres desnudos `implementer.md`, `reviewer.md`, `publisher.md`, `orquestacion.md` se refieren a sus assets de agente/managed.

### Matriz A — agente ↔ agente (aristas obligatorias)

| Arista | Nominal verificable | Fallo / control | Dictamen |
|---|---|---|---|
| Orchestrator → implementer → reviewer | Ruta obligatoria y serial: `managed/orquestacion.md:11-24`; implementer deja `impl_*`: `agents/implementer.md:101-136`; reviewer corre full gate: `agents/reviewer.md:47-82` | Hook Claude inspecciona handoff, pero es advisory y no señala archivo ausente: `hooks/subagent-stop-handoff.sh:30-58` | Correcto; cobertura parcial (F04) |
| Implementer → scribe → reviewer | Toggle, JSON y `markdownRequests`: `agents/implementer.md:13-15,142-181`; cadena: `agents/orchestrator.md:38-39` | JSON/MD validado por hook solamente al retorno Claude: `subagent-stop-handoff.sh:169-232` | Correcto en Claude; advisory fuera (F04) |
| Orchestrator → auditor/scout/architect → implementer | Señales y secuencia: `managed/orquestacion.md:32-53`; architect no descompone: `agents/architect.md:39` | Dos rechazos escalan: `lib/plan/gate.ts:115-137` en Claude | Especialización legítima |
| Orchestrator → N scouts/N implementers | Fan-out sólo independencia: `managed/orquestacion.md:45-48,55-57`; write scope: `agents/orchestrator.md:54-56` | Handoff concurrente puede dar alerta falsa, declarada advisory: `subagent-stop-handoff.sh:54-58` | Riesgo residual explícito |
| Reviewer → publisher | Receipt sólo tras APPROVED: `agents/reviewer.md:91-99`; publisher exige review/receipt: `agents/publisher.md:91-150` | Drift exige re-sign: `agents/reviewer.md:101-110` | Correcto |
| Reviewer → closeout | Closeout permite citar Pass-2 de este ciclo si bytes no cambiaron: `managed/cierre-sesion.md:3-6` | Choca con “this turn” universal de verify-before-done (F02) | Contradicción de frescura |

### Matriz B — agente ↔ skill/hook

| Owner → mecanismo | Contrato/cableado | Estado |
|---|---|---|
| Orchestrator → resolve-ticket/solution-design/plan-simple/plan-advanced/spec-bootstrap | Catálogo workflow: `roster.ts:81-94`; gate valida encargo implementer: `plan/gate.ts:205-226` | Correcto; limitación host declarada, no defecto nuevo |
| Implementer → locate-code/debug-failure/verify-before-done | Invocación explícita: `implementer.md:36-43,85-96` | Correcto |
| Reviewer → review-diff/verify-before-done/security extensiones | Passes y gate: `reviewer.md:47-82`; inyección skill→skill Codex: `codex/index.ts:167-205` | Correcto donde plugin habilitado |
| Auditor/scout/architect → reportes | Handoffs requeridos por orquestación: `managed/orquestacion.md:32-53` | Roles escriben artefactos; privilegio amplio es limitación F08, no vulnerabilidad probada |
| Scribe → JSON producer/Markdown | Forma del contrato: `implementer.md:142-161` | Enforcement sólo Claude (F04) |
| Publisher → receipt/follow-up | Preflight está anclado en review+receipt: `publisher.md:91-150` | Handoff ausente no hard-block (F04) |

### Matriz C — skill ↔ skill

| Composición | Nominal/fallo | Dictamen |
|---|---|---|
| resolve-ticket → auditor/scout → plan | Tabla por señales: `orquestacion.md:30-51`; escalación tras dos rechazos: `plan/gate.ts:115-137` | Correcta, no loop automático |
| solution-design → auditor challenge → plan-advanced | Separación proposer/challenger: `orquestacion.md:53` | Correcta; no owners duplicados |
| plan classify → plan check → implementer | Primera línea + artefacto: `plan/gate.ts:62-68,205-226` | Hard enforcement Claude; degradación conocida en otros hosts |
| locate-code → CodeGraph/tgrep | Plugin se anexa a agentes Codex: `codex/index.ts:448-457`; roster único reduce drift: `roster.ts:8-15` | Correcta con fallback documentado |
| debug-failure → verify-before-done | Diagnóstico antes de retry/evidencia: `implementer.md:43,85-96` | Correcta; segunda falla fuerza reevaluar hipótesis |
| security-invariants → semgrep; review-diff → jscpd | Inyección hacia skills soportada: `codex/index.ts:167-205` | Especialización legítima; opcional por plugin |
| scoped-gate → verify-before-done | No es sustituto de gate: `implementer.md:65` | Correcta |
| dominio → closeout/Engram | Promoción de hechos durables: `managed/cierre-sesion.md:5-6` | Depende de cumplimiento, no hook |

### 7.2 Solapamiento útil frente a duplicación dañina

| Par/grupo | Dictamen | Razón |
|---|---|---|
| Auditor / reviewer | Complementarios | Auditor diagnostica un área o falsifica diseño; reviewer evalúa un diff concreto y su evidencia. Se duplican sólo si se manda el mismo encargo a ambos sin pregunta distinta. |
| Architect / orchestrator | Complementarios | Architect propone alternativas; el principal decide después del challenge y descompone. Mantener esa separación. |
| Scout / proveedor estructural | Scout debe tener umbral | Un lookup que el principal resuelve con una llamada no justifica otro arranque. Un mapa independiente o evidencia voluminosa sí puede justificarlo. |
| `solution-design` / `plan-advanced` / `spec-bootstrap` | Capas válidas, posible ceremonia acumulada | Decidir qué construir, planear ejecución y trazar requisitos son funciones distintas. No volver a decidir en cada documento una decisión ya aceptada. |
| `secure-by-design` / `security-invariants` / semgrep | Complementarios | Diseño de amenazas, reglas del dominio y análisis estático detectan clases distintas; el scanner no sustituye autorización/IDOR. |
| `review-diff` / `verify-before-done` / `scoped-gate` | Complementarios con contradicción puntual | Checklist, evidencia y manejo de deuda no son lo mismo. El contrato de frescura/atribución necesita corrección (F01/F02). |
| Redux / Zustand / TanStack Query | Coexistencia no equivale a defecto | Estado global, local y remoto pueden tener dueños distintos. Es un riesgo de selección sin criterio del proyecto, no razón para desinstalar automáticamente. |
| Express `new-resource` / Next `new-resource` | No colisión activa demostrada | Pertenecen a presets diferentes. Namespacing merece una prueba si se mezclan catálogos, no una migración urgente sin caso real. |

### 7.3 Qué hace cumplir cada host

| Control | Claude | Codex | AGENTS.md/Cursor/Copilot | DeepSeek |
|---|---|---|---|---|
| Agentes/skills propios | Fichas y skills nativas | TOML + `.agents/skills` | Guía según adaptador | Depende del host utilizado |
| Plan antes del dispatch | Hook `PreToolUse(Agent)` | `reviewer-only`, declarado por doctor | Sin hook equivalente | No probado en esta auditoría |
| Ownership Markdown | Hook condicionado por `scribeOwnsMarkdown` | Contrato en prosa | Contrato en prosa | No probado |
| Forma del handoff | Hook advisory, no garantía de existencia | Contrato del consumidor | Contrato del consumidor | No probado |
| “No editar source” de roles analíticos | Instrucciones + permisos/tools; no aislamiento universal demostrado | Instrucciones y sandbox compartido | Depende del host | Depende del host |

**Dato importante:** `packages/cli/src/lib/plan/gate-support.ts:1-32` ya reconoce la degradación de planificación; `packages/cli/src/commands/doctor.ts:218-220,822-824` la comunica. No se propone implementar de nuevo ese aviso. Las diferencias restantes deben nombrarse con la misma honestidad.

DeepSeek no tiene adaptador nativo en el registro inspeccionado (`packages/cli/src/engines/shared/engine-capabilities.ts:97-143`). Eso **no** prueba incompatibilidad: puede funcionar como backend de un host compatible. Tampoco la compatibilidad de su API prueba que los hooks, permisos o selección de modelos de Navori funcionen sin cambios. La documentación oficial distingue API compatible e integraciones de agentes; no se hizo una ejecución real de ese camino. [DeepSeek: primera llamada e integraciones](https://api-docs.deepseek.com/).

## 8. Hallazgos consolidados y mejoras específicas

### F01 — ALTO · verificado · Contradicción interna al atribuir fallos del gate

**Evidencia:** `packages/core/core-assets/skills/verify-before-done.md:28` afirma que una falla fuera de `git diff --name-only` es anterior al cambio; `:37-40` exige baseline comparable y dice que fuera del diff el origen no está determinado.

**Por qué importa:** una modificación puede romper un consumidor no editado; la ubicación de un test no prueba causalidad. Incluso “archivo dentro del diff → introducido” es sólo triage, no demostración de antigüedad. El mismo agente puede justificar conclusiones opuestas según qué párrafo aplique.

**Mejora mínima:** unificar toda la skill en tres estados: introducido demostrado, preexistente demostrado y origen no determinado. Usar diff para orientar investigación, no como prueba causal. **Aceptación:** fixtures con regresión en consumidor no editado, fallo preexistente en archivo editado y ausencia de baseline; ninguno puede etiquetarse por ubicación solamente. Confianza alta.

### F02 — MEDIO · verificado · Frescura por turno contradice reutilización por identidad del diff

**Evidencia:** `verify-before-done.md:17,27,51,57` exige ejecución en este turno e incluye publisher; `packages/core/core-assets/managed/cierre-sesion.md:5` permite citar Pass-2 del mismo ciclo si no hubo cambios.

**Impacto:** reruns innecesarios o incumplimiento aparente de una de las reglas. No es la separación legítima entre fast gate del implementer y full gate del reviewer.

**Mejora mínima:** definir qué evidencia se conserva válida por identidad de bytes/commit, comando, entorno e inputs relevantes; una dependencia/configuración modificada también puede invalidarla. En ese caso el publisher verifica el receipt vigente, no ejecuta otra vez el gate. **Aceptación:** misma evidencia sin cambios se acepta; cambio de código, inputs o entorno relevante exige nueva ejecución. Confianza alta.

### F03 — MEDIO · verificado · Cuatro skills locales no tienen descubrimiento nativo en Codex

**Evidencia:** `project.localSkills` declara `author-agent`, `playwright-cli`, `rebase-rerender`, `worktree-hygiene`; existen en `.claude/skills/`, pero no sus cuatro directorios en `.agents/skills/`. El índice local se resuelve desde `.claude/skills` en `packages/cli/src/engines/shared/skills-index.ts`.

**Impacto acotado:** no se afirma que Codex sea incapaz de abrirlas manualmente: puede leer una ruta explícita. Lo perdido es equivalencia de descubrimiento nativo y, con ella, la probabilidad de activar reglas específicas del repo.

**Mejora:** fuente única de locales y publicación adapter-aware, o un puntero explícito válido que no aparente instalación nativa. No mantener dos copias manuales. **Aceptación:** los cuatro slugs aparecen y se pueden cargar desde ambos hosts; ausencia real se diagnostica sin inventar contenido. Confianza alta sobre el inventario, media sobre el impacto conductual.

### F04 — MEDIO · riesgo · Ownership Markdown y handoffs dependen más de prosa fuera de Claude

**Evidencia:** `packages/cli/src/engines/claude/build-settings.ts:173-203` registra `implementer-no-markdown`; `packages/cli/src/engines/codex/build-config-toml.ts:35-89` no registra su equivalente. `packages/core/core-assets/hooks/subagent-stop-handoff.sh:30-58` es advisory y no denuncia toda ausencia de artefacto.

**Impacto:** un consumidor puede recibir Markdown escrito por el dueño incorrecto o avanzar sin la evidencia esperada. No se reprodujo un incidente y la revisión posterior contiene parte del riesgo.

**Mejora:** describir advisory/enforced por control, no por host completo; validar existencia, feature, productor y destino en el punto de consumo. **Aceptación:** falta de `impl_<feature>` o feature incorrecto detiene la cadena antes del siguiente trabajo; un reporte paralelo de otra feature no satisface el contrato. Evitar volver hard-blocking un hook de matching heurístico sin resolver sus falsos positivos. Confianza alta sobre wiring, media sobre incidencia.

### F05 — MEDIO · riesgo · Scribe tiene scope escrito, pero preflight de identidad insuficientemente explícito

**Evidencia:** `packages/core/core-assets/agents/scribe.md:31-38` valida parseo/feature y exige tocar sólo los paths pedidos en el worktree/branch del productor; no especifica una comprobación ejecutable de esa identidad antes de editar/committear.

**Impacto:** un handoff desactualizado o mal dirigido podría contaminar otro trabajo. No es “scribe sin límites”: sí hay límites en prosa y reviewer/receipt posteriores.

**Mejora:** comprobar checkout, rama, feature y allowlist de paths al consumir el JSON; no permitir traversal ni rutas fuera del scope aprobado. **Aceptación:** casos negativos de rama/worktree/feature/path y evidencia incompleta fallan antes de escribir. No autorizar un refactor de schemas sólo porque parezca elegante. Confianza media.

### F06 — BAJO · verificado · Architect asume `origin/main`

**Evidencia:** `packages/core/core-assets/agents/architect.md:24` exige contrastar “already exists” contra `origin/main` sin parametrizar base o declarar fallback.

**Impacto:** portabilidad a repos sin origin o con otra base; no afecta necesariamente a este checkout que sí utiliza main.

**Mejora:** base declarada del proyecto y preflight de disponibilidad/frescura; si falta, marcar la afirmación no verificada en vez de inventar evidencia. **Aceptación:** fixtures sin remoto y con base distinta no producen una verificación falsa. Confianza alta.

### F07 — MEDIO · brecha de evidencia · La economía de la cadena obligatoria no está validada causalmente

**Evidencia:** `packages/core/core-assets/managed/orquestacion.md:11-24,50-51` exige implementer→reviewer incluso para cambios triviales. Los tests inspeccionados comprueban contratos/render; la telemetría histórica mide uso, no contrafactuales pareados.

**Impacto:** más handoffs pueden comprar calidad o sólo overhead; no se puede distinguir con el tamaño de los prompts ni con la tasa de delegación.

**Mejora:** experimento por clase de tarea, manteniendo seguridad y revisión para trabajos críticos. **Aceptación:** decisiones con éxito independiente, defectos escapados, costo total y tiempo total; no “se invocó más al reviewer” como proxy suficiente de calidad. No retirar el flujo obligatorio hasta tener esa evidencia. Confianza alta sobre la brecha de esta auditoría, no afirmación de ausencia de cualquier experimento fuera del alcance.

### F08 — BAJO · riesgo · Privilegio de escritura más amplio que la responsabilidad analítica

**Evidencia:** roster y render permiten escribir los artefactos de auditor/scout/reviewer; la restricción de no editar source queda parcialmente en instrucciones (`packages/cli/src/engines/shared/harness-assets.ts:20-32`; `packages/cli/src/engines/codex/index.ts:459-475`). Permitir Bash tampoco prueba sólo lectura en Claude.

**Mejora:** declarar la excepción y evaluar salida por canal o directorio acotado si el host lo permite. **Aceptación:** pruebas host-level registran tools/permisos efectivos y verifican que sólo se produzca el artefacto esperado. No se encontró ni explotó una vulnerabilidad; no recomendar bypass ni ampliar permisos para hacer pasar la auditoría. Confianza media.

### Oportunidades condicionadas, no bugs adicionales

- **Detección de bibliotecas en monorepos:** el registro reconoce límites de señales por paths entre raíz y workspace (`packages/cli/src/lib/assets/library-skills.ts:38-43`). Priorizar una fixture por ubicación antes de ampliar heurísticas: más detección también puede producir skills irrelevantes.
- **Seguridad contextual:** `security-invariants` cubre reglas útiles, pero la severidad debe aplicarse con amenaza concreta. Si el proyecto usa cookies de sesión, comprobar atributos y CSRF según arquitectura; no inferir vulnerabilidad por la palabra “cookie” ni seguridad por tener un scanner.
- **Discovery bajo presupuesto:** los tres contextos entregados como puntero requieren una prueba de carga efectiva, no más repetición siempre visible como primera solución.

**Resumen de severidad de hallazgos consolidados:** 0 CRÍTICOS; 1 ALTO (F01); 5 MEDIOS (F02–F05 y F07); 2 BAJOS (F06/F08). Incluye riesgos y brechas, no ocho bugs reproducidos. Eje seguridad: F05/F08 son riesgos de alcance/privilegio; no se demostró explotación. Eje rendimiento: F02 y F07 son los focos; el ahorro potencial no está cuantificado.

### Qué NO se considera hallazgo confirmado

- Falta de `orchestrator.toml` en Codex: diseño deliberado.
- `planTiers` reviewer-only fuera de Claude: limitación ya diagnosticada.
- Catálogo de bibliotecas no instalado en este proyecto: comportamiento selectivo correcto.
- Dos `new-resource` en presets distintos: riesgo futuro si se componen, no colisión activa probada.
- Cero invocaciones registradas de una skill: no prueba cero aplicación de su contenido.
- Menor prompt o modelo más barato: no demuestra menor costo por tarea resuelta.
- Un scanner que no escaneó archivos: no demuestra ausencia de vulnerabilidades.

## 9. Contraste con documentación oficial

Fuentes abiertas durante esta auditoría. Las páginas son mutables; las conclusiones describen lo consultado, no congelan el comportamiento de futuras versiones.

| Fuente | Criterio relevante | Consecuencia para Navori |
|---|---|---|
| [OpenAI: skills](https://learn.chatgpt.com/docs/build-skills) | Se publica metadata y el cuerpo se carga al seleccionar la skill; importan descripción, límites y ubicación nativa. | Medir por separado índice siempre visible y contenido bajo demanda. Verificar locales `.agents/skills`, no sólo listar slugs. |
| [OpenAI: subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Paralelizar trabajo independiente puede ahorrar tiempo; el multiagente comparable consume más tokens y los escritores paralelos agregan coordinación. | Mantener fan-out de lectura acotado; no confundir menos contexto en el principal con menos tokens totales. |
| [OpenAI: evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | Tool selection, argumentos y handoffs introducen puntos distintos de error; la complejidad multiagente debe justificarse con evals. | Probar activación, selección, transferencia y resultado; no sólo presencia de instrucciones en el render. |
| [Claude: subagents](https://code.claude.com/docs/en/sub-agents) | Tools y permisos restringen capacidades; `skills` precarga el cuerpo completo, no sólo metadata. | Un preload puede ayudar al cumplimiento a costa del arranque. Una obligación sin herramienta disponible no se arregla repitiendo el prompt. |
| [Claude: skills](https://code.claude.com/docs/en/skills) | El listado tiene presupuesto y las descripciones pueden acortarse. | Poner el disparador primero; verificar listado efectivo del host antes de atribuir mala activación a la calidad del texto. |
| [Claude: best practices](https://code.claude.com/docs/en/best-practices) | Contexto acotado y comprobaciones ejecutables sostienen autonomía; una revisión independiente puede intentar refutar el resultado. | Favorece reviewer fresco y evidencia, no necesariamente repetir el mismo gate en tres roles. |
| [Anthropic: building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Empezar simple; mayor complejidad puede intercambiar costo/latencia por mejores resultados. | La siguiente mejora no debería ser automáticamente otro agente. Primero corregir una contradicción o demostrar el cuello de botella. |
| [DeepSeek: thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) | Tool calls en modo de razonamiento tienen requisitos de continuidad del protocolo. | Portabilidad del Markdown no equivale a compatibilidad del ciclo de herramientas. Validar el host/API real, no inferirla del frontmatter. |

Las recomendaciones de experimentación de la siguiente sección son una propuesta de esta auditoría, no cifras prometidas por esos proveedores.

## 10. Mediciones históricas: útiles, pero no equivalentes a un benchmark actual

**Fuente leída:** `~/.navori/audits/navori-harness/ranges/2026-09-21--2026-09-22/report.json` y su Markdown. Generado por `navori@0.9.0`, schema 9, `2026-09-22T16:14:55.657Z`, Claude Code `2.1.267`. SHA-256 del JSON: `39f3dcc0ac22b5db9271e93142b87b1d7f1189a9808dc79f013e03f6abb09143`.

Es un archivo local del operador, no adjuntado al repo por contener material de sesiones. Aquí se conservan únicamente agregados. No se pueden reconstruir desde un clone sin ese insumo.

| Métrica | Resultado observado | Límite de interpretación |
|---|---:|---|
| Sesiones | 30; 28 selladas | Dos eran snapshots incompletos. Muestra de conveniencia, no censo. |
| Ejecuciones de subagentes | 119 | 104 de los cinco roles Navori presentes; 15 auxiliares/experimentales. No son 119 tareas independientes. |
| Input nuevo | 10,098 tokens | Campo del reporte, no toda la factura. |
| Cache creation | 10,981,242 tokens | No sumar thinking otra vez al output. |
| Output | 2,068,765 tokens | Incluye razonamiento según instrumento. |
| Suma anterior | 13,060,105 tokens | Masa de tokens no-cache-read, no costo monetario. |
| Arranque atribuido | 3,468,606 tokens; 26.56% de la suma anterior | No es un 26.56% de ahorro alcanzable. Arranque incluye más que los prompts de Navori. |
| Cache read acumulado | 321,980,322 tokens | No son tokens nuevos únicos; sí pueden ser facturables a otra tarifa. No omitirlos al calcular dinero. |
| Skills sin invocación/herencia registrada | 15 de 19 | El propio instrumento advierte que no captura toda aplicación implícita. No retirar esas 15 por este conteo. |
| `model-advisor` | 3,559 eventos, todos `skip`; 220.181 s agregados | 3,529 PreToolUse y 30 SessionStart. Candidato a optimización, no prueba de 220 s de latencia crítica recuperable. |

### Por rol, en esa muestra histórica

| Rol | n | Arranque medio | Output medio | Cache-read medio |
|---|---:|---:|---:|---:|
| auditor | 18 | 22,532 | 16,837 | 982,324 |
| implementer | 26 | 25,691 | 23,147 | 5,142,534 |
| reviewer | 32 | 24,474 | 7,317 | 793,760 |
| publisher | 17 | 21,185 | 6,077 | 516,328 |
| scout | 11 | 14,306 | 8,951 | 621,328 |

No se concluye que un implementer sea “peor” por consumir más: realiza otra tarea. Tampoco hay muestra equivalente de scribe/architect para evaluar su ROI actual. El rango observaba rendered 0.9.0 frente a CLI 0.8.7; esta auditoría lee 0.10.0. La comparación antes/después necesita segmentar esas versiones.

El instrumento marca dos reviewers temporalmente solapados; usa rama como proxy de diff. Eso no demuestra por sí solo doble gate sobre exactamente los mismos bytes. Su agregado de “gates completados” mezcla eventos correlacionados: no se transforma aquí en un conteo de ejecuciones completas del comando canónico.

## 11. Cómo demostrar si ésta es la mejor configuración

### 11.1 Primero pruebas baratas y deterministas

1. Contratos de F01/F02: una política de atribución y una de validez de evidencia.
2. Inventario por host: cada slug declarado tiene destino/puntero resoluble; cada control dice enforced/advisory/unsupported.
3. Handoffs negativos: ausente, feature incorrecta, estado no aprobado, rama/path desalineado.
4. Escenarios de routing: pregunta simple, bug localizado, refactor crítico, ticket multiarea, diseño aceptado y cambio sólo Markdown. Comprobar roles/skills esperados y prohibidos.

Esto valida maquinaria, no productividad; es condición necesaria antes de gastar en comparativas de modelos.

### 11.2 Experimento propuesto, no ejecutado

Comparar con la misma revisión base, modelo, configuración de host, herramientas disponibles, instrucciones de tarea y presupuesto de ejecución:

| Variante | Contenido | Qué aisla |
|---|---|---|
| A | Host con instrucciones mínimas del repo y mismas pruebas, sin orquestación Navori | Baseline realista; no quitar pruebas para favorecer al harness. |
| B | Navori 0.10.0 congelado | Beneficio/costo del paquete actual. |
| C | Navori con una única intervención por experimento | Atribución: corregir frescura, acortar publisher o cambiar handoff; no todo junto. |

Piloto sugerido: **12 tareas × 3 repeticiones × 3 variantes = 108 ejecuciones por host**. Dos hosts implican 216. Es presupuesto de exploración, no tamaño de muestra que garantice significancia. No se lanzó este gasto. Después del piloto, elegir tamaño según varianza y efecto mínimo útil; preregistrar hipótesis y no detener al primer resultado favorable.

Incluir bugs, cambios locales, refactors, seguridad y documentación; reservar casos fuera del corpus de desarrollo. Aleatorizar orden de variantes, separar caché fría/caliente, aislar worktrees/estado y conservar intentos fallidos. La unidad de comparación es la tarea, no cada tool call ni cada réplica como si fueran problemas independientes. Usar intervalos pareados por tarea y resultados desglosados; revisar artefactos finales a ciegas.

### 11.3 Métricas y decisión

| Objetivo | Métrica primaria propuesta | Protección contra una conclusión falsa |
|---|---|---|
| Calidad | Éxito en tests independientes + defectos escapados por severidad | “APPROVED” del mismo sistema no es ground truth. Incluir bugs sembrados y falsos positivos del reviewer. |
| Tokens/costo | Tokens totales de todos los roles, separados en input/cache-create/cache-read/output; costo por tarea aceptada | Más caché no es cero costo. Registrar tarifas/modelos del día y evitar comparar tokens de modelos como si costaran igual. |
| Tiempo | Tiempo desde pedido hasta artefacto aceptado, p50/p90, con fallos y presupuesto agotado | Separar ejecución, esperas humanas, colas, gate y rework; no sumar duraciones paralelas como wall-clock. |
| Cableado | Precisión/recall de activación por oportunidad y fallos de handoff | El denominador son oportunidades etiquetadas, no sólo invocaciones observadas. |

**Regla recomendada:** elegir una mejora de Pareto cuando exista; si se sacrifica costo/tiempo por calidad, declarar el intercambio y el umbral aceptable antes del experimento. No hay “mejor manera” universal sin ponderar tipo de trabajo y costo de un defecto escapado. La prioridad de Navori permite comprar calidad, pero no llamar ahorro a ese gasto.

### 11.4 Backlog ordenado

| Orden | Trabajo | Impacto esperado, aún no medido | Esfuerzo relativo | Evidencia para cerrarlo |
|---|---|---|---|---|
| 1 | F01/F02: unificar evidencia | Menos decisiones incorrectas y reruns ambiguos | Bajo | Contratos y casos negativos; misma política en todos los consumidores. |
| 2 | F03: locales por host | Menos guía omitida en Codex | Medio | 4/4 locales cargables en ambos hosts sin copias manuales divergentes. |
| 3 | F04/F05: consumidor de handoff e identidad | Menos cadenas rotas y scope accidental | Medio | Ausencia/feature/rama/path incorrectos se rechazan antes de escribir. |
| 4 | F06: base parametrizada | Portabilidad sin afirmaciones falsas | Bajo | Casos sin origin y base distinta. |
| 5 | Inventario de capacidades y privilegios | Menos garantías aparentes | Medio | Matriz efectiva probada, no sólo catálogo de capabilities. |
| 6 | Piloto A/B y una ablación a la vez | Decisión defendible sobre tokens/calidad/tiempo | Alto | Dataset, resultados completos e intervalos por tarea. |

No se estiman porcentajes de ahorro ni días-persona: no hubo implementación ni medición para respaldarlos.

## 12. Verificación ejecutada y restricciones

Se ejecutó el quality gate declarado, sin modificar código:

```sh
bun run format:check && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run jscpd:check && bun run semgrep:check && cd packages/cli && bun run check:size && bun run test:coverage && bun lint && bun typecheck
```

**El gate completo NO quedó verde.** Resultado de Vitest: **4,993 passed / 14 failed / 1 skipped**, 266 archivos aprobados y 3 fallidos de 269; 4 errores no manejados, duración 146.81 s. Diez fallos mostraron `listen EPERM: operation not permitted 127.0.0.1`; cuatro terminaron en timeout en pruebas que abren sockets. Las cuatro excepciones no manejadas también son `listen EPERM`. El sandbox impide esa operación; no se reintentó evadirlo ni se atribuyó a una regresión introducida por este reporte.

Archivos afectados por esa corrida:

- `packages/cli/src/lib/audit/__tests__/collect.test.ts`.
- `packages/cli/src/lib/audit/__tests__/launchd.test.ts`.
- `packages/cli/src/commands/__tests__/otel-receiver-doctor.test.ts`.

Antes de los tests pasaron formato, links, render (0 cambios pendientes), comandos de assets, presupuestos documentales, blame-ignore y tamaño de bundle (811.7 KB, techo 1200 KB). `jscpd` y `semgrep` salieron sin error pero **escanearon 0 archivos** en su diff: no cuentan como examen de seguridad o duplicación de todo el catálogo. El floor de cobertura no se alcanzó porque la suite anterior falló. Lint y typecheck se ejecutaron después por separado y pasaron.

`check:doc-budgets` advirtió que tres archivos de `.claude/context/` se entregarían como **punteros**, no inline: `20-agentes-disponibles.md`, `30-arranque-sesion.md`, `40-cierre-sesion.md`, por presupuesto acumulado de 8,000 caracteres. No equivale automáticamente a instrucciones perdidas; merece comprobar qué carga realmente el host.

La activación del log de esta sesión también falló con `EPERM` al escribir `~/.navori/audits/navori-harness/session-01a0d1e1-9db0-7d90-909b-25f7aa9d572f.log`. No se afirma que audit-mode haya quedado activo. El reporte y la inspección no dependen de ese log.

Un chequeo exploratorio del análisis de wiring utilizó `bun test` sobre cuatro archivos y obtuvo 48 pass/2 fallos de permisos de backup. **No se usa como gate canónico**: el proyecto valida mediante Vitest y la corrida anterior es la evidencia principal.

## 13. Cobertura restante y conclusión

Se inspeccionaron assets de todos los ítems tabulados, renders activos, registros, adaptadores relevantes, contratos de prueba y agregados históricos. No se ejecutaron todas las recetas de 36 bibliotecas y 26 presets en proyectos reales; las notas de ese catálogo tienen menor evidencia conductual que los contratos de core. No se hicieron deploys, cambios de permisos, llamadas pagadas a modelos ni modificaciones del harness.

No se prueba ausencia universal de contradicciones ni equivalencia de todos los hosts. Tampoco se verificó cada par matemáticamente posible entre 82 skills: se evaluaron dependencias declaradas, cadenas obligatorias y familias con señales de solapamiento. Un censo dinámico de interacción requiere los escenarios de la sección 11.

**Conclusión:** conservar las fronteras de responsabilidad que sí aportan control; corregir primero las reglas incompatibles y destinos incompletos; medir antes de añadir o retirar agentes. Hoy se puede defender la intención y buena parte de la maquinaria de calidad de Navori. Todavía no se puede defender, con esta evidencia, que minimiza tokens o tiempo total ni que cada paso adicional compra suficiente calidad.

## Key Learnings:

1. Calidad individual alta no garantiza sinergia: los contratos entre productores y consumidores son una superficie distinta.
2. Un gate verde prueba condiciones concretas; una regla escrita o una skill listada no prueba ejecución ni ROI.
3. La ventaja de Navori debe medirse por tarea aceptada y defecto evitado, incluyendo todos los roles, caché y rework.
