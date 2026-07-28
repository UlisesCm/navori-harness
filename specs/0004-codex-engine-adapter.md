# Spec 0004 — Codex engine adapter: paridad exacta Claude ↔ Codex

**Status:** proposed
**Date:** 2026-07-24
**Driver:** Ulises Ciprés
**Depends on:** [Spec 0002](./0002-claude-engine-adapter.md) — reutiliza sus helpers (`renderManagedFile`, `injectManagedSection`, `loadPreset`, `librarySkillById`).
**Objetivo:** que `navori render` produzca en un repo un harness Codex **equivalente en comportamiento** al que hoy produce para Claude Code, y que la spec sea tan prescriptiva que un agente de baja capacidad la ejecute sin tomar decisiones propias.

> **Cómo leer esta spec (agente ejecutor):** ejecuta las fases **en orden**. No saltes fases. Cada fase termina con un bloque **VERIFICAR** con comandos exactos; **no avances** a la siguiente fase hasta que todos los comandos de VERIFICAR pasen. Los diffs se dan con `ANTES` / `DESPUÉS` literales — aplica el cambio exacto. Si un comando de VERIFICAR falla, **detente y reporta**, no improvises.

---

## 1. Contexto: qué emite hoy el engine Claude (baseline de paridad)

`renderClaudeEngine` (`packages/cli/src/engines/claude/index.ts`) escribe, por repo:

| # | Activo | Destino Claude | Helper que lo escribe |
|---|--------|----------------|-----------------------|
| 1 | Reglas core + preset stack + índices | `CLAUDE.md` (bloques managed) | `computeRenderPlan` |
| 2 | Permisos + hooks + MCP | `.claude/settings.json` | `buildClaudeSettings` |
| 3 | Subagentes/roles | `.claude/agents/<role>.md` | `renderManagedFile` |
| 4 | Skills core + workflow + preset + library | `.claude/skills/<id>.md` | `renderManagedFile` |
| 5 | Hook defensivo | `.claude/hooks/guard-destructive.sh` (+x) | `renderManagedFile` (shell) |
| 6 | Hook quality-gate | `.claude/hooks/quality-gate-pre-commit.sh` (+x) | `renderManagedFile` (shell) |
| 7 | progress/ bootstrap | `progress/*.md` | one-shot |

## 2. Definición de paridad y mapeo a Codex

Codex CLI (jul 2026) soporta nativamente: `AGENTS.md` jerárquico, skills (`SKILL.md` + frontmatter), hooks (`[[hooks.PreToolUse]]`, cargados de `<repo>/.codex/`), subagentes GA (`[agents]` en `config.toml`), MCP (`[mcp_servers.*]`), y un modelo `sandbox_mode` + `approval_policy`.

| Activo Claude | Equivalente Codex | Destino Codex | Paridad |
|---------------|-------------------|---------------|---------|
| `CLAUDE.md` reglas + preset stack + orquestación | `AGENTS.md` | `AGENTS.md` (root) | ✅ exacta |
| `.claude/skills/<id>.md` | Skill `SKILL.md` | `.codex/skills/<id>/SKILL.md` | ✅ exacta (formato compatible) |
| `.claude/agents/<role>.md` (frontmatter) | `[agents.<role>]` | `.codex/config.toml` | ✅ traducción determinista |
| `settings.json` `hooks` PreToolUse | `[[hooks.PreToolUse]]` | `.codex/config.toml` + `.codex/hooks/*.sh` | ✅ exacta (mismo script) |
| `settings.json` MCP (engram) | `[mcp_servers.engram]` | `.codex/config.toml` | ✅ tras DT-6 |
| `settings.json` permisos `allow/ask/deny` | `sandbox_mode` + `approval_policy` | `.codex/config.toml` | 🟡 **aproximada** (ver DT-5) |
| `config.models.<role>` | `[agents.<role>].model` / `reasoning` | `.codex/config.toml` | ✅ |
| `progress/*.md` | igual (archivos markdown) | `progress/*.md` | ✅ (ya funciona, agnóstico) |

**Único punto sin paridad exacta:** granularidad de permisos (DT-5). La red de seguridad real la da el **hook** `guard-destructive` (paridad exacta), no la lista de globs.

---

## 3. Decisiones tomadas (DT) — cierran toda ambigüedad

### DT-1 — El engine `codex` es un engine COMPLETO, no un wrapper prose
No se reutiliza `renderProseFile` (tira orquestación, hooks, permisos, MCP). Se crea `engines/codex/index.ts` que emite múltiples archivos, pero **devuelve el mismo shape** que un prose engine (`{ written, skipped, warnings, backupPath }`) para encajar en `renderNonClaudeEngines` sin tocar el dispatcher más que una línea.

### DT-2 — Skills en forma de directorio
Destino: `.codex/skills/<id>/SKILL.md`. El asset fuente sigue siendo `packages/core/core-assets/skills/<id>.md` (**no se duplican assets**). El `name:` del frontmatter debe coincidir con `<id>` (regla de naming de Codex; los ids actuales ya cumplen: kebab-case, sin guiones consecutivos). commentStyle = `html` (SKILL.md es markdown).

### DT-3 — `.codex/config.toml` es un archivo managed con marcador shell-style
TOML acepta comentarios `#`, así que se reutiliza `injectManagedSection(..., "shell")` con `managedId = "codex-config-base"`. La zona fuera del marcador es del usuario (no se pisa).

### DT-4 — Los hooks shell se REUTILIZAN, con una rama de extracción para Codex
`guard-destructive.sh` y `quality-gate-pre-commit.sh` se emiten también a `.codex/hooks/`. Su `extract_cmd()` ya intenta jq → node → sed; se le agrega el shape del payload de Codex (confirmado en Fase 0). Un solo asset sirve a ambos engines.

### DT-5 — Permisos → `sandbox_mode` + `approval_policy` (paridad aproximada, declarada)
No hay equivalente 1:1 de los globs Bash. Mapeo fijo:
- `sandbox_mode = "workspace-write"` (permite escribir en el repo, no fuera).
- `approval_policy = "on-request"` (pide aprobación para lo destructivo/fuera de sandbox).
El engine emite un `warning` explícito: *"Permisos Codex son aproximados; la lista granular de `allow/ask/deny` de Claude no tiene equivalente 1:1. La protección real la da el hook guard-destructive."*

### DT-6 — Comando del MCP server engram (gap resuelto)
Hoy `engram/plugin.json` NO declara el comando de arranque del MCP server (Claude lo instala vía `claude plugin install engram`). Codex necesita `command`/`args` explícitos. **Decisión:** agregar a `plugin.json` un campo engine-agnóstico `mcpServer: { command, args, env? }`. El valor exacto se confirma en Fase 0 (`engram --help`). El engine Claude lo ignora (sigue con su vía actual); el engine Codex lo emite como `[mcp_servers.engram]`. Si un plugin no declara `mcpServer`, el engine Codex lo omite y emite un warning.

### DT-7 — Subagentes → `[agents.<role>]` traducidos del frontmatter
Por cada rol en `CORE_AGENTS` habilitado (misma condición `isAgentEnabled`), se emite una tabla `[agents.<id>]` en `config.toml` con: `model` (de `config.models.<id>`), `reasoning` (de `config.effort.<id>`), y `description` (del frontmatter del asset). El **cuerpo/protocolo** del rol NO se duplica en TOML: se referencia el `AGENTS.md` (que ya contiene el bloque de orquestación). Paridad de comportamiento sin duplicar prosa.

---

## 4. Fase 0 — Spike de verificación (BLOQUEANTE)

**Requisito:** Codex CLI ≥ v0.145.0 instalado (`codex --version`). Si no está, instalarlo o pedir a Ulises que lo haga (`! npm i -g @openai/codex` o el canal que use).

Verificar 3 incógnitas y **anotar los resultados en la sección "Resultados Fase 0" al final de esta spec** antes de continuar:

1. **Shape del payload de `PreToolUse` en Codex.** Crear un hook temporal que vuelque el stdin:
   ```bash
   mkdir -p /tmp/codex-spike/.codex/hooks
   cat > /tmp/codex-spike/.codex/hooks/dump.sh <<'EOF'
   #!/usr/bin/env bash
   cat > /tmp/codex-spike/payload.json
   exit 0
   EOF
   chmod +x /tmp/codex-spike/.codex/hooks/dump.sh
   cat > /tmp/codex-spike/.codex/config.toml <<'EOF'
   [[hooks.PreToolUse]]
   matcher = "Bash"
   [[hooks.PreToolUse.hooks]]
   type = "command"
   command = "bash /tmp/codex-spike/.codex/hooks/dump.sh"
   EOF
   # correr codex en ese dir y disparar un comando Bash trivial (ej. pedirle `ls`)
   ```
   **Anotar:** ¿el comando viene en `.tool_input.command`? ¿otra ruta JSON? Esto define la rama nueva de `extract_cmd()` (DT-4).

2. **Skills project-level.** Confirmar que Codex descubre `.codex/skills/<id>/SKILL.md` versionado en el repo (no solo `~/.codex/skills/`). Comando: colocar un `SKILL.md` mínimo en `/tmp/codex-spike/.codex/skills/hello/SKILL.md` y verificar con `codex` (slash `/skills` o el listado de skills) que aparece. **Anotar** la ruta correcta si difiere (`.agents/skills/` es la alternativa documentada).

3. **Comando del MCP server engram (DT-6).** `engram --help` (o `engram mcp --help`). **Anotar** `command` + `args` exactos para arrancar el server MCP por stdio.

> **Gate Fase 0:** no continuar hasta tener los 3 valores anotados. Si (1) o (2) revelan una incompatibilidad grave (p.ej. Codex no lee hooks/skills del repo), **detener y reportar a Ulises** — cambia el diseño.

---

## 5. Fase 1 — Registro del engine (andamiaje)

**Archivos a tocar (4) + 1 nuevo:**

### 1.1 `packages/cli/src/lib/schema.ts` (línea 4)
```
ANTES:   const ENGINES = ["claude", "agents-md", "cursor", "copilot"] as const;
DESPUÉS: const ENGINES = ["claude", "agents-md", "cursor", "copilot", "codex"] as const;
```

### 1.2 `packages/cli/src/lib/detect.ts` (función `detectExistingEngines`)
```
ANTES:
  if (existsSync(join(cwd, ".github", "copilot-instructions.md"))) found.push("copilot");
  return found;
DESPUÉS:
  if (existsSync(join(cwd, ".github", "copilot-instructions.md"))) found.push("copilot");
  if (existsSync(join(cwd, ".codex"))) found.push("codex");
  return found;
```

### 1.3 `packages/cli/src/lib/health.ts` (~línea 164, tras el walk de `.claude/skills`)
```
DESPUÉS de:
  for (const file of collectMarkdownRecursive(cwd, ".claude/skills")) files.push(file);
AGREGAR:
  for (const file of collectMarkdownRecursive(cwd, ".codex/skills")) files.push(file);
```
(`AGENTS.md` ya está cubierto en el array de líneas 160.)

### 1.4 `packages/cli/src/commands/render.ts`
Import (tras la línea 11 `renderCopilotEngine`):
```ts
import { renderCodexEngine } from "../engines/codex/index.ts";
```
En el map `PROSE_ENGINES` (tras la línea `copilot: ...`):
```ts
    codex: (c, cfg, o) => renderCodexEngine(c, cfg, o),
```
> Nota: el nombre `PROSE_ENGINES` queda ligeramente impreciso (codex no es prose), pero el contrato es solo "devuelve `{written,skipped,warnings,backupPath}`", que el engine codex cumple (DT-1). No renombrar el map en esta fase.

### 1.5 NUEVO `packages/cli/src/engines/codex/index.ts` (esqueleto)
```ts
import type { NavoriConfig } from "../../lib/config.ts";
import { effectiveConfig } from "../../lib/config.ts";
import type { ProseEngineResult } from "../shared/prose-harness.ts";

/**
 * Codex engine adapter — full parity with the Claude engine, retargeted to
 * Codex's locations: AGENTS.md (root), .codex/skills/<id>/SKILL.md,
 * .codex/config.toml ([agents]/[mcp_servers]/[[hooks]]/sandbox), .codex/hooks/*.sh.
 * Returns the ProseEngineResult shape so it plugs into renderNonClaudeEngines.
 */
export function renderCodexEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): ProseEngineResult {
  const config = effectiveConfig(inputConfig);
  const written: ProseEngineResult["written"] = [];
  const skipped: ProseEngineResult["skipped"] = [];
  const warnings: string[] = [];
  // Fases 2-5 rellenan este cuerpo. Por ahora, no-op verificable.
  void config;
  void cwd;
  void options;
  return { written, skipped, warnings, backupPath: null };
}
```

**VERIFICAR Fase 1:**
```bash
cd "packages/cli" && pnpm build          # compila sin errores de tipos
cd "packages/cli" && pnpm test           # suite verde (nada roto)
# el engine 'codex' ya es un valor válido de config.engines y no rompe render
```

---

## 6. Fase 2 — `AGENTS.md` con orquestación (paridad de contexto)

El `AGENTS.md` que hoy emite `agents-md` **omite** el bloque `orquestacion` (prose-harness línea 127). Codex SÍ tiene subagentes, así que para paridad debe incluirlo. Se parametriza el builder compartido.

### 2.1 `packages/cli/src/engines/shared/prose-harness.ts`
Firma de `buildHarnessProse` (línea 108):
```
ANTES:
export function buildHarnessProse(
  config: NavoriConfig,
  repoRoot: string,
  isWorkspace: boolean,
): string {
DESPUÉS:
export function buildHarnessProse(
  config: NavoriConfig,
  repoRoot: string,
  isWorkspace: boolean,
  opts: { includeOrchestration?: boolean } = {},
): string {
```
Filtro de `ruleBlocks` (línea 122-130), condicionar la exclusión de `orquestacion`:
```
ANTES:  e.asset.id !== "orquestacion" &&
DESPUÉS: (opts.includeOrchestration === true || e.asset.id !== "orquestacion") &&
```
> El engine `agents-md`/`cursor`/`copilot` llama sin `opts` → comportamiento idéntico (regresión cero). El engine codex llamará con `{ includeOrchestration: true }`.

### 2.2 En `engines/codex/index.ts`, emitir AGENTS.md
Reutilizar el patrón de `renderProseFile` PERO llamando a `buildHarnessProse(config, repoRoot, isWorkspace, { includeOrchestration: true })`. Como `renderProseFile` no acepta ese flag, el engine codex construye el AGENTS.md con su propia llamada a `injectManagedSection` (copiar el cuerpo de `renderProseFile` líneas 195-249, cambiando solo la llamada al builder). destRelPath = `"AGENTS.md"`, managedId = `"navori-codex-agents"`, header = `"# AGENTS.md\n"`.

**VERIFICAR Fase 2:**
```bash
cd "packages/cli" && pnpm build && pnpm test
# En un repo de prueba con engines:["codex"] y un preset con orquestación:
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba
grep -q "orquesta" /ruta/repo-prueba/AGENTS.md && echo "OK: orquestación presente"
# Y confirmar regresión cero en agents-md:
grep -L "orquesta" /ruta/repo-prueba-agentsmd/AGENTS.md   # NO debe contener el bloque
```

---

## 7. Fase 3 — Skills a `.codex/skills/<id>/SKILL.md`

Replicar los pasos 3-4-4b-6.5-6.6 del engine Claude (`claude/index.ts` líneas 638-828), cambiando **solo** `destRelPath`:
- core skills + workflow skills: asset `skills/<id>.md` → dest `.codex/skills/<id>/SKILL.md`
- preset extras (skills): `extra.relPath` → dest `.codex/skills/<basename-sin-.md>/SKILL.md`
- library skills: asset `lib-skills/<id>.md` → dest `.codex/skills/<id>/SKILL.md`

Usar `renderManagedFile` (de `engines/claude/render-managed-file.ts`) con `commentStyle: "html"`, `managedId: "<id>-base"` (mismos ids que Claude para consistencia del anti-retroceso), `meta = { source: "@navori/core", version: readCliVersion() }`. Dedup por destino con un `Set` igual que `renderedSkillDests`.

> **No dupliques la lógica**: extrae un helper compartido si el copy-paste dispara el gate jscpd (ver Quality gate). Opción limpia: exportar una función `collectSkillTargets(config, repoRoot): Array<{assetRoot, assetRelPath, destRelPath, managedId, exec}>` reutilizable por ambos engines, parametrizada por el prefijo de destino (`.claude/skills/<id>.md` vs `.codex/skills/<id>/SKILL.md`).

**VERIFICAR Fase 3:**
```bash
cd "packages/cli" && pnpm build && pnpm test
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba --apply
test -f /ruta/repo-prueba/.codex/skills/verify-before-done/SKILL.md && echo "OK skill dir"
head -5 /ruta/repo-prueba/.codex/skills/verify-before-done/SKILL.md   # frontmatter name == verify-before-done
# idempotencia: segundo render no debe reportar cambios
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba   # "up to date"
```

---

## 8. Fase 4 — `.codex/config.toml` (agents + hooks + mcp + sandbox)

### 4.1 NUEVO `packages/cli/src/engines/codex/build-config-toml.ts`
Función pura `buildCodexConfigToml(config, plugins, repoRoot): string` que devuelve el **cuerpo managed** (sin marcador; el marcador lo pone `injectManagedSection`). Contenido, en este orden:

```toml
# --- sandbox / permisos (DT-5, aproximado) ---
sandbox_mode = "workspace-write"
approval_policy = "on-request"

# --- subagentes (DT-7), uno por rol habilitado ---
[agents.leader]
model = "<config.models.leader | default>"
reasoning = "<config.effort.leader | default>"
description = "<del frontmatter del asset agents/leader.md>"
# ... resto de CORE_AGENTS habilitados ...

# --- hooks (DT-4) ---
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "bash .codex/hooks/guard-destructive.sh"
timeout = 10
# quality-gate SOLO si config.qualityGate.fast:
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "bash .codex/hooks/quality-gate-pre-commit.sh"
timeout = 180

# --- MCP (DT-6), por plugin habilitado que declare mcpServer ---
[mcp_servers.engram]
command = "<plugin.json#mcpServer.command>"
args = [ ... ]
```

Reglas de traducción (deterministas):
- Modelos: mapear `config.models.<role>` (`opus|sonnet|haiku`) al nombre de modelo que Codex espere. **Confirmar en Fase 0** el nombre exacto; si Codex usa modelos OpenAI, definir un mapa fijo `models.ts` (ej. `opus→gpt-5.x-high`, etc.) — **decisión de Ulises requerida aquí**, ver Riesgo R3. Si no hay decisión, omitir `model` y dejar que Codex use su default (emitir warning).
- `reasoning` de `config.effort.<role>` (`low|medium|high|max`). Codex acepta niveles de reasoning; mapear directo si coinciden, si no, mapa fijo.
- Las descripciones se extraen parseando el frontmatter del asset con `parseAsset` (ya existe, `engines/claude/parse-asset.ts`).

### 4.2 En `engines/codex/index.ts`, escribir config.toml
```ts
const tomlBody = buildCodexConfigToml(config, enabledPlugins, repoRoot);
const destPath = join(cwd, ".codex/config.toml");
const existing = existsSync(destPath) ? readFileSync(destPath, "utf-8") : "";
const injected = injectManagedSection(existing, "codex-config-base", tomlBody,
  { source: "@navori/core", version: readCliVersion() }, "shell");
// backup + atomic write (mismo patrón que renderProseFile líneas 226-248)
```
Cargar plugins con `loadEnabledPlugins(config.plugins).loaded` (mismo helper que el engine Claude, línea 604).

### 4.3 `packages/plugins/engram/plugin.json` — agregar `mcpServer` (DT-6)
Con el valor confirmado en Fase 0:
```json
  "mcpServer": {
    "command": "engram",
    "args": ["mcp"]
  },
```
(ajustar `command`/`args` al resultado real de `engram --help`).

**VERIFICAR Fase 4:**
```bash
cd "packages/cli" && pnpm build && pnpm test
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba --apply
# TOML válido:
python3 -c "import tomllib,sys; tomllib.load(open('/ruta/repo-prueba/.codex/config.toml','rb')); print('OK toml')"
grep -q "guard-destructive" /ruta/repo-prueba/.codex/config.toml && echo "OK hook guard"
grep -q "\[agents.leader\]" /ruta/repo-prueba/.codex/config.toml && echo "OK agents"
# idempotencia
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba   # "up to date"
```

---

## 9. Fase 5 — Hooks compartidos en `.codex/hooks/`

### 5.1 En `engines/codex/index.ts`, emitir los 2 hooks
Mismo patrón que Claude (líneas 699-735), con `destRelPath` = `.codex/hooks/guard-destructive.sh` y `.codex/hooks/quality-gate-pre-commit.sh`, `chmodExec = true`, `commentStyle = "shell"`, `managedId = "guard-destructive-base"` / `"qg-pre-commit-base"`. quality-gate solo si `config.qualityGate?.fast`.

### 5.2 `packages/core/core-assets/hooks/guard-destructive.sh` y `quality-gate-pre-commit.sh` — rama Codex en `extract_cmd()`
Con el shape confirmado en Fase 0. Ejemplo (AJUSTAR a lo anotado en Fase 0 — si Codex usa `.tool_input.command`, **no hace falta cambio**):
```bash
  # (dentro de extract_cmd, tras el intento node y antes del sed fallback)
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.tool_input?.command ?? j?.<RUTA_CODEX> ?? ""))}catch{}})' 2>/dev/null && return 0
  fi
```
> Si Fase 0 confirmó que Codex usa la MISMA ruta `.tool_input.command`, **saltar 5.2** (el script ya sirve tal cual) y anotarlo.

**VERIFICAR Fase 5:**
```bash
cd "packages/cli" && pnpm build && pnpm test
node ./packages/cli/dist/index.js render --cwd /ruta/repo-prueba --apply
test -x /ruta/repo-prueba/.codex/hooks/guard-destructive.sh && echo "OK ejecutable"
# Prueba funcional REAL en Codex (paridad de comportamiento):
cd /ruta/repo-prueba && codex   # pedirle un `rm -rf` de prueba en dir temporal → el hook debe BLOQUEAR
```

---

## 10. Fase 6 — Tests, verificación end-to-end y rollout

### 6.1 Tests unitarios (NUEVO `packages/cli/src/engines/codex/__tests__/render-codex.test.ts`)
Espejo de `render-agents-md.test.ts` + casos propios:
- first render crea AGENTS.md + `.codex/skills/*/SKILL.md` + `.codex/config.toml` + `.codex/hooks/*.sh`
- idempotencia (segundo render = `unchanged`)
- modelo híbrido: editar la zona user de `config.toml` (fuera del marcador) → re-render la preserva
- version-bump sin truncación (regresión del bug #129)
- `config.toml` es TOML parseable
- engram habilitado → `[mcp_servers.engram]` presente; engram deshabilitado → ausente
- `includeOrchestration`: AGENTS.md de codex contiene `orquestacion`, el de agents-md NO

### 6.2 Test e2e (`cli.e2e.test.ts`)
`init` con `engines:["codex"]` en repo limpio → estructura esperada en disco.

### 6.3 Verificación real (skill `verify` del repo)
En 1 repo Bonum real con Codex instalado: `/skills`, `/subagents`, `/hooks` en Codex reconocen lo generado; un skill se invoca; el hook bloquea un destructivo.

### 6.4 Rollout
- Bump + release (ver memoria [Proceso de release de navori]).
- Repos que quieran Codex: agregar `"codex"` a `engines[]` en su `navori.config.json`.
- `navori render --all --apply` para propagar.

**VERIFICAR Fase 6 (quality gate final):**
```bash
cd "packages/cli" && pnpm test    # TODO verde, incluye los nuevos tests codex
# doctor limpio en el repo de prueba:
node ./packages/cli/dist/index.js doctor --cwd /ruta/repo-prueba
```

---

## 11. Quality gate (obligatorio antes de cerrar cada PR)
```bash
cd packages/cli && pnpm test
cd packages/cli && pnpm build
# gates de duplicación/estáticos del repo (jscpd/semgrep) si aplican al CI
```
Si el gate jscpd marca duplicación entre `claude/index.ts` y `codex/index.ts`, extraer el helper compartido de la Fase 3 (`collectSkillTargets`) y/o de emisión de hooks.

## 12. Riesgos y su mitigación
- **R1 — Payload de hooks distinto (DT-4).** Mitigado por Fase 0 + rama en `extract_cmd`. Bajo riesgo (parser ya extensible).
- **R2 — Skills/hooks/config del repo no reconocidos por Codex.** Mitigado por Fase 0 (gate). Si falla, es rediseño → reportar.
- **R3 — Nombres de modelo Codex ≠ `opus|sonnet|haiku`.** Requiere **decisión de Ulises** sobre el mapa `models.ts` (Fase 4.1). Fallback seguro: omitir `model`, usar default de Codex + warning.
- **R4 — Permisos aproximados (DT-5).** Aceptado y declarado por warning; la protección real es el hook.
- **R5 — Deriva de formato de Codex.** Fijar versión mínima soportada (v0.145.0) y documentarla en el README del engine.

## 13. Estimación
~6–8 días. Reparto: Fase 4 (config.toml: agents+hooks+mcp+sandbox) ≈ 50% (único código genuinamente nuevo). Fases 2/3/5 son mayormente reutilización. Fase 1 y 6 son mecánicas.

---

## Resultados Fase 0 (COMPLETA — spike ejecutado contra Codex CLI v0.145.0, 2026-07-27)

**Método:** repos de prueba efímeros + `codex exec --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`. Payload de hook capturado volcando stdin a archivo; discovery de skills verificado pidiendo al modelo listar sus skills SIN leer archivos.

- **Payload PreToolUse Codex:** el comando viene en **`.tool_input.command`** — ruta JSON **idéntica a Claude**. Payload real:
  ```json
  { "hook_event_name": "PreToolUse", "tool_name": "Bash",
    "tool_input": { "command": "echo ..." }, "cwd": "...",
    "session_id": "...", "turn_id": "...", "tool_use_id": "...",
    "permission_mode": "bypassPermissions", "model": "gpt-5.6-sol" }
  ```
  → **Consecuencia: la Fase 5.2 se ELIMINA.** El `extract_cmd()` de los hooks ya lee `.tool_input.command`; un solo asset sirve a ambos engines sin cambios. DT-4 se cumple con cero código nuevo en el shell.

- **Ruta de skills project-level válida:** **AMBAS** funcionan con discovery **nativo** (aparecen en la lista de skills inyectada sin leer archivos): `.codex/skills/<id>/SKILL.md` **y** `.agents/skills/<id>/SKILL.md`. **El adapter que shipeó usa `.agents/skills/<id>/SKILL.md`** — la ubicación cross-tool universal que otros agentes también leen (config.toml + hooks + agents siguen bajo `.codex/`). Formato de skill confirmado: dir-por-skill `<id>/SKILL.md` con frontmatter `name:` == `<id>`. Nota: es un split-root (skills en `.agents/`, resto en `.codex/`) — revisable si se prefiere consolidar todo bajo `.codex/`.

- **Comando MCP engram:** `command = "engram"` (o path absoluto `/opt/homebrew/bin/engram`), `args = ["mcp", "--tools=agent"]`. Verificado además en el `~/.codex/config.toml` real del usuario (ya lo usa así). El perfil `agent` = 15 tools; default (sin `--tools`) = 19.

- **Nombres de modelo Codex (R3):** modelos disponibles en la instalación: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. Default del usuario: `gpt-5.6-sol` + `model_reasoning_effort = "medium"`. **DECISIÓN DE ULISES PENDIENTE** sobre el mapa `opus|sonnet|haiku → gpt-5.6-*`. `reasoning_effort` válidos: `low|medium|high` seguros; `max`/`xhigh` aceptados a nivel config; `minimal` lo rechaza el modelo actual.

### Hallazgos extra (no previstos en la spec)
- **Eventos de hook Codex** son más ricos que solo PreToolUse: se observaron `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`. Amplía la paridad de hooks (oportunidad futura).
- **Hook trust:** Codex exige confianza persistida de los hooks (o `--dangerously-bypass-hook-trust`). **Detalle de rollout obligatorio a documentar:** en un repo con hooks generados por navori, el usuario debe aprobar/confiar los hooks la primera vez que corre Codex, o los hooks no disparan.
- **Config del repo:** confirmado que Codex lee y mergea `<repo>/.codex/config.toml` + `<repo>/.codex/hooks/*.sh` (no solo `~/.codex/`). El diseño de la spec es válido.

### Gate Fase 0: ✅ PASADO — ninguna incompatibilidad grave. Se puede proceder a Fase 1.
