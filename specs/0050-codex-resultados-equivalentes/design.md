# Codex: resultados equivalentes y perfiles actuales — Design

## Enfoque

Extender el spine, adaptador, receipts, handoffs y primitivas de dispatch existentes. Los resultados son compartidos; los mecanismos pueden ser nativos de cada engine. Se reutiliza aceptación de specs, `executeReceipt`, handoffs de revisión y `evaluatePlanGate`; no se crea otro runner ni un servicio OAuth/API.

La resolución dinámica de familias existente es la base para seguir versiones dentro del contrato conocido del catálogo. La extensión cubre modelo y esfuerzo, principal y todos los roles habilitados, provenance y los límites de actualización en cada frontera de ejecución. El host conserva el control sobre su modelo efectivo.

## Componentes y anchors

- `ENGINE_CAPABILITIES` y `CODEX_PARITY` en `packages/cli/src/engines/shared/engine-capabilities.ts` y `packages/cli/src/engines/shared/codex-parity.ts`: capacidades acotadas por versión, superficie y evidencia — R1, R2, R17.
- `executeReceipt`, `evidenceIdentity` y `checkReceipt` en `packages/cli/src/commands/receipt.ts` y `packages/cli/src/lib/diagnose/receipt.ts`: evidencia de aceptación e invalidación — R3, R4.
- `evaluatePlanGate` y `DispatchSchema` en `packages/cli/src/lib/plan/gate.ts`: handoff, revisión actual y preparación de dispatch — R5, R8, R13.
- Guardas de publicación, reglas y flujo de aprobación de Codex: autorización ligada a acción/destino/diff y devolución desde subagente — R6, R7, R16.
- `resolveCodexModel` y `scanModelProfileProvenance` en `packages/cli/src/lib/assets/model-profile.ts`: selección por rol, herencia, overrides y provenance — R9, R11, R12, R14.
- `readCodexCatalogSlugs`, `highestOfFamily` y `resolveCodexModelValue` en `packages/cli/src/lib/codex/model-catalog.ts`: orden numérico, catálogo y candidatos degradados — R10, R15, R18.
- `buildCodexConfigToml` en `packages/cli/src/engines/codex/build-config-toml.ts` y renderer de agentes: configuración project-managed para futuros inicios — R12, R13, R16.

Estos anchors nombran el diseño actual, no afirman que la feature esté implementada.

## Contratos y decisiones

### Perfiles y precedencia

La intención durable permanece en `navori.config.json`; resolución y provenance se derivan para render, doctor y dispatch. La precedencia es por campo: override explícito de Codex por rol, mapping Codex explícito aplicable, default derivado del perfil Claude y finalmente herencia declarada. Se conserva `models.codexMap`; cualquier ampliación debe representar overrides por rol/esfuerzo sin duplicar configuración global. Un pin de modelo no reemplaza por sí mismo la regla del esfuerzo.

Defaults acordados: Opus medium → Sol medium; Sonnet medium → Luna high; Haiku → Luna conservando esfuerzo; otros esfuerzos permanecen configurados. Por ejemplo, Sonnet low continúa low y Sonnet high continúa high. Overrides explícitos de esfuerzo y pins prevalecen en su campo.

Cada registro de perfil identifica rol, ámbito (principal/subagente), fuente, familia o pin, esfuerzo de entrada y destino, catálogo y estado. Los estados `candidate`, `configured`, `observed`, `degraded`, `unknown` y `pending` son distintos. `observed` requiere dato del host ligado al inicio o dispatch correspondiente. Una entrada de catálogo no demuestra soporte de esfuerzo ni disponibilidad runtime.

### Frescura y frontera de dispatch

La lectura de catálogo ocurre al render, inicio y preparación de cada nuevo dispatch. Una fuente verificable del host/contexto debe sustentar la frescura. Los slugs por sí solos no permiten inferir un TTL o timestamp: sin evidencia, el estado es unknown/degraded y el candidato no se anuncia como latest vigente. Formatos desconocidos se omiten con diagnóstico; no se comparan lexicográficamente ni se adivinan IDs. El soporte cubre nuevas versiones numéricas dentro del formato conocido, no cambios incompatibles del protocolo.

Cada preparación tiene identidad propia, rol y acción. Solo un consumidor puede reclamar y consumir esa identidad; otra acción, rol o consumidor concurrente no puede reutilizarla. El diseño requiere probar dos consumidores sobre el mismo record, además de cruces de rol/acción. No se presupone que TTL, escritura atómica o eliminación tolerante a ausencia proporcionen exclusividad.

### Principal, aprobación y ciclo de vida

El principal es propiedad del host. Una configuración project-managed puede expresar intención para futuros inicios, pero solo evidencia runtime prueba el modelo efectivo. Si el host no aplica esa selección, el perfil queda pending y se ofrece el remedio de inicio correspondiente. No se introduce un agente orquestador sustituto ni se cambia una sesión en curso.

Un subagente devuelve una solicitud concreta. El principal puede tramitarla o acreditar una autorización humana/host previamente concedida que cubra exactamente la acción y alcance. El principal no genera consentimiento por redactar un registro. Handoff, receipt o hash vinculan contenido y estado, pero no autentican por sí mismos a quien autorizó. Una denegación no habilita retries con otra herramienta; superficies no verificadas quedan declaradas sin cobertura.

Los records antiguos pueden seguir leyéndose como historia, pero no prueban garantías nuevas cuando les faltan los vínculos requeridos. Al reanudar se recupera tarea y siguiente paso; las aprobaciones, revisiones y evidencia se revalidan contra estado actual.

## Atributos de calidad y fallos

| Atributo | Criterio futuro | Evidencia requerida |
|---|---|---|
| Confiabilidad | Ningún criterio pasa con evidencia ausente, fallida u obsoleta | Casos negativos de evidencia y receipt |
| Control humano | Ninguna acción se publica sin autorización aplicable, vinculada y de un solo uso | Principal sin fuente, replay, cambio de diff/destino |
| Cobertura de roles | Cada rol habilitado tiene modelo y esfuerzo cotejados; ninguno requerido queda unknown/pending para aceptación | Inventario explícito de main, core, extras y locales |
| Compatibilidad | Se preservan pins, contenido user-owned, configuración global y trust | Snapshots antes/después y casos offline |
| Mantenibilidad | Render, doctor y dispatch comparten la resolución y provenance | Tests de consistencia de perfil |

Fallas de receipt o revisión obsoletos dejan el criterio pendiente hasta revalidación. Catálogo viejo, inválido, ausente o sin fuente de frescura produce degraded/unknown. Rechazo de modelo/esfuerzo deja pending y requiere decisión humana. Un host que mantiene otro principal conserva estados requested/configured separados de observed. Un consumidor duplicado no obtiene permiso por haber leído primero el record.

## Compatibilidad

No se reescriben pins ni mappings `codexMap` explícitos. El cambio del default Sonnet medium a Luna high se muestra en preview y release notes, sin afirmar equivalencia de calidad ni cambiar automáticamente a Sol si Luna no cumple. Los registros previos siguen como historia, pero no se promueven a evidencia vigente. El render usa managed markers, backup y escritura atómica existentes; no edita bloques generados por shell ni cambia trust, archivos globales o políticas de permisos.

## Estrategia de pruebas

Los casos unitarios y de integración se añaden a suites existentes o a los paths futuros declarados en `tasks.md`. Cada test incorpora `// Covers: R<n>`. Las suites mockeadas y los validadores prueban contratos deterministas, no comportamiento vivo del host. Ninguna prueba lee el home real ni llama APIs externas.

La evaluación final es un protocolo vivo futuro con cuatro fixtures controlados: (1) regresión de bug pequeño, (2) feature de dos módulos seguida por review independiente, (3) reanudación después de cambio de evidencia/diff, y (4) solicitud de aprobación iniciada por subagente. Para cada engine y escenario se registran versión del host, modelo y effort efectivos o unknown, criterios, resultado y evidencia compacta; también reintentos y duración, y consumo cuando el host lo expone. Métricas de costo pueden decir “no disponible”; evidencia requerida ausente falla aceptación. Se conserva cada fallo y no se mezclan correcciones con la evidencia de una corrida. No se infiere causalidad de cambiar la familia Sonnet medium por Luna high.

## Fuentes oficiales

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): eventos y resultados de hooks; verificar de nuevo las capacidades por versión en cada entrega.
- [Modelos e inferencia de Codex](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): fuentes de catálogo disponibles; una entrada no equivale a disponibilidad runtime.

Las sondas y matrices de la Spec 0041 son antecedentes versionados, no aceptación automática de esta spec ni evidencia universal para todo host. No se ejecutaron sondas vivas para este scaffold.

## Fuera de alcance

- Igualar razonamiento, herramientas, hooks, transcripts, prompts, diffs, costo o decisiones internas entre engines.
- Crear un runner genérico, broker de modelos, capa always-on o servidor MCP.
- Descargar catálogos, añadir OAuth/API o cambiar trust, configuración global u otros engines.
- Implementar las entregas futuras como parte de este PR de scaffold.
