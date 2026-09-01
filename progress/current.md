# Sesión actual

**Estado:** `idle`. `main` en `789fb24`, sincronizado con `origin/main`. Tag `v0.6.5` pusheado.
**4 issues abiertos**, todos de la spec 0010: #545, #546, #547, #548. Más #538 (prune / `.codex/hooks.json`).

## Dónde quedó el harness global (spec 0010)

`navori global` es la capa por-máquina en `~/.claude`: un SessionStart hook con gate que inyecta un
baseline de prosa **solo** donde no hay `navori.config.json`. **Sigue sin instalarse en esta máquina**
(no existe `~/.navori/global.json` — huella cero, que es la invariante §2.4). Para probarlo sin tocar
el perfil real: `CLAUDE_CONFIG_DIR=~/navori-fresh navori global init`.

La §8 de la spec se rehizo esta jornada en fases **FA / FB / FC / FD**. FA cerró 3 de 5.

### Hecho

- **#542 + #543** (PR #549) — el hook lleva marcador `navori:managed` + hash sobre cada byte, y
  `global doctor` **ejecuta** el gate en dos tmpdirs en vez de solo comprobar que el archivo existe.
- **#541** (PR #550) — `globalSafe` declarado en `CoreManagedAsset` + `global-safe-inventory.test.ts`,
  que afirma la equivalencia en ambas direcciones (todo marcado pasa las 4 reglas; todo sin marcar
  falla al menos una).
- **#544** (PR #551) — `ownedPermissions` se calcula en el merge y `uninstall` retira esa
  intersección y nada más. Round-trip byte-idéntico.

## SIGUIENTE PASO: #546 (FB) — skills y subagentes globales como plugin `@skills-dir`

Es lo que hace que un repo sin navori herede un harness **operativo** y no 37 líneas de prosa que
describen guardrails inexistentes. El diseño ya está decidido y verificado contra la doc de Claude
Code (ver el issue y §8 FB de la spec):

```
~/.claude/skills/navori/
├── .claude-plugin/plugin.json     name: "navori"
├── skills/     → las 12 base, como /navori:<nombre>
├── agents/     → los 7 invocables + leader.md
└── hooks/hooks.json  → el gate se muda aquí
```

**Lo crítico a no olvidar:** las skills NO pueden instalarse sueltas en `~/.claude/skills/` — ahí
**personal gana a project** y eclipsarían las del repo, user-sections incluidas, en los 15+ repos
Bonum. El plugin las namespacea y el problema desaparece por construcción. Los agentes del plugin, en
cambio, heredan la semántica de defer gratis: `.claude/agents/` del proyecto los sobrescribe.

Requiere el modo `globalFallback` en `placeholders.ts` para `{{qualityGate.*}}`, `{{branchBase}}` y
`{{prTarget}}` — el agente global **deriva** el gate en vez de traerlo horneado. Y una entrada en
`navori migrations` por la mudanza del hook desde `settings.json`.

Después: **#545** (init interactivo, ya desbloqueado por #541), **#547** (FC), **#548** (docs).

## Deuda / gotchas vigentes

- **El guard `~/.navori` (#404/#424) da falso positivo en local** cuando hay otra sesión de Claude
  Code trabajando en otro repo: sus hooks escriben `~/.navori/audits/<repo>/session-<uuid>.log`
  durante la corrida. Verificable: el log crece **sin** correr tests. En CI siempre pasa.
- **Ojo con la base de las branches.** El squash de #549 se tragó dos commits locales sin pushear.
  Antes de branchear: `git log origin/main..main` debe estar vacío.
- El website documenta **8 de 20** comandos (`apps/website/src/content/commands.ts`). #548 propone el
  guard que cierra la clase entera, igual que `subcommand-inventory.test.ts` hace contra `CLAUDE.md`.
