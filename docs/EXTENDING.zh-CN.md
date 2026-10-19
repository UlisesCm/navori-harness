[English](EXTENDING.md) | [Español](EXTENDING.es.md) | [简体中文](EXTENDING.zh-CN.md)

# EXTENDING — 新增内容应该放在哪里

> Navori 的设计初衷就是便于扩展。你安装的 harness 是起点，不是上限：真正让它在**你的**代码仓库中发挥价值的，是只有你掌握的知识。本指南会说明把这些知识放在哪里效果最好。
>
> 项目方向请参阅 [`DIRECTION.md`](./DIRECTION.zh-CN.md)。本指南回答一个实际问题：*我有新的内容——一条规则、一项技能、一个工具或一段指导文本——应该放在哪里，才能现在可用，六个月后仍然可用？*
>
> 本指南面向两类读者：**(a)** 在自己的代码仓库中扩展 Navori 的人；**(b)** 为 Navori 做贡献的人。大多数人属于 (a)，这也是每分钟投入收益最高的情况。

## 好消息：你通常已经有适合的位置

这里有五种放置位置，按成本从低到高排序。“成本低”意味着文件较少、审查工作较少、每个会话消耗的 token 较少。成本最低的方式通常也最有效，因为它把知识放在代理本来就会查找的地方。

从最上面开始，只有前一层不够用时才往下选。

| 你要添加的内容 | 放置位置 | 由谁纳入版本控制 |
|---|---|---|
| 适用于**你的代码仓库**的规则（自有模式、数据层约定或关键区域） | 已涵盖该主题的 skill 的**用户区段** | 你的代码仓库 |
| 当前没有已安装 skill 涵盖的知识 | **项目本地 skill** — `.claude/skills/<id>/SKILL.md` | 你的代码仓库 |
| 可在多个代码仓库复用的**技术栈**知识 | **本地 preset** — `.navori/presets/<id>/` | 你的代码仓库 |
| **外部工具**（二进制程序或 MCP 服务器）的封装 | **plugin** | Navori |
| **通用**指导：适用于任何代码仓库、技术栈和引擎 | **core** | Navori |

每一层的设计目标都是尽量不需要下一层。如果在两者之间犹豫，优先选择表格中靠上的一层：以后随时可以提升，而提升比撤回容易。

## 临时状态迁移

运行时会把交接文件保存在 `.navori/state/handoffs/`，把 hook 状态保存在 `.navori/state/hooks/`。这两个目录都属于当前 checkout 的本地状态，不得纳入版本控制。在**一个版本周期**内，仍可读取 `.claude/progress/` 和 `.codex/progress/` 中现有的交接文件；通过 `--dir` 显式继续操作时，会继续使用该目录。过渡期结束后，Navori 不会自动清理：不会复制、移动或删除旧状态或新状态。若要回滚，请使用上一个 CLI 版本，并在需要时通过 `--dir` 显式指定目录。

`<git-common-dir>/navori/` 中以前的标记也会原样保留。每个 checkout 都会建立自己的检测器基线，因此更新后通知可能会**重新触发一次**。这不代表清理或迁移这些标记。纳入版本控制的 `progress/` 目录（包括 `progress/current.md` 和 `progress/history.md`）以及 `.navori/presets/` 下的 preset 保留原有语义，也可以纳入版本控制；它们不属于临时状态。

路径验证会在**可信本地写入者**这一假设下防范可观察到的路径遍历和符号链接。它无法提供防竞态的路径约束：checkout 目录中的恶意**并发更改**可能在验证和使用之间，将读取或写入重定向到 **checkout 之外**。静态检查可以缩短风险窗口，但**不能保证**避免这种**竞态**。CLI 不会清理或修复这些路径。

---

## 1. 用户区段 — 默认选择，通常也是最佳选择

Navori 渲染的每个 skill 都带有 `<!-- navori:user-section -->` 标记。你在其下方写入的内容完全归你所有：`render` 和 `sync` 会完整保留这些内容，CLI 每次升级后也仍会保留。模板已经提示了可添加的内容；参见 `.claude/skills/review-diff/SKILL.md` 的末尾。

你得到的是：**无需新增文件、无需配置，也无需额外审查**。规则会留在代理已经为该主题加载的 skill 中。这是把你的知识转化为代理行为最快的方式。

`navori doctor` 会指出仍保留模板的用户区段；这些都是为通用 skill 补充代码仓库专属规则的机会。

## 2. 项目本地 skill

如果某个主题值得单独成文，这个选项完全由你管理。

1. 创建 `.claude/skills/<id>/SKILL.md`。宿主发现的是**目录形式**，因此按此结构创建后，skill 就能立即加载（`packages/cli/src/lib/assets/skill-meta.ts`、`resolveLocalSkillPath`）。
2. 在 frontmatter 中编写 `description`，说明**何时**使用该 skill。这个触发条件让宿主能在合适的时机自动加载它。完整契约（字段、类型和限制）见 [`recipes/skill-authoring.md`](./recipes/skill-authoring.zh-CN.md)。
3. 在 `navori.config.json` 的 `project.localSkills` 中声明 id。之后 `doctor` 会检查它（缺少 `<id>/SKILL.md` 时发出警告），文本型引擎会在 skill 索引中将其标记为 `project-local`。Claude 宿主只通过 `description` 发现它（`CLAUDE.md` 已不再包含 skill 索引，#1273）。

**Navori 从不写入该文件。** 文件没有 managed 区块或用户区段：整个文件都归你所有，今后的渲染也不会修改它。Navori 会为你建立索引并检查它：

| `doctor` 警告 | 你可以采取的操作 |
|---|---|
| `missingLocalSkills` | 将已声明的 id 与文件关联起来，使 skill 出现在索引中。 |
| `triggerlessSkills` | 为已编写的 skill 添加触发条件，使它能够自行激活。 |

第二种警告的收益最高：编写优质 skill 内容才是难点，但没有触发条件，skill 就无法发挥作用。添加一条 *“Use when…”* 描述即可激活它。

## 3. 本地 preset

`navori preset init <id>` 会创建 `.navori/presets/<id>/`，其中包含 manifest、`managed/stack.md` 和 `skills/`，并将其接入配置。解析顺序是**本地 → 内置**，因此如果本地 preset 与官方 preset 使用相同 id，本地版本优先。这是在不修改 package 的情况下，让内置 preset 适配团队环境的简洁方式。

preset JSON 可以声明 `libraries: [<lib-skill id>]`：这些是它始终包含的 library skill，渲染时会与 `project.libraries` 合并。CLI registry 不认识的 id 会被丢弃并发出警告。manifest 中的 `id` 必须与文件名一致，否则 preset 不会加载。

如果只想给*当前*代码仓库添加 library skill，而不创建 preset，可声明 `project.extraLibraries: [<lib-skill id>]`（也可以在某个 workspace 内声明 `extraLibraries`，仅适用于该 workspace）。这些 id 归你管理：`update` 不会修改它们；渲染时会将它们与检测到的 library 及 preset 中的 library 合并。根级值**不会**继承到 workspaces；每个 workspace 都要声明自己的值。registry 不认识的 id 会在 `render` 和 `doctor` 中触发警告。不支持通过这种方式移除已检测到的 library 或 preset 中的 library。

当知识属于某个**技术栈**，而且你希望在下一个使用该技术栈的代码仓库中继续使用时，本地 preset 就是合适的一层。编写一次，在各处复用。

## 4. Plugin — 外部工具的封装

Navori 通过 plugin 将 harness 连接到外部世界：plugin 封装二进制程序或 MCP 服务器，把安装、权限、hooks 和文档集中管理。现有 plugin——`engram`、`acli`、`gh`、`tgrep` 和 `codegraph`——采用相同结构：都声明 `externalTool.checkBinary`。应遵循这一模式；它让 `navori add <plugin>` 能提供安装方式，也让 `doctor` 能验证工具。

> **`codegraph` 和 `tgrep` 是第六和第七个 plugin。** 它们于 2026-09-15 退役，并由 #838 于 2026-09-16 重新引入，同时采用新的集成方式：通过 *Code discovery* 在结构化发现和文本发现之间路由。此前设计的构成——外部二进制程序、MCP 服务器、防护规则、会话 hook 和五处指导文本注入——仍在 [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md) 中逐项记录。

如果你想添加的内容没有要安装的工具，那是好消息：它可能只是一项 skill 或 managed 区块，这两种方式更容易落地。

`plugin.json` 最多提供六种组成部分。只添加需要的部分：

| 组成部分 | 提供的能力 |
|---|---|
| `externalTool` | 待检查的二进制程序、按平台提供的安装命令（`darwin`、`linux` 或 `win32`；出现其他平台键时 plugin 会加载失败），以及在某个平台没有安装命令时使用的官方安装链接 `installDocs`。可选的 `capabilityProbe`（`{args, mustContain, minVersion}`）用于声明二进制程序必须支持某项功能标志，适用于 `--version` 无法可靠报告该功能的情况，例如它输出的次版本号与 package 中的版本不一致。`doctor` 和 `init` 会运行 `args`，并在输出中找不到 `mustContain` 时发出警告。`pinnedVersion` 要求与 `--version` 完全匹配；`minVersion` 则仅供参考，会显示在消息中，但不会与已安装版本比较。可选的 `versionAdvisory`（`[{below, reason: {es, en}, ref?}]`）用于列出已知存在问题的特定版本。如果安装版本低于 `below`（不含该版本；`below` 是第一个修复版本，必须精确使用 `x.y.z` 格式），`doctor` 会在不访问网络的情况下发出警告。此项仅供参考，不会影响健康判定或 `--strict`。这三个版本字段用途不同：`pinnedVersion` 要求完全相等，版本过新或过旧都会警告；`capabilityProbe.minVersion` 只会显示；`versionAdvisory.below` 是已知问题版本的最低修复版本。约定：只有存在上游 `ref`（issue 或 release）时才添加条目；`reason` 必须同时提供 `es` 和 `en`。如果升级仍不足以解决状态，应在 `reason` 中说明补救操作（engram 示例：重新运行 `engram setup codex`）。所有匹配的条目都会报告；修复版本的预发布版本也算已修复。可选的 `latestRelease`（`{source, id, notify?}`）用于启用“上游有更新版本”的提示（#1244）。它不能与 `pinnedVersion` 同时使用；两者并存时会加载失败。查询由独立 worker 执行，每个工具每天一次，不使用 token；当 `source` 为 `github` 时查询 `api.github.com/repos/<id>/releases/latest`，当 `source` 为 `npm` 时查询 `registry.npmjs.org/<id>/latest`。只保存 `x.y.z` 格式的稳定版本（允许 `v` 前缀；其他格式会在 `doctor` 中标为“unparseable”，且不会报告）。如果上下文预算允许，提示会在会话启动时显示；否则会提示运行 `navori doctor`。`notify` 指定触发提示所需的最低版本变化级别：`major`、`minor` 或 `patch`（默认 `minor`）。宿主工具（Claude Code、Codex 和 Pi）不受监控，因为它们会自行通知用户。添加此字段时，应同时提升 `plugin.json` manifest 中的 `version`。 |
| `managed[]` | 注入 `CLAUDE.md` 的区块。 |
| `settingsFragment` | 已配置好的工具所需权限。 |
| `scripts[]` | 复制到 `.claude/scripts/` 的文件。 |
| `hooks[]` | 按事件注册的 hook，例如 `SessionStart` 和 `PreToolUse`。 |
| `skills[]` | plugin 自有资源，**或**通过 `injectInto` 扩展现有资源。 |

**`injectInto` 是此格式中最优雅的部分。** 如果 plugin 有适用于现有代理的指导文本，就把它注入该代理的文件中。代理由此了解工具，无需任何人维护平行副本。`engram` 可以覆盖四个目标（`orchestrator`、`implementer`、`reviewer` 和 `auditor`），而无需新增任何资源——只需两个扩展文件，就能让四个代理变得更强。

要衡量成本：会话加载的是**合成后的**文件，它有自己的上限（`maxWordsComposed`）。注入的成本比复制低得多；设置这个上限正是为了维持这种优势。

## 5. Core — 对所有项目都适用的内容

core 的门槛很高，理由充分：其中的内容会渲染到安装了 Navori 的每个代码仓库。适合进入 core 的内容必须**对任何代码仓库、技术栈和引擎都成立**。如果一句话需要加上“如果你使用 X”，它就适合放进 preset；如果需要说“在我们团队”，它就适合放进用户区段。三种贡献都很有价值，只是属于不同层次。

如果内容确实通用，可以继续推进：重新阅读 `DIRECTION.md` 中的不变量和非目标。如果你的想法涉及其中之一，就在 `specs/` 下提出 spec。复杂想法应通过 spec 认真讨论。

---

## 让提案更有说服力的四个问题

写作前先回答这些问题，可以显著降低审查阻力。审查者也会问同样的四个问题。

## 1. 这个主题目前放在哪里？

查看宿主在当前会话中显示的 skill 列表（`CLAUDE.md` 已不再包含“Available skills”区块，#1273）。其中包括 core skill、工作流 skill、自动检测的 library skill 和 preset skill。花一分钟查看经常就能发现该主题已经有合适位置。这样，你的贡献可以放在该 skill 的**用户区段**，或通过 `injectInto` 注入——写起来更快，也能沿用该 skill 已有的权威性。

把某个主题的知识集中在一处，有助于代理始终给出一致的响应。扩展现有内容，而不是在旁边再建一份，可以强化这种一致性。

## 2. 它符合项目方向吗？

`DIRECTION.md` 声明了十项不变量和一份非目标清单——它们共同约定如何让 Navori 在不同版本和代码仓库间保持一致。符合这些内容是最快的路径：支持某项不变量的提案只需几分钟就能审完。

如果你的想法确实需要调整其中一项，也有相应途径：提出 spec。项目通过 spec 调整方向，任何人都可以提出理由，开启讨论。

## 3. 它占用多少预算，又带来什么价值？

这些限制都有明确数字；了解它们能帮助你有针对性地写作：

- 启动上下文预算为 **8000 bytes**（`NAVORI_CTX_BUDGET`，定义于 `packages/core/core-assets/hooks/session-start-context.sh`）。代理每次会话都会读取其中的内容，因此这是 harness 最宝贵的空间。放不下的内容会降级为 *“使用 `Read` 阅读”* 的指针。它仍有帮助，但收益较低。
- 每种 skill 类型都有字数上限。内容确有必要时，可通过 `maxWords` 提高上限；该覆盖是显式的，便于将理由写在数字旁边。
- 每个包含 `CLAUDE.md` managed 区块的代码仓库中，每次会话都会为该区块付出 token 成本。

用这个问题精炼每一段文字：*它带来的价值是否超过占用的空间？* 一段准确的文字通常胜过一页内容，整个 harness 都会因此受益。

## 4. 这是实施工作，还是决策？

两者都受欢迎，但分开处理效果更好。如果更改会影响**如何作出决定**——派发什么工作、哪些内容始终渲染、Navori 会向用户代码仓库写入什么，或 harness 拥有哪些权限——就把这部分放入 spec，单独讨论其价值。决策达成后，再清晰地实施。

---

## 提交前检查清单

对于 (a)，在自己的代码仓库中扩展：

- [ ] 我查看了当前会话显示的 skill 列表，确认该主题是否已有合适位置。
- [ ] 我选择了能满足需求且成本最低的层次（先考虑用户区段，再考虑 skill；先考虑 skill，再考虑 preset）。
- [ ] `description` 说明了**何时**使用该 skill，而不只是说明它的功能。
- [ ] `.claude/skills/<id>/SKILL.md` 使用目录形式，并且 id 已在 `project.localSkills` 中声明。
- [ ] `navori doctor` 检查通过。

对于 (b)，为 Navori 做贡献——除以上各项外，还需满足：

- [ ] 我已阅读 `DIRECTION.md`，并知道此更改符合哪项不变量（或由哪份 spec 提出）。
- [ ] 如果扩展现有资源，我会使用 `injectInto` 并在已有内容上继续扩展。
- [ ] 我遵守该资源类型的字数上限；如需提高上限，使用 `maxWords` 并在旁边写明理由。
- [ ] 质量门禁（`pnpm check`）通过，并且同一个 PR 包含镜像重新渲染。触发条件见 [`../CONTRIBUTING.md`](../CONTRIBUTING.zh-CN.md)。

## 如果你要审查提案

按顺序、以对话方式提出四个问题。多数情况下，想法总能找到适合的实现方式；审查工作的一部分就是找出它。

1. **它最适合哪一层？**（参见上表。）
2. **该主题已有合适位置吗？** 如果有，使用用户区段或 `injectInto`，更快落地。
3. **它符合项目方向的哪一部分？** 如果提案希望调整方向，应通过 spec 充分讨论。
4. **它占用多少资源，又带来什么？** 如果内容会进入常驻上下文，应说明读者能从中获得什么。

## 参考资料

- [`DIRECTION.md`](./DIRECTION.zh-CN.md) — 项目目的、目标、非目标和不变量。
- [`recipes/skill-authoring.md`](./recipes/skill-authoring.zh-CN.md) — `SKILL.md` 契约：frontmatter、类型、限制和触发条件。
- [`architecture.md`](./architecture.zh-CN.md) — 渲染机制、五个层次和 managed 区块。
- [`../packages/cli/src/engines/README.md`](../packages/cli/src/engines/README.zh-CN.md) — 第六层，也是最宏大的选择：**添加引擎**。其中介绍 `EngineAdapter` 契约和 spike 检查清单，旨在让新 provider 只需增加一张声明式表格。
- [`../CONTRIBUTING.md`](../CONTRIBUTING.zh-CN.md) — 质量门禁、镜像重新渲染、提交和 pull request。
