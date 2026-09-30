# navori master template ux

Contrato funcional de UX para herramientas de design system como Navori Heron. Cada sección lleva un marcador `<!-- ux-kind: … -->` que `navori master check` usa para validarla.

## Metadatos
<!-- ux-kind: metadata -->

Proyecto, etapa del master-plan, fecha, modo (`template`, `en-curso` o `desde-cero`), superficies incluidas, actores relevantes, archivos fuente utilizados.

## Fuentes y autoridad
<!-- ux-kind: sources -->

Documentos base: `DECISIONS.md`, `MASTER.md`, `parts.json`, `context/DIGEST.md`, `context/CODEBASE.md`, `context/md/*`. Planes auxiliares: `plan1.md`, `plan2.md`, `plan3.md`. Prioridad: decisión explícita en `DECISIONS.md` sobre inferencias UX.

## Superficies
<!-- ux-kind: surfaces -->

Enumerar todas las interfaces orientadas a personas. Para cada superficie: ID (`MOBILE`, `DASHBOARD`, etc.), nombre, actores que la utilizan, propósito, capacidades principales, restricciones del Master Plan, requisitos relacionados (`RN-*`, `RF-*`, `RNF-*`, `P<n>`).

## Actores
<!-- ux-kind: actors -->

Por cada actor: ID (`ACT-<NAME>`), nombre, objetivo principal, capacidades, restricciones, superficies que utiliza, acciones prohibidas, relaciones con otros actores.

## Journeys
<!-- ux-kind: journeys -->

Un Journey (`J<nn>`) representa un objetivo de usuario de principio a fin. Incluir: ID, nombre, actor, objetivo, trigger, estado inicial, resultado esperado, flows involucrados (`F<nn>`), requisitos relacionados, excepciones relevantes.

## Flows
<!-- ux-kind: flows -->

Un Flow (`F<nn>`) es una secuencia concreta de interacción. Incluir: ID, nombre, actor, propósito, trigger, precondiciones, pasos principales, decisiones, estados alternos, errores, resultado final, pantallas relacionadas (`SCR-*`), requisitos relacionados (`RN-*`, `RF-*`, `RNF-*`).

## Arquitectura de información
<!-- ux-kind: information-architecture -->

Organización conceptual de cada superficie. No decidir componentes visuales. Incluir secciones, subsecciones, jerarquía lógica que refleje las capacidades reales del Master Plan.

## Inventario de pantallas
<!-- ux-kind: screens -->

Cada pantalla (`SCR-<SURFACE>-<nn>`): ID, nombre, superficie, actor, propósito (una sola oración), requisitos relacionados (`RN-*`, `RF-*`, `RNF-*`, `P<n>`), journeys y flows relacionados, información necesaria, acciones (primary, secondary, destructive), estados, condiciones, navegación, permisos, eventos importantes.

## Componentes funcionales
<!-- ux-kind: components -->

Componentes conceptuales reutilizables (`C<nn>`), no de framework. Incluir: ID, nombre, responsabilidad, información requerida, acciones disponibles, estados, pantallas donde aparece, variaciones funcionales.

## Patterns funcionales
<!-- ux-kind: patterns -->

Comportamientos recurrentes (`PT<nn>`): búsqueda, filtros, paginación, listas infinitas, formularios, confirmación, autenticación, onboarding, estados vacíos, recuperación de errores, tablas, vistas de detalle, QR, etc. Por cada pattern: ID, nombre, propósito, pantallas que lo usan, estados necesarios, reglas funcionales, requisitos relacionados.

## Estados globales
<!-- ux-kind: global-states -->

Estados que Heron debe considerar: `loading`, `empty`, `error`, `offline`, `unauthorized`, `forbidden`, `success`, `disabled`, `partial data`. Añadir estados específicos del dominio (ej. `membership-expired`, `benefit-exhausted`). No todas las pantallas necesitan todos los estados.

## Requisitos UX
<!-- ux-kind: ux-requirements -->

Requisitos observables identificables (`UX-<n>`): deben derivarse de necesidades del producto, no ser puramente estéticos. Ej. "El usuario debe conocer el estado de su membresía antes de iniciar un canje", "Las restricciones relevantes deben estar disponibles antes de confirmar".

## Navegación
<!-- ux-kind: navigation -->

Modelo conceptual de navegación por superficie: pantallas raíz, pantallas secundarias, navegación entre screens, deep links relevantes, back behavior, entry points, flows que cruzan superficies. No decidir tabs, sidebar, drawer concretos salvo requisito funcional obligatorio.

## Cross-surface flows
<!-- ux-kind: cross-surface -->

Cuando un proceso implique varias aplicaciones: qué actor actúa, en qué superficie, qué información se transfiere, qué resultados pueden producirse. Ej. Cliente móvil → Partner → Backend → Cliente resultado.

## Matriz de trazabilidad
<!-- ux-kind: traceability -->

Tabla que relacione: Requirement → Journey → Flow → Screens → Patterns. Todo requisito funcional con impacto visible debería aparecer al menos una vez. Formato: tabla con columnas `Requirement`, `Journey`, `Flow`, `Screens`, `Patterns`.

## Cobertura por pantalla
<!-- ux-kind: screen-coverage -->

Para cada pantalla: ¿por qué existe? ¿qué requisito cubre? ¿qué actor la utiliza? ¿qué información necesita? ¿qué acciones permite? ¿qué estados maneja? ¿en qué flow participa? Si alguna respuesta no existe, revisar si realmente es necesaria.

## Preguntas abiertas UX
<!-- ux-kind: open-questions -->

Ninguna

## Fuera de alcance
<!-- ux-kind: out-of-scope -->

Explicitar UX que deliberadamente no pertenece a esta etapa (ej. onboarding corporativo, sistema de reviews, gestión avanzada de campañas). Esto evita que Heron diseñe funcionalidades que aún no forman parte del producto.

## Validación del UX Contract
<!-- ux-kind: checklist -->

- [ ] Todas las superficies humanas están declaradas.
- [ ] Todos los actores relevantes tienen una superficie.
- [ ] Los principales objetivos de cada actor tienen Journey.
- [ ] Cada Journey está compuesto por Flows.
- [ ] Cada Flow referencia pantallas.
- [ ] Cada pantalla tiene propósito.
- [ ] Cada pantalla tiene requisitos relacionados.
- [ ] Cada pantalla declara información, acciones y estados.
- [ ] Los errores y estados alternos críticos están contemplados.
- [ ] Los cross-surface flows están definidos.
- [ ] Los patterns recurrentes están identificados.
- [ ] No contiene decisiones visuales arbitrarias.
- [ ] No contiene dependencias de frameworks UI.
- [ ] No contradice MASTER.md ni DECISIONS.md.
- [ ] No repite preguntas ya resueltas.
- [ ] La trazabilidad Requirement → Journey → Flow → Screen existe.
- [ ] No quedan preguntas UX que bloqueen el diseño.

## Restricciones para Heron
<!-- ux-kind: heron-handoff -->

### Heron MUST preserve

Reglas de negocio, roles, permisos, requisitos, decisiones explícitas, capacidades requeridas, estados de negocio, flows obligatorios.

### Heron MAY improve

Agrupación de pantallas, arquitectura de información, navegación, reducción de pasos, reutilización de patterns, nombres UX, composición funcional — siempre que conserve los requisitos.

### Heron owns

Layout, jerarquía visual, dirección artística, paleta derivada de la marca, tipografía, spacing, grid, density, iconografía, responsive behavior, motion, component visual design, Design System, accesibilidad visual, implementación en Penpot.
