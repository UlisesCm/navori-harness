# Escritura paralela de implementer y scribe

La escritura paralela es optativa para trabajo de spec nivel 3 ya aceptado, con `harness.scribeOwnsMarkdown` activo, alcance independiente y prosa determinada antes de empezar. El flujo serial sigue siendo el predeterminado. El soporte nativo actual se limita al contrato de procedencia de Codex 0.162.1; otros hosts usan el flujo serial. La autorización local no demuestra consentimiento humano autenticado. El modo amplía agentes existentes: el beneficio de velocidad aún no está demostrado. Mide duración y tokens del lote y reevalúa su valor a los 30 días; retíralo si no aporta beneficio. No se añade automatización para esa revisión.

## Autorización y alcance

El plan de trabajo aprobado enumera rutas exactas para implementer, cada `markdownRequest` y salidas derivadas del renderer; las rutas son disjuntas y están dentro del alcance. El request previo identifica `spec`, `delivery` y `milestone`. El alcance material de spec, workplan, configuración y comandos queda ligado exactamente. Sólo el progreso/evidencia del workplan y el estado de checkbox de las tareas se excluyen de esos bindings. Las salidas derivadas permitidas siguen declaradas. Al preparar se capturan HEAD, branch, target/base, bindings, hashes derivados y bytes previos de solo lectura; esa línea base heredada debe conservarse.

Desde la raíz del checkout, crea el JSON de autorización aprobado y ejecuta:

```sh
bun packages/cli/src/index.ts handoff prepare-parallel <feature> --request <archivo.json> --target <rama-base> --json
bun packages/cli/src/index.ts handoff check <feature> --for scribe --parallel --target <rama-base> --json
```

La preparación entrega un UUID `runId` nuevo, que ambos productores usan sin modificarlo. Para iniciar una corrección o un siguiente milestone aceptado, espera hasta que ambos productores del run activo hayan terminado —con registro terminal `DONE` o `BLOCKED`— y prepara una sucesión explícita:

```sh
bun packages/cli/src/index.ts handoff prepare-parallel <feature> --request <archivo.json> --target <rama-base> --supersede <active-runId> --json
```

Cada autorización y sus registros son inmutables: la sucesora recibe UUID nuevo, referencia al run previo y archivo de sucesión archivado. Las claims nuevas quedan ligadas al run, actor nativo y contexto actual. Las claims previas no sirven para el run sucesor. Se retienen todas las rutas derivadas previas y los bytes heredados no asignados permanecen intactos. Una autoridad activa parcial, inválida o malformada detiene el flujo; no reactiva ownership serial anterior. No hay reset automático ni replay de claims.

## Producción y unión serial

Cada rol inicia antes de escribir y sella sólo sus rutas autorizadas:

```sh
bun packages/cli/src/index.ts handoff begin-parallel <feature> --run <runId> --target <rama-base> --json
bun packages/cli/src/index.ts handoff complete-parallel <feature> --run <runId> --status DONE --target <rama-base> --json
```

Si no puede completar, sella `--status BLOCKED --reason "<causa>"`. Tras `DONE`, cada productor conserva inmutables sus propios bytes. Durante la producción no hace stage, commit, checkout, render ni checks compartidos; no se promete Git concurrente. Tras ambos `DONE`, se serializan el render oficial, los checks compartidos, el handoff JSON final genuino del implementer y su handoff Markdown. El implementer nativo designado finaliza entonces:

```sh
bun packages/cli/src/index.ts handoff finalize-parallel <feature> --target <rama-base> --json
```

La revisión independiente del estado nuevo precede a commits seriales. Cada corrección se revisa por separado, aunque la ronda previa aún no tenga commit. No se confía en una afirmación de consentimiento humano como evidencia del protocolo.

## Criterio de validación viva A4

El checker del ticket sólo acepta evidencia viva obtenida de fuentes reales y operaciones literales: ambos productores nativos deben escribir cambios durante claims actuales y demostrar solapamiento observado; el render y los checks compartidos ocurren después de la unión y en serie; la revisión debe ser independiente y corresponder al estado conjunto actual. Fixtures sintéticas, resúmenes del caller, ausencia de fallas o un parser negativo no prueban A4. Hasta observar una ejecución positiva que cumpla todos los criterios y termine con código cero, A4 y el beneficio de velocidad quedan sin verificar.
