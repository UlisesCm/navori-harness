# Spec 0037 — Baseline T1

**Captura:** 2026-09-28 · **Estado:** baseline reproducible; T1 aprobado y completo. No es un receipt
ni certifica el gate completo, trust efectivo o paridad runtime.

## Checkout y procedencia

| Dato | Valor observado | Evidencia |
|---|---|---|
| Checkout / cwd | `/Users/ulisescm/Documents/Dev - Docs/navori-harness` | V03 |
| HEAD | `131067295be01fa7b5410acea403b9702bae339c` | V01, V03 |
| Host | Darwin 27.0.0 arm64; Node v24.20.0; Bun 1.4.2 | V03 |
| Codex CLI | `/opt/homebrew/bin/codex`, 0.158.0 | V03 |
| Claude Code CLI | `/Users/ulisescm/.local/bin/claude`, 2.1.283 | V03 |
| Navori CLI global | `/Users/ulisescm/.nvm/versions/node/v24.20.0/bin/navori`, symlink a `../lib/node_modules/navori/dist/index.js`; versión 0.10.1 | V01, V03 |
| Build local evaluado | `packages/cli/dist/index.js`; versión 0.10.1; SHA-256 `fe82a96e46120b4f5fe64b7288798954e9cdccdbf90d8a023834b0a957e19907`; 902321 bytes | V01 |
| Dist global instalado | SHA-256 `61dc37b2c8c2f1ea8d6bb5226e09f0fa2da066b8ac12b9ddbc513b805fed9e8a`; 855769 bytes | V01 |

Ambos binarios anuncian semver 0.10.1, pero su contenido difiere. `navori` global no lista el
comando top-level `codex`; el build local evaluado sí soporta `codex trust`. Esta es la fixture
T1 de misma versión declarada/contenido y superficie distinta, no prueba del comportamiento de un
host live. Para evaluar el checkout sin instalar ni sustituir el binario global, ejecutar desde la
raíz del repo `node packages/cli/dist/index.js <comando>`.

El build local puede cambiar después de una compilación o de Vitest: el pretest reconstruyó
`dist/index.js` en esta verificación. Antes de reutilizar esta captura, volver a calcular SHA y
tamaño de ambos binarios y registrar versión, HEAD y cwd; no asumir que este hash sigue siendo el
actual.

## Configuración y límites de observación

V03 confirmó que existen `navori.config.json`, `.codex/config.toml`, `~/.codex/config.toml` y
`~/.claude/settings.json`. No se inspeccionó su contenido ni se verificó trust. Tampoco se ejecutó
diagnóstico de CA/red/permisos. Ninguna de estas comprobaciones acredita ejecución de hooks,
configuración efectiva, controles confiables ni estado de runtime.

## Dependencias conciliadas

- **Spec 0035:** su tablero `specs/0035-paridad-codex/tasks.md` conserva sus tareas marcadas como
  completas. Se toma como baseline histórico de integración, no como certificación runtime para
  esta spec.
- **Spec 0036:** en `specs/0036-engine-neutral-state/tasks.md`, T1–T5 y T8 están completas; T6, T7
  y T9 siguen pendientes. La raíz de estado compartida ya tiene owner en
  `packages/cli/src/lib/primitives/state-root.ts`: `resolveStateRoot` y `stateArtifactPath`.
  Consumir estos helpers cuando aplique; no crear un almacén paralelo ni copiar la migración.
- **#1082 / #1084:** #1084 está integrado en este HEAD. El documento
  `docs/research/codex-plan-gate-1082.md` conserva la observación versionada de Codex CLI 0.158.0:
  `PreToolUse` para `collaborationspawn_agent` expuso `message` y `task_name`, sin rol tipado; el
  marcador sintético no fue legible (sin inferir cifrado); el deny general observó cero hijos, el
  allow uno y la etiqueta `implementer` produjo un hijo default. El plan-gate selectivo permanece
  advisory. Reabrir solo ante cambio relevante de host/ruta más datos pre-spawn tipados/legibles y
  controles positivos/negativos. No se repitió el probe; la evidencia histórica no es receipt.

La auditoría histórica sobre `ea59ee5cc9a3dd0a6890752b121feeb8a5d9cccd` antecede la integración
de #1084 y queda preservada en [evidence.md](evidence.md). Para esta T1, el baseline de
implementación es `131067295be01fa7b5410acea403b9702bae339c`; esta identificación local no prueba
que `origin/main` esté actualizado remotamente.

## Verificación T1 y trazabilidad

En el HEAD indicado, las suites objetivo pasaron: 7 archivos, 94 tests; `oxlint` exit 0. Comando:

```sh
cd packages/cli && bun run test -- src/engines/__tests__/engine-parity.test.ts src/engines/__tests__/codex-rules.test.ts src/lib/__tests__/codex-trust.test.ts src/lib/__tests__/codex-hook-payloads.test.ts src/lib/__tests__/lifecycle-hooks.test.ts src/lib/__tests__/session-start-hook.test.ts src/lib/__tests__/handoff-contract.test.ts && bun lint
```

Esta es una verificación baseline, no regresión final, campaña runtime ni receipt. Evidencia
aceptada para T1: V01 (procedencia/build), V03 (checkout, hosts y existencia de configuración),
V14 (#1082/#1084 y criterio advisory) y V18 (suite objetivo). Trazabilidad prevista: R1/R3/R18
mediante V01/V03/V18 y R14 mediante V14. **T1 fue aprobado y marcado completo tras revisión fresca; este
baseline sigue sin certificar gate/receipt vigente, trust efectivo ni paridad runtime.**
