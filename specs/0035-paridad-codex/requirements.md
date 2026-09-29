# Paridad Codex — Requirements

**Status:** borrador · **Fecha:** 2026-09-25 · **Base revisada:** `bb1470d5` · **Issue:** #1071

- **Objetivo del usuario (2026-09-25):** que un repo con el engine `codex` funcione igual que con
  Claude, y que se instale con facilidad.
- **Decisiones del usuario (2026-09-25):**
  - La confianza del repo y la aprobación de hooks se resuelven con un comando opt-in que pide
    confirmación explícita. No basta con solo detectarlas.
  - Mapeo de modelos por defecto: opus→`gpt-6-sol`, sonnet→`gpt-6-sol`, haiku→`gpt-6-luna`.
- **Decisión del usuario (2026-09-27):** todo setup Codex generado debe usar por defecto acceso
  completo sin sandbox, conservar `approval_policy = "on-request"` y
  `approvals_reviewer = "user"`; no cambiar la sandbox administrada por el host ni mutar otros
  repositorios o la configuración global como efecto lateral.
- **Alcance temporal:** Codex plan-gate queda fuera de esta spec hasta que el host permita
  verificar su aplicación real. El resto de la funcionalidad Codex descrita aquí permanece en
  alcance; los controles Claude no cambian.

## Context

Verificado contra `bb1470d5`, contra `codex-cli 0.157.0` y contra el código fuente de
`openai/codex` en `rust-v0.157.0`:

- **Hooks sin registrar.** El engine Claude registra 16 hooks en `.claude/settings.json`
  (`engines/claude/build-settings.ts`). El engine Codex copia los 16 scripts a `.codex/hooks/`,
  pero `buildCodexConfigToml` (`engines/codex/build-config-toml.ts`) solo registra
  `guard-destructive`, `model-advisor`, `comment-draft-confirm` y, con `qualityGate.fast`,
  `quality-gate-pre-commit`. Los otros 12 están en disco y Codex nunca los ejecuta.
- **Sin contexto de arranque.** Una sesión real de Codex en `monorepo-fullstack` respondió que no
  recibió la rama, los commits recientes ni `progress/current.md`. En Claude eso lo entrega
  `session-start-context.sh` en `SessionStart`.
- **Codex 0.157 ya soporta lo necesario.** Tiene 12 eventos: `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStart`,
  `SubagentStop`, `PreCompact`, `PostCompact` e `Interrupt`. Nombres de herramienta que ven los
  hooks: `Bash`, `apply_patch` (acepta `Write`/`Edit` como alias del matcher), `spawn_agent`
  (acepta `Agent`) y `mcp__<server>__<tool>`. Dentro de un subagente, los payloads traen
  `agent_id` y `agent_type` desde 0.134.
- **`ask` no existe en Codex.** Un hook que responde `permissionDecision: "ask"` cuenta como hook
  fallido, y la llamada pasa. `pr-publisher-confirm.sh` responde `ask`, y registrarlo tal cual lo
  haría inútil. `comment-draft-confirm.sh` ya lo documenta en su encabezado. Codex sí tiene un
  equivalente para comandos de terminal: las reglas de `.codex/rules/*.rules`
  (`prefix_rule(..., decision="allow" | "prompt" | "forbidden")`), que se cargan cuando el
  proyecto es de confianza.
- **Permisos aproximados.** Claude traduce `permissions.allow/ask/deny` a `.claude/settings.json`.
  El setup Codex generado usa `danger-full-access` con aprobación `on-request` y revisor `user`;
  las reglas de terminal y hooks son controles separados, no aislamiento de filesystem/red ni una
  aprobación por comando.
- **Modelos desactualizados.** `CODEX_MODEL_BY_CLAUDE_TIER` (`engines/codex/index.ts`) fija
  `gpt-5.6-sol`/`-terra`/`-luna`. El `models_cache.json` de Codex ya ofrece `gpt-6-sol`,
  `gpt-6-luna` y `gpt-6-astra`.
- **Instalación manual y en silencio.** Si el proyecto no tiene `trust_level = "trusted"` en
  `~/.codex/config.toml`, Codex no carga nada de él: ni `.codex/` (config, hooks y reglas) ni
  `AGENTS.md` (`core/src/agents_md.rs`, `load_project_instructions`). Cada hook necesita además
  un `trusted_hash` en `[hooks.state."<clave>"]`. El hash cubre la definición del hook (evento,
  matcher, comando, timeout, statusMessage) y no el contenido del script. Hoy el usuario lo
  resuelve a mano en `/hooks`, y navori solo imprime `codexTrustHint`. Sin eso, los hooks no
  corren y nada avisa. `codex app-server` expone `hooks/list`, que devuelve el `trustStatus` de cada
  hook sin abrir la TUI.
- **`AGENTS.md` cerca del tope.** Codex deja de leer instrucciones pasado `project_doc_max_bytes`
  (32768 por defecto). El `AGENTS.md` de este repo mide 29207 bytes y el de `monorepo-fullstack`
  26676.

## Requirements (EARS)

### Hooks y contexto

- **R1** — WHEN el engine `codex` renderiza, el sistema SHALL registrar en `.codex/config.toml`
  el hook `session-start-context` en `SessionStart` para los orígenes `startup`, `resume`,
  `clear`, `compact` y `fork`.
- **R2** — WHEN `session-start-context` corre bajo Codex, el sistema SHALL entregar como
  `additionalContext` la rama, los commits recientes y `progress/current.md`, igual que bajo Claude.
- **R3** — WHEN el engine `codex` renderiza, el sistema SHALL registrar cada hook que el engine
  Claude registra, con el evento y el matcher equivalentes de Codex, salvo los que
  `ENGINE_CAPABILITIES.codex` declare `unsupported` con su razón y la superficie de plan-gate
  excluida temporalmente por R6.
- **R4** — WHEN un hook registrado para Codex corre, el script SHALL leer el payload de Codex
  (`apply_patch`, nombres de herramienta y `agent_type`) y producir la misma decisión que produce
  con el payload equivalente de Claude, salvo superficies excluidas o temporalmente diferidas. La
  normalización de nombres de delegación no constituye evidencia de que Codex plan-gate esté
  registrado o aplicado.
- **R5** — IF un hook decide `ask` bajo Claude THEN el engine `codex` SHALL expresar esa decisión
  con un mecanismo que Codex respeta, y SHALL NOT emitir `permissionDecision: "ask"`.
- **R6 (diferido)** — Codex plan-gate y la aplicación global de workplans quedan temporalmente fuera
  de alcance. El engine SHALL NOT registrar ni declarar `plan-gate` como `enforced` en Codex. Esta
  exclusión no cambia el plan-gate de Claude ni los demás hooks de Codex. El smoke real de Codex
  0.157.1 creó un implementer sin workplan aun usando el CLI compilado de esta rama; por tanto, no
  hay evidencia de enforcement ni de que los nombres de delegación observados sean suficientes.
- **R7** — WHEN el engine `codex` renderiza con `harness.scribeOwnsMarkdown` activo, el sistema
  SHALL registrar `implementer-no-markdown` sobre `Bash` y `apply_patch`, y
  `ENGINE_CAPABILITIES.codex` SHALL declarar `markdown-ownership` como `enforced` con evidencia de
  tipo `hook`.
- **R8** — WHEN `control-inventory.test.ts` corre, el sistema SHALL verificar que cada control de
  Codex declarado `enforced` con evidencia `hook` esté registrado en `.codex/config.toml` con ese
  evento y matcher exactos; SHALL verificar además que `plan-gate` no esté registrado ni declarado
  `enforced` mientras R6 siga diferido. Los controles Claude permanecen sin cambios.

### Permisos, modelos e instrucciones

- **R9** — WHEN el engine `codex` renderiza, el sistema SHALL generar `.codex/rules/navori.rules`
  que traduzca las reglas `ask`/`deny` de comandos de terminal de la configuración de permisos de
  navori a `prefix_rule` con `prompt`/`forbidden`, y SHALL NOT emitir reglas `allow`.
- **R10** — IF una regla de permisos no es de terminal o no cabe como prefijo THEN el sistema
  SHALL omitirla de `.codex/rules/navori.rules` y listarla en las advertencias del render.
- **R11** — WHERE `models.codexMap` no define un tier, el engine `codex` SHALL asignar
  `gpt-6-sol` a opus, `gpt-6-sol` a sonnet y `gpt-6-luna` a haiku.
- **R12** — WHEN el `AGENTS.md` renderizado supera los 32768 bytes, el sistema SHALL escribir en
  `.codex/config.toml` un `project_doc_max_bytes` mayor o igual a su tamaño.

### Instalación

- **R13** — WHEN el usuario corre `navori codex trust` en un repo con el engine `codex`, el sistema
  SHALL mostrar la ruta del proyecto y cada hook de navori (evento, matcher y comando) antes de
  escribir nada.
- **R14** — WHEN el usuario confirma de forma explícita, `navori codex trust` SHALL escribir en
  `~/.codex/config.toml` la confianza del proyecto y el `trusted_hash` de cada hook de navori,
  después de respaldar el archivo, sin tocar ninguna otra clave.
- **R15** — IF el usuario no confirma, o la sesión no es interactiva y falta `--yes`, THEN
  `navori codex trust` SHALL terminar sin escribir en `~/.codex/`.
- **R16** — WHEN `navori doctor` corre en un repo con el engine `codex`, el sistema SHALL reportar,
  sin escribir nada, si el proyecto es de confianza y el estado de cada hook de navori
  (`Trusted`, `Modified` o `Untrusted`), y SHALL nombrar `navori codex trust` como el arreglo. Un
  proyecto sin confianza SHALL reportarse aparte, indicando que Codex no carga ni `AGENTS.md`.
- **R17** — WHEN `init`, `sync` o `render` terminan con el engine `codex` y el repo o algún hook no
  está aprobado, el sistema SHALL indicar `navori codex trust` como el siguiente paso.
- **R18** — IF la versión instalada de Codex es menor que la mínima que exigen los hooks
  registrados THEN `navori doctor` y el render SHALL advertirlo con la versión mínima.
- **R19** — WHEN el engine `codex` renderiza plugins habilitados THEN el sistema SHALL tratar
  `externalTool` como capacidad CLI y SHALL NOT emitir una advertencia de MCP omitido ni una tabla
  `mcp_servers` para ese plugin; SHALL renderizar la tabla `mcp_servers` cuando exista `mcpServer`;
  y SHALL advertir cuando el plugin no declare ninguna de las dos capacidades. Este requisito no
  implica que Codex invoque automáticamente una herramienta CLI.
- **R20** — WHEN el engine `codex` renderiza la configuración del proyecto THEN el sistema SHALL
  establecer `sandbox_mode = "danger-full-access"`, `approval_policy = "on-request"` y
  `approvals_reviewer = "user"` como defaults del proyecto. Codex solo SHALL cargar esos defaults
  si el proyecto es de confianza; los agentes generados SHALL heredar el modo del padre si no
  declaran uno más restrictivo, y una opción explícita del agente, CLI o host SHALL poder prevalecer.
  Esto no SHALL afirmar aprobación por comando ni mutación de configuración global o de otros
  repositorios.
