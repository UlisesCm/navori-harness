# Workplans 0065, fase 1: PR 1, 2 y 3 (solo documento; nada implementado)

Autor: S3, 23 nov 2026, ~16:35 CST. Fuentes:
- Spec mergeada `origin/dev:specs/0065-autonomia/spec.md` (#1786 + #1792).
- Diseño `.navori/state/handoffs/solution_0065-autonomia.v3.md` (C.7, F y G).

Si la v3 y la spec difieren, manda la spec.

## Corrección a la v3: ramas destino

La v3 (C.7) dice "todos contra `migration/rust`". La spec mergeada dice otra cosa (sección "Entorno y datos"):
- El TS nace en `dev`: `schema.ts`, `config.ts`, `policy-source.ts`, `extension-source.ts`, `denials.ts`, `bridge-source.ts` y sus pruebas.
- Solo los archivos que **no existen en `dev`** van directo a `migration/rust`.

Comprobado con `git cat-file -e` sobre `origin/dev` y `origin/migration/rust`:

| Archivo | En `dev` | En `migration/rust` |
|---|---|---|
| `crates/navori-core/src/config.rs` | no | sí |
| `crates/navori-core/assets/pi/extension.ts.in` | no | sí |
| `scripts/js/gen-pi-extension-asset.mjs` | no | sí |
| `scripts/js/rust-manifest-check.mjs` | no | sí |
| `.github/workflows/rust.yml` | no | sí |
| `schema.ts`, `config.ts`, `extension-source.ts`, `denials.ts`, `bridge-source.ts`, `navori.config.v1.json` | sí | sí |

**Consecuencia: cada PR se parte en dos (a: `dev`, b: `migration/rust`), con orden forzado.**
- El oráculo de `migration/rust` (`rust.yml:50`) compara el TS de esa rama con el Rust.
- Si el caso `autonomy` (b) entra antes de que el TS de (a) llegue por la sincronización, el oráculo falla.
- Lo mismo pasa con `extension.ts.in`: se regenera desde el dist del TS (`rust.yml:59`, `gen-pi-extension-asset.mjs --check`), así que necesita el TS nuevo en la misma rama.

**Pregunta para Ulises (decide él):**
- Opción A: (b) se abre después de la sincronización `dev → migration/rust` que trae (a).
- Opción B: (b) lleva también una copia del TS, al amparo de la excepción vigente (solo `bridge-source.ts`, #1784). No alcanza para PR 1 ni PR 3, que tocan `schema.ts` y `extension-source.ts`.
- **Recomiendo A:** es la más reversible y no amplía excepciones.

## Orden y dependencias

1. **PR 1 (clave):** no depende de nada. Puede empezar cuando Ulises lo autorice, después del 26 (regla: nada de 0065 antes del corte).
2. **PR 2 (`asked`):** empieza cuando el grupo de re-firmas del 26 esté mergeado (tarea 2 de la spec). Es independiente de PR 1.
3. **PR 3 (política):** necesita PR 1 y PR 2 mergeados en las dos ramas.
   - Previo de la spec: atribuir cada acción a su sesión (#1774). La pregunta 3 sigue abierta; ver también el hallazgo de las 33 filas de prueba en #1774.
4. **La enmienda del invariante 9 (#1792) ya está mergeada en `dev`.** Las excepciones de `DIRECTION.md` en `migration/rust` (#1784) también están mergeadas.

---

## PR 1: clave `autonomy`, sin comportamiento nuevo (tarea 1)

**`plan classify 0065-pr1-clave --sharedContract`: nivel 2, score 4. Señales: `non-trivial-files:3(+2)`, `root-dirs:4(+2)` y `floor:shared-contract`.** Lleva architect y desafío: el diseño ya existe en la v3; falta su versión para este PR.

**Archivos:**
- (a) `dev`:
  - `packages/cli/src/lib/config/schema.ts` (`:648` en la v3)
  - `packages/cli/src/lib/config/config.ts` (`CONFIG_KEY_RULE`, `:280`)
  - `packages/cli/src/lib/config/__tests__/autonomy-config.test.ts` (nuevo)
  - `apps/website/public/schema/navori.config.v1.json` (por `gen:schemas`)
- (b) `migration/rust`:
  - `crates/navori-core/src/config.rs` (`:506`, `:1176`, `:1190-1192`)
  - `scripts/js/rust-oracle/cases/config-autonomy.json` (nuevo)

**Forma:** `autonomy: { mode: "off"|"routine", integrationBranches?: string[] }`, estricta, `mode` obligatorio y hasta 16 ramas.

**Validación de ramas:**
- 1 a 255 caracteres de `[A-Za-z0-9._/-]`, empieza por alfanumérico.
- Sin `..`, `//` ni `@{`; no termina en `/`, `.` ni `.lock`.
- No es `main` ni `HEAD`, y sin duplicados.
- La rama por defecto se rechaza al consentir (PR 3), no aquí.

**Pruebas → guion o regla de la spec:**

| Prueba | Spec |
|---|---|
| `mode` desconocido → error que nombra `autonomy.mode` | R1; Estados/Error |
| `integrationBranches` con `main`, comodín (`*`, `?`), duplicado o 17 ramas → error que nombra la clave | R1; Estados/Error |
| Config sin `autonomy` se parsea igual que hoy (snapshot del objeto) | R2; paso 10 (la mitad de config) |
| Caso del oráculo: válido `off` y `routine`, modo desconocido, `main`, comodín y duplicado; TS = Rust | Tarea 1 ("paridad en ambas implementaciones") |
| `gen:schemas --check` sin diferencia | Tarea 1 |

**Verificación:**
- `node scripts/js/rust-manifest-check.mjs`
- `bun run oracle:rust`, solo en (b) y después de la sincronización
- `bun check`
- `cargo test -p navori-core`
- El `git diff --exit-code` de la v3 (C.7) sobre `ported.json`, `navori-hooks/src`, `core-assets/{hooks,scripts,settings}`, `hook-includes.ts` y `packages/plugins`

**Pre-chequeos:**
- Que `autonomy` no llegue por una capa de preset o workspace. La v3 (G) lo da por no verificado. Hay que leer la fusión de capas de config antes de escribir el esquema: si las capas la mezclan, la extensión del PR 3 ve otra cosa que `config.ts`.

---

## PR 2: el bridge conserva qué hook hizo cada pregunta (tarea 2)

**`plan classify 0065-pr2-asked --criticalArea`: nivel 1, score 7. Señales: `non-trivial-files:2(+2)`, `root-dirs:3(+2)` y `critical-area:declared(+3)`.** Área crítica (hooks): implementer y reviewer independiente.

**Archivos:**
- `packages/cli/src/engines/pi/bridge-source.ts`: campo aditivo `asked: { hook: string; reason: string }[]` en `BridgeResult` y una línea en `runBridge`. Hay que re-citar las líneas en la punta: la v3 cita `:35` y `:278` sobre `e7488d2b`, y #1773 y #1790 las movieron.
- `packages/cli/src/engines/pi/__tests__/hook-bridge.test.ts`
- `crates/navori-core/assets/pi/extension.ts.in` (b; generado)
- `.pi/extensions/navori.ts` y `packages/cli/src/engines/__tests__/__golden__/pi.snap` (render)

**Rama:**
- `bridge-source.ts` tiene excepción vigente en `migration/rust` (#1784), así que (b) puede llevar el TS y el asset juntos.
- (a) en `dev` lleva el mismo diff de `bridge-source.ts`. La v3 ya pedía no tocar el payload ni el `spawn`.

**Condición de la v3, que sigue en pie:** si el diff toca `bridgePayload`, el `spawn` o `bridgeVerdict`, se detiene y pasa a un grupo de re-firmas.

**Pruebas → spec:**

| Prueba | Spec |
|---|---|
| Dos hooks preguntan: `asked` tiene los dos `{hook, reason}` en orden; `asks` sigue igual | R3 ("todas sus preguntas vienen de los hooks propios"); base de los pasos 3 y 6 |
| Un hook bloquea y otro pregunta: `block` gana y `asked` no cambia el resultado | R5 y R13 |
| `extension-source.ts` sigue consumiendo `asks` sin cambios (diff vacío) | Condición de la v3 |
| `gen-pi-extension-asset.mjs --check` en verde | Tarea 2 |

**Verificación:**
- La de PR 1.
- `git diff origin/migration/rust -- packages/cli/src/engines/pi/bridge-source.ts`, limitado al tipo y a la línea de acumulación.

**Pre-chequeos:** ninguno pendiente. El costo es nulo: no hay llamadas nuevas.

---

## PR 3: política en la extensión, registro y límites (tareas 3 a 6)

**`plan classify 0065-pr3-politica --criticalArea --moneyCredentialsPii`: nivel 2, score 8. Señales: `non-trivial-files:4(+3)`, `root-dirs:6(+2)`, `critical-area:declared(+3)` y `floor:money-credentials-pii`.** El piso de credenciales viene del veto de secretos en cuerpo y título (R9).

**Archivos (a menos que se indique):**
- `packages/cli/src/engines/pi/policy-source.ts` (nuevo)
- `extension-source.ts`
- `denials.ts`
- `__tests__/policy-{parse,limits,routine,consent,bodies,log,attribution}.test.ts`
- `denials.test.ts`
- (b): `extension.ts.in` y `.pi/extensions/navori.ts`
- Docs: `docs/pi.md` (+ `.es`, `.zh-CN`), `CHANGELOG.md` y la referencia en `docs/DIRECTION.md`
- Sin verificar: `bundle-render-data.ts`

**Pruebas → guion de aceptación (manual, Linux y repo fabricado) y pruebas automáticas:**

| Paso | Automática que lo cubre antes del manual |
|---|---|
| 1. Sin consentir → aviso y diálogo | `policy-consent`: sin archivo → `off` y aviso |
| 2. Consentir por comando; RPC rechaza | `policy-consent`: `ctx.mode !== "tui"` → rechazo; frase con 6 hex |
| 3. PR a `dev`, comentario, revisión que pide cambios, issue, sin diálogo y con marca | `policy-routine`: matriz C.6 × {off, routine} × {padre, hijo}; `policy-bodies`: cuerpo solo de `.navori/state/publish/` y marca agregada |
| 4. Registro: decisión y resultado sin texto sensible | `policy-log`: dos líneas con el mismo `call`, ≤ 4 KiB, sin cuerpos ni títulos |
| 5. Merge, `--force-with-lease`, aprobar → diálogo | `policy-limits` (R6) |
| 6. `.env`, en línea, token, PR ajeno, `--base` repetido → diálogo | `policy-bodies` y `policy-parse`: flag repetido, repo ajeno (R7), secreto (R9) |
| 7. Bloqueos de R5; `git tag --list` corre | `policy-limits`: cada uno con su regla en `denials.ts` |
| 8. Subagente → rechazo y reenvío | `policy-routine`: hijo, nunca rutina (R12) |
| 9. Cambiar ramas o reinstalar el binario → re-consentir y nombrar el componente | `policy-consent`: un byte cambiado en cada componente → `off`; dos worktrees conviven |
| 10. Sin la clave → 0.12 | `policy-routine` con la clave ausente: snapshot del comportamiento actual |

**Pre-chequeos pedidos (antes de escribir la política):**

| Pre-chequeo | Estado al 23 nov | Qué falta |
|---|---|---|
| **Tokenización analizador ↔ bash** | Sin verificar. La v3 lo razona con alfabeto cerrado y re-serialización (C.3) | La prueba diferencial es la PRIMERA del PR: genera comandos sobre el alfabeto, los pasa por `bash -c 'printf "%s\0" "$@"' _ <cmd>` y compara con el analizador. Si difiere en uno, no hay rutina para esa forma |
| **Paginación de comentarios** (`gh pr view --json comments`) | **No comprobable en este repo:** el PR con más comentarios tiene 22 (#1527; `gh pr list --state all --limit 300`, ordenado). gh 2.105.0 | Probarlo en el repo fabricado del guion, con un PR de 101 comentarios, antes de fijar la regla "≥ 100 → diálogo" de la v3. Publicar en el repo fabricado es parte del entorno de la spec, no del repo real |
| **Forks** (`gh repo view --json nameWithOwner` frente a `gh pr create` en un fork) | No comprobable aquí: `UlisesCm/navori-harness`, `fork=false` (`gh repo view`) | Clonar un fork del repo fabricado y comparar `nameWithOwner`, `gh pr create --dry-run` (si existe en 2.105.0) y el `isCrossRepository` del PR resultante |
| **Costo del hash** | **Medido:** el binario `~/.cargo/bin/navori-rust` pesa 10 732 240 bytes. Su sha256 tarda unos 98 ms por cálculo en Node (5 iteraciones) y entre 0,18 y 0,32 s con `sha256sum` (3 corridas, en frío) | El hash del binario necesita caché por `(dev, ino, size, mtimeNs)`; sin caché, cada llamada candidata suma unos 100 ms. Los otros tres componentes son pequeños y no se midieron (sin verificar) |

**Verificación:**
- La de PR 1.
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- Guion manual completo sobre el paquete construido (tarea 7)

**Reversión:** revertir PR 3, luego PR 2 y luego PR 1; borrar `~/.pi/navori/autonomy/`.

## Fuera de alcance de estos workplans

- La implementación: nada se escribe antes del 26 ni sin la aprobación de Ulises.
- La fase 2 (escrituras indirectas, sesión en el journal) y la autonomía en Claude Code o Codex.
- Que este repo declare la clave: lo hace Ulises.
