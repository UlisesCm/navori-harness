# Borrador del release 0.13.0: pasos e (bump) y f (docs)

> BORRADOR SIN EJECUTAR (rama wip/release-0.13-bump-docs, 20 nov 2026). No se mergea. Al
> ejecutar, cada paso va en su propio commit sobre `dev` después del corte (T10) y este archivo se
> elimina. Pasos a–g del plan: #1527 (issuecomment-7027107162).

## Bloqueos antes de ejecutar

1. **Q24 de 0062: cómo se publican los binarios.** Decisión de Ulises (20 nov 11:25): intenta
   crear la org `navori` en npm y se queda el esquema actual, `@navori/<os>-<cpu>` como
   `optionalDependencies` de `navori`, sin cambiar código. Plan B si el nombre está tomado: ver
   "Plan B de Q24" abajo.
2. **legacy.json**: decidido, opción E (Ulises, 20 nov 11:45). El TS congelado se publica aparte
   como `@navori/legacy` (`navori-legacy` en el plan B), construido desde el commit anterior al PR
   de corte y con la versión del release; `packaging/legacy.json` fija `{ version, integrity,
   commit }`. Implementado en #1760. 0.12.5 no pasó la prueba rápida (detalle en
   decisiones-ulises/2026-11-20-legacy-json).
5. ~~**El prólogo nativo busca `navori-rust` y el paquete no lo instala**~~ RESUELTO: opción A
   (decisiones-ulises/2026-11-20-1645). El paquete expone el bin `navori-rust` (#1769), y sin
   postinstall `doctor` avisa del costo.
3. **claudePlugins**: no hay 0.12.6; sale en 0.13 (Ulises, 20 nov 11:25).
4. **Paso f′**: integrar main en dev (merge commit, #1705 y #1748) y luego dev en migration/rust,
   antes del PR dev → main.

## Lo que entró en migration/rust desde el borrador (al 23 nov)

Debe aparecer en las notas del release y en la entrada de `releases.ts`:

- `gate foreign` nativo (#1775, con #1777 de seguimiento).
- `audit --arm` y `audit --disarm` nativos (#1791, si entra antes del 26). El resto de `audit`
  sigue en el TS congelado; los cuatro modos que llaman los hooks son deuda en el inventario
  post-0.13.
- El paquete expone `navori-rust` y el launcher JS para instalaciones sin postinstall (#1769).
  El seguimiento del legacy, con pin completo y `--from-pin`, entró en #1764.
- `check-pin` exige que Cargo y `packages/cli` tengan la misma versión (#1788).
- El oráculo y `cutover-check` respetan `requires`. `sync` y `remove` sin sus banderas quedan como
  prompts interactivos del TS (#1780, D2).
- La caché de `navori --version` se invalida al cambiar el `node` del PATH (#1778, de S1).

## Paso e: bump a 0.13.0

Un solo commit `chore(release): navori v0.13.0` sobre `dev`, después del corte:

| Archivo | Cambio | Nota |
|---|---|---|
| `packages/cli/package.json` | `0.12.5` → `0.13.0` | El TS congelado del repo; `release-tag.yml` crea el tag al llegar a main. |
| `Cargo.toml` (`[workspace.package]`) | `0.13.0-rust.1` → `0.13.0` | `workspaceVersion()` de `dist-assemble.mjs` toma de aquí la versión de `navori` y de los paquetes de plataforma. |
| `Cargo.lock` | `cargo update --workspace` (con `--locked`, el build falla hasta actualizarlo) | Solo cambian las versiones de los crates del workspace. |
| `packaging/legacy.json` | lo escribe `dist-assemble legacy --write-pin` antes del corte | Ver "Antes del PR de corte: el legacy" en el paso g. No se edita a mano. |
| `crates/navori-cli/src/notices.rs` | `ENABLED: bool = false` → `true` | T11/R85. **Va en este PR del bump, no en el del corte** (Ulises, 20 nov 11:25). |
| `navori.config.json` (`harnessVersion`) y `.claude/settings.json` (`$navori.version`) | los escribe el render | No editar a mano. |

Comandos, en este orden (los mismos de README § Releases, adaptados al binario):

```bash
# 1. versión y lock
cargo update --workspace
# 2. re-render obligatorio: STAMP_VERSION sale de packages/cli/package.json (navori-core lib.rs)
bun run --filter navori build && node packages/cli/dist/index.js render --apply
#    (tras el corte: cargo build --release -p navori-cli && target/release/navori-rust render --apply)
# 3. goldens que dependen de la versión
#    packages/cli/src/__tests__/fixtures/cli-surface.golden.json (en 0.12.5 cambió 62 líneas)
#    imágenes og de apps/website/public (og*.svg y og*.png llevan la versión)
# 4. verificación
navori gate full
bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked
node scripts/js/dist-assemble.mjs --out /tmp/navori-0.13 --pack --binary linux-x64=target/release/navori-rust
```

Puntos a revisar al ejecutar:

- `STAMP_VERSION` (`crates/navori-core/src/lib.rs:10`) es la versión del TS del checkout. Tras el
  corte el TS del repo queda congelado en 0.13.0, así que los marcadores seguirán estampando la
  versión de `packages/cli/package.json`. Confirmar que eso sigue siendo lo buscado o si pasa a
  `VERSION` (decisión de diseño, no del bump).
- Que `navori --version` del binario responda `0.13.0`: el `postinstall` compara la versión del
  paquete con la del binario y, si no coinciden, deja los bins JS (`packaging/npm/lib/install.js`).
- **Las dos versiones suben juntas y al mismo número** (decisiones-ulises/2026-11-23-version-stamp):
  `Cargo.toml` es lo que responde `navori --version` y `packages/cli/package.json` es
  `STAMP_VERSION`. Los hooks corren plan-gate, `tools session-context` y `gate probe` en proceso
  solo cuando `navori --version` es `STAMP_VERSION` (`hook_facts.rs` `in_process`, plan-gate
  `same_version`). Si difieren no se rompe nada, pero cada llamada lanza un proceso. `check-pin`
  (paso 0 de la publicación) falla si difieren.

### Pasos obligatorios del mismo PR del bump (decisiones-ulises/2026-11-23-1120, punto 3)

Con Cargo y `packages/cli` en el mismo número se rompen dos supuestos. Los dos arreglos van en el
PR del bump, no después.

**e.1 `semver.rs` exige que las versiones difieran.** `crates/navori-core/tests/semver.rs:25`
tiene `assert_ne!(STAMP_VERSION, VERSION, "the stamp must never be the Rust prerelease")` (D20 de
0058, R38). Con las dos en 0.13.0, `cargo test --workspace` falla.

- Arreglo propuesto: cambiar esa aserción por
  `assert_eq!(STAMP_VERSION, VERSION, "the binary answers --version with VERSION; the hooks run in process only when it is the stamp")`.
  Se conservan las aserciones de orden del prerelease (`0.13.0-rust.1` = `0.13.0`,
  `is_downgrade("0.13.0-rust.1", "0.12.2")`), porque siguen valiendo.
- Enmendar D20 en `specs/0058-*/design.md`: desde 0.13.0 la versión de sello y la de Cargo son la
  misma. La igualdad pasa a ser un invariante que la prueba vigila en cada PR, y `check-pin` (#1788)
  lo vuelve a comprobar al publicar.
- Verificación: `cargo test -p navori-core --locked --test semver` en verde con las dos en 0.13.0,
  y en rojo si se deja una en `0.13.0-rust.1`.
- **Listo para aplicar:** commit `d75d5c63` en la rama `wip/release-0.13-bump-e1` (prueba y enmienda
  de D20). En el PR del bump: `git cherry-pick d75d5c63`. No se mergea suelto: hoy falla a
  propósito porque las versiones difieren. Verificado: en rojo con 0.13.0-rust.1 frente a 0.12.5, y
  en verde con las dos iguales.

**e.2 `dist-probe` deja de distinguir el binario del legacy.** `scripts/js/dist-probe.mjs`
(`checkInstall`, :198-202) espera `version` (Cargo) en el carril nativo y `legacyVersion` (el pin)
sin binario. Con las dos en 0.13.0, un launcher que cayera por error al legacy pasaría la
comprobación de `--version`.

- Arreglo propuesto: agregar a `checkInstall` un discriminador que no dependa de la versión.
  Correr un subcomando delegado (por ejemplo `navori workspace ls`) con `NAVORI_TS_CLI` apuntando
  a un stub JS que imprime una marca y sale con 0.
  - Carril nativo: el binario delega en ese stub. `plan()` del launcher respeta un `NAVORI_TS_CLI`
    que ya viene puesto, y en el caso enlazado no hay launcher. Debe aparecer la marca.
  - Sin binario: el launcher corre `node legacy/dist/index.js` directo y no lee `NAVORI_TS_CLI`. La
    marca NO debe aparecer.
- Prueba en `packages/cli/src/__tests__/dist-launcher.test.ts` o en la de `dist-probe`: con un
  launcher que cae al legacy, `checkInstall` reporta la falla aunque `--version` coincida.
- Verificación: el job `probe` de `rust-release.yml` en verde en las 4 plataformas con las versiones
  iguales.
- **Adelantado en #1799**, porque no depende de que las versiones coincidan. En el PR del bump solo
  hay que confirmar que el job `probe` sigue en verde.

## Paso f: docs

### `apps/website/src/content/releases.ts`: entrada 0.13

`landing-inventory.test.ts` falla si la minor actual del CLI no tiene entrada. Borrador para
redactar con Ulises (la línea principal es suya):

```ts
{
  minor: "0.13",
  date: "<fecha del tag v0.13.0>",
  headline: {
    es: "navori es un binario nativo",
    en: "navori is a native binary",
    "zh-CN": "navori 现为原生二进制程序",
  },
  bullets: [
    {
      es: "La CLI es un binario Rust para macOS (arm64 y x64) y Linux (arm64 y x64, estático con musl), con los mismos comandos y la misma salida que el TS. En otras plataformas, el paquete instala el último TS publicado, verificado con su integrity.",
      en: "The CLI is a Rust binary for macOS (arm64 and x64) and Linux (arm64 and x64, statically linked with musl), with the same commands and the same output as the TS one. On other platforms the package installs the last published TS, verified against its integrity.",
      "zh-CN": "CLI 现为 Rust 二进制程序，支持 macOS（arm64 与 x64）和 Linux（arm64 与 x64，使用 musl 静态链接），命令与输出与 TS 版本一致。其他平台会安装最后发布的 TS 版本，并校验其 integrity。",
    },
    {
      es: "Los hooks de Claude Code y Pi corren nativos, con los mismos veredictos que los scripts de shell, comprobados con replay y siete días de sombra.",
      en: "Claude Code and Pi hooks run natively, with the same verdicts as the shell scripts, checked by replay and seven days of shadow runs.",
      "zh-CN": "Claude Code 与 Pi 的钩子以原生方式运行，裁决与 shell 脚本一致，已通过回放和七天影子运行验证。",
    },
    {
      es: "master, codex, workspace, ticket, registry y la mayor parte de audit (salvo --arm y --disarm) siguen en el TS congelado, que viaja dentro del paquete; no necesitas instalar nada aparte.",
      en: "master, codex, workspace, ticket, registry and most of audit (except --arm and --disarm) stay on the frozen TS, which ships inside the package; there is nothing else to install.",
      "zh-CN": "master、codex、workspace、ticket、registry 以及 audit 的大部分功能（--arm 与 --disarm 除外）仍由冻结的 TS 版本处理，它随包一起发布，无需另行安装。",
    },
    {
      es: "claudePlugins en navori.config.json declara los plugins de Claude Code y el render escribe enabledPlugins en .claude/settings.json (#1747).",
      en: "claudePlugins in navori.config.json declares Claude Code plugins, and render writes enabledPlugins into .claude/settings.json (#1747).",
      "zh-CN": "navori.config.json 中的 claudePlugins 用于声明 Claude Code 插件，render 会将 enabledPlugins 写入 .claude/settings.json（#1747）。",
    },
  ],
},
```

Pendiente de confirmar al redactar: la lista exacta de delegación permanente
(`scripts/js/rust-areas.mjs` en el árbol del corte), el texto de #1717/#1727 (auditoría con
escritores concurrentes, en la memoria release-0.13-plan) y #1718 (plazo de du en doctor).

### `README.md`, `README.es.md`, `README.zh-CN.md`

- **§ Releases (T11, R21, R22):** los pasos 2, 3 y 8 cambian con el binario:
  - paso 2: subir `packages/cli/package.json` **y** `[workspace.package]` de `Cargo.toml`;
  - paso 3: el re-render se hace con el binario (`target/release/navori-rust render --apply`);
  - paso 8: `npm publish` ya no sale de `packages/cli`. Se publican los paquetes que arma
    `dist-assemble.mjs` desde los artefactos de `rust-release.yml` (`npm-packages/*.tgz`): primero
    los cuatro de plataforma, después `navori`. Depende de Q24.
  - Nuevo: `packaging/legacy.json` fija el TS de respaldo y de la delegación permanente; se
    actualiza solo con una decisión explícita.
- **§ Development:** build con `cargo build`, toolchain de `rust-toolchain.toml`,
  `bun run rust:hooks-sync` para las cabeceras de los hooks nativos; `packages/cli/src` deja de ser
  la fuente de la CLI.
- **§ Monorepo structure:** `crates/` (navori-cli, navori-core, navori-hooks) y `packaging/`.
- **§ Migrating to 0.12** → agregar "Migrating to 0.13": nada que hacer en el repo; tras
  `npm i -g navori@0.13`, `navori --version` debe decir 0.13.0; en plataformas sin binario responde
  el TS.

### `CONTRIBUTING.md`, `CONTRIBUTING.es.md`, `CONTRIBUTING.zh-CN.md`

- Build y pruebas con cargo (`cargo test --workspace --locked`, clippy, fmt) además de bun.
- Cambios en hooks: `crates/navori-hooks` es la fuente; los espejos y `crates/ported.json` se
  regeneran con `rust:hooks-sync` (procedimiento #247 y skill rebase-rerender).
- `packages/cli/src` congelado: solo las suites de artefacto.

### `docs/architecture.md`, `.es.md`, `.zh-CN.md`

- CLI en Rust; el TS congelado (`legacy/`) solo para la delegación permanente y las plataformas sin
  binario.
- Hooks nativos con firma (`navori:native-hook`) y su relación con los scripts de shell.

### Specs

- 0062: marcar T10, T11 y A4 con su evidencia.
- 0060: ya cerrada para 0.13 (T23, A8) en #1756; revisar T29.
- 0057–0061: estado final en sus `tasks.md` (correr `navori spec check <spec>` antes de commitear).

## Plan B de Q24: paquetes sin scope

Solo si la org `navori` está tomada. Los paquetes de plataforma pasan de `@navori/<os>-<cpu>` a
`navori-<os>-<cpu>` (`navori-darwin-arm64`, `navori-darwin-x64`, `navori-linux-arm64`,
`navori-linux-x64`). Archivos que cambian:

- `scripts/js/dist-assemble.mjs`: `SCOPE` (:32) y los nombres que arma (:101 `optionalDependencies`,
  :110 `name` del paquete de plataforma); el directorio de salida ya es `navori-<platform>` (:143).
- `packaging/npm/lib/launcher.js:23`: el paquete que resuelve el lanzador (`@navori/${key}` →
  `navori-${key}`).
- `packages/cli/src/__tests__/dist-launcher.test.ts`: los nombres esperados.
- `.github/workflows/rust-release.yml`: el nombre del paso de ensamblado (:78) y las sondas R84 si
  nombran el paquete.
- Docs: el comentario de cabecera de `dist-assemble.mjs` (:16), `specs/0062-rust-activacion-corte`
  (D53 en `design.md` y T6/T7 en `tasks.md`) y la sección de instalación del README.
- Antes de publicar: comprobar con `npm view navori-<os>-<cpu>` que los 4 nombres estén libres.

## Paso g

PR dev → main con merge commit; notas "Qué cambia al actualizar" en el cuerpo, incluyendo #1705 y
#1748 (decisión de Ulises, 20 nov). Tag con `release-tag.yml` y publicación: Ulises.

### Antes del PR de corte: el legacy

En el commit anterior al PR de corte (T10), con `packages/cli/package.json` ya en la versión del
release o pasando `--version` igual a la que estampará el binario (`STAMP_VERSION`):

```bash
node scripts/js/dist-assemble.mjs legacy --from <sha> --version 0.13.0 --out /tmp/legacy-0.13 --write-pin
```

Se commitea `packaging/legacy.json` (`version`, `integrity`, `commit`). El ensamblado rechaza un
legacy cuyo `crates/ported.json` difiera del del commit que compila los binarios.

### Publicación, en este orden exacto

Sin `latest` hasta el final: cada paquete se publica con `--tag next` y se promueve al cierre, así
que un `npm i -g navori` no recibe nada a medias.

0. **Pin completo antes de publicar** (D53; pendiente de #1764 señalado por S3): sobre el commit del
   release, `node scripts/js/dist-assemble.mjs check-pin` tiene que imprimir
   `dist-assemble: packaging/legacy.json is complete`. Falla si `commit` no es hex de 40, si
   `integrity` no es `sha512-`, si `version` no es la de `packages/cli/package.json` o si la versión de
   Cargo no es la de `packages/cli/package.json` (#1788). Hoy ningún
   workflow lo corre: cuando exista un job de publicación, este paso va primero en él.
1. **Legacy primero:** `npm publish /tmp/legacy-0.13/<tarball> --tag next --access public`.
   Comprobar que npm sirva los mismos bytes que fija el pin:

   ```bash
   test "$(npm view @navori/legacy@0.13.0 dist.integrity)" = "$(node -p 'require("./packaging/legacy.json").integrity')"
   ```

2. **Los 4 binarios:** `npm publish <tarball> --tag next --access public` por plataforma, con los
   tarballs de `rust-release.yml` del commit del release.
3. **Verificar que existan los 4 binarios y el legacy antes del principal** (Ulises, 20 nov 11:25):

   ```bash
   for p in @navori/darwin-arm64 @navori/darwin-x64 @navori/linux-arm64 @navori/linux-x64 @navori/legacy; do
     npm view "$p@0.13.0" version || { echo "falta $p@0.13.0"; exit 1; }
   done
   ```

   Con el plan B: `navori-<os>-<cpu>` y `navori-legacy`. Si falta alguno, no se publica `navori`.
4. **Ensamblar el principal sin `--legacy-tarball`** (lo baja de npm y verifica la integrity) y
   publicarlo: `npm publish <navori-0.13.0.tgz> --tag next`.
5. **Humo desde el registro:** en un directorio temporal, `npm i navori@next` y `npx navori --version`
   (0.13.0), un subcomando delegado (`npx navori workspace ls`) y `dist-legacy-smoke` contra el
   tarball del registro.
5b. **Versiones y plan-gate en proceso, después de instalar** (decisiones-ulises/2026-11-23-version-stamp).
   Con `navori@next` instalado (global o en el directorio de humo, con su `node_modules/.bin`
   primero en el `PATH`):

   ```bash
   v=$(navori --version); r=$(navori-rust --version)
   s=$(node -p 'require("./packages/cli/package.json").version')   # STAMP_VERSION, en el checkout del release
   test "$v" = 0.13.0 && test "$r" = 0.13.0 && test "$s" = 0.13.0 || { echo "versiones: navori=$v navori-rust=$r stamp=$s"; exit 1; }
   # plan-gate en proceso: un navori espía delante en el PATH anota cada argv; en proceso, el hook
   # solo le pide --version (la sonda) y nunca `plan gate`.
   spy=$(mktemp -d); real=$(command -v navori)
   printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> %s/argv.log\nexec %s "$@"\n' "$spy" "$real" > "$spy/navori"; chmod +x "$spy/navori"
   printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Task","session_id":"humo","cwd":"'"$PWD"'","tool_input":{"subagent_type":"implementer","prompt":"workplan: humo"}}' \
     | PATH="$spy:$PATH" NAVORI_HOOK_IMPL=rust bash .claude/hooks/plan-gate.sh; code=$?
   test "$code" = 2 && ! grep -qs '^plan gate' "$spy/argv.log" && echo 'plan-gate en proceso'
   ```

   Se corre en el checkout del release, ya re-renderizado en 0.13.0 (la cabecera del hook tiene que
   ser la del binario instalado; si no, el runtime difiere con `hook integrity mismatch` y sale 1).
   Sin workplan, el gate niega con exit 2: ese 2 prueba que el runtime nativo dio un veredicto. Que
   `argv.log` no tenga `plan gate` prueba que fue en proceso. Si falta cualquiera de las dos cosas,
   no se promueve.
6. **Promover:** `npm dist-tag add <paquete>@0.13.0 latest` en el mismo orden (legacy, binarios,
   `navori` al final) y `npm view navori version`.

### Reversa (nunca `npm unpublish`)

- **Falla antes del paso 6:** nada está en `latest`. Se deja `next` apuntando a lo publicado o se
  mueve a la versión anterior (`npm dist-tag add navori@0.12.5 next`), se corrige y se publica
  0.13.1. Las versiones publicadas no se borran.
- **Falla después del paso 6:** `npm dist-tag add navori@0.12.5 latest` devuelve a los usuarios al
  TS anterior; después `npm deprecate navori@0.13.0 "<motivo>; usa 0.13.1"` y lo mismo para los
  paquetes de plataforma y el legacy si el fallo es suyo. La corrección sale como 0.13.1 con el
  mismo orden.
- Un paquete de plataforma o el legacy roto no se reemplaza (npm no permite republicar una
  versión): se publica la siguiente versión de todo el conjunto, porque el principal fija la
  versión exacta de sus `optionalDependencies` y del legacy.
