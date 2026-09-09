# Sesión actual

**Estado:** `main` en `2cfcf0f`, limpio y sincronizado. **npm en 0.8.0** (publicado por
Ulises). 0 PRs propios abiertos. **2 issues abiertos**: #625 y #626, nacidos fuera de esta
sesión, los dos sobre skills.

## Jornada: el 0.8.0, el rollout completo, y la causa raíz de por qué no se delega

Empezó con `navori audit --arm` y terminó encontrando que la doctrina de orquestación
nunca llegó al agente. En medio: una spec, un release y el parque entero al día.

### Spec 0017 T7 — `alwaysLoad` (#619)

El experimento cerró con control cuantitativo: misma versión de Claude Code (2.1.236),
misma consulta `select:Grep`, **68 → 67 tools diferidas**, y codegraph expone exactamente
una. Gana la rama 2a de R13. `McpServerSchema.alwaysLoad`, emitido **solo cuando es true**,
manifest de codegraph en 0.0.2. De paso responde C4 del design: `alwaysLoad` **sí** aplica a
servers stdio aunque la doc solo lo documente para http/sse/ws.

### Release 0.8.0 y rollout 18/18

Minor y no patch por dos razones que el número tenía que comunicar: `engines.node` pasó de
`>=20` a `>=22` en los 10 paquetes publicados (rompe instalación en Node 20, que está EOL) y
`mcpServer.alwaysLoad` es campo nuevo. El repo no documenta política de versionado — de ahí
la pregunta.

Rollout verificado en los 18 repos, no asumido: `settings.json` y `.mcp.json` en 0.8.0,
`alwaysLoad: true` presente, cero bloques `jscpd-protocol`/`semgrep-protocol` sobrantes.
Los 15 de Bonum sin commit (gitignored). **bonum-webapp queda instalado y sin commitear a
pedido de Ulises** — ojo: ahí el harness SÍ se versiona y arrastra un mes de drift (HEAD en
0.5.1) sobre la rama `fix/BT-1442`.

### Spec 0018 — el harness por workspace (#620)

29 de 35 archivos por workspace son byte-idénticos a la raíz, y el 34-38% de cada PR de bump
son archivos que el motor no alcanza. Propone `monorepo.workspaceHarness: "minimal" | "full"`
con default `minimal`.

**Casi se cuela un hallazgo falso**: afirmé que 21 skills de workspace estaban anunciadas y
no cargables. La doc oficial lo desmintió —las skills anidadas cargan en diferido al tocar
un archivo del subdirectorio— y se retiró ANTES de escribir la spec. Si se cuela, la spec
habría movido skills que funcionan.

### La causa raíz (#623 → #624)

`navori audit` sobre 13 sesiones: 4 lanzamientos de subagente, `reviewer` una sola vez.
La Fase 1 (#622) midió la tasa **sobre oportunidades**: **2% (2 de 68)**, y es un techo — el
instrumento ve el 34% de las escrituras porque el resto va por Bash.

Y entonces apareció el fondo: **`additionalContext` de un hook no se entrega entero**. Pasado
un límite del host (por debajo de 10,441 bytes, medido), Claude Code entrega un **preview de
~2 KB** y persiste el resto en un archivo que el modelo nunca abre. navori emitía 20–48 KB con
el resume ANTES que la doctrina, así que `Role: orchestrator` caía en el byte 4,511–33,129 y
**no llegó a una sola sesión en 40+ medidas**. El agente no decidía no escalar: no tenía
escalera.

Control que lo prueba: un fixture recién creado, sin `progress/current.md` que empuje, deja
el bloque en el byte 1,030 y sí llega.

Arreglado en #624: doctrina primero, `add_bounded` con presupuesto de 8,000 y punteros para
lo que no cabe. **24,529 → 7,470 caracteres.**

## Lo que sigue

1. **Partir o encoger `orquestacion.md`** (12.6 KB). Hoy llega como PUNTERO, no entregada.
   Es lo único que falta para que la escalera de ruteo exista de verdad. Patrón candidato:
   el de #615 — el detalle a la skill dueña del momento. **Es spec, no parche.**
2. **Implementar la spec 0018** (6 tareas en 3 lotes). Su rollout BORRARÁ ~38 archivos en
   moonar y ~57 en navori-health.
3. **El A/B de activación**, con el banco ya commiteado en `scripts/ab-activation/`. Correrlo
   antes de (1) mediría un harness roto contra sí mismo.
4. **#625 y #626**, ambos sobre skills, ninguno de esta sesión.
5. **T10 de la spec 0017** sigue sin marcar: el release + rollout se hicieron hoy.
6. **El drift de bonum-webapp**: un mes sin commitear, ahora con el 0.8.0 encima.

## Notas de método (las dos costaron)

**Un hook no se verifica por lo que emite, sino por lo que sobrevive al corte del host.**
Declaré #623 inexistente en la Fase 1 tras grepear el archivo persistido del hook — que es
exactamente la parte que NO llega. Falso negativo con evidencia aparente, la clase peor.

**Un instrumento de medición se audita antes que sus resultados.** El minero de transcripts
dio primero 1962 oportunidades (la firma de comando era `cd "/Users/…`, idéntica en todo) y
después un 0% que era artefacto: cuando el orquestador SÍ delega, el trabajo ocurre en el
sidechain y el detector, que mira el hilo principal, queda ciego.

El guard de aislamiento de `~/.navori` sigue dando **falso positivo determinista** mientras
haya sesiones de Claude Code vivas en otros repos. Verificado: la entrada que marcó es un log
de navori-health, con 10 procesos `claude` corriendo.
