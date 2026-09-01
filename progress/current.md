# Sesión actual

**Estado:** FB entregada (#546) en la branch `feat/546-global-plugin-skills-dir`, gate verde.
**4 issues abiertos**: #545, #547, #548 (spec 0010) y #538 (prune / `.codex/hooks.json`).

## Dónde quedó el harness global (spec 0010)

`navori global` es la capa por-máquina en `~/.claude`. **Sigue sin instalarse en esta máquina**
(no existe `~/.navori/global.json` — huella cero, la invariante §2.4). Para probarlo sin tocar el
perfil real: `CLAUDE_CONFIG_DIR=$(mktemp -d) HOME=$(mktemp -d) navori global init`.

La §8 se rehizo en fases **FA / FB / FC / FD**. FA cerró 3 de 5 (#541, #542+#543, #544). **FB cerró.**

### FB — el harness global dejó de ser solo prosa

`~/.claude/skills/navori/` con `.claude-plugin/plugin.json` carga como `navori@skills-dir` sin
marketplace y sin paso de instalación. Ahí van los 8 agentes, las 12 skills base y —esto es lo que
saca los hooks de navori del `settings.json` del usuario— el gate del §3.1, vía `hooks/hooks.json`.

Las tres propiedades salen del mecanismo, no de cuidado nuestro: las skills quedan namespaceadas
`/navori:<id>` y no pueden eclipsar las del repo; los agentes de plugin son la precedencia MÁS BAJA,
así que `.claude/agents/` del repo gana y el defer del §3.1 sale gratis; y desinstalar es borrar un
directorio.

**El modo `globalFallback`** (`lib/placeholders.ts`) es lo que hace renderizables los assets fuera de
un repo: `qualityGate.fast|full`, `branchBase` y `prTarget` rinden como la instrucción de DERIVARLOS.
Con eso `orquestacion` entra completo al baseline —y tiene que entrar, o instalas 8 subagentes sin
doctrina de routing— y se retira el follow-up de "partir el bloque".

Cinco desviaciones del boceto, todas anotadas en la spec (§8 FB, bloque **ENTREGADO**): settings.json
queda solo con `permissions` y a menudo ni se crea; la migración F1→FB deja copia restaurable en
`~/.navori/migrations/<ts>/claude-global/`; `blocks.include` se actualiza solo si nadie lo tocó; el
manifest lleva `author` porque `--strict` lo exige; y los fallbacks son cortos y sin backticks.

## SIGUIENTE PASO

**#547 (FC)** — doctor cross-scope: `navori doctor` detecta el harness global y avisa de choques
reales (agente ensombrecido, permiso global contra un `deny` del repo, drift del hook, y el caso
`@skills-dir` bloqueado por managed settings). Sin `scope: both` ya no tiene falso-positivo.

Después: **#545** (init interactivo) y **#548** (docs + el guard de `commandOrder`).

## Deuda / gotchas vigentes

- **El guard `~/.navori` (#404/#424) da falso positivo en local** cuando hay otra sesión de Claude
  Code trabajando en otro repo: sus hooks escriben `~/.navori/audits/<repo>/session-<uuid>.log`
  durante la corrida. Pasó en esta jornada (`audits/alertaciudadana_backend/`). En CI siempre pasa.
- **Un spec que escriba en `~/.navori` necesita mockear `home.ts`.** Es la razón por la que la
  migración F1→FB vive en su propio archivo (`global-legacy-migration.test.ts`) y no junto al resto
  de `global-render`: el mock de `safeHomedir` no se puede acotar a un `describe`.
- **Ojo con la base de las branches.** Antes de branchear: `git log origin/main..main` debe estar vacío.
- El website documenta **8 de 20** comandos (`apps/website/src/content/commands.ts`). #548 propone el
  guard que cierra la clase entera, igual que `subcommand-inventory.test.ts` hace contra `CLAUDE.md`.
