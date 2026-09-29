# Paridad operativa Claude / Codex CLI — Design

**Estado:** diseño de architect con síntesis del orchestrator tras una ronda de challenge.
**Veredicto del orchestrator:** CONCERNS; apto para descomponer y trabajar por lotes, no certifica
paridad runtime ni autoriza implementación en esta sesión. Véase [review.md](review.md).
**Señales:** contratos compartidos de render, hooks/permisos y migración de artefactos managed;
confiabilidad, compatibilidad y presupuesto de contexto.
**Base inspeccionada:** `ea59ee5cc9a3dd0a6890752b121feeb8a5d9cccd`; contraste con el objeto local
`131067295be01fa7b5410acea403b9702bae339c` (`origin/main`). El fetch previo falló por DNS:
actualidad remota **unverified**. Las anclas siguientes son archivo + símbolo/encabezado, no líneas.

## Approach

Extender las piezas existentes, no construir un ejecutor de agentes ni un subsistema de paridad.
El render produce assets y configuración; doctor observa sin reparar; una campaña autorizada en
Warp prueba lo que el CLI realmente ejecuta. Mantener separados esos tres niveles permite corregir
las brechas sin transformar una declaración de capacidad en una garantía de ejecución.

### Decision drivers

- `docs/DIRECTION.md` — `Principios de diseño / invariantes`: un spine compartido, configuración
  checked-in, preview, backups y respeto por contenido del usuario. Reutilizar placement/write/prune.
- `docs/DIRECTION.md` — `North Star` y `No-metas`: endurecer lo existente; navori genera, no ejecuta
  herramientas por el agente. Las campañas live no pasan a ser comportamiento automático de doctor.
- `docs/EXTENDING.md` — `Plugin — la envoltura de una herramienta externa`: Semgrep/jscpd conservan
  sus manifests y scripts; no se convierten en core ni se agregan scanners alternativos.
- `docs/EXTENDING.md` — `Las cuatro preguntas que hacen fuerte a una propuesta`: la profundidad
  vive bajo demanda; el playbook no añade otra capa always-on ni una skill con activación nueva.
- `CLAUDE.md` — `Quality gate`, y `specs/0036-engine-neutral-state/design.md` — `Decisions and contracts`:
  preservar el gate del proyecto y consumir el dueño vigente del estado, no repetir su migración.
- [Requisitos](requirements.md) — `Alcance y decisiones conservadoras`: conservar full-access,
  on-request/user, overrides, política Claude de scanners y plan-gate advisory; calidad antes que
  tokens o velocidad, sin inventar equivalencia entre modelos.

### Qué ya existe y qué falta

Las fuentes de esta tabla existen en la base inspeccionada. El diff local entre esa base y
`13106729` solo cambia la documentación de #1082, razones de plan-gate y sus pruebas, además del
historial; no integra una implementación de los demás cambios aquí propuestos.

| Dueño actual / ancla | Reutilización y brecha |
|---|---|
| `engines/shared/execute-plan.ts` — `PlacementRequest`, `collectPlan`, `commitWrites`; `engines/shared/render-managed-file.ts` — `renderManagedFile` | Ya resuelven managed, backup y escritura. No hace falta otro motor de instalación |
| `engines/claude/index.ts` — `Plugin scripts`, `pluginScriptManagedId`, `legacyPluginScriptContent` | Ya materializa scripts con procedencia y protección legacy; extraer únicamente el descriptor reusable, no copiar todo el renderer |
| `lib/config/plugins.ts` — `HookEntrySchema`, `ScriptEntrySchema`, `SkillEntrySchema`; manifests Semgrep/jscpd — `scripts`, `hooks` | Contrato de scripts/hooks presente, pero comandos concretos apuntan a Claude |
| `engines/codex/hook-registrations.ts` — `resolveCodexHooks`, `codexHookCommand`; `lib/codex/trust.ts` — `codexHookHash`, `readCodexTrustState` | Registro core y trust comparten comando; falta incorporar plugins a esa misma resolución |
| `core-assets/hooks/_partials/` — `extract_cmd`, `is_scan_trigger`, `navori_worktree`, `navori_collect_scan_files` | Extracción, selección de operación, worktree y baseline compartidos; conservarlos, no implementar un parser por engine |
| `core-assets/agents/orchestrator.md` — `Orchestrator Playbook (embodied by the main agent)` | Es la fuente completa; Codex la pierde al redirigir referencias a AGENTS sin materializar su profundidad |
| `engines/claude/agent-mcp-tools.ts` — `deriveMcpTools`; `lib/config/plugins.ts` — `SkillEntrySchema.mcpTools` | Ya existen grants explícitos por rol; Codex debe traducirlos, no deducir lecturas por nombres de herramientas |
| `commands/doctor.ts` — `buildEngineInventory`, `scanCodexHealth`, `scanTgrepFreshness`, `scanCodegraphDrift` | Diagnóstico existente a ampliar; inventario declarado no verifica assets ni runtime |
| `lib/assets/model-profile.ts` — `scanMissingModelProfile`; `engines/codex/index.ts` — `buildAgentToml` | Omisión/herencia es válida; faltan procedencia y evaluación por rol, no nuevos defaults globales |
| `lib/handoff/check.ts` — `checkHandoff`; `lib/primitives/state-root.ts` — `resolveStateRoot`, `stateArtifactPath` | Consumidor y resolución de estado ya existen; la circularidad está en la instrucción de cuándo invocarlos |

En esta tabla, rutas `engines/`, `lib/` y `commands/` son relativas a `packages/cli/src/`;
`core-assets/` es relativo a `packages/core/`.

### Opciones y trade-offs

1. **Patrón actual + documentación solamente.** Viable para declarar límites de host, modelos y
   plan-gate. No resuelve R4/R7/R11: siguen faltando scripts, profundidad y grants Codex. Se conserva
   para capacidades no demostrables, pero no como respuesta completa.
2. **Extensión acotada del spine y adaptadores — recomendada.** Agregar placements y traducciones
   faltantes; enriquecer doctor aditivamente; validar por ruta/versiones. Reutiliza owners y evita
   duplicar semántica Claude. Costo: migración de registros/trust y pruebas por engine. Reversible
   con release anterior/backups, sin tocar configuración global ni estado runtime.
3. **Nueva abstracción universal de capacidades/ejecución.** Descartada: `ENGINE_CAPABILITIES`,
   `EngineAdapter` y manifests ya cubren declaración/placement; un broker de agentes o supervisión
   de scanners no demostraría lo que el host oculta y violaría el límite de generación.

El escalón 2 no convierte cada helper en un framework: extraer funciones puras compartidas solo
cuando tengan consumidores Claude y Codex. No hay base de datos, daemon, MCP nuevo ni launcher Warp.

## Components

| Componente / ancla | Cambio propuesto | Requisitos |
|---|---|---|
| `packages/cli/src/commands/doctor.ts` — `buildEngineInventory`, `scanCodexHealth`, `scanMissingExternalTools`, `scanTgrepFreshness`, `scanCodegraphDrift` | Procedencia y etapas observadas como campos aditivos; inventario por ubicación | R1–R3, R16, R19, R21 |
| `packages/cli/src/engines/codex/index.ts` — `createCodexAdapter.extraFiles`, `orphanScans` | Scripts managed y referencia de profundidad, sin `.claude` como dependencia | R4, R7, R18, R20, R23 |
| `packages/cli/src/engines/codex/{hook-registrations,build-config-toml}.ts` — `resolveCodexHooks`, `codexHookCommand`, `buildCodexConfigToml`; `packages/cli/src/lib/codex/trust.ts` — `readCodexTrustState` | Misma lista resuelta para render, trust y diagnóstico, incluyendo plugins | R2, R4–R6, R13, R18, R20 |
| `packages/cli/src/engines/claude/index.ts` — `Plugin scripts`; `packages/cli/src/lib/render/hook-includes.ts` — `expandHookIncludes` | Compartir identidad/descripción de script y expansión; preservar migración legacy Claude | R4, R6, R20 |
| `packages/plugins/{semgrep,jscpd}/scripts/check-*.sh` — `PreToolUse EXIT CONTRACT`; `packages/core/core-assets/hooks/_partials/hook-input.sh` — `nv_tool`, `nv_subagent_type` | Conservar decisiones; corregir explicación de resultados ambiguos y normalizar solo observaciones probadas | R5, R6, R8–R10 |
| `packages/core/core-assets/agents/orchestrator.md` — playbook; `packages/core/core-assets/managed/{orquestacion,planificacion}.md` — `The mechanics`, precondiciones | Profundidad portable y handoff en el consumidor, prosa condicional por engine | R7, R13–R15, R23 |
| `packages/cli/src/engines/codex/index.ts` — `buildAgentToml`; `packages/cli/src/engines/claude/agent-mcp-tools.ts` — `deriveMcpTools`; `packages/cli/src/lib/assets/model-profile.ts` — `scanMissingModelProfile` | Grants por perfil desde fuente compartida y procedencia de modelo/effort | R8, R9, R11, R12 |
| `packages/cli/src/engines/shared/engine-capabilities.ts` — `ENGINE_CAPABILITIES`, `ControlDeclaration` | Separar declaración de validación efectiva, actualizar límites y explicación de handoff | R2, R9, R13, R14, R18, R21 |
| `README.md`, `packages/plugins/engram/skills/engram-orchestrator.md` — ejemplo de startup; documentación de compatibilidad de esta spec | Matriz versionada, límites y evidencia por escenario, sin promesa absoluta | R17–R23 |

## Decisions

### D1 — Doctor describe hechos; no ejecuta la campaña (R1–R3, R16, R19, R21)

Conservar `engineInventory` como inventario **declarado** para no romper consumidores JSON.
Agregar `provenance` y `engineEvidence` al resultado existente, sin comando/subsistema nuevo.
Cada fila se identifica por engine, ubicación del workspace, tipo/id de asset o control y contrato.
No colapsar el monorepo a una unión que esconda un script faltante en un workspace.

`provenance` registra cwd, SHA del checkout, ruta invocada/resuelta del CLI, versión declarada y
hash del entrypoint/binario legible o build id disponible, además de host/ruta/versión comprobados.
El hash del entrypoint identifica ese archivo, no certifica todo el bundle. Separar CLI en ejecución
y CLI resuelto en PATH cuando difieran. `unknown` lleva causa; no sustituir build por semver.

Para cada capacidad registrar **declarada**, **materializada**, **registrada**, **trust** y
**ejecución observada** por separado. Archivo ausente es ausencia comprobada; permiso denegado es
no verificado. Doctor lee disco, registro y trust con sus helpers actuales; por defecto ejecución
es `not-run`, no un probe automático. Un informe live emparejado aporta su propia evidencia, nunca
se convierte en éxito de doctor por tener un archivo con un nombre conocido.

### D2 — Scripts compartidos, destinos por engine (R4–R6, R18, R20)

Materializar `scriptAssets` en `.codex/scripts/<dest>` mediante `PlacementRequest` managed,
expansión de includes e interpolación existente. Claude mantiene `.claude/scripts/<dest>`.
Compartir cálculo de managed id y descriptor desde el actual `pluginScriptManagedId`; conservar
su namespace de autoría, ya que las rutas separan engines. No copiar scripts ya generados en Claude.

Extender la resolución Codex para sumar hooks del plugin después de los core. Para los dos
manifests presentes, admitir la forma exacta `bash "$CLAUDE_PROJECT_DIR/.claude/scripts/<dest>"`
cuando `<dest>` pertenece a `scriptAssets`; producir comando con raíz Git + subpath workspace +
`.codex/scripts/<dest>`, todo correctamente quoted. No reemplazar strings dentro de shell
arbitrario. Otra forma no soportada queda como omisión explicada, no hook supuestamente válido.
No se necesita cambiar el schema público del plugin para estos dos casos.

La lista resuelta lleva origen (`core` o plugin/id), evento, matcher, comando, timeout y status.
Render y trust consumen **la misma lista y el mismo constructor de comando**. Extender el tipo
resuelto actual, no mantener una segunda tabla de trust para plugins. Orden core existente intacto;
plugins ordenados determinísticamente por id y orden de manifest. Añadir/quitar plugins puede
mover índices posicionales de otros plugins: reportar trust resultante, no prometer conservarlo.

Mantener timeout 600 y matcher Bash para estos manifests; no registrar todas las herramientas
indiscriminadamente. Si un script utiliza `hook-input`, ampliar la detección de engine por ubicación
para `.codex/scripts/` además de `.codex/hooks/`; no inventar engine desde campos del payload.

### D3 — Paridad del scanner, no cambio silencioso de política (R5, R6)

El contrato actual #510 es deliberado: findings bloquean, un scanner roto distinguible se informa
pero no impide la operación. Se conserva en ambos engines; errors no pasan a ser verdes. El bloque
`PreToolUse EXIT CONTRACT` de ambos scripts es el dueño, no la prosa de doctor.

El registro terminal también forma parte del contrato: `navori_audit_on_exit` debe conservar el
exit original antes de cualquier cleanup y distinguir resultado del scanner de decisión del hook.
No registrar todo exit no cero como block: exit 1 distinguible conserva decisión no bloqueante.
El trap jscpd no puede reemplazar ese exit por el éxito de `rm`. Extender el registro de auditoría
existente sin otro almacén; V05 verifica terminal además de exit/stderr/sentinel. Esta corrección
mejora fidelidad de evidencia en ambos hosts, no cambia la política #510.

| Resultado | Decisión a conservar | Diagnóstico |
|---|---|---|
| Semgrep 0 / jscpd 0 con archivos escaneados | Permitir | Escaneo verde |
| Semgrep 1 | Exit 2, impedir operación cubierta | Findings nuevos |
| jscpd 1 | Exit 2, impedir operación cubierta | Resultado bloqueante ambiguo: clones o error interno, no clones confirmados |
| Error distinguible del scanner (>1) | Exit 1, decisión no bloqueante vigente | No validado; causa/exit, sin verde ni caché nueva |
| jscpd sin flags requeridas | Exit 2 como hoy | Capacidad incompatible, no veredicto de duplicación |
| Binario ausente / base o árbol no resolubles / cero archivos | Conservar omisión advertida | Razón específica; cero archivos no equivale a escaneo ejecutado |
| Timeout o muerte del hook por el host | Resultado observado, no garantía de deny | Incompleto/no verificado; correlación `gate-started`, terminal y efecto |

Conservar el cache Semgrep por contenido/base/script/binario/TTL y su comprobación posterior;
no añadir cache jscpd por simetría. Reutilizar `scan-scope`, `resolve-worktree`, `gate-trigger` y
`extract-cmd`; errores de listado y señales preservan sus decisiones actuales. Ni CA ni permisos
se reparan deshabilitando TLS o escalando automáticamente. La documentación oficial acepta exit 2
para bloquear `PreToolUse`; eso no demuestra que un timeout externo bloquee. [Codex hooks](https://learn.chatgpt.com/docs/hooks).

### D4 — Playbook completo como referencia, una sola fuente (R7, R18, R23)

Conservar `packages/core/core-assets/agents/orchestrator.md` como fuente, incluido su presupuesto.
Claude conserva el destino actual y su user-section. Codex genera **`.codex/orchestrator.md`**
como referencia managed fuera de `.codex/agents/`; no emitir perfil TOML, modelo raíz ni registro
de agente. Reutilizar parse/interpolate/condition/adapt, quitando frontmatter de agente del destino
Codex. Así no aparece una skill nueva ni otro trigger que todos los arranques deban pagar.

`adaptHarnessTextForCodex` redirige la antigua referencia a ese archivo, no a AGENTS. `AGENTS.md`
mantiene la obligación compacta y el enlace navegable. La referencia contiene `Startup protocol`,
`How to decompose work`, `How to launch in parallel`, `Frugal delegation`, `Continuous execution`,
`Anti-broken-telephone rule`, `Closing the cycle`, `Second opinion` y `Reclaim the worktree`.
Aplicar los mismos condicionales del harness; no eliminar un límite para caber en el cap.

Las extensiones de plugin al orchestrator ya inyectadas en AGENTS por `buildAgentsMdRequest`
conservan ese destino en este cambio; no volver a copiarlas dentro del playbook Codex. No mover
reglas manuales Claude al nuevo archivo ni leer `.claude` para producir una instalación Codex-only.
Medir bytes fuente, render y contexto compuesto; no declarar ahorro de tokens por contar caracteres.

### D5 — Rol real y evento real antes de certificar controles (R8–R10, R13, R14)

Los TOML validan configuración, no selección. L03 debe registrar ruta de despacho, perfil aplicado,
instrucción distintiva y metadata efectiva de modelo/effort para cada rol habilitado, excepto el
orchestrator principal. Autodeclaración del hijo o `task_name` no son prueba de identidad.

Si la ruta disponible crea `default`, declararla no equivalente para ese eje. El fallback explícito
es encargar a un hijo genérico la lectura del asset del rol y su scope, **solo como instrucciones**;
no hereda por ello grants/modelo/guards del perfil. Si el encargo requiere esa restricción mecánica,
no usar ese fallback para certificarlo: requiere una ruta de perfil probada o intervención del
operador. No sustituirlo silenciosamente por app-server, un segundo CLI pagado o un broker nuevo.

`hook-input.sh` sigue siendo el único adaptador compartido. Las asociaciones observadas conservan
nombre crudo, evento, versión de host y rol ausente como ausente. Un nombre desconocido permanece
literal; nunca se convierte a implementer. #1082 aporta `PreToolUse: collaborationspawn_agent`,
no evidencia de su `PostToolUse` ni de `SubagentStart`. Ampliar matchers de telemetría solamente con
el fixture observado del evento pertinente; no registrar un gate selectivo basándose en un alias.

Plan-gate permanece advisory. `13106729:docs/research/codex-plan-gate-1082.md` — `Result` y
`Decision and upgrade criteria` ya integra #1082 vía #1084. No repetir su probe ni volver a corregir
sus razones. Solo una nueva versión/ruta justificará L06 con rol/apertura legibles antes del spawn,
negativo sin hijo y positivos conforme/otro rol en trust aislado. La prosa compartida declarará el
control Claude y el procedimiento advisory Codex sin prometer un deny universal.

### D6 — Grants MCP desde su dueño, sin fingir sandbox (R11, R18, R20)

Extraer a helper compartido la derivación pura de `deriveMcpTools`; mantener en Claude la mutación
de frontmatter. Codex compone tools MCP del asset y grants de `skills[].injectInto/mcpTools`, sin
leer el árbol Claude y sin inferir efectos por prefijos como `read`/`write`.

Primero conservar la distinción de `rewriteAgentTools`: asset sin campo `tools` **hereda** y no
se transforma en denegación por falta de grants; asset con allowlist explícita recibe la derivación
de esa lista más grants de plugin. La extracción compartida debe representar también este modo,
no solo retornar las entradas de `deriveMcpTools`. Wildcard conserva su semántica explícita.

En el modo allowlist, para cada servidor de plugin administrado por navori, el perfil expresa la lista con
`mcp_servers.<id>.enabled_tools`; grant wildcard conserva servidor completo; ausencia de grant
expresa `enabled = false`, no una lista vacía de semántica ambigua. Las restricciones explícitas
más estrechas del usuario no se amplían; conflictos de configuración no parseable/edited managed
se reportan en lugar de sobreescribirse. No tocar servidores globales ajenos al inventario managed.
La combinación de grants y filtros debe verificarse en config efectiva y con stub, no por TOML solo.
Los filtros existen en la [documentación MCP](https://learn.chatgpt.com/docs/extend/mcp), y los
perfiles admiten configuración por agente según [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

**Precondición de entrega, no intersección supuesta:** V11/L03 enfrenta perfil con grant amplio a
config padre/usuario más restrictiva, `disabled_tools` y servidor deshabilitado. La lectura de config
efectiva pertenece al probe/diagnóstico autorizado, no a un merger del home dentro de render.
Esperado: ninguna herramienta previamente excluida reaparece. Hasta demostrarlo para la ruta y
versión soportadas, no activar ni anunciar como segura la nueva traducción de grants en esa ruta.
Si el host reemplaza restricciones en vez de preservarlas y no existe representación monotónica
demostrable, mantener la traducción sin habilitar para ese caso y publicar `unsupported` con causa;
no resolverlo ampliando permisos ni leyendo/escribiendo el home silenciosamente. Esto no certifica
la herencia actual como segura: deja la brecha R11 visible. Un merger global o nueva configuración
de política requeriría revisar alcance con el usuario. El lote de viabilidad precede al de emisión.

Ejemplo real: reviewer/implementer reciben lectura Engram de `mcpTools`; auditor conserva
`mem_save` autorizado por su manifest. No convertir todos los roles analíticos a read-only ni
revocar escrituras legítimas de informes. La política de filesystem/red, shell y herramientas no
MCP se mantiene; full-access/on-request/user son deliberados. Los filtros no son autorización del
servidor ni aislamiento universal: Bash, API directa, conectores ajenos y una ruta de hijo genérico
siguen fuera de esa garantía. `analytic-write-tools` no pasa a enforced global por esta traducción.

### D7 — Modelo/effort con procedencia y evaluación, no tier como calidad (R12, R22)

Conservar `buildAgentToml` y `models.codexMap`: reportar valor configurado, origen
`explicit | mapped | inherited` y efectivo observado por separado para modelo y effort. Omitir
un campo sigue siendo herencia válida. No fijar un modelo al principal usando orchestrator.

**Decisión propuesta para architect/reviewer:** mantener el baseline actual durante la campaña
(architect heredado; reviewer configurado sonnet/low en este repo) y comparar antes de modificarlo.
No introducir otro nombre de modelo ni tocar config global. L09 evalúa architect contra riesgos y
alternativas omitidos, y reviewer contra defectos sembrados/falsos positivos. Si se autoriza probar
otro effort soportado, cambiar una variable dentro del mismo host/modelo. El registro final dirá
conservar/cambiar/no concluyente y por qué; sin observabilidad/consumo autorizado, conservar y
registrar evaluación pendiente, nunca afirmar equivalencia de calidad. Overrides de usuario ganan
según el contrato efectivo del host, no por una precedencia inventada en navori.

### D8 — Planificar antes del productor; validar al consumir (R15, R18)

Corregir `orquestacion.md` — `The mechanics` y referencias dependientes: investigación, architect,
auditor y primer productor no consumen todavía `impl_<feature>.json`. No exigirlo ni fabricarlo.
Antes de despachar un consumidor de un handoff producido (orchestrator/scribe y su siguiente fase),
`checkHandoff` conserva sus validaciones y debe resultar ok. La precondición de planificación para
implementar sigue separada y obligatoria; esta corrección no es bypass del plan-gate Claude.

Reutilizar `resolveStateRoot`/`stateArtifactPath`; no nueva raíz, nuevo tipo de sesión ni opción que
salte validaciones. La excepción autorizada para redactar esta spec no modifica por sí misma la
regla vigente; solo esta futura corrección cambia la prosa distribuida.

## Contracts

### Diagnóstico aditivo

Cada etapa de `engineEvidence` contiene `status: verified | missing | unverified | not-applicable`,
una causa cuando no está verificada y referencia al hecho observado. `execution` utiliza resultados
`pass | fail | blocked | not-run | not-supported`, además de versión/ruta/escenario de la evidencia.
No sumar estos campos para producir un porcentaje de paridad. `ControlDeclaration.state` sigue
siendo declaración del producto, no estado observado de la sesión; un `enforced` declarado con rol
no probado debe aparecer como ejecución no verificada, no como éxito.

Conservar campos y exit codes previos de doctor; añadir advertencias específicas sin convertir
herencia válida o falta de live en configuración rota. Sí conservar errores actuales de TOML/trust.
Las pruebas V01–V03 fijan serialización y ausencia de promoción entre etapas.

### Operaciones cubiertas por scanners

El recurso es la operación shell interceptada, no toda publicación posible. Inventario derivado de
`check-semgrep.sh`/`check-jscpd.sh` — `TRIGGER_RE`, y `_partials/gate-trigger.sh` — `is_scan_trigger`:

| Entrada | Semgrep | jscpd | Límite |
|---|---|---|---|
| `git commit`, incluidas formas compuestas/wrappers reconocidas | Cubierta | Cubierta | Probar cada familia que reconoce el detector compartido |
| `git push` | Cubierta | Excluida deliberadamente | jscpd solo controla commit; no ampliar trigger |
| `gh pr create` | Cubierta | Excluida deliberadamente | Semgrep backstop remoto existente |
| API/MCP/app, GUI Git, alias o wrapper opaco no reconocido | No certificada | No certificada | Sin hook Bash observable o sin comando identificable |
| Tool/evento que el host no expone | No soportada/no verificada | Igual | No extrapolar desde otra ruta |

Antes de aceptar la implementación se completa V05/L05 con las familias reales del detector, no
solo tres strings felices. Un positivo `git status` no dispara scanner; un negativo por findings
no produce sentinel. Error/ausente/timeout prueban su propia decisión y diagnóstico. No modificar
el detector compartido para simular cobertura que el host no entrega.

### Evidencia y responsabilidades runtime

[Validation](validation.md) es el contrato único de registro V/L. Las campañas guardan resultados
redactados con SHA, ejecutables, ruta real, config efectiva no secreta, trust, esperado/observado y
causa. Doctor no inicia servidores ni reindexa. tgrep/CodeGraph: CLI y MCP son canales distintos;
frescura y resultado correcto son dos hechos. Skills: discovery, invocación explícita y activación
según metadatos son tres pruebas. Engram: lectura y escritura con identidad runtime son dos pruebas;
`unknown_session` no autoriza crear una identidad desde el modelo. No escribir memoria de producción
para probar paridad.

## Security boundaries and quality attributes

**Asset/actor/boundary:** repositorio/configuración del usuario y efectos de herramientas; agente
principal/hijos; frontera entre artefacto generado, host que lo aplica y servidor que autoriza.
**Amenazas:** certificar un control inactivo, ampliar grants, ejecutar contenido no revisado, perder
contenido manual o publicar evidencia sensible.

Se seleccionan de [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) **PW.1.1** para
explicitar límites/requisitos de seguridad y **PW.8.1** para pruebas de los controles seleccionados.
Aplicación local: inventario anterior, negativos de rol/scanner/trust, migración no destructiva y
redacción. No se afirma conformidad ASVS, SLSA ni certificación de supply chain por un hash local.

| Atributo | Criterio medible | Evidencia / prueba | Owner |
|---|---|---|---|
| Confiabilidad diagnóstica | Ninguna etapa inferida; toda limitación tiene causa | V01–V03, V19, V21; filas por ubicación | Implementer + reviewer |
| Compatibilidad | Fixtures Claude-only/Codex-only/dual y worktree preservan decisiones/base/includes | V04–V06, V18, V20 | Implementer + reviewer |
| Seguridad acotada | Findings cubiertos: cero efectos; MCP restringido: lectura sí/escritura no; informes sí | V05/V11, L03/L05 y trust V20 | Reviewer |
| Mantenibilidad | Una fuente por playbook, grants y scripts; segunda render sin drift | V04/V07/V20, checks render/assets | Implementer + reviewer |
| Contexto/costo | Presupuestos existentes verdes; bytes antes/después y costo no disponible distinto de cero | V23, L09 | Reviewer + operador live |
| Calidad operativa | Resultados individuales de todas las repeticiones, omisiones y fallos visibles | V08/V12/V17/V22, L03/L07/L09 | Operador live + reviewer |

**Riesgo residual:** full-access y errores de scanner no bloqueantes conservados; timeout del host,
rutas de publicación no interceptadas y conectores ajenos no quedan contenidos por estos cambios.
La verificación estática no sustituye negativos live ni autorización del servidor.

## Failure modes

- Plugin válido con comando no traducible: script puede estar presente, hook no registrado; warning
  específico. No contar el plugin como operativo ni ejecutar shell reinterpretado.
- Asset modificado/no escribible o backup fallido: conservar las protecciones del spine, registrar
  estado parcial y no aprobar trust. Siguiente render autorizado reintenta idempotentemente.
- Cambio de orden/config de hooks: recalcular trust con registro real; `Modified`/`Untrusted` no se
  convierten en Trusted por render. Scripts cambiados también requieren revisión aunque el hash de
  registro del host no cubra sus bytes; no describir ese hash como integridad de todo el script.
- Hijo default, rol/costo/effort no observables: eje no verificado; no inventar metadata ni afirmar
  que el guard de implementer fue probado. Eventos desconocidos mantienen su identidad cruda.
- CA, red, permisos sqlite/log, binario ausente, runtime sin identidad: causa operativa, no resultado
  limpio ni diagnóstico automático de bug del adaptador. Sin retry escalado ni instalación oculta.
- Proceso muere después de `gate-started`: resultado incompleto; no publicar marker verde. Un
  sentinel presente refuta bloqueo de esa llamada, aunque el log anterior diga intención de deny.
- Checkout o binario cambia durante la campaña: invalidar comparabilidad/frescura de esos resultados;
  conservarlos como evidencia histórica. No acumularlos como passes del diff nuevo.

## Migration

Iniciar implementación sobre base que incluya #1084; no presentarlo como integración pendiente de
main. Registrar SHA efectivo sin reusar el scratch #1082 como única evidencia. No repetir trabajo
terminado de Spec 0035. Confirmar los helpers aterrizados de Spec 0036 y consumirlos; esta spec no
copia/mueve/borra handoffs, caches ni stamps, ni redefine su ventana de compatibilidad.

Preview muestra scripts/perfiles/playbook nuevos, cambios de config y los hooks que requieren
revisión. `--apply` usa backup, managed markers y antirollback existentes. Scripts Codex ajenos o
editados no se adoptan por nombre. Claude conserva el oracle legacy de `legacyPluginScriptContent`;
Codex no necesita importación de scripts desde Claude. Disabled-plugin/engine pruning borra solo
artefactos de autoría demostrada y conserva user sections y hooks ajenos.

Rollback por versión previa/backup conforme al flujo existente; el antirollback sigue impidiendo
pisar assets nuevos con un CLI viejo sin el mecanismo explícito correspondiente. No aprobar trust,
rescribir el home ni borrar datos como parte del rollback automático. Segunda render sin cambios
debe ser idempotente en las tres configuraciones y workspaces.

## Testing strategy

El catálogo [validation.md](validation.md) define ubicaciones/casos y es fuente de la futura
asignación a tareas. Esta tabla asegura cobertura de diseño, no declara pruebas ejecutadas:

| Decisión/riesgo | Requisitos | Pruebas |
|---|---|---|
| D1: procedencia falsa o etapa inferida | R1, R2, R3 | V01, V02, V03, L01 |
| D2/D3: plugin solo declarado, decisiones divergentes | R4, R5, R6 | V04, V05, V06, L05 |
| D4: profundidad perdida o always-on inflado | R7, R23 | V07, V23 |
| D5: etiqueta confundida con perfil/evento | R8, R9, R10 | V08, V09, V10, L03, L04 |
| D6: lectura ensanchada o escritura legítima anulada | R11 | V11, L03 |
| D7: defaults/overrides o comparación incorrectos | R12, R22 | V12, V22, L09 |
| D5: enforcement inventado | R13, R14 | V13, V14, revisión #1082; L06 solo condicional |
| D8: preflight circular o consumidor permisivo | R15 | V15, L08 |
| Diagnóstico de búsqueda sin efecto lateral | R16 | V16, L02 |
| Skills presentes pero no operativas | R17 | V17, L07 |
| Baseline de integración perdido | R18 | V18, L01, L04, L08 |
| Memoria legible confundida con escritura autorizada | R19 | V19, L08 |
| Migración/descripción de capacidad engañosas | R20, R21 | V20, V21, L01 |

Tests unit/integration sin modelos primero; live solo con autorización, homes/repos aislados y
versiones fijadas. El gate completo del proyecto sigue siendo obligatorio conforme a su contrato;
no reemplazarlo por una suma histórica de tests. Un bloqueo de infraestructura no es pass ni prueba
de regresión sin base comparable. No hace falta `evals.md` de nueva capa always-on: no se agrega una;
L09 es comparación operacional explícita y preserva resultados invertidos.

## NOT in scope

- Enforcement selectivo de plan-gate con la ruta #1082; reinterpretar `task_name` como perfil.
- Cambiar a fail-closed los errores de scanner o imponer un watchdog que altere política Claude;
  requiere decisión separada, no se cuela como portabilidad.
- Aislamiento universal de herramientas, filesystem/red, autorización MCP del servidor o protección
  de toda vía de publicación; cambiar full-access/on-request/user o trust global.
- Nuevos modelos/defaults globales, instalaciones, actualizaciones, reindexados o campañas live
  pagadas por el solo hecho de terminar esta spec.
- Reescribir arquitectura de estado de Spec 0036; fabricar handoffs o sesiones Engram.
- Nuevo orchestrator spawnable, broker, MCP, daemon, framework de doctor o skill always-on.
- Certificar Codex App/IDE/cloud por haber probado CLI en Warp; respuestas idénticas o mejora
  estadística a partir de tres repeticiones.

## Open questions and durable knowledge

No se necesita elegir un nuevo modelo ni política scanner para terminar el diseño. La campaña
futura requiere autorización explícita de consumo/trust aislado. Si un campo de perfil o una ruta
no pueden observarse, el resultado permitido es no verificado, no una selección inventada.

Destino durable propuesto: esta spec posee decisiones y límites; la matriz publicada enlaza los
registros versionados; manifests/shared helpers conservan grants y semántica de ejecución; el
playbook fuente conserva doctrina. No promover resultados circunstanciales a reglas globales ni
copiar el diseño íntegro a AGENTS/CLAUDE.
