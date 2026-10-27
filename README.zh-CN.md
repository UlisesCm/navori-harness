> [English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

<div align="center">

# navori

**面向 Claude Code（及其他 AI 引擎）的多代理 harness 与 SDD 脚手架。**

[![npm](https://img.shields.io/npm/v/navori?color=8b5cf6)](https://www.npmjs.com/package/navori)
[![CI](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/navori)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/navori?color=8b5cf6)](./LICENSE)

</div>

`navori` 只需**一条命令**，就能将你的 Claude Code 配置（agents、skills、hooks、`CLAUDE.md` 和 `AGENTS.md`）带到任何代码仓库，并持续更新，同时保留本地自定义内容和已有工作。

```bash
npx navori init           # wizard con detección de stack
# o, sin preguntas — harness completo sin instalar nada externo:
npx navori init --recommended
# o, + proveedores externos (tgrep, acli) y política estricta:
npx navori init --full
```

`--recommended` 使用你已有的软件运行完整 harness（Engram 始终启用；仓库配置了 GitHub remote 时启用 `+gh`），不会安装任何东西。`--full` 会增加外部 provider（需要你自行安装对应二进制；CodeGraph 仍需选择启用）、严格策略（`posture`/`reviewRigor`/`testsForNewCode`）、必需的 monorepo 扫描，以及必需的 pre-commit hook。

> 📦 npm：[`navori`](https://www.npmjs.com/package/navori) · 📖 CLI 完整参考：[`packages/cli/README.md`](./packages/cli/README.zh-CN.md)

---

## 问题

为 agent 构建一套实用的 harness（专用 agents、skills、hooks、质量门和 SDD 约定）后，这些知识会保存在**一个**仓库的 `.claude/` 和 `CLAUDE.md` 中。要在其他仓库复用，就得复制粘贴；内容变化后再手动同步，久而久之容易过时。

`navori` 让这套 harness **可版本控制且可复现**：签入仓库的 `navori.config.json` 描述项目，CLI 据此重建所有资源。`<!-- navori:managed -->` 之类的标记用于区分 CLI 管理的内容和你自行编辑的部分。

## 它会生成什么

运行 `navori init` 后会生成：

- **`navori.config.json`** — 仓库的事实来源，记录技术栈、预设、插件、质量门和检测到的库。
- **`CLAUDE.md`** — CLI 会同步其中带版本信息的 managed blocks，同时保留这些区块之外的手动内容。
- **`.claude/`** — agents、skills、hooks 和 `settings.json`；默认只读，并通过 guard 拦截破坏性命令。

## 工作原理

**五层级联结构**——每层都在前一层基础上细化；越具体的设置优先级越高：

```
Core  →  Preset  →  Workspace  →  Project config  →  Engine adapters
```

- **Core** — 通用基线：agents、skills、hooks 和 SDD 协议。
- **Preset** — 面向特定技术栈的层，提供中性基础预设（`vite-react-ts`、`express`）和其上的专用变体（Next.js、NestJS、Express+Mongoose、Vite+Mantine、Astro、Medusa、background-worker 等）。
- **Library skills** — 可跨预设复用的模块化 skills，根据依赖检测注入。无论使用哪个预设，只要仓库包含相应依赖，就会获得 `socketio`、`mongoose`、`redux-toolkit`、`formik`、`zod` 等 skills。
- **Workspace** — 可继承的默认设置，以及涉及多个仓库时使用的跨仓库 tickets。
- **Project config** — 在 `navori.config.json` 中设置项目覆盖项。
- **Engine adapters** — Claude Code（`.claude/`）和完整 Codex（`AGENTS.md`、`.agents/skills`、`.codex/agents`、hooks 和 MCP），以及通用 `AGENTS.md`、Cursor 和 Copilot。Pi 需显式启用（`.pi/` 中包含扩展和 agents，skills 位于 `.agents/skills`）；最低且经过测试的版本为 1.1.0，Pi 要求 Node.js >= 22.19。矩阵和限制见 [docs/pi.md](./docs/pi.zh-CN.md)。

要启用完整支持，请使用 `"engines": ["claude", "codex"]`。要在 Claude 旁边使用轻量的 Codex 配置，请使用 `["claude", "agents-md"]`；无需额外设置 `codexMode`。

Codex 具备**保障能力对等性**：每个 hook、agent、skill 和规则在 Codex 中都有对应实现或已记录的限制（[`docs/native-overlap.md`](./docs/native-overlap.md)；实时验证见 [`docs/research/codex-paridad-verificacion.md`](./docs/research/codex-paridad-verificacion.md)）。

- 使用 Codex 执行 `navori render --apply` 后，运行 `navori codex trust` 以批准项目 hooks。hooks 发生变化时（例如启用 `masterPlan` 或 tgrep 后）以及在每个 worktree 中都要重新执行；`navori doctor` 会按路径提示缺少信任授权。
- 要求 Codex >= 0.160.0；版本较低时 `doctor` 会发出警告。
- Hooks 会调用全局安装的 npm 二进制，因此要保持更新。二进制版本低于仓库版本时，`doctor` 会发出警告。
- tgrep 搜索 guard 只有在索引存在时才会拦截（`tgrep index`）；没有索引时，搜索会放行。

**同步模型** — managed blocks 带有 `hash`、`version` 和 `source`。`sync` 会报告可用更新，并在替换你手动编辑过的区块前发出警告。每次写入前都会创建备份。

**按 agent 配置模型** — 每个 agent 都使用自己的 `model` 和 `effort`：`orchestrator` 与 `architect` 使用 `opus`/`xhigh` 处理判断和设计；`implementer`、`reviewer`、`scout` 与 `auditor` 使用 `sonnet`/`medium` 进行综合；`publisher` 与 `scribe` 使用 `haiku`/`low` 执行机械工作。机械工作不会按判断类任务的成本计费。聚焦的输出和按事件配置的质量门（仅运行所需检查，并行执行）也能降低每次会话的成本。详见 [`docs/recipes/model-tiering.md`](./docs/recipes/model-tiering.zh-CN.md)。

## 分级规划

`navori plan classify` 根据仓库信号（`project.criticalPaths`、新增依赖、模式迁移、资金/凭证/PII 等）衡量任务复杂度（0–10），并分配相应级别：

| 级别 | 含义 |
|---|---|
| 0 | 微小任务 — 无需 workplan，直接免于质量门。 |
| 1 | 标准任务 — 由 `implementer`/`reviewer` 使用 workplan，无需预先设计。 |
| 2 | 需要设计 — 首先由 `architect`（`opus`/`xhigh`）处理，交付包含至少 3 个方案和一项建议的 `solution_<scope>.md`。 |
| 3 | 与级别 2 相同，但范围更大（多仓库、共享契约）——仍由 `architect` 在任何人编写代码前决定设计。 |

启用 `harness.planTiers: true` 后，`PreToolUse` hook（`navori plan gate`）会拒绝派遣缺少对应级别有效 workplan 的子代理。连续两次被拒后，要求会提升到下一级（增加交付物，而不只是增加尝试次数）。如果未安装 `navori` 或没有 `plan` 子命令，hook 不会给出判定：在会显示提示的模式下，它会请求确认，而不是无声阻断。`navori plan classify --diff` 会对实际 diff 运行同一分类器，并在工作超出声明级别时发出警告。

**共存** — 已经有自己的 harness（编排/SDD）？`blocks.exclude` 可以让 Navori 与之共存，不覆盖你已有的区块：使用 `navori configure blocks` 选择不渲染 `orquestacion` / `sdd`，harness 的其他部分保持不变。

## 命令

| 命令 | 功能 |
|---|---|
| `init` | 检测技术栈并通过向导初始化（也可用 `--recommended` 跳过问题且不安装外部工具，或用 `--full` 添加外部 provider 和严格策略）。 |
| `refresh` | 重新检测仓库、刷新配置并运行完整引擎——让项目保持最新状态。 |
| `update` | 从 npm 更新 Navori，并使用新二进制运行 `refresh`（`--cli-only` 会在更新 CLI 后停止）。 |
| `render` | 为每个已配置引擎生成原生文件（默认预览；`--apply` 写入文件）。`--all` 一次性渲染全局注册表中的**所有**仓库，可用一条命令在 Navori 版本升级后完成推广。 |
| `registry` | 管理 Navori 仓库的全局注册表（`ls` / `scan <dir>` / `add` / `remove` / `prune`）。`init` 和 `refresh` 会自动注册仓库；`scan` 会加入已有仓库。 |
| `sync` | 通过冲突解决和备份刷新所有已配置的引擎。 |
| `add` / `remove` / `configure` | 启用插件 / 停用插件并清理其区块和脚本 / 无需重新初始化即可调整配置。`configure migrate` 会重命名已弃用且导致配置无法加载的键（`--all` 会处理整个注册表）。 |
| `doctor` / `status` / `audit` | 检查配置和漂移，并提示外部工具版本（仅供参考，不影响 `--strict`）/ 快速快照 / 衡量 harness 在会话中的使用情况（结果、可用时间窗口、快照比较）。 |
| `sync`（逐文件） | 除区块外，还可交互式替换没有标记的文件（`--accept-new-files` 一次接受全部文件）。 |
| `spec <classify\|check>` | 将 spec 分类为一个 PR 或按交付拆分的多个 PR（`classify`），并验证其 `tasks.md`（`check`）：里程碑、标准、覆盖情况和纵向交付。 |
| `plan <sub>` | 分级规划（`classify`、`render`、`update`、`check`、`gate`）；参见[分级规划](#分级规划)。 |
| `gate <fast\|full>` | 运行质量门，将完整输出写入日志（`.navori/state/gate/`），并仅在 stdout 输出简洁判定。 |
| `handoff <check>` | 在派遣下一个 agent 前验证 implementer 的 handoff。 |
| `codex trust` | 批准 `~/.codex/config.toml` 中的项目 hooks。 |
| `receipt <sign\|check\|gate\|review>` | 发布前为已审阅内容生成凭据；`gate` 决定每个里程碑需要范围受限的质量门还是完整质量门。 |
| `tools notice` | 为启动 hook 发出待处理的外部工具版本通知（`--ack` 将其标记为已送达）。 |
| `master <sub>` | 分阶段总体规划（`init`、`ux`、`mode`、`advance`、`check` 等）和交付（`delivery-*`，须通过 `--approved-by` 门控）。 |
| `adopt` | 将你手动编写的 harness 文件纳入 Navori 管理（添加管理标记，不重写内容）。 |
| `workspace` / `ticket` / `dominio` | 管理跨仓库配置和 tickets，以及工作区的持久知识库。 |
| `preset` / `scan` / `backup` / `migrations` / `bench` | 本地预设、monorepo、恢复和基准测试。 |

→ 完整命令表、预设和插件见 [`packages/cli/README.md`](./packages/cli/README.zh-CN.md)。

## 迁移到 0.12

- 已移除 `global` 命令和 launchd 收集器（`audit --collect` 仍保留）。`doctor --json` 不再输出 `globalScope`。
- 已移除 `jscpd` 和 `semgrep` 插件：执行 `navori add jscpd|semgrep` 会提示它们已弃用。
- Pi 的最低版本升至 1.1.0：Pi 0.87.x 不再提供 `navori_subagent`。Node.js 最低版本：>= 22.12。
- `navori update` 现在会更新 CLI（查询 npm、确认、安装，然后运行 `navori refresh`）。原有行为改由 `navori refresh` 执行，不再提供别名：此前用 `navori update` 重新同步 harness 的脚本必须改用 `navori refresh`。
- 使用 `navori render --apply` 迁移（清理 Navori 管理的已弃用资源），然后运行 `navori doctor`（报告残留项）。

## 在你的仓库中扩展 Navori

Navori 安装的是基线；让它在**你的**仓库中发挥价值的，是只有你掌握的知识。有四个位置可以存放这些内容，成本从低到高排列。成本最低的方式往往效果最好，因为规则就放在 agent 本来会查看的地方。

| 你掌握的内容 | 应放在哪里 |
|---|---|
| 仓库专属规则（自有模式或数据层约定） | 已覆盖该主题的 skill 的 **user section**。 |
| 任何已安装 skill 都未涵盖的知识 | `.claude/skills/<id>/SKILL.md` 中的**项目本地 skill**，并在 `project.localSkills` 中声明。 |
| 可在多个仓库复用的技术栈知识 | **本地 preset**（`navori preset init <id>`）。 |
| 二进制或 MCP server 的封装 | **plugin**（属于 Navori，不属于你的仓库）。 |

`navori doctor` 会配合你新增的内容，并指出仍待处理的机会：声明了 id 却缺少对应文件、只需在 `description` 中说明适用时机就能启用的 skill，或等待填写仓库规则的 user section。

→ 完整指南（包含让方案更有说服力的四个问题）见 [`docs/EXTENDING.md`](./docs/EXTENDING.zh-CN.md)。`SKILL.md` 文件契约（frontmatter、类型、上限、触发条件）见 [`docs/recipes/skill-authoring.md`](./docs/recipes/skill-authoring.zh-CN.md)。

## Monorepo 结构

```
navori-harness/
├─ packages/
│  ├─ cli/            # el CLI `navori` (publicado a npm)
│  ├─ core/           # @navori/core — managed assets (agentes, skills, presets, hooks), bundleados al CLI
│  └─ plugins/        # acli · codegraph · engram · gh · tgrep
├─ apps/
│  └─ website/        # landing + docs (Astro, deploy a GitHub Pages)
└─ package.json      # workspaces + trustedDependencies (bun)
```

构建时，`@navori/core` 和插件会**打包进 CLI**（不会单独发布）：只需执行一次 `npm i -g navori` 即可获得全部内容。

## 开发

需要 **Node >= 22** 和 **bun 1.4.4**。

```bash
bun install
bun run build                 # build de todos los paquetes

bun check                     # quality gate completo (lo que valida CI en PRs a main)
bun check:fast                # pasada rápida: format, jscpd, ast-grep, lint, typecheck
bun hooks:install             # instala el pre-commit: check:fast (sin tests)

# probar el binario local sin publicar:
node packages/cli/dist/index.js init --cwd /ruta/a/un/repo
```

**质量门**：在仓库根目录运行 `bun check`。它是 `navori.config.json` 中 `qualityGate.full` 的别名；该配置是质量门的**唯一来源**。`CLAUDE.md` 中的 managed blocks 和 `publisher` 执行的命令都由此生成。不要复制到其他文件：副本会逐渐与原配置不一致。

→ 贡献方式、镜像重新渲染的触发条件和 PR 规则见 [`CONTRIBUTING.md`](./CONTRIBUTING.zh-CN.md)。项目接受与不接受的内容见 [`docs/DIRECTION.md`](./docs/DIRECTION.zh-CN.md) 和 [`docs/EXTENDING.md`](./docs/EXTENDING.zh-CN.md)。

## 发布

发布需要手动操作，并且必须按**以下顺序**进行。分支流程是 `dev` → `main`：tickets 合并到 `dev`，只有发布才从 `dev` 进入 `main`。从 0.8.2 起，第 4 步的提交必须**通过 PR**，不能直接 push。此前 README 曾写明直接发布，同时又提醒没有 PR 可供事前查看——也就是说，CI 只能在发布树已经合入后才能验证。

1. 在 `apps/website/src/content/releases.ts` 中编写该次 minor 版本的条目（标题 + 3–5 个项目符号，提供西班牙语和英语版本）。如果当前 CLI minor 版本没有对应条目，`landing-inventory.test.ts` 中的 "release notes" 检查会失败。
2. 更新 `packages/cli/package.json` 中的版本号。
3. **必须重新渲染镜像，不是可选步骤：**

```bash
   bun run --filter navori build && node packages/cli/dist/index.js render --apply


```
   每个 managed block 的标记都会记录 CLI 版本，因此第 2 步的版本更新会让整个仓库的已渲染镜像过时。从 0.6.0 升到 0.6.1 时，`.claude/` 和 `CLAUDE.md` 中共有 **30 个文件**受影响。跳过这一步会让 tag 指向不一致的树，并导致发布后 `main` 上的第一次 CI 失败（`bun run check:render`，#421）。走 PR 流程可以在合并前发现问题；直接 push 时就没有这道检查。
4. 提交 `chore(release): navori vX.Y.Z`，同时包含版本更新**和**第 3 步的重新渲染。推送到 `dev`，并像其他 ticket 一样创建指向 `dev` 的 PR。
5. 创建从 `dev` 指向 `main` 的 PR，使用**合并提交，不要 squash**。这样 `dev` 仍是 `main` 的祖先，后续发布不会带入被改写的历史。合并后 `dev` 会落后于合并提交；将它 fast-forward 到 `main`，使两个分支保持一致。
6. 创建 tag `vX.Y.Z`——**从 0.8.6 起自动执行**。当 `main` 上的 `packages/cli/package.json` 发生变化时，`release-tag.yml` 会在该次 push 的 HEAD（第 5 步的合并提交，其中包含 `chore(release)` 提交）创建并 push 带注释的 tag；如果 tag 已存在则不重复创建。该操作具备幂等性，重新运行不会产生变化。

   之所以自动化，是因为 **0.8.4 和 0.8.5** 都漏掉了这一步，而且第二次漏掉时，准确命令已经写在这里。影响会延迟出现且不易察觉：`check-asset-commands.mjs` 会与最新 tag 比较，因此没有 tag 的发布会拿前一个版本做校验。仓库已经是 0.8.4，它却仍会报告“存在于 v0.8.3”，而检查不会失败。

   如需手动执行：`git tag -a vX.Y.Z <HEAD de main tras el paso 5> && git push origin vX.Y.Z`。在 `dev` → `main` 流程启用前发布的 tag 直接指向 `chore(release)` 提交，例如 `v0.8.2` → `285fa51` 和 `v0.8.3` → `6f32a00`。
7. 在 `packages/cli` 中运行 `npm publish`。

Website 页脚通过导入 CLI 的 `package.json` 显示版本（`apps/website/src/components/Footer.astro`）；`deploy-website.yml` 的 `paths` 过滤器也会监视该文件，所以第 2 步的版本更新会触发网站重新部署。**如果网站显示旧版本，首先检查这个过滤器**：在 0.8.4 之前，它没有包含 CLI manifest，导致网站落后两个版本；npm 已发布 0.8.4 时，网站仍显示 `v0.8.2`。

## 致谢与灵感来源

Navori 并非凭空诞生。以下项目为它提供了灵感；功劳归于各项目的创建者：

| 项目 | 借鉴之处 |
|---|---|
| [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) | 最接近 Navori 的项目：支持 SDD、持久化记忆，并根据任务复杂度进行自然路由的生态配置器。 |
| [gstack](https://github.com/garrytan/gstack) | 按角色串联、彼此协作的 skills；按主机自动检测并使用独立配置；跨模型审查。 |
| [harness-sdd](https://github.com/betta-tech/harness-sdd) | EARS 表示法、强制的需求↔测试可追溯性，以及作为 spec 状态机的文件系统。 |
| [ejemplo-harness-subagentes](https://github.com/betta-tech/ejemplo-harness-subagentes) | Leader/Implementer/Reviewer 模式和避免信息失真的原则：状态存入磁盘，聊天中只传引用。 |
| [superpowers](https://github.com/obra/superpowers) | 子代理驱动开发：每项任务使用全新 agent，spec 面向“热情的初级开发者”。 |
| [ponytail](https://github.com/DietrichGebert/ponytail) | 避免过度设计的决策阶梯——“解决方案可以粗略，阅读绝不能马虎”。 |
| [codegraph](https://github.com/colbymchenry/codegraph) | 通过预索引图谱获取精确上下文，避免反复 grep/read。可通过 `navori add codegraph` 选择启用；`init --full` 默认不启用。它是 Navori 的活跃插件，曾于 2026-09-15 短暂移除，并于 2026-09-16 与 `tgrep` 一同重新加入（#838）；详见[记录](./docs/research/tgrep-como-funcionaba.md)。 |
| [graphify](https://github.com/Graphify-Labs/graphify) | 提交到仓库中的确定性知识图谱（代码 + 文档），类似 managed assets。 |
| [caveman](https://github.com/JuliusBrussee/caveman) | 将 token 效率作为通用 skill：简洁表达，同时保持技术准确。 |
| [Goose](https://goose-docs.ai/) | 用于团队和 CI/CD 工作流共享的可移植 YAML recipes。 |
| [Pi](https://pi.dev/) | “原语，而非功能”：按需加载 skills，并在现成工作流之上扩展。 |

→ 各项目的说明及经核实的细节见 [`docs/inspiration.md`](./docs/inspiration.md)。

## 许可证

[MIT](./LICENSE)
