# Sesión actual

**Estado:** `main` en `a277602`. **0 PRs abiertos**, **1 issue**: #661 (tool-mix), abierto a
propósito. La **spec 0020 quedó cerrada: 9 de 9 tasks**.

## Dónde quedó todo

Ver `progress/history.md`, entradas del 2026-09-10. No se repite aquí.

Resumen de una línea: **el 0.8 entregaba la escalera y la delegación seguía sin ocurrir**;
la 0020 conectó las tres palancas que el host sí evalúa, y ahora el efecto es medible.

## Lo primero al retomar

1. **Verificar main por contenido antes de confiar en cualquier PR mergeado.** Hoy el squash
   del #660 dejó fuera un commit empujado después (`4bfc4b8`, los arreglos de un review en
   frío): GitHub no procesó esos pushes —el ref remoto avanzó, el PR siguió reportando el
   head viejo y no hubo runs nuevos— y el merge tomó solo hasta donde el PR creía estar.
   Main quedó con el bug CRÍTICO que el review había encontrado, con el PR diciendo "merged"
   y "CI pass". Se recuperó con #663. **Un commit vacío no destraba a GitHub; cerrar y
   reabrir el PR sí.**

2. **#661 no se cierra activando tgrep "barato".** El issue decía 7 repos; son 24. Y los
   auditados que se pueden tocar sin commit son justo los de volumen casi nulo (5, 31 y 47
   búsquedas): activar ahí no da señal. Los dos que moverían la aguja —`alertaciudadana_app`
   y `alertaciudadana_backend`, 2,094 búsquedas y 0% wrapper— exigen PR en cada repo. La
   decisión de hoy fue **no activar nada todavía**; el alcance está documentado en el issue.

3. **Un dato de #661 que no arregla ningún plugin:** `Grep` nativo es 6 llamadas de 4,566
   (0.1%) estando en `allow` en todos los repos. Es probablemente la mitad más interesante
   de ese issue.

## Lo último de la jornada: el contrato de tgrep

Revisando un reporte del wrapper escrito por otra sesión en `moonar-medusa-monorepo` —
exacto en todo lo técnico, verificado contra el script— apareció que **repetía fielmente una
promesa que los assets de navori hacían y el script no cumple**: el contrato no es solo
`0 = match / 1 = no match`. `tgrep-search.sh` sale **2** cuando en la rama `grep -rn` no
queda patrón tras descartar flags, y eso significa *no se buscó nada*. Leerlo como "no
match" es el falso negativo silencioso que el reindex-por-búsqueda existe para prevenir.
Corregido en los dos assets y fijado con un test (#667).

De paso entró la trampa de método que faltaba: verificar QUÉ motor corrió se hace por stderr
vacío, pero aislarlo con `2>&1 1>/dev/null | head` devuelve stdout bajo MULTIOS de zsh — un
falso "corrió tgrep" del comando que debía probarlo.

**Y el dato que cierra la discusión de #661:** ese reporte, el mejor entendimiento de tgrep
que se ha producido, se escribió en moonar — donde el wrapper está instalado y funcionando.
Moonar lo usa en **33 de 362 búsquedas, 9.1%**. La sesión que entendió tgrep a fondo siguió
yéndose por shell 9 de cada 10 veces. **El cuello de botella no es documentación ni
comprensión**, así que "escribir mejor la doctrina" queda descartado con evidencia: lo que
queda es la palanca mecánica o aceptar el número.

## Instrumental que quedó listo

Tres piezas, y las tres existen porque una medición que no se puede repetir es una anécdota:

- `scripts/mine-search-routing.py` — wrapper / nativo / shell por repo, con la línea base
  (3.7% global; 7–10% donde tgrep está activo, 0% donde no está instalado) en su docstring.
- `scripts/classify-activation-arm.py` + `mine-activation.py` — el brazo antes/después de
  activación, clasificando por lo que el host **inyectó**, no por lo que el hook imprimió.
- La señal `routing-notice` del audit (0020 R5) — distingue "el aviso salió y la sesión
  delegó" de "salió y terminó sin delegar". Esa segunda línea es la medición que la spec
  existía para producir.

## Pendiente fuera de este repo

`bonum-webapp` tiene 43 archivos de `.claude/` trackeados, contra la convención de que en
los repos `/bonum` el harness no se commitea. Puede ser deliberado; conviene decidirlo a
propósito.
