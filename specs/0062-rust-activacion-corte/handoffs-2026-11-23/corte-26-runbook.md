# Runbook del corte del jueves 26 nov 2026 (S3)

> Preparado por S3 el 23 nov (11:15-13:30 CST). Los datos son de la punta `origin/migration/rust` = `c8865656` y de la vigilancia de las 11:01. Antes de usarlo, mira la sección 0: lo que cambió desde entonces.
> Fuentes: `decisiones-ulises/2026-11-20-todo-en-013` (plan), #1527 issuecomment-7023004855 (instalación), issuecomment-7023973506 (cierre) e issuecomment-7066266095 (lista del grupo).
> Cada afirmación lleva **[V]** si está verificada (con el comando o `archivo:línea`) o **[S]** si es un supuesto.

## 0. Decisiones del día (actualizado el 23 nov, ~16:30, con lo que decidió Ulises)

1. **Hora de la instalación: la decides el jueves.** Recomendación de S3: **opción B**, primero la tabla de la 1.ª ventana completa (después de las 17:16) y luego la instalación. Motivo: así la 1.ª ventana cierra con 7 días completos y su tabla de evidencia no sale con filas "cortadas". Los PRs que sí tienen hora límite (las 12:00, punto 4) se resuelven antes, por la mañana. La B solo atrasa la instalación (y el cierre de la ventana nueva, ~3 dic) unas 5 h.
2. **Decidido: C y D se instalan en sombra como todos.** El 26 no se activa nada (sección 4). Lote C se presenta con la nota de la prueba que contaminó la sombra (sección 3, "Lote C").
3. **Decidido: #1797 y #1798 se mergean antes de instalar.** **Hecho:** Ulises los mergeó el 23 nov (8fd601ef y 345cec21). Antes de instalar queda solo el PR del aislamiento de `pii_egress_guard.rs` (paso 2).
4. **Decidido: el arreglo de #1776 tenía hora límite, las 12:00. Resuelto: entró.** Ulises mergeó #1800 (`[grupo-refirmas-2] fix(guard): la regla de descartes cierra en fallo cuando git no puede inspeccionar`) el 23 nov a las 16:21 CST (f9331066). Re-firma los 12 hooks: cambia `impl` en todos y `blocks` en guard-destructive. La tabla de la sección 1 está al día. Ya no hay hora límite pendiente.
5. **Decidido (Ulises, 23 nov): la medición no cambia antes del 26.** Las 33 filas de la prueba (sección 3) se presentan con la nota y la evidencia; no se excluyen.

### Paso previo obligatorio: máquina sin carga ajena (decisión de Ulises, 23 nov)

Antes del gate de la mañana y antes de la instalación, y otra vez justo antes de cada uno:

```sh
uptime                                                     # carga media de 1 min < 4
cat /proc/pressure/memory | head -1                        # some avg10 < 20
pgrep -af 'stress-ng|vitest|jest|cargo (test|build)|bun (test|run (test|build|check))' | grep -v "$$"   # vacío
ls -la /tmp/navori-heavy.lock ~/.jey-heavy.lock 2>/dev/null; fuser /tmp/navori-heavy.lock ~/.jey-heavy.lock 2>/dev/null   # nadie los tiene
```

- **Vacío y en calma:** sigue.
- **Si algo corre** (de navori, jey u otro repo, `jey-wt-*` incluido): **no se lanza el gate ni la instalación.** Se avisa en engram a la sesión dueña y se espera a que termine. No se mata un proceso ajeno.
- **Motivo:** el ensayo del 23 nov dio 6 fallas por tiempo agotado con una carga de 75, causada por un `stress-ng --cpu 24` de `jey-wt-s1-flakyA` (sección 9). jey usa su propio candado, `~/.jey-heavy.lock`, así que `flock /tmp/navori-heavy.lock` no lo serializa. Otro `stress-ng` de 2 h (`jey-wt-s1-base`, `s1-flakyB-runs.sh`) arrancó a las 17:41 del 23 nov.
- **Gate de la mañana (decidido):** `navori gate full` sobre la punta + #1804 en `.claude/worktrees/s3-ensayo-26`, sin carga ajena. Lo corre S3; resultado en la sección 9.

### Lista de comprobación de la mañana del 26 (10 minutos)

Todo es de solo lectura. Si un resultado no coincide, para y mira la sección indicada.

| # | Qué mirar | Comando | Resultado esperado |
|---|---|---|---|
| 1 | Checkout y binario sin cambios desde el 19 nov | `cd ~/Documentos/dev/personal/navori-rust && git rev-parse --short HEAD && stat -c '%y' ~/.cargo/bin/navori-rust && sha256sum ~/.cargo/bin/navori-rust \| cut -c1-16` | `9afccdef`, `2026-11-19 16:14:07…`, `a510785e989d9662` |
| 2 | Nadie compiló en el checkout de la sombra | `cat ~/.cache/navori-rust/s3/r81/target-watch.log` | Solo la línea `start:`; ninguna `ALERT` |
| 3 | Vigilancia viva | `systemctl --user is-active s3-shadow-watch s3-vigila s3-target-watch` | `active` ×3 |
| 4 | Sin divergencias ni pérdidas nuevas | `tail -1 ~/.cache/navori-rust/s3/r81/vigila-loop.log \| grep -o 'div=[0-9]* nf=[0-9]* sf=[0-9]* pend=[0-9]*'` | `div=1 nf=0 sf=0 pend=5` (la divergencia es la de la prueba; los 5 pendientes tienen causa) |
| 5 | Punta de `migration/rust` igual a la del ensayo (o con cambios conocidos) | `git fetch -q origin && git log --oneline --first-parent 088ca5ba..origin/migration/rust` | Vacío, o solo PRs que ya conoces. Si entró algo que re-firma, la tabla de la sección 1 ya no vale: vuelve a mirarla |
| 6 | PR del aislamiento de `pii_egress_guard.rs` | `gh pr list --head test/pii-web-shell-aislado --state all --json number,state,mergeStateStatus` | `OPEN CLEAN` o `MERGED`; si sigue abierto, mergearlo es el paso 2 |
| 7 | Punta de `migration/rust` sin rojos | `gh run list --branch migration/rust --limit 3 --json conclusion,headSha --jq '.[]\|.headSha[0:8]+" "+.conclusion'` | `success` en la última |
| 8 | Presión de la máquina | `cat /proc/pressure/memory \| head -1` | `some avg10` < 20 |
| 9 | Ramas de lotes en el remoto | `git ls-remote --heads origin 'wip/rust-activar-*'` | 4 ramas (se rehacen antes del ~3 dic, no el 26) |
| 10 | Respaldo del binario listo para la reversa | `ls -la ~/respaldos/` | `wip-activacion-2026-11-23.bundle` (y, tras el paso 0 de la sección 2, `navori-rust-9afccdef`) |

## 1. Grupo de re-firmas 2: estado

**[V]** `git show 9afccdef:crates/ported.json` contra `origin/migration/rust`: **los 12 hooks cambian de `impl`**. Siguen todos en `mode: shadow`, así que la ventana R81 nueva arranca desde cero para los 12.

Punta: `088ca5ba` (23 nov, después de #1797, #1798, #1800 y #1802).

| hook | impl instalado (9afccdef) | impl en la punta (088ca5ba) |
|---|---|---|
| guard-destructive | 42bb61c4a51f | 005cd9f6c5be |
| subagent-no-background | c5c75f10bf0a | d9cbd7029598 |
| quality-gate-pre-commit | e4b75826274d | 53efb8ac8a16 |
| plan-gate | 819983096646 | 585f1e323a7b |
| session-start-context | 25d45f6b532c | 2568459bd61d |
| subagent-stop-handoff | 5a3323c9a2af | 87c3c17c014a |
| model-advisor | 01db0c7624a4 | 515c6b3c9a67 |
| general-purpose-confirm | 7698361c8b12 | b91450b62083 |
| implementer-no-markdown | 343a47d62614 | 5ec59a54640d |
| comment-draft-confirm | fb145071686c | 73595cfa984a |
| pr-publisher-confirm | 4e44d656fea3 | 066f40e5b58f |
| pii-egress-guard | 2f9510a8ed74 | 9c4f9c6313ea |

### PRs que cambian la firma o el camino de los hooks

Todos están **mergeados** **[V]** (`gh pr view <n> --json state,mergeCommit`):

| PR | Qué | Merge | Revisiones | Nota |
|---|---|---|---|---|
| #1772 `[grupo-refirmas-2]` | Latencia del guard. Re-firma los 12 hooks | `aefe0109` | Subagente APPROVED; S3 APPROVED con 2 MEDIO y 2 BAJO | Seguimiento en #1776 (sección 7) |
| #1773 `[grupo-refirmas-2]` | Bridge de Pi directo, con gracia para los hermanos | `3234bcf0` | Subagente APPROVED; S3 CHANGES_REQUESTED con 2 MEDIO | El MEDIO del PWD lo resolvió #1790. El otro era de proceso y quedó sin efecto con el merge |
| #1790 | PWD literal en la llamada directa | `b88e86d3` | Subagente APPROVED; S1 APPROVED con 2 BAJO | Sus BAJO: PR del comentario (abajo) y nota en la lista del grupo |
| #1775 y #1777 | `gate foreign` nativo | `0672b291`, `51d712c3` | S2 APPROVED; S3 APPROVED con 1 MEDIO | No re-firma |
| #1778 | Caché de `navori --version` por node | `af2ce8d2` | S1 y S2 APPROVED; S3 también | No re-firma |
| #1791 | `audit --arm/--disarm` nativos | `95ce2a38` | Subagente APPROVED | La segunda revisión pedida a S3 en `revisiones/1791` no está hecha; ver la sección 8 |
| #1795 | `--help` en los scripts | `c8865656` | S1 | Sin efecto en los hooks |

### #1800 no afecta la ventana R81 en curso [verificado 23 nov, 17:55 CST]

Se comprobó lo mismo que con #1772:
- **Checkout de la sombra sin cambios:** `git rev-parse --short HEAD` sigue en `9afccdef` y no hay archivos rastreados modificados.
- **Binario sin cambios:** `~/.cargo/bin/navori-rust` tiene mtime `2026-11-19 16:14:07` y sha256 `a510785e989d9662…`.
- **Firma de las filas:**
  - Hay 940 filas posteriores al merge (22:21:24Z), hasta las 23:55:20Z.
  - Todas llevan la `implementation` instalada: guard 42bb61c4a51f, quality-gate e4b75826274d, subagent-no-background c5c75f10bf0a, implementer-no-markdown 343a47d62614, comment-draft fb145071686c y pr-publisher 4e44d656fea3.
  - Ningún hook tiene más de una `implementation` en la ventana.
- **Vigilancia de las 17:02:** `div=1 nf=0 sf=0 pend=5`, sin cambios.
- **`target-watch`:** sin alertas.

**Conclusión:** la firma nueva de #1800 solo existe en la punta. Entra con la instalación del 26 y abre la ventana nueva con los 12 hooks.

### Pendiente del grupo: nada

- **#1776 (fail-closed de la regla 7 con git inutilizable): mergeado como #1800** (f9331066, 23 nov 16:21 CST). Ver la decisión 4.
- El triaje del resto de #1776 está en issuecomment-7113095516: todo está firmado y nada es solo de docs.

### PRs para antes de instalar

| PR | Qué | Estado |
|---|---|---|
| #1798 | Comentario de `bridgeNativeEnv` en `bridge-source.ts` | **Mergeado** (345cec21). El título nuevo está en la cola de S3 (02) |
| #1797 | `gen-pi-extension-asset.mjs` rechaza flags desconocidos (cierra #1789) | **Mergeado** (8fd601ef) |
| #1804, aislamiento de `pii_egress_guard.rs` (**mergeado**, f1e198df) | La prueba corre el script con `NAVORI_HOOK_IMPL=shell` y ya no escribe en el journal real (#1774). Solo `tests/`, **no re-firma** | Rama `test/pii-web-shell-aislado` @ 361d9609. `gate full` exit 0 sobre fe7996f8 y ensayo sobre 088ca5ba (sección 9). **Lo mergeas tú, antes de instalar** |

**Sin listo ni PR, y fuera de 0.13 por decisión:** routing-watch y bash-outcome-watch (`decisiones-ulises/2026-11-23-0910`) y el PR B de arranques de Node (descartado).

**Anotado para el grupo y no implementado:** el comentario de `hook_facts.rs:341-343`. **[V]** Ese archivo **no** está firmado: `implementationHash` solo recorre `crates/navori-hooks/src` (`scripts/js/rust-manifest-check.mjs:168-179`). Puede ir en cualquier PR normal cuando decidas.

### Ensayo en seco de los merges

Hecho en `.claude/worktrees/s3-ensayo-26`, rama local `s3/ensayo-26-v2`, sin push.
- **[V]** `origin/migration/rust` (95ce2a38) + la rama del comentario + #1795: merges limpios. Después Ulises mergeó #1795 (c8865656). Las dos ramas abiertas se rebasaron sobre c8865656 sin conflictos.
- El resultado de los checks está en la sección 9.

## 2. Secuencia del día

**Opción A (12:00):** la 1.ª ventana se corta unas 4-5 h antes de cumplir 7 días. Sus filas salen en ámbar "cortada por el grupo de re-firmas 2".
**Opción B (recomendada, después de las 17:16):** la 1.ª ventana cierra completa. La última primera fila es `pii-egress-guard [claude]`, 2026-11-19T23:15:14Z, que cierra el 26 a las 17:15 CST **[V]** (tabla de las 11:01). La ventana nueva cerraría ~3 dic a la misma hora de la instalación.

Todo lo de abajo lo corres tú en el checkout de la sombra; ninguna sesión instala.

**Paso 0. Antes de tocar nada (S3 lo prepara; tú solo lo confirmas)**
```sh
cd ~/Documentos/dev/personal/navori-rust
git rev-parse --short HEAD                      # debe dar 9afccdef
stat -c '%y' ~/.cargo/bin/navori-rust             # 2026-11-19 16:14:07
sha256sum ~/.cargo/bin/navori-rust | cut -c1-16   # a510785e989d9662
mkdir -p ~/respaldos && cp -p ~/.cargo/bin/navori-rust ~/respaldos/navori-rust-9afccdef   # copia para la reversa (sección 5)
```

**Paso 1. Tabla de la 1.ª ventana (antes del avance rápido)**
```sh
~/.cache/navori-rust/s3/r81/r81-cierre.sh            # opción B: después de las 17:16, con el reloj real
# opción A: el mismo comando a las 12:00 (sale ámbar en las filas abiertas), más el ensayo:
~/.cache/navori-rust/s3/r81/r81-cierre.sh 2026-11-26T17:16:00-06:00
```
S3 revisa las canceladas con `hermanos.sh` y publica la tabla en #1527 como evidencia.

**Paso 2. Merges antes de instalar (decidido).** #1797, #1798 y #1800 (#1776) ya están mergeados. #1804 (aislamiento de `pii_egress_guard.rs`) también está mergeado (f1e198df). No falta ningún merge antes de instalar.
```sh
gh pr merge <n> --merge   # uno por PR, con la CI en verde
```

**Paso 3. Instalación.** Son los pasos 1-6 de issuecomment-7023004855, resumidos:
```sh
cd ~/Documentos/dev/personal/navori-rust
git status --short && git fetch origin && git switch ulises/rust-sombra && git merge --ff-only origin/migration/rust
node scripts/js/rust-hooks-sync.mjs --check; echo "hooks-sync=$?"          # 0
bun install --frozen-lockfile && bun run build
CARGO_BUILD_JOBS=4 flock /tmp/navori-heavy.lock cargo install --path crates/navori-cli --locked --force
navori-rust --version; stat -c '%y' ~/.cargo/bin/navori-rust; sha256sum ~/.cargo/bin/navori-rust | cut -c1-16
node -e 'const fs=require("fs");const b=fs.readFileSync(process.env.HOME+"/.cargo/bin/navori-rust");console.log(b.includes(fs.readFileSync("crates/ported.json"))?"manifiesto embebido: OK":"NO COINCIDE")'
printf '{"tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"%s"}' "$PWD" | LC_MESSAGES=C NAVORI_TS_CLI="$PWD/packages/cli/dist/index.js" bash .pi/navori/hooks/guard-destructive.sh; echo "exit=$?"   # 0
```
Después reinicia todas las sesiones de pi del checkout y comprueba que cada PID tenga `LC_MESSAGES` y `NAVORI_TS_CLI` (paso 5 del comentario).

**Paso 4. Ventana nueva.** Primeras filas del impl nuevo (paso 6 del comentario). S3:
- anota en `sombra-ventana` la firma, el binario y la primera fila de cada hook y engine;
- deja `batches.json` con Guard, B, D, C y subagent-stop-handoff (el lote E queda vacío: routing-watch y bash-outcome-watch salieron de 0.13);
- relanza `s3-vigila` con `known_div=0` y `known_pending=0`.

Eso no cambia cómo se mide; solo reinicia los conteos conocidos del monitor.

**Paso 5. A5 de #1790.** Corre después de unas horas de uso normal:
```sh
~/.cache/navori-rust/s3/r81/vigila.sh   # en las filas [pi] del impl nuevo: div=0 nf=0 sf=0
grep -c '"stderrDiffers":true\|"codeDiffers":true\|"stdoutDiffers":true' .navori/state/rust-shadow/*.jsonl   # solo sirve como dato si se filtra por el impl nuevo; vigila.sh ya lo hace
```
Criterio: ninguna divergencia nueva en las filas de Pi. Un PWD no canónico debería diferir a bash (exit 3) y no dejar diferencia. S3 lo reporta.

### Después de instalar: medición de la pieza 5 de 0066 (decisión de Ulises, 23 nov)

Tras el avance rápido, el checkout de la sombra trae el `publisher.md` con `plan classify <feature> --diff` (#1782).
- **Comprobación previa:** `grep -c 'classify <feature> --diff' .pi/agents/publisher.md` debe dar ≥ 1.
- **Desde la hora de instalación, en las sesiones de Pi:** contar los `gh pr create`, cuántos corrieron antes `plan classify … --diff`, y cuántos abortaron por nivel ≥ 2 o por un `critical-area:`.
- **Fuente:** `~/.pi/agent/sessions/*navori-rust*/*.jsonl`, con archivos más nuevos que la instalación.
- **Resultado:** en `decisiones-ulises/2026-11-21-evidencia-orquestador`.
- Hasta el 23 nov no se pudo medir: el checkout seguía en `9afccdef`, sin la frase.

## 3. Tabla de evidencia de R81, tal como sale hoy

**[V]** `r81-ensayo-20261123-1101.md` (vigila.sh: `--now` 26 nov 17:16, `--close-per-row`, `--sibling-cancel`, causas y lotes):

| Lote | Hooks | Veredicto | Causa del rojo y evidencia |
|---|---|---|---|
| Guard | guard-destructive | **verde** | Pi: 4164 llamadas, 2 pendientes con causa, 6 canceladas inferidas por un hermano. Claude: 117, sin tráfico desde el 20 nov |
| B | quality-gate-pre-commit, subagent-no-background, implementer-no-markdown | **verde** | quality-gate [pi]: 1 pendiente con causa y 6 canceladas |
| D | comment-draft-confirm, pr-publisher-confirm | **rojo** | pr-publisher-confirm [pi]: 2 pérdidas (2026-11-21T17:15:37.255Z y 17:16:02.687Z) **a menos de 10 min** (criterio c). Ver la nota de abajo |
| C (solo Claude) | plan-gate, general-purpose-confirm, session-start-context, model-advisor, pii-egress-guard | **rojo** | pii-egress-guard [claude]: 1 divergencia, fila `416799fc`, 2026-11-21T22:41:35.846Z. Los dos bloquean (código 2) y solo cambia el stderr (#1774) |
| subagent-stop-handoff | subagent-stop-handoff | verde | 3 llamadas de Claude |

**Causas de D** (`causes.json` **[V]**): las dos pérdidas son del pico de presión del 21 nov a las 11:15 CST, con memoria some avg60≈46.
- La de 17:15:37 fue un hermano abortado: `comment-draft-confirm` agotó su plazo de 10 s en la misma llamada.
- La de 17:16:02 agotó su propio plazo de 10 s.
- Evidencia: transcript de S1 `2026-11-21T16-52-56-712Z_01a1ff06`, con dos llamadas bash "timed out after 10000 ms".
- Son 2 de 4167 (0,05 %), así que el criterio (b) se cumple. Falla solo el (c): las dos están a menos de 10 min.

**Lote C: el rojo sale entero de una prueba, no de tráfico real** (verificado el 23 nov; detalle en engram `rust-hooks/pruebas-contaminan-sombra` y en el comentario para #1774 de la cola).
Nota para la tabla de cierre (decisión de Ulises: **la medición no cambia**, las filas no se excluyen; se presentan con esta nota):
- **Prueba:** `crates/navori-hooks/tests/pii_egress_guard.rs`. `shell()` corre `bash <repo>/.claude/hooks/pii-egress-guard.sh` con el `PATH` real (`:54-60`, `:73-84`, `:135-149` en `9afccdef`). El bloque nativo llama a `navori-rust … --shadow`, que escribe en el journal de la raíz del script (`crates/navori-cli/src/journal.rs:120-200`, `:264-269`).
- **Binario:** `~/Documentos/dev/personal/navori-rust/target/debug/deps/pii_egress_guard-4b42e1302449b5b9`, compilado dentro del checkout de la sombra (`strings`: `~/Documentos/dev/personal/navori-rust/crates/navori-hooks`).
- **Fecha:** binario del 21 nov, 16:36:31 CST. Scope `run-p174083-i134266` (`flock … cargo test -p navori-hooks`) de 16:35:51 a 16:41:52. Ráfaga de 22:41:28.681Z a 22:41:35.941Z.
- **33 = 33:** la prueba llama a `shell()` 33 veces (27 casos borde, más 2, más 4) y la ráfaga tiene 33 filas. La divergencia `416799fc` es el caso no UTF-8 de `invalid_utf8_and_nul_decide_as_the_script_does`, que es la divergencia declarada en `pii_egress.rs:353-366`.
- **Resto:** `pii-egress-guard [claude]` tiene 3 filas reales (19 nov). Sin las de la prueba, C no tiene divergencias. Guard, B, D y subagent-stop-handoff no cambian.
- **Quién lanzó la prueba:** sin confirmar (pregunta a S1 y S2 en engram, `aviso-s3-sin-builds-en-sombra`).
- **Para que no se repita en la ventana nueva:** PR de S3 (en la cola) que fuerza `NAVORI_HOOK_IMPL=shell` en `shell()`, con merge antes de instalar. Además el monitor `s3-target-watch` avisa si alguien compila en el checkout de la sombra.

## 4. Criterio para los lotes en rojo

Contexto **[V]**: el 26 no se activa nada (`todo-en-013`, punto 3). Los 12 hooks siguen en `shadow` y deciden los scripts. La tabla de la 1.ª ventana es evidencia. Lo que decide la activación es la ventana nueva (~3 dic). "Excluir del corte" un lote no es posible tal cual: la re-firma de #1772 ya cambió los 12 `impl`, y la instalación es una sola.

**Lote D (`comment-draft-confirm`, `pr-publisher-confirm`)**
- *Avanzar con el rojo documentado* (recomendado): se instala como todos, en sombra; la ventana nueva lo juzga de cero. #1773 da 2 s de gracia a los hermanos tras un bloqueo, lo que ataca la forma A de #1783. El plazo agotado bajo presión (forma B) no lo arregla.
- *Excluirlo*: habría que revertir la re-firma de esos dos hooks (`crates/navori-hooks/src`) y volver a firmar. Costo alto y sin beneficio: en sombra no deciden.
- **Decidido: avanza, en sombra.** Motivo: no hay divergencias ni fallas del nativo; las pérdidas son del entorno (presión) y del bridge (aborto), no del hook. Para el ~3 dic: si la ventana nueva repite pérdidas agrupadas bajo presión, decide si el criterio (c) cuenta las pérdidas con causa de entorno o si el lote espera a 0.13.1.

**Lote C (solo Claude)**
- *Avanzar con el rojo documentado* (recomendado): se instala en sombra. Por la regla de `todo-en-013`, punto 6, los hooks solo de Claude se activan solo si tienen tráfico de Claude en la ventana nueva. Desde el 20 nov no hay sesiones de Claude, así que **casi seguro siguen en sombra** en 0.13, con o sin la divergencia.
- *Excluirlo*: mismo costo que en D, sin ganancia.
- **Decidido: avanza, en sombra.** Su único rojo es de la prueba (sección 3). Queda para después del 26 cómo tratar las filas de pruebas y las divergencias declaradas en el código.

## 5. Plan de reversa

**La instalación falla** (por ejemplo, `hooks-sync` distinto de 0, el manifiesto no coincide, "integrity mismatch" o `cargo install` falla). No sigas:
```sh
cd ~/Documentos/dev/personal/navori-rust
cp -p ~/respaldos/navori-rust-9afccdef ~/.cargo/bin/navori-rust     # binario anterior (sha a510785e…)
git switch --detach 9afccdef && bun run build                      # CLI y harness de 9afccdef; .pi/ queda como en el commit
# para volver a la rama: git switch -C ulises/rust-sombra 9afccdef (mueve la rama: lo decides tú)
```
Después reinicia las sesiones de pi. La 1.ª ventana sigue midiendo con la firma vieja.

**Aparecen divergencias nuevas después del corte.** Los hooks están en sombra y la decisión sale del script, así que **no hace falta revertir**:
- S3 anota la divergencia con metadatos, abre un issue con un caso mínimo y avisa a S1.
- La fila sale en rojo en la ventana nueva y ese lote no se activa el ~3 dic.
- Si el arreglo re-firma, solo ese hook reinicia su ventana.

**El bridge directo de Pi falla.** Con un spawn fallido o una salida 3, 126 o 127, cae a bash (#1773; **[V]** `bridge-source.ts:28-29,235`). Si hiciera falta forzar bash en una sesión: `NAVORI_HOOK_IMPL=shell` en el entorno de pi (`bridge-source.ts:29`). Costo: con `shell`, la envoltura se salta el bloque nativo (`bridge-source.ts:64`), así que esa sesión deja de escribir filas de sombra. Úsalo solo en una sesión y anótalo.

## 6. Ramas wip de S1 (guard, B, C, D)

Respaldo **[V]**: `~/respaldos/wip-activacion-2026-11-23.bundle` (`git bundle verify`: "complete history"). Las ramas ya están en origin con el mismo SHA.

| Rama | SHA | Contenido | Base y atraso |
|---|---|---|---|
| wip/rust-activar-guard | a44edd40 | `mode` shadow→active de guard-destructive, línea de `ported-history` y cabeceras renderizadas | 31fb2828; 97 atrás |
| wip/rust-activar-lote-b | 33d0ffbd | Lo mismo para quality-gate, subagent-no-background e implementer-no-markdown | 31fb2828; 97 atrás |
| wip/rust-activar-lote-c | 7637957a | Activa los 5 de C (solo `ported.json` y `ported-history`) | f40cbe7e; 115 atrás |
| wip/rust-activar-lote-d | a7d98b7a | Lo mismo para comment-draft y pr-publisher | 31fb2828; 97 atrás |

- **No entran el 26** (`todo-en-013`, punto 3: la activación es al cerrar la ventana nueva).
- **[V]** Ensayo en `s3/ensayo-lotes-3dic` (worktree s3-ensayo-26): **las cuatro chocan** con la punta actual. Chocan en las cabeceras `impl=` de los scripts renderizados (`.claude/hooks`, `.pi/navori/hooks`) y en `crates/ported-history.jsonl`, porque llevan la firma anterior a #1772.
- **Antes del ~3 dic**, S1 las rehace sobre la punta: cambio de `mode`, `render --apply` y una línea de historial nueva.
- Orden propuesto (`decisiones-ulises/2026-11-20-1830`): Guard → B → D, uno por lote y solo los que salgan en verde. C solo con tráfico de Claude (casi seguro, no).

## 7. Otros pendientes que no bloquean el 26

- #1776: triaje en issuecomment-7113095516.
- #1783 (aborto de hermanos): diagnóstico en issuecomment-7112969548.
- #1774 (pii): diagnóstico en issuecomment-7113055618.

## 8. Segunda revisión de #1791: hecha

S3 la hizo el 23 nov, después del merge, sobre 02653c04. Resultado: APPROVED, sin CRÍTICO ni ALTO, con 2 MEDIO y 4 BAJO.
- MEDIO: `current_uid()` resuelve `id` por PATH (`audit_private.rs:282-288`).
- MEDIO: las pruebas de paridad pasan en vacío sin dist (`audit_arm.rs:27-41`).
- El detalle está en `revisiones/1791`, y el comentario en la cola de S3 (03).
- El seguimiento es de S2. **No bloquea la instalación:** ningún hallazgo cambia la firma ni el veredicto de un hook.

## 9. Checks del ensayo en seco [verificado]

**Ensayo final (23 nov, 16:29-16:53 CST).**
- Rama local `s3/ensayo-26-v4` en `.claude/worktrees/s3-ensayo-26`.
- Base: `origin/migration/rust` (`088ca5ba`, ya con #1797, #1798, #1800 y #1802) + `test/pii-web-shell-aislado` (361d9609), con merge limpio.
- Resultados:
  - `rust-manifest-check.mjs`: "hashes and unport history match".
  - `rust-hooks-sync.mjs --check`: exit 0.
  - En el gate pasaron `check:render`, `check:doc-budgets` (con el aviso conocido de `30-arranque-sesion` en este repo), `check-test-preservation` y `bundle 1612.7KB`.
  - **`navori gate full`: exit 1, con 6 fallas, todas por tiempo agotado** ("Test timed out in 60000ms" y "Hook timed out in 10000ms"). Fallaron `native-hook-failclosed`, `role-guard` (4) y `pi/runtime`. 11216 pruebas pasaron, en 1358 s contra unos 409 s de lo normal.
    - La carga media fue de 75 por un `stress-ng --cpu 24` de otra sesión (`jey-wt-s1-flakyA`).
    - Log: `.navori/state/gate/full-20261123T222907817Z.log` del worktree.
  - **Repetición de esos 3 archivos** a las 16:52, con la carga ya en 16: **82/82**.
  - **Lectura:** no hay fallas reales en el ensayo. Conviene correr el gate completo otra vez el 26 por la mañana, sin carga ajena.

**Ensayo anterior (v3, sobre `c8865656` + #1797 + #1798):** `gen-pi-extension-asset.mjs --check` al día, manifest y hooks-sync en verde, `gate full` exit 0 con 11220 pruebas.

Lotes, de cara al ~3 dic (rama `s3/ensayo-lotes-3dic`): los cuatro chocan (sección 6). #1800 volvió a cambiar los 12 `impl`, así que también chocan con la punta nueva. No se commitearon resoluciones.

Nada de esto se subió ni se mergeó.
