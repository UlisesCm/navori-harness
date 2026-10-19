> [English](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.md) | [Español](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.es.md) | [简体中文](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.zh-CN.md)

# navori

面向 Claude Code（及其他 AI 引擎）的多代理 harness 与 SDD 脚手架。

`navori` 只需一条命令，就能将你的 Claude Code 配置（agents、skills、hooks、`CLAUDE.md` 和 `AGENTS.md`）带到多个仓库，同时保留本地自定义内容和已有工作。

它还会渲染完整的 Codex harness：`AGENTS.md`、位于
`.agents/skills/` 的 skills、位于 `.codex/` 的 agents 和 hooks，以及项目级 MCP 配置。

## 引擎配置方案

```jsonc
// Paridad completa para ambos proveedores
{ "engines": ["claude", "codex"] }

// Claude completo + guía AGENTS.md ligera para Codex y otras herramientas
{ "engines": ["claude", "agents-md"] }

// Solo guía universal, con el menor número de archivos
{ "engines": ["agents-md"] }

// Solo Pi (opt-in; ver docs/pi.md)
{ "engines": ["pi"] }
```
`codex` 已包含并管理 `AGENTS.md`，无需再与 `agents-md` 组合。如果配置中同时包含两者，Codex adapter 会优先处理，以避免区块重复。

## 安装

```bash
npm i -g navori
# o sin instalar
npx navori init
```
## 快速开始

```bash
# Modo opinado: cero preguntas, harness completo sin instalar software externo
# (engram siempre activo, +gh si el repo tiene remote de GitHub).
# Avisa si falta el binario de algún plugin habilitado y cómo instalarlo.
cd ~/tu-repo
navori init --recommended

# + proveedores externos (tgrep, acli) + pre-commit hook +
# scan-monorepo + project block estricto — requiere instalar los binarios de esos proveedores.
# También avisa si falta algún binario y cómo instalarlo, sin instalarlo nunca.
navori init --full

# O wizard interactivo con detección de stack
navori init
```
`init` 会自动检测仓库中的以下信息：
- **项目名称**（来自 `package.json`、`pyproject.toml`、`Cargo.toml`、git remote 或目录名）
- **技术栈**：框架（Next.js、Vite、NestJS、Express、Astro 等）、UI、表单、状态管理和测试工具
- **建议预设**（根据技术栈，例如 `vite-react-ts-mantine`、`nextjs`、`express-mongoose`）
- **Quality gate**（由 `package.json` 中的脚本组成）
- **Git 基础分支**（`origin/HEAD`，否则依次回退到 main/master/develop）
- **现有 Claude 配置**（`.claude/`、`CLAUDE.md`、`AGENTS.md`、agents、skills），并提供共存或备份后替换的选项

并生成：
- `navori.config.json` — 仓库配置的事实来源
- `CLAUDE.md` — CLI 持续同步其中的 managed blocks
- `.claude/` — agents、skills、hooks 和 settings

## 可选更新提示

在交互式命令中，如果 Navori 检测到新版本，会显示更新提示。npm registry 查询在后台运行，不会阻塞命令。因此，首次运行只会开始填充缓存，提示可能要到之后的某次运行才出现。每 24 小时最多查询并提示一次。CI、JSON 模式以及 help 和 version 命令中不会显示提示。

要禁用提示，请设置 `NAVORI_NO_UPDATE_NOTIFIER=1`。提示会根据检测到的安装方式建议更新命令，并以 `npx` 作为替代方案。它不会自动安装或更新 Navori，也不会运行 `render`。更新 Navori 后，运行 `navori render --apply` 将更改应用到 harness。

### 插件工具更新提示

像 `engram` 这样的插件可以在其清单中声明 `latestRelease` 以接收
当插件有新版本时显示提示。提示会出现在启动上下文的末尾，占用预留的 300 个字符；每个版本每 24 小时最多显示一次。

执行查询：
- **来源**：`api.github.com/repos/<owner>/<repo>/releases/latest` 或
  `registry.npmjs.org/<package>/latest`（没有令牌，只是 `navori/<version>` 用户代理）
- **频率**：每个工具每天最多请求一次，并通过 lock 预留请求名额
- **网络**：网络请求由后台 detached worker 执行；session
  不会等待
- **缓存**：`~/.navori/tool-versions/`（与 `~/.navori/update-notice/` 类似）
- **CI**：不访问网络，也不刷新缓存或显示提示

同时禁用 Navori 的更新提示：`NAVORI_NO_UPDATE_NOTIFIER=1`。

**限制：**
- Codex 在无网络的 sandbox 中不会刷新缓存或显示提示。
- Pi 没有 session hooks，因此更新提示只会出现在 `navori doctor` 中。
- 如果提示超出预留空间，会显示指向 `navori doctor` 的说明，并在下次 session 重试（不会标记为已送达）。
- `doctor` 将所有消息显示为信息行，而不应用 `--strict`。

如果进程突然退出后提示仍被 lock 阻塞，只有当 lock 持续超过一分钟时才需要处理。此时停止所有 `navori` 进程，再删除 `~/.navori/tool-versions/lock` 或 `~/.navori/update-notice/lock`；保留这两个目录中的缓存文件。

## 命令

| 命令 | 功能 |
|---|---|
| `init` | 自动检测并通过向导初始化仓库（也可用 `--recommended` 跳过提问且不安装外部软件，或用 `--full` 添加外部 provider 和严格策略）。 |
| `add <plugin>` | 启用插件，并可选择安装其外部工具。 |
| `remove <plugin>` | 停用插件，并清理其 managed blocks、子区块和脚本。 |
| `configure <section>` | 无需重新运行向导即可调整配置的某个部分。 |
| `adopt <path>` | 将手动编写的 `.claude/` 文件纳入 Navori 管理：添加 managed block 包装，但不重写内容（默认预览）。 |
| `refresh` | 一步完成仓库重新检测、配置刷新和同步。 |
| `update` | 从 npm 更新 Navori，然后用新二进制运行 `refresh`（参见[更新 Navori](#更新-navori)）。 |
| `render` | 为每个已配置引擎生成原生文件（默认预览；`--apply` 写入）。`--all` 渲染全局注册表中的所有仓库；`--prune` 清理已不存在的仓库。 |
| `registry <sub>` | 管理 `render --all` 使用的 Navori 仓库全局注册表（`ls`、`scan <dir>`、`add`、`remove`、`prune`）。 |
| `sync` | 通过冲突解决和备份刷新所有已配置的引擎。区块冲突可用 `--interactive` 逐项解决（查看 diff 并选择 keep-mine / accept-new），也可用 `--accept-new` / `--keep-mine` 批量处理。交互模式会逐个解决没有标记的完整文件（查看 diff 并选择 keep / accept）；`--accept-new-files` 会一次接受所有可解决文件。 |
| `preset init <id>` | 在 `.navori/presets/<id>/` 中搭建本地预设。 |
| `scan` | 检测 monorepo 中的新 workspace（`pnpm-workspace.yaml` / `package.json#workspaces`）。 |
| `doctor` | 检查配置、每个 managed block 的漂移（`CLAUDE.md` **和 `AGENTS.md`**）、规范顺序、格式错误的标记、monorepo 不同步和缺少的外部工具（CI 使用 `--strict`）。已安装版本的已知问题（`externalTool.versionAdvisory`）和新工具版本提示（`navori tools notice`）仅作信息展示，不影响 `--strict`。 |
| `status` | 快速查看配置、启用的插件、漂移数量和后续步骤。 |
| `audit` | 报告 harness 的实际运行情况：token 归属、遵循情况缺口、review 和 receipt 结果、工具在不同时间窗口内的可用性，以及每个已接受任务的效率和生命周期。`--snapshot` 保存指定范围的命名快照；`--compare` 按 cohort 与另一快照比较，并提供原因和证据。 |
| `gate <fast\|full>` | 运行 `qualityGate.fast` 或 `qualityGate.full`，将完整输出写入日志（`.navori/state/gate/`），仅向 stdout 输出简洁判定。参数：`--cwd <path>`。 |
| `receipt <sub>` | 发布前为已审阅的字节生成 receipt：`sign`（`--feature <id>`、`--gate-ran scoped\|full`、`--spec <dir> --milestone <Mn>` 或 `--phase <name\|index>`）、`check`、`gate --spec <dir> --milestone <Mn>` 或 `--phase <name\|index>`（决定里程碑使用范围受限还是完整质量门），以及 `review begin` / `review seal --nonce <n>`（带内容标识的 review sidecar）。通用参数：`--target <ref>`、`--dir <path>`、`--json`。 |
| `spec <classify\|check> <feature>` | `classify` 根据 `sdd.deliveries` 阈值判断 spec 应在一个 PR 中交付，还是每个 delivery 一个 PR；`check` 验证其 `tasks.md`：里程碑、标准、覆盖情况和纵向交付。参数：`--cwd`、`--json`。 |
| `tools notice [--ack <pluginId@x.y.z,…>]` | 为启动 hook 发出待处理的外部工具版本提示；`--ack` 将它们标记为已送达。 |
| `handoff <check\|log-review>` | `check` 在派遣下一个 agent 前验证 implementer 的 handoff（`impl_<feature>.json`）；`log-review <feature>` 验证 `review_<feature>.json`，并将 score >= 50 的 findings 追加到 `findings.jsonl`（`navori handoff check <feature> [--for scribe] [--produced-by reviewer [--since <iso>]] [--dir <path>] [--cwd <checkout>] [--json]`）。 |
| `plan <sub>` | 分级规划（`harness.planTiers`）：`classify [--files\|--diff]` 衡量任务复杂度和级别；`render`/`update` 保持 Markdown workplan 与 JSON 同步；`check` 验证其 schema 和规则；`gate` 是 `PreToolUse(Agent)` hook，会拒绝没有有效 workplan 的 dispatch。 |
| `master <sub>` | 分阶段 master plan 引导流程（`init`、`ux`、`mode`、`template`、`check`、`advance`、`status`、`part`、`close`）及其分项交付：`delivery-slice`、`delivery-check`、`delivery-baseline`、`delivery-queue`、`delivery-criterion`、`delivery-review`、`delivery-present`、`delivery-decision`、`delivery-publication`、`delivery-revoke`。用于授权或批准的命令需要 `--approved-by`。 |
| `bench` | 以 dry-run 模式运行 N 次 `render` 并报告延迟，用于检测本地回归。 |
| `workspace <sub>` | 管理跨仓库 workspace（`init`、`ls`、`show`、`link`、`add-repo`、`set-default`、`render`、`rename`、`delete`）。 |
| `ticket <sub>` | 在 workspace 中以文件形式管理 tickets（`new`、`list`、`show`、`archive`、`delete`）。 |
| `dominio <sub>` | 管理持久的 workspace 知识库（`init`、`list`、`show`、`reindex`、`doctor`、`inject`）。 |
| `codex <sub>` | Codex 专用命令；目前 `trust` 用于批准 `~/.codex/config.toml` 中的项目 hooks。 |
| `backup <sub>` | 列出并恢复 `~/.navori/backups/` 中的备份。 |
| `migrations <sub>` | 列出并恢复 `~/.navori/migrations/` 中的迁移。 |

## 预设

除了核心之外，预设还提供特定于堆栈的技能和规则。 `init` 根据其检测到的内容提出建议。

**官方预设（包含）：**

|预设|堆栈|
|---|---|
| `vite-react-ts` | Vite + React + TS（SPA，不绑定特定 UI 库）|
| `vite-react-ts-mantine` | Vite + React + TS + Mantine（SPA）|
| `nextjs` | Next.js（应用程序路由器）|
| `react-native-expo` | React Native + Expo（移动应用）|
| `astro` | Astro（静态/SSR）|
| `nestjs` | NestJS（后端）|
| `express` | Express（后端，与数据库无关）|
| `express-mongoose` | Express + Mongoose（后端）|
| `fastapi-python` | FastAPI（后端，Python）|
| `bun-keystone` | Keystone 6 + Prisma（后端，Bun）|
| `background-worker` |后台 worker（任务和队列：agenda / bullmq / amqplib）|
| `medusa` | Medusa.js v2（后端）|
| `monorepo-turbopnpm` | Monorepo 与 Turborepo + pnpm 工作区 |

**中性预设**（`vite-react-ts`、`express`）提供通用技术栈 skills，不会把你绑定到某个库；专用预设（`…-mantine`、`…-mongoose`）会在此基础上增加对应层的 skills。**你的技术栈没有官方预设？**没关系。`init` 仍会安装完整 harness（agents、质量门、协议、SDD），你可以立即使用，只是没有该技术栈的专用 skills。`init` 会发出提示，保留基线配置（`preset: custom`），并建议用本地 preset 填补空缺。

**本地预设** — 在仓库的 `.navori/presets/<id>/` 下创建并纳入版本控制：

```bash
navori preset init sveltekit
# ✓ .navori/presets/sveltekit/  (manifest + managed/stack.md + skills/)
# ✓ navori.config.json → preset: sveltekit
# → edita las plantillas y corre 'navori render --apply'
```
解析顺序为**本地 → 内置**：如果本地预设与官方预设使用相同 id，本地预设优先。这样可以覆盖内置预设，而无需修改软件包。

## 可用插件

| 插件 | 用途 | 外部工具 |
|---|---|---|
| `engram` | 跨 session 的持久记忆 | `engram` 二进制 |
| `codegraph` | 通过 MCP 进行代码结构发现；需显式启用（不包含在 `--full` 中） | `codegraph` 二进制 |
| `tgrep` | 通过带索引的 CLI 进行文本代码发现 | `tgrep` 二进制 |
| `acli` | 在终端中读取 Jira tickets | `acli` |
| `gh` | GitHub Issues、PR 和 workflow runs | `gh` |

> `codegraph` 和 `tgrep` 于 2026-09-15 短暂退役，并于
> 2026-09-16 重新引入（#838），通过集成实现协同工作——详见
> [`docs/research/tgrep-como-funcionaba.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/research/tgrep-como-funcionaba.md)。

启用插件：

```bash
navori add engram          # te ofrece instalar la tool externa si falta
navori add engram --skip-install   # solo registra el plugin
```
## 分级规划（`harness.planTiers`）

通过 `navori.config.json` 中的 `harness.planTiers: true`，`navori plan classify` 测量
任务复杂度（依据资金/凭证/PII、新依赖、schema 迁移或涉及
`project.criticalPaths` 路径等信号）并将其划分为 0–3 级。`PreToolUse(Agent)` hook
（`navori plan gate`）会拒绝派遣缺少对应级别 workplan 的子代理，并在连续两次
拒绝后提高要求。如果缺少 `navori` 或当前构建没有 `plan` 子命令，hook 不会给出判定；
在会显示提示的模式下，它会请求确认，而不是让用户无路可走（`bypassPermissions`、
`dontAsk` 和 `plan` 模式仍会阻断）。`navori plan classify --diff` 会针对
`git diff --name-only <base>...HEAD` 运行同一分类器，并在工作超出 workplan 声明的级别时发出警告。

`project.criticalPaths`（glob 数组）是可选的。没有它时，`classify` 只有在通过
`--criticalArea` 显式声明“涉及关键区域”后才会识别该条件，不会从变更文件中自行推断。

`architect` agent 不再使用 `harness.architect` 标志，而是始终渲染。可通过
`models.architect`/`effort.architect`（默认 `opus`/`xhigh`）调整其 tier。配置中若仍有
`harness.architect`，会报已弃用键警告并失败，而不是静默忽略；`navori configure migrate` 会删除该键。

## 规格交付 (`sdd.deliveries`)

大型 spec 不一定要在一个 PR 中交付。`navori spec classify <feature>` 会依据
`navori.config.json` 中的 `sdd.deliveries` 阈值（`splitMinTasks`、`splitMinLoc`、
`maxPrsPerSpec`；默认值为 12 个任务、预计 1500 LOC、4 个 PR）判断它应由一个 PR 交付，
还是按 delivery 拆成多个 PR。`navori spec check` 会根据语法验证 `tasks.md`：

- **`E<n>`**：delivery；每个对应一个 PR。
- **`M<n>`**：milestone；逐个验证并分别提交。
- **`T<n>`**：任务；声明其涵盖的 `R<n>`。

完整质量门每个 PR 运行一次，而不是每个 milestone 运行一次。每个 milestone 采用哪种质量门，由 `navori receipt gate` 决定。

## 工作区安全带 (`monorepo.workspaceHarness`)

`monorepo.workspaceHarness` 决定 monorepo 中每个 workspace 获得多少 harness。整个仓库共用一个值：

- `minimal`（默认）：workspace 的 context 文件，以及根目录尚未提供的 skills。与根目录相同的 skill 不会重复。
- `full`：提供全部内容，与裁剪 harness 之前相同。
- `root`：仅提供 workspace 的 context 文件（`CLAUDE.md`；使用 Codex 时还包括 `AGENTS.md`）。根目录会提供声明了 workspace 的 library 和 preset skills。

`navori doctor` 会将 `minimal` 和 `root` 视为精简 harness；值为 `full` 时会发出提示。

## 防御线束（默认只读）

`navori` 生成的 harness 默认采用安全权限策略，减少日常操作中的提示，同时保留对危险操作的防护：

- **读取操作无需确认**：`git status/diff/log/show`、`ls`、`cat`、`grep`、`Read`/`Glob`/`Grep` 等命令都会直接运行，不会打断你。
- **破坏性操作需要确认**（`ask`）：`rm -rf`、`git push --force`、`git reset --hard`、`git clean -f`、`chmod -R` 等。
- **丢弃未提交的工作会被阻止**（`guard-destructive`、exit 2、无法批准）：包括 `git reset --hard`、`git checkout -f`、`git checkout -- .`（或 `git checkout .`）、不带 `--staged` 的 `git restore <paths>`，以及不带 `-n` 的 `git clean -f`。是否阻止取决于仓库状态：工作树干净时没有内容会丢失，命令可以通过。如果无法检查目标目录（例如路径使用变量、替换语法或不存在），也会阻止。提示会说明如何安全处理。
- **`publisher` 不会重写历史**：commit 失败后，它不会运行 `git reset` 或重写提交。它会用 `git status` 和 `git log -1 --stat` 报告情况，由 orchestrator 或用户处理恢复。
- **灾难性操作会被拒绝**（`deny`）：`rm -rf /`、`sudo rm`、`mkfs` 等。
- `guard-destructive` hook 还会提供额外的兜底保护。

**工作树之外的临时状态**：两个 harness hooks（`managed-drift-watch.sh` 和 `routing-watch.sh`）会将状态写入 `<git-common-dir>/navori/`，位于工作树之外，因此 `git status` 看不到。此外，`render` 和 `sync` 会写入带版本控制的 `.claude/.gitignore`，忽略 `progress/`、`worktrees/` 和 `settings.local.json`，避免这些路径显示为未跟踪文件。启用 `codex` 时，还会生成 `.codex/.gitignore`，其中只忽略该目录里的临时文件。已更新的仓库也会忽略旧文件 `.claude/.managed-drift-stamp` 和 `.claude/.routing-watch/`。引擎运行所需的文件不会被忽略。

## Workspace 与跨仓库 tickets

如果一个 ticket 涉及多个仓库（例如前端、后端和微服务），workspace 会提供统一入口：

```bash
# Crear workspace
navori workspace init bonum --description "Bonum platform"

# Registrar repos del workspace
navori workspace add-repo bonum --name webapp --path ~/dev/bonum/webapp --stack vite-react-ts-mantine
navori workspace add-repo bonum --name backend --path ~/dev/bonum/nexus --stack nestjs

# Crear ticket
navori ticket new bonum BNM-123 --title "Checkout flow rebuild"

# En cada repo que toca el ticket, agrega una referencia:
# echo "ticket: BNM-123" >> progress/current.md

# Ver el ticket + en qué repos aparece
navori ticket show bonum BNM-123
```
Workspace 也会保存可继承的默认值：

```bash
navori init --workspace bonum    # hereda engines, plugins, branchBase, etc.

# Ajustar un default sin editar el manifest a mano
navori workspace set-default bonum branchBase main
navori workspace set-default bonum prTarget develop      # PRs van a develop, no a main
navori workspace set-default bonum engines claude,cursor
navori workspace set-default bonum plugins.engram.enabled true
```
一次性重新渲染 workspace 中的所有仓库：

```bash
navori workspace render bonum           # preview (no toca disco)
navori workspace render bonum --apply    # escribe en cada repo
```
数据存储在 `~/.navori/workspaces/<name>/`（manifest、tickets/ 和 backups/）。

## 升级 Navori 后的全局推广

更新 CLI（`npm i -g navori@latest`）后，可以通过全局注册表用一条命令将更改应用到**所有**仓库，无需逐个处理：

```bash
navori render --all            # preview: qué cambiaría en cada repo del registro
navori render --all --apply     # escribe el render nuevo en todos
navori render --all --verbose   # además lista cada bloque managed que cambió, por repo
navori render --all --prune     # además limpia repos que ya no existen
```
输出是一份清晰的报告：标题显示注册表和运行模式（preview/apply）；每个仓库占一行（`created`/`updated`/`conflict`/`removed`/`unchanged`）；通知会**列出**包含手动编辑区块的仓库（此类 conflict 不会被 render 覆盖）；最后提供汇总 `ok · changed · conflict · failed`。

注册表（`~/.navori/registry.json`）会自动填充：每次运行 `navori init` 或
`navori refresh` 都会注册当前仓库。若要加入已安装的仓库，先扫描一次：

```bash
navori registry scan ~/dev ~/otra-carpeta   # registra todo lo que tenga navori.config.json
navori registry ls                          # ver el registro (✓ presente / ✗ missing)
navori registry prune                       # quitar los que ya no existen
```
注册表与 workspace 相互独立：注册表记录“有哪些仓库”；workspace 定义每个仓库继承的策略配置（`branchBase`/`prTarget`）。

## 带版本信息的 managed blocks

`navori` 注入到 `CLAUDE.md` 中的每个块都携带元数据：

```html
<!-- navori:managed id="idioma-rol" hash="3fbef743" version="0.0.1" source="@navori/core" -->
contenido sincronizado
<!-- /navori:managed id="idioma-rol" -->
```
- **`hash`**：检测你是否编辑过区块；`sync` 在覆盖前会发出警告。
- **`version`**：发布新版 `@navori/core` 或插件时，`sync` 会报告“update available”。
- **`source`**：标明区块属于哪个软件包（`doctor` 会显示来源）。

如果您手动修改托管块然后运行 `sync`，您将看到：

```
Conflict in 'idioma-rol':
  - tu versión
  + versión del Core
```

你可以选择 `skip-conflicts`、对 `CLAUDE.md` 区块进行交互式解决，或 `abort`。
完整文件冲突永远不会自动覆盖。

每次 `sync` 前都会自动备份到 `~/.navori/backups/<timestamp>/`，保留 30 天。

## 精细配置

无需重新初始化，只调整一项设置：

```bash
navori configure plugins              # multiselect de plugins activos
navori configure quality-gate         # comandos del quality gate
navori configure language en          # switch a inglés (fallback a es)
navori configure engines              # multiselect: claude / codex / agents-md / cursor / copilot / pi
navori configure branch-base main     # punto de fork / rama protegida
navori configure pr-target develop    # rama destino del PR (gh pr create --base)
navori configure workspace bonum      # asociar a un workspace
navori configure migrate              # renombra claves retiradas (el config vuelve a cargar)
```
当 `harness`/`models`/`effort` 中已弃用的键导致 `navori.config.json` 无法加载时，
`migrate` 是恢复方式。其他命令读取该配置时都会中止，因此 `migrate` 会直接读取原始 JSON、
备份文件并重写它。一对一重命名会自动完成；如果多个已弃用键映射到同一目标且值不同，
Navori 不会猜测——它会询问，或使用 `--scout=<model> --scout-effort=<level>`。
`--dry-run` 不写入；`--all` 会处理整个注册表（除非指定 `--apply`，否则为预览模式）。

## 门和本机挂钩的配置键

- `qualityGate.scoped`（字符串）：reviewer 使用的范围受限检查通道——运行 `full` 中成本较低的检查，以及与 diff 相关的测试。若未设置，则使用 `fast`。它会插入为 `navori.scopedGate`。
- `qualityGate.nativeHooks`（布尔值）：声明项目的原生 pre-commit 已运行 `fast`；`quality-gate-pre-commit` hook 因此只跳过自己的质量门步骤。
- `plugins.<id>.nativeHook`（布尔值）：声明原生 git hook 会运行该插件的检查，因此不注册对应 hook（脚本仍会安装）。

## `progress/current.md` 大小上限

每个 session 都会加载 `progress/current.md`，因此它有大小上限。pre-commit hook 会阻止 agent 提交：如果文件超出硬上限，或已超限时仍继续增长（人工提交不受阻止）。`navori doctor` 使用相同上限按字节测量并发出警告；session-start hook 超过软上限时也会警告，但不会阻止。

## 迁移到 0.12

- `global` 命令和 launchd collector 已移除（`audit --collect` 保留）。`doctor --json` 不再输出 `globalScope`。
- `jscpd` 和 `semgrep` 插件已停用：`navori add jscpd|semgrep` 回应称它们已停用。
- Pi 的最低版本升至 1.1.0：Pi 0.87.x 不再提供 `navori_subagent`。Node.js 最低版本：>= 22.12。
- `navori update` 现在更新 CLI（查询 npm、提交、安装然后运行 ​​`navori refresh`）。以前的行为现在是 `navori refresh`，没有别名：使用 `navori update` 重新同步线束的脚本应更改为 `navori refresh`。
- 使用 `navori render --apply` 迁移（清理由 Navori 管理的已弃用资源），然后运行 `navori doctor`（报告残留项）。

## 在您的存储库中扩展线束

Navori 安装的是基线；让它在**你的**仓库中发挥价值的，是只有你掌握的知识。
有四种存放方式，按每个 session 的文件、review 和 token 成本从低到高排列。
从表格顶部开始：成本最低的选项通常也最有效。

| 你掌握的内容 | 放在哪里 |
|---|---|
| 仓库专属规则（自有模式或数据层约定） | 已覆盖该主题的 skill 的 **user section**。 |
| 已安装 skill 都未涵盖的知识 | **项目本地 skill**。 |
| 可在多个仓库复用的技术栈知识 | **本地 preset**（`navori preset init <id>`）。 |
| 二进制或 MCP server 的封装 | **plugin**（属于 Navori，不属于你的仓库）。 |

**默认使用 user section。** Navori 渲染的每个 skill 都带有 sentinel
`<!-- navori:user-section -->`；你在它后面写的内容归你所有，`render`/`sync` 永远不会修改。
无需新建文件或配置，规则也会留在 agent 本来就会查看的位置。

**项目本地 skill**分两步设置：

```bash
# 1. la forma DIRECTORIO es la única que el host descubre.
#    Un `<id>.md` suelto en .claude/skills/ no se carga nunca.
mkdir -p .claude/skills/mi-skill && $EDITOR .claude/skills/mi-skill/SKILL.md

# 2. declara el id en navori.config.json:
#    "project": { "localSkills": ["mi-skill"] }
navori doctor   # valida que el archivo exista y que su description diga CUÁNDO usarla
```
frontmatter 需要 `name`、`type`（`behavior` \| `reference` \| `tool`）以及带有**激活触发条件**的 `description`。
Host 会读取该描述并按需加载 skill，因此写明“在……时使用”就能让它在正确时机自动生效。
如果缺少触发条件，`navori doctor` 会发出提示；这通常是最值得优先修复的问题，因为内容已经写好。

Navori **绝不会写入**项目本地 skill：它没有 managed block 或 user section，文件完全由你管理。

→ 完整指南（包含使提案更有说服力的四个问题）：
[`docs/EXTENDING.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/EXTENDING.zh-CN.md)。
`SKILL.md` 合约：[`docs/recipes/skill-authoring.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/recipes/skill-authoring.zh-CN.md)。

## 设计理念

- **不干涉你的工作流程。** CLI 负责检测并给出建议，由你决定是否采用。
- **与现有 harness 共存。** `coexist` 模式不会修改已有内容。
- **绝不静默覆盖。** 标记中包含 hash，每次写入前都会备份。
- **默认只读。** 读取操作无需授权；破坏性操作需要确认。
- **输出始终清晰易读。** 提供人类可读文本，也支持通过 `--json` 接入 CI pipeline。
- **支持双语。** schema 支持 `language: es | en`。目前西班牙语（`es`）内容完整；英语（`en`）会明确使用 fallback。

## 许可证

MIT。

## 更新 Navori

`navori update` 会查询 npm 获取 Navori 最新版本，并根据当前安装方式显示对应命令：全局 npm、devDependency、dependency 或 `npx`。确认后（除非设置了 `--yes`），它会安装更新，然后用新二进制运行 `navori refresh`。

- `--cli-only`：更新 CLI 后停止，不运行 `refresh`。
- 无网络或 Navori 已是最新版本：直接运行 `refresh`。
- 安装失败：打印手动执行的命令，并以退出码 1 结束。
- 没有 TTY 且未设置 `--yes`：打印命令，并以退出码 1 结束。
- 仅支持 npm 包管理器。
