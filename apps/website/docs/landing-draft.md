# Landing: borrador para continuar

## Dirección acordada

Explicar el potencial de Navori con lenguaje básico, tanto para desarrolladores como para reclutadores y personas no técnicas que quieran proponerlo a su equipo. Conservar la identidad y hacer más visible el cuadriculado.

El usuario prefiere una escena con acciones físicas a un diagrama de textos que cambian: consola a la izquierda (25% en escritorio), robot a la derecha, conversación progresiva y animación sincronizada.

## Implementado

- Hero, beneficios, adopción, compatibilidad, primeros pasos y FAQ reorganizados.
- Detalles de configuración y catálogo técnico en un desplegable; se conservan los enlaces a sus secciones.
- Escena de 21 segundos: entra el prompt, aparece el robot con popup, busca lentamente en archiveros Engram y CodeGraph, toma un chip de tgrep, lo integra en el pecho y acelera los movimientos de búsqueda.
- Pausa, repetición, barra temporal, pausa al salir de pantalla y alternativa con movimiento reducido. La conversación completa también se puede leer sin reproducir la escena.
- Inglés, español y chino simplificado; exportaciones Markdown actualizadas.
- GSAP 3.15.0 y [tres skills oficiales versionadas](../.agents/skills/README.md).

La [grabación de la escena actual](previews/robot-search.mp4) conserva la versión revisada por el usuario; todavía muestra el pendiente conceptual descrito abajo.

## Siguiente cambio solicitado: separar tgrep de CodeGraph

El usuario indicó que le gusta más el funcionamiento, pero cuestionó que tgrep estuviera dentro del cajón de CodeGraph. Son herramientas independientes: CodeGraph aporta descubrimiento estructural; tgrep busca texto.

**Todavía no se aplicó esta corrección.** El usuario pidió estacionar el avance en un PR draft antes de continuar.

1. Quitar la etiqueta `tgrep` del tercer cajón de CodeGraph.
2. Dar al chip un soporte de herramientas independiente.
3. Ajustar el recorrido del robot y del chip para que la recogida provenga de ese soporte.
4. Mantener el encaje del chip en la ranura del pecho y la diferencia visual entre búsqueda lenta y rápida.
5. Actualizar la grabación y revisar con el usuario antes de ampliar la historia a nuevas etapas.

## Archivos para retomar

- `src/components/sections/HarnessGraph.astro`: consola y dibujo de la escena.
- `src/scripts/session-animation.ts`: timeline GSAP y controles.
- `src/content/session-animation.ts`: mensajes, tiempos y textos en tres idiomas.
- `src/content/landing.ts`: textos del resto de la landing y datos anteriores de la primera iteración; revisar datos sin consumidores al pulir el borrador.

## Verificación y límites

- `bun run build` desde `apps/website`: verde; 133 rutas, validación de las 99 páginas canónicas y sus alternativas Markdown.
- `bun run check:fast`: verde.
- Pruebas focales `website-i18n.test.ts` y `landing-inventory.test.ts`: 26 aprobadas.
- Navegador: reproducción real completa, pausa, repetición, búsqueda temporal, movimiento reducido, temas claro/oscuro y anchos de 320 a 1440 px; sin errores de JavaScript ni desbordamientos detectados.
- Gate completo inicial, antes de rebasar el avance sobre `main`: 10165 aprobadas, 24 fallidas y 2 omitidas. Las 24 fallas fueron de fixtures de `role-guard` dentro del worktree bajo `/tmp`; al moverlo fuera del temporal, su suite focal pasó 56/56. **El gate completo no se repitió.** Debe ejecutarse sobre el diff final antes de marcar el PR listo.
- Revisión directa por solicitud de trabajar sin subagentes. No hay revisión independiente ni aprobación para merge o despliegue.

La aceleración es una metáfora animada, no un benchmark ni una promesa de rendimiento de tgrep. La disponibilidad de plugins y controles depende del asistente y la configuración.

## Preview local

Desde `apps/website`, ejecutar `bun run build` y después `bun run preview --host 127.0.0.1 --port 4326`. La escena está en `/es/#anatomy`.
