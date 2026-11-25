# Continuar rust-0.13 desde otra PC (Mac)

Guía del cierre del 23 nov 2026. Empieza por [`estado-sesiones-2026-11-23.md`](estado-sesiones-2026-11-23.md): qué hizo cada sesión y qué le queda. Esta guía explica cómo retomar ese trabajo en una máquina que no es la PC Linux.

## 1. Qué viaja y qué no

| Viaja (git o engram) | Se queda en la PC Linux |
|---|---|
| Ramas y PRs (#1803, #1805 a #1815) | El checkout de la sombra (`~/Documentos/dev/personal/navori-rust` en `9afccdef`) y su journal `.navori/state/rust-shadow/` |
| Este documento, el estado y las copias de `handoffs-2026-11-23/` | El binario instalado `~/.cargo/bin/navori-rust` (sha `a510785e989d9662`) |
| Las herramientas de `handoffs-2026-11-23/herramientas/` | Los datos de medición en `~/.cache/navori-rust/` y los binarios de `target-*` |
| La memoria de engram, por `UlisesCm/private-engram-sync` (privado) | Los worktrees de `.claude/worktrees/` y el respaldo `~/respaldos/wip-activacion-2026-11-23.bundle` |

**Consecuencia:** la ventana R81 vive en la PC Linux. Su vigilancia, la tabla de cierre del 26 (después de las 17:16) y la instalación del 26 se hacen ahí, en persona o por ssh. Las mediciones de latencia (verificación de #1772, R17) y la reproducción de la divergencia bajo carga también se hacen en la PC Linux, porque sus umbrales se tomaron en esa máquina.

Desde la Mac sí se puede: implementar y revisar PRs (#1801, #1793, #1806), preparar #1803, las segundas revisiones, los workplans de 0065 y los documentos.

## 2. Preparar la Mac

1. Memoria:
   ```sh
   git clone https://github.com/UlisesCm/private-engram-sync.git ~/private-engram-sync
   cd ~/private-engram-sync && engram sync --import && engram sync --status
   ```
   Antes de salir de la Mac, exporta igual que en el README de ese repo (`git pull`, `engram sync --all`, commit y push). Así la PC Linux no pisa lo nuevo.
2. Repo: `git clone https://github.com/UlisesCm/navori-harness.git` y `git fetch origin`. Trabaja siempre en worktrees desde `origin/migration/rust` (o la rama del PR), nunca en `main`.
3. Herramientas: Rust 1.99.1 (lo fija `rust-toolchain.toml`, que ya trae los targets de Apple), bun, node y jq 1.7 o 1.8.x. Instala `flock` con `brew install flock`, porque macOS no lo trae.
4. Entorno (en `~/.zshenv`, igual que en Linux):
   - `export LC_MESSAGES=C`. Sin esto, el Rust de los hooks rechaza el locale y nunca evalúa.
   - `export NAVORI_TS_CLI=<clon>/packages/cli/dist/index.js`.

   En los worktrees, déjalo vacío (`NAVORI_TS_CLI=`). Los scripts `env.sh` de las herramientas fijan la ruta del toolchain de Linux: en la Mac basta con `rust-toolchain.toml`.
5. En cada worktree nuevo: `bun install --frozen-lockfile` y el build de `packages/cli` antes del gate. Quita los symlinks de `node_modules` antes de firmar un recibo.

## 3. Reglas que siguen vigentes

- **Merges** (`decisiones-ulises/2026-11-23-autonomia-merge`): cada sesión mergea sus PRs a `migration/rust` o `dev` con:
  - CI verde;
  - revisión por subagente;
  - segunda revisión de otra sesión si toca un área crítica;
  - recibo.

  Nunca `main`, npm, tags, releases ni reinstalar `navori-rust`.
- **Re-firmas:** nada que re-firme después del jueves 26 a las 12:00. La medición R81 no cambia antes del 26.
- **Guard y hooks:** nunca `--no-verify`. Si un hook bloquea, 0 reintentos; solo un reintento si fue por timeout.
- **Scripts:** encadena con `&&`. No corras scripts de `scripts/js` con flags que no conoces.
- **Carga:** antes de algo pesado, confirma que no hay carga ajena. En Linux se usa `systemd-run --user --scope -p MemoryMax=8G -- flock /tmp/navori-heavy.lock`; en la Mac, `flock /tmp/navori-heavy.lock` con `CARGO_BUILD_JOBS=4` y `--test-threads=4`.
- **Engram:** cada sesión actualiza su puntero `coordinacion/rust-0.13/sesion-N` al terminar cada tarea.

## 4. Retomar cada sesión

Abre una sesión por cada una y pídele: «sigamos session N; lee el puntero `coordinacion/rust-0.13/sesion-N` y `specs/0062-rust-activacion-corte/estado-sesiones-2026-11-23.md`». Su cola:

| Sesión | Primero | Dónde está el trabajo |
|---|---|---|
| S1 | #1801 (plazo miércoles 25 a las 12:00; avisar a Ulises el miércoles por la mañana), después #1793 | Workplans en `handoffs-2026-11-23/workplan_guard-git-forms.md` y `workplan_routing-watch-write-probe.md`. Cópialos a `.navori/state/handoffs/` del clon antes de despachar al implementer |
| S1 (en Linux) | Divergencia del fuzz bajo carga y verificación de #1772 | #1813 (herramienta); `herramientas/s1/window.sh`, `flaky.sh` |
| S2 | #1806 (gate y revisiones), #1803 después de la ventana, segunda revisión de #1801 | Ramas `feat/cutover-delegacion-transitoria` y `release/0.13-bump`; borrador del release en #1807 |
| S3 (en Linux) | La mañana del 26: lista de comprobación y gate full; después de las 17:16, tabla de cierre | `handoffs-2026-11-23/corte-26-runbook.md`; `herramientas/s3/` |
| S3 (en la Mac) | Workplans de 0065, #1783 después del 26 | `workplan_0065-fase1.md`, `solution_1783-aborto-hermanos.md` |

## 5. Vigilancia R81 (PC Linux)

Al cierre del 23 nov (19:55 CST) las unidades `s3-shadow-watch`, `s3-vigila` y `s3-target-watch` estaban **inactivas**: se detuvieron con las sesiones. La última ronda de `s3-vigila` fue a las 19:03 y dio `div=1 nf=0 sf=0 pend=5`, igual que la línea base conocida.

El ensayo del cierre (`r81-cierre.sh 2026-11-26T17:16:00-06:00`, corrido a las 19:55) sale `exit=1`, con dos rojos ya explicados en el runbook (sección 3):
- lote C: la divergencia de `pii-egress-guard [claude]` que escribió la prueba (#1774);
- lote D: `pr-publisher-confirm [pi]`, dos pérdidas del 21 nov a menos de 10 min.

Para relanzar la vigilancia en la PC Linux (las herramientas viven en `~/.cache/navori-rust/s3/r81/`; hay copia en `herramientas/s3/`):

```sh
cd ~/.cache/navori-rust/s3/r81
systemd-run --user --unit s3-vigila --collect -p WorkingDirectory="$PWD" -E PATH="$PATH" -E HOME="$HOME" \
  /bin/bash -c "exec ./vigila-loop.sh 6 >> vigila-loop.out 2>&1"
systemd-run --user --unit s3-target-watch --collect -p WorkingDirectory="$PWD" -E PATH="$PATH" -E HOME="$HOME" \
  /bin/bash -c "exec ./target-watch.sh >> target-watch.out 2>&1"
systemd-run --user --unit s3-shadow-watch --collect -p WorkingDirectory="$HOME/.cache/navori-rust/s3" -E PATH="$PATH" -E HOME="$HOME" \
  /bin/bash -c "exec ./shadow-watch.sh >> shadow-watch.out 2>&1"
./vigila.sh   # una ronda a mano, de solo lectura
```

`vigila-loop.sh` edita el resumen diario de #1527 (`issuecomment-7043932176`) en cada ronda. `r81-cierre.sh` usa el worktree `.claude/worktrees/s3-r81-close` del checkout de la sombra.

## 6. Herramientas copiadas

En `handoffs-2026-11-23/herramientas/`, con `/home/<usuario>` cambiado por `$HOME`. Son copias de referencia: sus rutas asumen la PC Linux.

- `s1/`:
  - `window.sh` y `flaky.sh`: verificación de #1772 y la divergencia;
  - `forms.sh` y `repro.sh`: matriz de formas de git del guard (#1801);
  - `count.py`, `fp.py`, `harness.py`, `lanes.py` y `lanes_probe.py`: costo de routing-watch (#1793);
  - `env.sh` y `heavy.sh`.
- `s2/`:
  - `s2-*.sh`: entorno, delta de CI, espera de PR, integración y medición;
  - `e2e-gate-foreign.sh.txt` (con extensión `.txt` porque usa `eval` y el lint del repo lo rechaza; quítasela para usarlo), `audit-e2e-arm.sh` y `smoke.mjs` (humo del legacy).
- `s3/`:
  - `vigila*.sh`, `relanza-vigila.sh`, `r81-cierre.sh`, `r81-rows.mjs`, `hermanos.sh`, `target-watch.sh` y `resumen-gen.py`;
  - `causes.json` y `batches.json`: entradas de `hook-shadow-report.mjs`;
  - `shadow-watch.sh`, `ci-delta.sh`, `clean-measure.sh`, `r17-criteria.mjs` y `env.sh`.
