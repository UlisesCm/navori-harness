[English](pi.md) | [Español](pi.es.md) | [简体中文](pi.zh-CN.md)

# Pi 编码代理

Pi 是 Navori 的可选引擎。它会为 Pi 渲染由 Navori 管理的项目资源，并为获准的角色添加 `navori_subagent` 扩展工具。项目的信任设置、MCP、提供方身份验证以及用户级代理资源仍由 Pi 管理。

本指南只记录已经验证的状态。机器检查的契约（版本、支持矩阵和运行时准入项）由 `packages/cli/src/engines/pi/__tests__/first-class-e2e.test.ts` 解析。

## 要求与设置

- 最低支持的 Pi 版本：**1.1.0**
- 已测试的 Pi 版本：**1.4.0**

最低版本由 `MIN_PI_VERSION`（`packages/cli/src/engines/pi/runtime-version.ts`）定义。已测试版本是 `packages/cli` 中固定版本的开发依赖 `@earendil-works/pi-coding-agent`。最低版本也适用于验收证据：该证据读取 Pi 内置 bash 的 `structuredContent.exit_code`；它还适用于获准的子进程运行时能力（见[运行时准入项](#运行时准入项)），这些能力仅在 1.4.0 上验证过。Pi 1.1–1.3 会加载完整扩展，但 `navori_subagent` 会拒绝子进程，并提示“请升级 Pi”。

以下情况会将 Pi 视为**未经验证**：版本低于最低版本、属于预发布版本（例如 `1.2.0-rc.1`），或报告的版本无法解析。未经验证的 Pi 只会以写入阻止模式加载扩展：`bash`、`edit`、`write` 和 `powershell` 会被阻止；`read`、`grep`、`find` 和 `ls` 保持可用；每个进程首次遇到被阻止的调用时会显示一条提示；并且不会注册 `navori_subagent`。高于最低版本的稳定版仍获准使用；目前没有声明最高版本，因此若后续版本出现不兼容，会通过发布新版本处理。

Pi 的运行时最低要求为 Node.js **22.19.0 或更高版本**。当前 Navori 代码仓库要求 Node.js **24 或更高版本**，因此运行其 CLI 时应遵循更高的代码仓库要求。参见 [Pi 快速入门](https://pi.dev/docs/latest/quickstart)。

在项目配置中启用 Pi：

```json
{
  "engines": ["pi"]
}
```

然后渲染项目资源，并在应用前检查建议的更改：

```sh
navori render
navori render --apply
```

在项目中启动 Pi，并检查/接受 Pi 的项目信任提示。渲染文件不会自动激活不受信任的项目资源。扩展加载时会检查 Node.js 以及已导入 Pi 包的 `VERSION`；未经验证的 Pi 会进入上述写入阻止模式。这不是由宿主统一执行的 `pi --version` 握手；运行时测试针对固定版本的 Pi 包进行。

## 支持矩阵

每一行对应 `ENGINE_CAPABILITIES.pi.controls` 中的一项 Pi 控制。`enforced` 表示受信任的 Pi 项目扩展会检查该边界；`advisory` 表示该信号仅作为上下文或警告，绝不是权限边界；`unsupported` 表示 Navori 不会在 Pi 上提供该控制。

| 控制项 | 状态 | 边界 |
| --- | --- | --- |
| `plan-gate` | enforced | 启用 `harness.planTiers` 时，扩展只会对 `navori_subagent` 的 implementer 调用实施门禁。直接调用 Pi shell 和工具可以绕过它。 |
| `master-plan` | advisory | 启用 `harness.masterPlan` 时，每个代理启动前都会附加一行有长度限制的状态信息。它仅提供上下文，不是权限边界。 |
| `markdown-ownership` | advisory | 启用 `harness.scribeOwnsMarkdown` 时，会阻止 implementer 子代理直接通过 Pi `edit`/`write` 修改 Markdown。bash 和进程可用的其他写入方式仍可绕过它。 |
| `handoff-shape` | enforced | `implementer` 或 `reviewer` 的 `navori_subagent` 子代理结束时，受信任的扩展会验证其规范交接文件（并根据派发快照检查时效性）。交接文件缺失、过期或无效时会返回 `isError`。直接 shell/工具调用以及其他角色可以绕过它。 |
| `handoff-consumer` | enforced | 会检查带有明确 feature 的 reviewer `navori_subagent` 调用。直接 shell 和工具调用可以绕过它。 |
| `analytic-write-tools` | advisory | 按角色设置的工具允许列表只是模型可见的能力，并不是操作系统、文件系统或网络沙箱。Scout 和 reviewer 仍保留 `write`。 |
| `local-skill-discovery` | enforced | `project.localSkills` 会投影为 `.agents/skills/<id>` 下的指针；仅在未启用 Codex 时写入。 |
| `acceptance-evidence` | enforced | 扩展会将宿主观察到的 Pi 内置 bash 退出结果（父会话、子会话及嵌套调用；Pi 1.1.0+）记录为 workplan 证据。设置了 `PI_SESSION_ID` 时，若没有该证据，`plan update` 会拒绝将状态设为 `cumplido`。此机制会关闭失败：若 bash 工具被替换或缺少 `exit_code`，则不会记录任何内容。 |
| `repeat-failure-advice` | advisory | 内置 bash 连续出现三次相同失败后，会附加一条建议。它不会阻止操作或更改结果；缺少 `exit_code` 时也不会显示。 |
| `compact-advice` | unsupported | 没有任何 Pi 绑定运行 compact-advice，因此 publisher 派发后不会注入上下文大小建议。 |
| `general-purpose-confirm` | unsupported | Pi 的 `navori_subagent` 角色列表有七个固定角色，没有可确认的 general-purpose 角色。 |

Pi 也会原生发现 `.agents/skills/` 中受信任的项目技能。如果同时选择 Pi 和 Codex，共享目标位置由 Codex 管理，Pi 不会重复写入。Pi 不会复制或运行 Claude 与 Codex 的 hook 脚本。

## 运行时准入项

每一行对应 `ENGINE_CAPABILITIES.pi.runtimeAdmissions` 中的一项子进程运行时能力。`admitted` 表示已在 Pi 1.4.0 上验证；`deferred` 表示当前不可用。

| 能力 | 决定 | 边界 |
| --- | --- | --- |
| `child-mcp-off` | admitted | `--no-mcp` 只会在子进程中禁用 Pi 内置 MCP。这不是操作系统沙箱；父会话仍保留其 MCP。 |
| `child-model-selection` | admitted | `--model <provider/id>` 用于选择子进程的模型。不会重新定义 effort 或 thinking。 |
| `child-tool-allowlist` | admitted | `--tools` 是模型可见的允许列表，不提供隔离。通过 `--no-mcp` 关闭间接 MCP 暴露。 |
| `child-ipc-relay` | admitted | 子进程通过 Node IPC（`stdio` `ipc`）向父进程报告被拒绝的确切命令。它绝不会批准命令；参见[审批中继](#审批中继)。 |
| `child-mcp-grants` | deferred | 子进程以 `--no-mcp` 运行。Pi 1.1.0 会连接每个已启用的 MCP 服务器，并在子进程提示中列出所有服务器，因此无法验证按角色授予 MCP 的方式。需要 MCP 的角色在子进程中仍不可用。 |
| `session-end-event` | admitted | 仅当父会话正常退出或执行 `/new` 时，才会运行 `session_shutdown`。SIGKILL 不会触发该事件，因此会在下次关闭时清理。重新加载、恢复和分叉都不会结束会话。 |
| `settle-boundary-entries` | admitted | `agent_before_settle` 会在代理运行结束时附加一条可见记录。它不会设置 `continue`，因此无法强制发起另一条模型请求。 |

## 会话生命周期

这些操作只在父会话中运行；子会话什么也不做。所有失败都会静默处理，不会导致会话失败。

- **退出或 `/new`**（原因是 `quit` 或 `new` 的 `session_shutdown`）：
  1. `worktree-reclaim` 会在 12 s 截止时间内运行，且仅当 `.claude/worktrees` 存在时运行。Pi 分支会保留有未发布工作或 `.navori/state/` 下存在忽略文件的 worktree。
  2. `audit-mode-close` 会在 3 s 截止时间内运行，并且只封存现有审计日志。
- **重新加载、恢复和分叉**：不运行任何操作。
- **验证提醒**（仅在设置了 `hooks.verifyOnStop` 时触发的 `agent_before_settle`）：如果工作树存在未提交更改，会附加一条固定的西班牙语提醒，提示运行质量门禁并提交更改；该提醒以可见的 `custom_message` 显示。它不会触发另一条模型请求。

## Hook 桥接

受信任的扩展通过桥接运行共享的 Navori hook 脚本。契约如下：

- **载荷。** 桥接发送形状与 Claude 一致的载荷：`hook_event_name`、`tool_name`（`Bash`、`Edit` 或
  `Write`）、`tool_input`、`cwd`、`session_id`、`permission_mode`，以及子会话中的 `agent_id`/`agent_type`。
  脚本副本通过其位于 `/.pi/navori/` 下的路径识别 Pi，而不是依据载荷识别。
- **位置。** 脚本会复制到 `.pi/navori/hooks/<id>.sh`，脚本集合来自 `PI_HOOK_BINDINGS`
  （`engines/pi/hook-bindings.ts`）：
  - `guard-destructive`：`tool_call`、bash、`enforced`，父会话和子会话。
  - `subagent-no-background`：`tool_call`、bash、`enforced`，仅子会话。
  - `managed-drift-watch`：`tool_result`、bash、edit 和 write、`advisory`，父会话和子会话。
  - `worktree-reclaim` 和 `audit-mode-close`：`session_shutdown`，仅父会话，`lifecycle`。
  - `stop-verify-reminder`：`agent_before_settle`，仅父会话，`advisory`；仅在设置了 `hooks.verifyOnStop` 时安装。

  [防护规则](#防护规则)一节说明每项规则会阻止什么。
- **Shell。** 脚本使用 Pi shell 配置中的 bash 运行。不会使用项目的 `shellPath`。
  如果没有 bash，或只能使用 `sh` 回退程序，则所有 `enforced` 脚本都会被阻止，并会指出需要执行的操作。
- **执行。** 非交互式脚本会并发运行，每个脚本各自有超时限制。最先触发的阻止结果生效。
- **判定结果。** 只有包含 `hookSpecificOutput`、`systemMessage` 或 `continue` 的 stdout JSON 对象才是判定结果。
  其他 stdout 内容视为噪声，最多保留其中 64 KiB。stderr 会保留开头和结尾部分。

| 脚本结果 | `enforced`（tool_call） | `advisory`（tool_result） | `lifecycle` |
| --- | --- | --- | --- |
| 退出码 0，没有判定 JSON | 允许 | 无操作 | 无操作 |
| 退出码 2 | 阻止，原因 = stderr | 警告 = stderr | 无操作 |
| JSON `permissionDecision` 为 deny | 阻止 | 无操作 | 无操作 |
| JSON `permissionDecision` 为 ask | 询问 | 无操作 | 无操作 |
| JSON `permissionDecision` 为 allow，且包含 context 或 message | 允许 | 警告 = context | 无操作 |
| JSON 决策未知、包含 `updatedInput`，或 `continue` 为 false | 阻止 | 无操作 | 无操作 |
| 其他退出码、信号、超时、未能启动或没有 bash | 阻止 | 无操作 | 无操作 |

`advisory` 和 `lifecycle` 脚本失败时会静默处理。仅对 `enforced` 脚本采用失败时关闭策略。

**Manifest v2。** `.pi/navori.json` 的 `schemaVersion` 为 2，包含 `hooks`（桥接绑定）、
`ownedPaths`（Navori 管理的路径）和 `permissionRules`（`ask` 和 `deny`）。防降级机制：仅支持 v1 的 Navori 会将 v2 视为外部文件并拒绝写入 Pi 资源；此 CLI 也会拒绝覆盖较新的 schema。仍可识别 v1 manifest，渲染时会将其升级。如果无法读取 manifest、格式错误或版本不是 v2，扩展会因无法评估相关操作而阻止 `bash`、`edit` 和 `write`；读取操作仍可用。

**Powershell（D-U3）。** Pi 的 `powershell` 工具会在共享 shell 策略之外运行命令，因此 Navori 会在 `session_start` 时通过 `setActiveTools` 将其从活动工具中移除，并在 `tool_call` 时阻止任何 `powershell` 调用。在 Windows 上使用 `bash` 工具；它需要 Git for Windows（Git Bash）。

### 延迟

每次通过桥接执行 bash 调用时，所有已绑定脚本都会并发运行：p50 为 26.7 ms，p95 为 31.1 ms，最大值为 34.6 ms（macOS，n=60）。测量方式见 `packages/cli/src/engines/pi/__tests__/first-class-latency.test.ts`。

## 插件

启用的插件通过 `renderPiEngine`（`packages/cli/src/engines/pi/index.ts`）和 `plugin-projection.ts` 接入 Pi。重叠矩阵标记为 Pi 原生支持的插件会被跳过。启用的插件会投影以下内容：

- **技能写入技能目录。** 插件技能的 `injectInto: .claude/skills/<id>/SKILL.md` 会成为 `.agents/skills/<id>/SKILL.md` 中由 Navori 管理的子区块。仅当 `engines` 中没有 Codex 时，Pi 才会写入它；启用 Codex 后，由 Codex 写入该技能，Pi 不会重复写入。
- **角色说明。** 插件技能的 `injectInto: .claude/agents/<role>.md` 会插入变量并按 Pi 的条件处理后，附加到 `.pi/agents/<role>.md`。声明了 `mcpServer` 的插件完全不会提供角色说明：Pi 子进程以 `--no-mcp` 运行。
- **Orchestrator 和 AGENTS.md 区块。** 注入到 `.claude/agents/orchestrator.md` 的技能以及插件的 `managed` 区块会成为共享 `AGENTS.md` 的子区块。只有在没有其他已启用引擎管理该文件（`ownsAgentsMd`）时，Pi 才会写入这些区块；否则以该引擎的输出为准。
- **脚本。** 即使启用了 Codex，插件脚本也会作为 Pi 自己的可执行副本复制到 `.pi/navori/scripts/<dest>`。只有桥接行会运行该脚本，或插件的 hook 扩展包含在已安装的 Pi hook 副本中时，才会安装脚本。目标路径冲突时会跳过。
- **Hooks。** 插件的 `PreToolUse`/`Bash` hooks 使用 Codex 转换时采用的语法。它们会成为 `.pi/navori.json` 中的 manifest v2 行，指向 `.pi/navori/scripts/<dest>`：`tool_call`、`bash`、范围 `all`、`enforced`、非交互式，并使用 manifest 中的超时时间。无法转换的 hook 会报告为警告，且不会安装。
- **Hook 扩展。** 目标为 Claude 核心 hook 的插件 `hookExtensions` 条目，会成为 Pi 副本 `.pi/navori/hooks/<hook>` 中由 Navori 管理的子区块；禁用插件时会再次移除该区块。

所有权、备份和清理都使用与其他引擎相同的共享渲染计划：插件输出路径归 Navori 管理，计划会报告备份路径；`.pi/navori/scripts/` 下不再有绑定关系的脚本会被清理。禁用插件时，会从 `.agents/skills/<id>/SKILL.md` 移除其子区块，并清理 Pi 输出。

按单元划分，[兼容性清单](#兼容性清单)中的状态如下：

| 插件单元 | Pi 状态 | 在 Pi 上的含义 |
| --- | --- | --- |
| 技能子区块（`.agents/skills`、`AGENTS.md`） | `advisory` | 模型会读取的文本；没有任何机制强制执行。 |
| 由 hook 运行的插件脚本 | `enforced` | 仅对 `bash` 工具调用提供安全带，不是沙箱。 |
| 插件 hook | `enforced` | 限制与共享防护规则相同；仅在扩展已加载时强制执行。 |
| `settingsFragment` | `n/a` | 只有 `allow` 规则，而 Pi 不会转换这类规则（Codex 也一样）。 |
| MCP 服务器 | `advisory` | 如果 Pi 的 MCP 配置中缺少服务器或服务器已禁用，渲染时会发出警告。 |
| 子角色上的 MCP 插件技能 | `unsupported` | 子进程以 `--no-mcp` 运行，因此不会注入说明文本。 |
| Pi 不会渲染其技能的角色（例如 `publisher`） | `unsupported` | 等待 spec 0048 的 R14 和 M11 中的角色工作完成。 |
| tgrep 防护脚本和 `tgrep-search-lane` hook 扩展 | `enforced`（安全带） | 脚本安装在 `.pi/navori/scripts/` 下。该通道通过桥接在 Pi 防护副本（`.pi/navori/hooks/guard-destructive.sh`）中运行。它仅涵盖 grep/rg；tgrep、其服务器或索引不可用时会开放失败。 |

如果插件的 MCP 服务器在 Pi 原生 MCP 配置中缺失或已禁用，渲染时会发出警告。Navori 绝不会写入 Pi 的 MCP 配置。

## 防护规则

Navori 的防护规则是基于文本的策略。Pi 没有权限系统，因此每条规则都通过匹配调用文本来工作，是安全带而不是沙箱。[兼容性清单](#兼容性清单)中的相关行标为 `enforced (seatbelt)`。

**破坏性命令和 deny 规则（`guard-destructive`）。** 共享破坏性规则和共享的 `deny` 权限规则会在父会话及所有子会话中阻止操作。渲染时会将 `deny` 规则转换为 token 前缀，转换方式与 Codex 相同。它的 `ask` 规则会在父会话中确认（见下文的共享 `ask` 规则）。
Pi 副本额外增加三条仅适用于 Pi 的规则：

- **控制平面。** 当写入动词（`>`、`>>`、`>|`、`tee`、`sed -i`、`rm`、`mv`、`cp`、`ln`、`dd`、`install`、`truncate`、`chmod`、`git checkout|restore`）和内联解释器（`python -c`、`node -e`、`perl -i`、`ruby -e`、`php -r`）指向 `.pi/navori/**`、`.pi/extensions/**`、`.pi/settings.json` 或 `.pi/navori.json` 时，会阻止操作。读取仍然允许。
- 会阻止从 bash 调用 **`pi --no-extensions`**（或 `-ne`）。这种形式会启动一个不带扩展、桥接或 hooks 的 Pi。

**受管理文件（`edit` 和 `write` 通道）。** 扩展按照 Pi 自身工具的方式规范化路径：移除开头的 `@`、展开 `~`、将 Unicode 空格转换成普通空格、相对于项目解析路径，并跟随符号链接。随后：

- 它会阻止访问控制平面，以及 `.pi/navori.json` 中每个 `ownedPaths` 条目，包括尚不存在的目标路径。
- 对于混合文件（`AGENTS.md`、`CLAUDE.md`、skills、`.claude/`、`.codex/`、`.cursor/rules/`、Copilot 指令），只有符合真实标记语法的内容才会被识别为受管理区块：开始和结束标记具有相同的 id，两者都位于第 0 列，且都在代码围栏之外。如果文件包含受管理区块，则会阻止 `write`。如果 `oldText` 落在受管理区块内，或编辑请求的形状不受该通道识别，则会阻止 `edit`。区块外的文本（包括用户区段）仍可编辑。
- 在行中间引用的标记，或没有结束标记的开始标记，都不算区块。若匹配混合文件路径，但目标不是常规文件或大小超过 4 MiB，则会阻止操作。
- 外部 `.pi/agents/*.md` 文件仍可通过 `edit` 编辑。已知缺口：shell 通道会列出 Navori 的全部七个角色文件（`scout`、`implementer`、`reviewer`、`scribe`、`auditor`、`architect`、`publisher`），范围更广；因此，在 Navori 渲染相应角色之前，shell 写入会阻止名称与其中之一相同的用户文件。

**漂移提示（`managed-drift-watch`）。** 每次 bash、edit 或 write 调用之后，监视器都会检查 Pi 根目录下的受管理区块，包括 `.pi/navori/`。它会在 `.navori/state/hooks/managed-drift-stamp-pi` 中保存自己的基线，因此不会读取并发 Claude 会话将看到的报告。漂移会作为工具结果中的警告显示，不会阻止操作。

**绕过方式类别。** 安全带相关行列出了以下绕过方式（`PI_SEATBELT_BYPASSES`）：

- `sh -c`、`eval`、`xargs` 或经过混淆的命令。
- 将脚本写入磁盘后再执行。
- 规则未覆盖的 `pi --no-extensions` 形式。
- 父会话中具备写入能力的 MCP 工具（`mcp__github__*`）。
- 在 Navori 处理器之后修改工具输入的第三方扩展。

破坏性规则也有自身的缺口：先 `cd` 进入控制平面再使用相对路径写入（`cd .pi/navori && echo x > navori.json` 会通过）、通过变量拼接控制平面路径，以及 `mkfs.ext4` 这类 `mkfs.<fs>` 拼写。共享 `mkfs` deny 规则只匹配完全相同的 token，因此 `mkfs /dev/sda` 会被阻止，而 `mkfs.ext4 /dev/sda` 不会。

**检查顺序（`tool_call`）。** 对每次调用，扩展依次执行：(1) 阻止 `powershell` 调用；(2) 读取 manifest；若无法读取或版本不是 v2，则阻止 `bash`、`edit` 和 `write`；(3) `edit` 或 `write` 进入受管理文件通道；(4) 运行桥接脚本，若 `enforced` 脚本阻止操作，则停止调用；(5) 针对 `--approved-by` 声明以及每个 `ask` 判定结果，一并请求一次确认。确认绑定到用户看到的确切输入；输入发生变化时会拒绝操作。

**提交和推送门禁（`quality-gate-pre-commit`）。** Pi 没有原生 git hooks，因此 Pi 副本会同时对 `git commit` 和 `git push` 实施门禁。它会运行 `qualityGate.fast`，截止时间为 600 s。门禁失败时会在父会话和子会话中阻止调用。找不到门禁运行器时，会在子会话或没有 UI 的情况下阻止调用；在有 UI 的父会话中则会询问。只有设置了 `qualityGate.fast` 才会存在该脚本。进度文件大小限制（`progress/current.md`）也适用于 push，不仅适用于 commit。角色截止时间必须长于门禁时间：每个带有 `bash` 的角色，其截止时间至少为门禁 + 10 min（20 min）。各角色的截止时间由 `packages/cli/src/engines/pi/role-tools.ts` 中的 `PI_ROLE_TIMEOUT_MS` 定义：`implementer` 为 30 min，`publisher` 为 40 min，`scribe`、`reviewer`、`auditor` 和 `architect` 各为 20 min。`scout` 没有 `bash`，保持 10 min。

**发布确认。** 在任何发布操作前，这些脚本都会询问，并在询问中显示正文：

- 每次执行 `gh pr create` 时，`pr-publisher-confirm` 都会询问（Pi 没有宿主提示，因此 Pi 副本总会询问）。
- `comment-draft-confirm` 会询问评论草稿和 review 草稿；`master-accept-confirm` 会询问 master 的接受和关闭操作。
- 对正文文件的批准会绑定到该文件的 sha256。扩展会在确认后、允许调用前重新检查摘要。如果确认后正文被修改、创建或删除，或者无法读取，就会拒绝操作。
- 通过 shell 构建的正文、stdin 和内联正文会显示在确认中，但不绑定哈希。

**共享 `ask` 规则。** 桥接会收集每个脚本以及共享 `ask` 权限规则给出的 `ask` 判定结果。随后，扩展会针对 `--approved-by` 声明和所有这些判定结果显示一次确认，并将其绑定到确切的调用。

- 阻止始终优先于询问：先运行 `enforced` 脚本，因此最终会被阻止的调用不会提交给用户确认。
- 确认在父会话中进行。子会话（设置了 `NAVORI_PI_CHILD_DEPTH`）会被拒绝，并将确切命令中继给父会话（见[审批中继](#审批中继)）。在 TUI 和 RPC 模式（提供真实 UI 上下文）中，可以通过输入文本完成确认。在 headless/print 模式下，没有交互式 UI，调用会被拒绝。
- `publisher` 已获准使用并受上述所有规则约束：其发布操作会在子会话中被拒绝、中继给父会话，并在那里确认。

**确认对话框（先拒绝）。** 父会话会显示一个文本输入对话框（`ctx.ui.input`），标题为 "Navori approval required"，其中包含确切命令、原因以及输入 `yes, run it` 的提示。只有输入完全匹配的文本（去掉前后空白后）才会批准。空 Enter、Escape、任何其他文本、超时或对话框故障都会拒绝调用。这里不使用选择器，因此不会有预先高亮的选项。确认之后，扩展会重新检查代码仓库状态和正文摘要；其中任何一项发生变化，都会拒绝调用并重新请求批准。

## Doctor 检查结果

启用此引擎后，`navori doctor` 会报告以下 Pi 检查结果。它们全部都是提示：没有一项会改变 doctor 的 `ok` 结果，而且扩展已经会对每项检查失败时关闭。没有 `pi` 二进制文件或无法读取设置文件时，表示无项可检查，而不是错误。

- **未经验证的版本**：已安装的 Pi 低于最低版本、属于预发布版，或版本无法解析。
- **Powershell 默认值**：有效的 `defaultTools`（项目 `.pi/settings.json`，否则使用用户设置）选择了 `powershell`。
- **外部扩展**：来自 `.pi/extensions/` 和项目 `extensions` 设置的项目扩展条目中，除 Navori 自有扩展之外的条目。

## Navori 子代理

加载受信任的项目扩展后，Pi 会提供 `navori_subagent` 工具。获准角色及其 Pi 工具列表（来源：`packages/cli/src/engines/pi/role-tools.ts`）如下：

- `scout`：`read, grep, find, ls, write`
- `implementer`：`read, grep, find, ls, bash, edit, write`
- `reviewer`：`read, grep, find, ls, bash, write`
- `scribe`：`read, grep, find, ls, bash, edit, write`；仅在启用 `harness.scribeOwnsMarkdown` 时获准使用，此时 implementer 也必须启用 `scribe` 角色
- `auditor`：`read, grep, find, ls, bash, write`
- `architect`：`read, grep, find, ls, bash, write`；在 Pi 上无法派发嵌套子代理（`navori:if-not onPi`）
- `publisher`：`read, grep, find, ls, bash`；其 git commit 和 push 都会运行质量门禁，发布操作需要父会话确认（见[防护规则](#防护规则)）

该工具要求提供 `role` 和非空的 `task`；`feature` 可选，但 reviewer 必须显式提供 Navori feature slug 以进行交接检查；`implementer`、`reviewer` 和 `scribe` 都必须提供 `feature`。角色指令和描述都会保留。仅当配置的模型能映射到具体的 `codexMap` 模型时才会使用该模型；否则子进程会继承所选 Pi 模型。每个角色都有明确的 Pi 工具列表；缺少映射或映射未知时会失败时关闭，而不是启用默认工具。子进程不会获得 MCP 授权（见 `child-mcp-grants`）。

### 审批中继

无头子进程无法批准操作。当子进程的 Bash 命令声称已获人工批准（`--approved-by`）但被拒绝时，子进程会通过 Node IPC 通道将被拒绝的确切命令发送给父进程。父进程会验证每条消息：消息必须符合预期 schema，大小不得超过 8 KiB，并且每个子进程最多接受 5 条。已接受的请求会显示在 `navori_subagent` 结果的 `details.parentApprovals` 中，并在结果内容中附带一行说明。中继只负责报告；原有拒绝仍然有效。

没有 IPC 时，父进程会从同一 `toolCallId` 的 `tool_execution_start` 参数中恢复命令；该调用会以错误结束，绝不会报告成功。模型的 Bash 不会继承此通道。

### 子进程结束时的交接验证

派发时，扩展会为子进程创建规范交接文件快照：implementer 对应 `impl_<feature>.json`，reviewer 对应 `review_<feature>.json`。子进程结束时，如果交接文件缺失，或与快照相比没有变化（内容和 mtime 相同），就会因过期而验证失败。

- `implementer` 会运行 `navori handoff check <feature> --for orchestrator`。出现 `head` 警告也会导致失败。
- `reviewer` 会运行 `navori handoff check <feature> --produced-by reviewer --since <dispatch time>`。sidecar 和判定结果必须有效；并且封存证据必须通过检查，检查所对应的 review 必须在派发时刻或之后开始。

任何失败（包括检查无法读取）都会返回 `isError`，其中包含原因和子进程输出（失败时关闭）。子进程结束时不会验证 `scribe`；它只需要满足 `feature` 要求。

## 限制与无头运行

- 子进程最多嵌套一层，最多并发运行三个，且每个子进程限时十分钟。
- 子进程输出最多保留 64 KiB；发生截断时会报告，但不会视为取消。
- 取消时会发送 `SIGTERM`，五秒后升级为 `SIGKILL`。超出主进程生命周期的后代进程也会被升级终止。
- 子进程不会再注册另一个 `navori_subagent` 工具。
- 无头子进程无法批准操作。扩展会拒绝子进程发出的审批请求，并将命令返回给父会话，由用户在那里批准。信任并不等于批准：只有在受信任的父会话加载扩展后，子进程才会收到进程范围内的 `--approve`。
- 这些限制、工具列表和 `--no-mcp` 都不会创建操作系统沙箱。子进程会继承用户的环境、文件系统和网络权限，以及 Pi 代理目录。

## 与 Claude 的实时比较

M5 读取器会把已确认的 Pi 子进程与其调用 ID 关联，并在派生之后保留失败记录。
M6 新增 `navori audit --by-engine --published-from <bare>`：不可用的 Git 或转录证据保持不可用，缺少最低观测数量时输出 `inconclusive`。关联是描述性的；它不授予行为者权限，也不构成独立审查者。

仓库中仅供开发者使用的驱动是 [scripts/bench/run-live.ts](../scripts/bench/run-live.ts)。
它从同一个 fixture 准备两个真实的 Git 检出副本、60 个搜索文件、一个本地裸远程仓库，以及一个本地 `gh` 测试替身。
其 `auth status` 预检说明本地发布不需要 GitHub 认证；它既不读取凭据，也不对 GitHub 进行认证。
不受支持的命令仍以状态码 64 退出。fixture 使用 `npm test` 作为安全的 gate 命令；包的测试脚本
无依赖地运行 `node --test`。发布的引用为 `claude/benchmark` 和 `pi/benchmark`。
Git 配置和模板仅限于 fixture 本地。原生引擎仍保留其正常的
文件系统/网络访问权限和原生权限；此驱动不是操作系统沙箱。

准备阶段不会启动模型：

```bash
bun scripts/bench/run-live.ts prepare
```

将返回的物理 `root` 复制到 `NAVORI_BENCH_ROOT`。在取得账户、模型和支出预算的单独授权后，从操作员自己的 POSIX 终端启动一个引擎：

```bash
NAVORI_LIVE_BENCH=1 bun scripts/bench/run-live.ts launch --root "$NAVORI_BENCH_ROOT" --engine claude --model sonnet
NAVORI_LIVE_BENCH=1 bun scripts/bench/run-live.ts launch --root "$NAVORI_BENCH_ROOT" --engine pi --model provider/model
```

按顺序运行它们。驱动要求原生支持 `--session-id`（在 Claude Code
2.1.309 和 Pi 1.3.0 中观察到）；此观察不会扩展固定 SDK 测试所验证的运行时准入范围。
Claude 的 fixture 角色使用 Sonnet；Pi 继承明确选定的 provider/model。
执行标志不是金额上限。操作员控制原生审批和经授权的支出限额。
本次比较中禁用了 MCP 工具；原生安全设置仍然生效。

父进程打开期间，在另一个终端获取下一条精确提示：

```bash
bun scripts/bench/run-live.ts task --root "$NAVORI_BENCH_ROOT" --engine claude --task 2
```

对任务 3–5 以及 Pi 重复此操作，将每条返回的提示粘贴到对应引擎中。任务 2 会在**已跟踪的字节**中激活
已存在且失败的分页测试，从而使任务 1 的缓存 gate 失效。在任务 5 期间，
父进程暂停时运行 `/compact`，然后发送另一轮。每个父进程在完成其五个任务后退出。
驱动从不提供审批响应，也从不使用权限绕过标志。

```bash
bun scripts/bench/run-live.ts collect --root "$NAVORI_BENCH_ROOT"
```

收集阶段针对本次运行的私有审计根目录（`NAVORI_AUDITS_ROOT`）执行 `navori audit --by-engine --published-from`，
不带 `--all-repos`，因为审计读取器会拒绝与 `--by-engine` 同时使用该标志。
作用域队列仅接纳分配给本次运行的会话头。原生来源验证仍由审计读取器负责。
部分观测会保留其指标和失败记录；缺失的阶段标签无法获得 `pass`。
标签并不证明任务已执行。`comparisonVerification: unverified` 使操作员对五个真实任务和实际模型的验证
与 K1 指标结果保持分离。
未启动任何模型或缺少来源时，结果为 `inconclusive`。
将真实结果、原生版本、实际解析的模型以及脚本化的一致性结果记录到
`specs/0053-pi-igualar-claude/evals.md`。该比较的 n = 1，允许使用不同的模型，并且不等同于相关审批或独立审查。
本地准备不构成实时验收。

部分实时结果（仅 Claude Code，未运行 Pi，`inconclusive`，无一致性声明）记录于
[evals.md](../specs/0053-pi-igualar-claude/evals.md)。

## 兼容性清单

`PI_PARITY`（`packages/cli/src/engines/shared/pi-parity.ts`）列出 Navori 为其他引擎输出的每个单元（核心 hooks、共享权限规则、插件 manifest 片段），以及 Pi 当前对每个单元提供的能力。
每行有一种状态：

- `enforced`：会阻止或要求某些 Pi 无法自行绕过的操作。阻止操作的文本策略行属于安全带，而不是沙箱（Pi 没有权限系统），并且必须列出其绕过方式类别。
- `advisory`：提供信息但不阻止操作，或只涵盖部分形态。
- `unsupported`：存在缺口，并说明原因。
- `n/a`：该单元不适用于 Pi，并说明原因。

缺少对应行的单元会导致清单测试失败（`pi-parity.test.ts`），并指出缺失项。某行会一直保持 `unsupported`，直到实现该功能的更改同时更新状态、代码和测试。

<!-- pi-parity:start -->
<!-- Generated from `PI_PARITY` (`packages/cli/src/engines/shared/pi-parity.ts`). Do not edit by hand: `first-class-e2e.test.ts` pins it. -->

每个安全带行的绕过方式类别（安全带是文本检查，不是沙箱）：

- sh -c / eval / xargs / 混淆命令
- 将脚本写入磁盘后再执行
- 不属于规则覆盖形式的 pi --no-extensions
- 父会话中具备写入能力的 MCP 工具（mcp__github__*）
- 在 Navori 处理器之后修改工具输入的第三方扩展

| 单元 | 状态 | 类别 | 边界 |
|---|---|---|---|
| `hook:audit-mode-close` | advisory | — | 只封存已经存在的日志：Pi 不会通过此 hook 启动审计模式日志（`audit-mode-trigger` 不受支持），因此在日志启动前它不起作用。失败会静默处理。 |
| `hook:audit-mode-trigger` | unsupported | — | Pi 不会通过此 hook 启动审计模式日志（不在 spec 0048 范围内，设计目标明确排除）。 |
| `hook:bash-outcome-watch` | advisory | 控制项 `repeat-failure-advice` | — |
| `hook:comment-draft-confirm` | enforced | 安全带（上述绕过方式类别） | 内联正文或无法读取的正文只会作为命令显示；stdin 正文（`-F -`）和由 shell 构建的路径（`$VAR`、`$(…)`）不会显示。检查与执行之间仍有一个时间窗口。间接 shell 形式可以绕过它。 |
| `hook:engram-write-guard` | n/a | — | 仅适用于 Codex：Pi 子进程以 `--no-mcp` 运行，因此没有 engram 授权需要防护（`child-mcp-grants` 尚未实现）。 |
| `hook:general-purpose-confirm` | unsupported | 控制项 `general-purpose-confirm` | — |
| `hook:guard-destructive` | enforced | 安全带（上述绕过方式类别） | 对命令字符串实施文本策略：共享脚本中的破坏性规则、共享 `deny` 权限规则、对 Pi 控制平面（`.pi/navori/**`、`.pi/extensions/**`、`.pi/settings.json`、`.pi/navori.json`）的写入，以及 `pi --no-extensions`。共享 `ask` 规则会给出 `ask`（见对应行）。 |
| `hook:implementer-no-markdown` | advisory | 控制项 `markdown-ownership` | — |
| `hook:managed-drift-watch` | advisory | — | 不会阻止操作；只会检查带有哈希标记的区块（AGENTS.md、skills、hook 副本）。扩展、manifest 和角色文件没有逐区块哈希，因此改由防护规则和 edit/write 通道保护。无法评估的漂移会静默处理。 |
| `hook:master-accept-confirm` | enforced | 安全带（上述绕过方式类别） | 覆盖 `navori master part\|delivery-baseline\|delivery-queue\|delivery-criterion … --approved-by`、`master close`、`delivery-review\|decision\|publication\|revoke` 和 `delivery-slice --refresh`；间接 shell 形式（`sh -c`、磁盘上的脚本）可以绕过。该确认是安全带，不是沙箱。 |
| `hook:master-plan-context` | advisory | 控制项 `master-plan` | — |
| `hook:model-advisor` | unsupported | — | 移植到 Pi 需要脚本提供 Pi 模式并添加绑定；目前没有计划（模型通过 `/model` 选择并传给子进程，spec 0047 R17）。 |
| `hook:plan-gate` | enforced | 控制项 `plan-gate` | — |
| `hook:pr-publisher-confirm` | enforced | 安全带（上述绕过方式类别） | 仅在启用 publisher 角色时安装；内联正文或无法读取的正文只会作为命令显示。间接 shell 形式可以绕过它。 |
| `hook:quality-gate-pre-commit` | enforced | 安全带（上述绕过方式类别） | 仅在配置了 `qualityGate.fast` 时存在（与 Claude 和 Codex 一样，否则没有对应行）；结果仅适用于当时的工作树。间接 shell 形式（`sh -c`、磁盘上的脚本）可以绕过；代理以外的 hook（例如用户自己的终端）无法被检测到。 |
| `hook:role-guard` | n/a | — | 仅适用于 Codex：Claude 和 Pi 通过工具允许列表限制角色，而不是通过 hook（`HOOK_ENGINES`）。 |
| `hook:routing-watch` | advisory | — | 每个会话最多一条提示；永不阻止操作；出错的结果不会转发，因此失败的写入或被拒绝的 `navori_subagent` 既不算工作也不算委派；与 Claude 一样需要在仓库根目录启动 Pi，bash 通道只统计重定向/tee/sed -i 写入。 |
| `hook:session-start-context` | advisory | — | 仅提供上下文，不是边界；发生任何错误时都会跳过注入。 |
| `hook:stop-verify-reminder` | advisory | — | 不会阻止操作，也不会设置 `continue`，因此不会产生额外模型请求；每次代理运行最多提醒一次；失败时不显示任何内容。 |
| `hook:subagent-no-background` | enforced | 安全带（上述绕过方式类别） | 仅对命令字符串实施文本策略，仅适用于子会话：父会话可以将工作放到后台。 |
| `hook:subagent-stop-handoff` | enforced | 控制项 `handoff-shape` | — |
| `hook:worktree-reclaim` | advisory | — | 与 Claude 的标准相同（工作树干净、已推送、PR 已合并），此外还会保留 `.navori/state/` 下有忽略文件的 worktree。Pi 不会创建 worktree；SIGKILL 不会触发事件，下次关闭时才会清理。失败会静默处理。 |
| `permission-rule:class:allow-not-translated` | n/a | — | Pi 没有权限系统，因此没有需要转换的 allow 列表（与 Codex 相同）。 |
| `permission-rule:class:bash-ask` | enforced | 安全带（上述绕过方式类别） | token 前缀：带内部通配符的模式会被丢弃；粘连在末尾 token 上的 `*` 会收窄为完全匹配该 token（`git clean -f*` 只会询问 `git clean -f`，不会询问 `-fd`）；阻止规则优先于询问。 |
| `permission-rule:class:bash-deny` | enforced | 安全带（上述绕过方式类别） | token 前缀：带内部通配符的模式或非 Bash 条目会被丢弃（见对应行）；粘连在末尾 token 上的 `*` 会收窄为完全匹配该 token。 |
| `permission-rule:class:prompt-amendment` | n/a | — | 仅适用于 Codex 的持久化“不要再询问”提示修订；Pi 没有提示规则。 |
| `permission-rule:dropped:Agent(orchestrator)` | n/a | — | Pi 的角色列表没有可派发的 orchestrator 角色，因此无需禁止。 |
| `permission-rule:narrowed:Bash(git branch --delete*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git clean -d*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git clean -f*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git push --force*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-push-force`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git reset --hard*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git stash clear*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(git stash drop*)` | enforced | 安全带（上述绕过方式类别） | 类别 `git-destructive-prefix`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）。 |
| `permission-rule:narrowed:Bash(mkfs*)` | enforced | 安全带（上述绕过方式类别） | 类别 `mkfs`：前缀只匹配字面目标；同一脚本中编号对应的规则（root/home/system rm、`--no-preserve-root`、mkfs 变体）会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force --recursive $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则（root/home/system rm、`--no-preserve-root`、mkfs 变体）会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force --recursive --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force --recursive /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force --recursive ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -R $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -R --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -R /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -R ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -r $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -r --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -r /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --force -r ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive --force $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive --force --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive --force /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive --force ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive -f $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive -f --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive -f /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive -f ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）；同一脚本中编号对应的规则（root/home/system rm、`--no-preserve-root`、mkfs 变体）会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）；同一脚本中编号对应的规则（root/home/system rm、`--no-preserve-root`、mkfs 变体）会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm --recursive ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标（粘连在末尾的 `*` 会收窄为完全匹配该 token）；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R --force $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R --force --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R --force /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R --force ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R -f $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R -f --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R -f /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R -f ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -R ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -Rf $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -Rf --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -Rf /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -Rf ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f --recursive $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f --recursive --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f --recursive /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f --recursive ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -R $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -R --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -R /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -R ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -r $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -r --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -r /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -f -r ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fR $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fR --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fR /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fR ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fr $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fr --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fr /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -fr ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r --force $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r --force --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r --force /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r --force ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r -f $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r -f --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r -f /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r -f ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -r ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -rf $HOME/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -rf --no-preserve-root*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-no-preserve-root`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -rf /*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `permission-rule:narrowed:Bash(rm -rf ~/*)` | enforced | 安全带（上述绕过方式类别） | 类别 `rm-recursive-root-home`：前缀只匹配字面目标；同一脚本中编号对应的规则会阻止其他拼写形式。 |
| `plugin-hook-extension:tgrep/tgrep-search-lane` | enforced | 安全带（上述绕过方式类别） | 仅对 grep/rg 片段实施文本安全带；tgrep 缺失、服务器未运行或没有索引时会开放失败。 |
| `plugin-managed:acli/acli-protocol` | advisory | — | 只有在 Codex 和 agents-md 都不管理 AGENTS 文件时，Pi 才会通过 includePluginBlocks 写入该文件；否则以该文件所有者的输出为准。该区块只是说明文本：Pi 会读取，但没有机制强制执行。 |
| `plugin-managed:codegraph/codegraph-search-v2` | advisory | — | 只有在 Codex 和 agents-md 都不管理 AGENTS 文件时，Pi 才会通过 includePluginBlocks 写入该文件；否则以该文件所有者的输出为准。该区块只是说明文本：Pi 会读取，但没有机制强制执行。 |
| `plugin-managed:tgrep/tgrep-search-v2` | advisory | — | 只有在 Codex 和 agents-md 都不管理 AGENTS 文件时，Pi 才会通过 includePluginBlocks 写入该文件；否则以该文件所有者的输出为准。该区块只是说明文本：Pi 会读取，但没有机制强制执行。 |
| `plugin-mcp-server:codegraph` | advisory | — | 已配置不代表已连接：不会检测 `--no-mcp`、`-builtin:mcp` 或替换 Pi 原生 MCP 的扩展；只读取服务器名称和 `enabled`。Navori 从不写入 Pi MCP 配置。 |
| `plugin-mcp-server:engram` | advisory | — | 已配置不代表已连接：不会检测 `--no-mcp`、`-builtin:mcp` 或替换 Pi 原生 MCP 的扩展；只读取服务器名称和 `enabled`。Navori 从不写入 Pi MCP 配置。 |
| `plugin-script:tgrep/guard-search-routing.sh` | enforced | 安全带（上述绕过方式类别） | 只涵盖内容搜索（grep/rg）；tgrep 缺失、其服务器未运行或没有索引时会开放失败。 |
| `plugin-settings:acli` | n/a | — | 只有 `allow` 规则：Pi 没有权限系统，不会转换此类规则，与 Codex 相同。 |
| `plugin-settings:codegraph` | n/a | — | 只有 `allow` 规则：Pi 没有权限系统，不会转换此类规则，与 Codex 相同。 |
| `plugin-settings:engram` | n/a | — | 只有 `allow` 规则：Pi 没有权限系统，不会转换此类规则，与 Codex 相同。 |
| `plugin-settings:gh` | n/a | — | 只有 `allow` 规则：Pi 没有权限系统，不会转换此类规则，与 Codex 相同。 |
| `plugin-settings:tgrep` | n/a | — | 只有 `allow` 规则：Pi 没有权限系统，不会转换此类规则，与 Codex 相同。 |
| `plugin-skill:acli/acli-comment-channel-publisher` | advisory | — | 仅提供指导，没有任何机制强制执行；禁用 publisher 角色时，没有对应角色文件，因此不会渲染该说明文本。 |
| `plugin-skill:codegraph/codegraph-access-v2-architect` | unsupported | — | codegraph 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 architect 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:codegraph/codegraph-access-v2-auditor` | unsupported | — | codegraph 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 auditor 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:codegraph/codegraph-access-v2-implementer` | unsupported | — | codegraph 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 implementer 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:codegraph/codegraph-access-v2-orchestrator` | advisory | — | 只有在 Codex 和 agents-md 都不管理 AGENTS 文件时，Pi 才会通过 includePluginBlocks 写入该文件；否则以所有者的输出为准。该区块只是说明文本：Pi 会读取，但没有机制强制执行。 |
| `plugin-skill:codegraph/codegraph-access-v2-reviewer` | unsupported | — | codegraph 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 reviewer 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:engram/engram-auditor-extension` | unsupported | — | engram 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 auditor 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:engram/engram-implementer-extension` | unsupported | — | engram 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 implementer 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:engram/engram-orchestrator-extension` | advisory | — | 只有在 Codex 和 agents-md 都不管理 AGENTS 文件时，Pi 才会通过 includePluginBlocks 写入该文件；否则以所有者的输出为准。该区块只是说明文本：Pi 会读取，但没有机制强制执行。 |
| `plugin-skill:engram/engram-reviewer-extension` | unsupported | — | engram 声明了 MCP 服务器，而 Pi 子进程以 `--no-mcp` 运行，因此不会注入 reviewer 说明文本；渲染时会通过 `mcpRoleDiagnostics` 指出该角色。 |
| `plugin-skill:gh/gh-comment-channel-publisher` | advisory | — | 仅提供指导，没有任何机制强制执行；禁用 publisher 角色时，没有对应角色文件，因此不会渲染该说明文本。 |
<!-- pi-parity:end -->

## 周期命令

已验证的周期流程，按顺序如下：

1. 运行 `navori render`，然后运行 `navori render --apply`，安装 Pi 资源。
2. 在受信任的项目中启动 Pi。启动时会加载 Navori 上下文（AGENTS.md 和运行状态快照）。
3. `navori plan update <feature> --decision approved --date <YYYY-MM-DD>` 会批准 workplan 并刷新扩展读取的验收索引。`navori plan render <feature>` 会重写 workplan Markdown，也会写入验收索引。如果索引中没有该 feature 对应的行，验收证据检查会失败，并报告错误 `run navori plan render <feature>, then rerun the command`。
4. 使用 `navori_subagent` 派发角色（按要求提供 `role`、`task` 和 `feature`）。
5. 验收命令通过 Pi 内置 bash 运行。设置了 `PI_SESSION_ID` 时，宿主会将观察到的每次退出结果记录为证据。
6. `navori plan update <feature> --progress <ID>=cumplido --json` 只有在记录了证据时才会关闭验收标准。若没有证据，该命令会以非零状态退出并指出对应标准。
7. 更改 `engines` 后，运行 `navori render --apply --prune` 禁用引擎。只会清理 Navori 管理的资源；外部文件和工作成果会保留。

## 无凭据端到端测试结果

自动化通过以下命令在固定版本的 Pi 1.4.0 运行时上执行测试：`bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-e2e.test.ts`。测试在进程内运行已编译的 CLI（render、已批准的计划、`plan update`）、真实 Pi SDK 代理循环和工具流水线、渲染扩展派生的真实 `pi` 子进程、Pi 内置 bash 和 write 工具、git 以及文件系统。测试涵盖安装、无 UI 时的批准、拒绝、大于 256 KiB 的子进程流、使用父进程所选模型派发 implementer/scribe/reviewer、证据记录、回执、升级和禁用。

明确列出的限制：

- 没有实时模型。模拟 provider 可以证明流水线运行，但不能证明模型遵守要求。
- 没有 TUI 或 RPC 进程。父进程在进程内运行；通过 Pi 的真实扩展运行器和 stub `ui.input` 驱动审批，因此没有测试对话框的实际渲染。
- “Receipt”是基于宿主记录证据，通过共享的 `plan update ... cumplido` 关闭标准。
- 没有实时 OAuth。不会读取、存储或使用任何真实凭据。

## 自动化未执行的项目

- **常驻上下文对比（RED/GREEN，实时模型）**：未执行。设计要求执行（见 [design.md](../specs/0047-pi-first/design.md)）；当前待完成。
- **实时模型冒烟测试**：部分完成，见 [evals.md](../specs/0047-pi-first/evals.md)。手动冒烟测试已确认启动时从 `AGENTS.md` 加载上下文，并通过 `navori_subagent` 派发 implementer。除此之外的内容尚未覆盖。待完成的 0048 实时冒烟测试记录在 [evals.md](../specs/0048-pi-paridad/evals.md) 中。
- **实时 Pi 会话中的关闭流程**：未执行。

## 原生 MCP 与项目信任

Pi 提供原生 MCP 支持，包括用户级服务器 `~/.pi/agent/mcp.json` 和项目级服务器 `.pi/mcp.json`。Pi 会通过信任门控控制项目资源。授予信任前应检查项目；参见 Pi 的 [MCP 配置](https://pi.dev/docs/latest/mcp)、[设置](https://pi.dev/docs/latest/settings)和[安全与信任](https://pi.dev/docs/latest/security)指南。

Navori 会保留用户和项目各自拥有的 MCP 配置。它不会创建或迁移上述任一文件，不会添加 MCP 服务器，不会更改 Pi 的 `builtin:mcp` 设置，也不会安装独立的 MCP 扩展。请通过 Pi 的原生机制配置服务器，并避免将凭据放入项目配置。

信任由 Pi 明确决定。Navori 不会自动批准父项目，也不会使用 `-e` 绕过信任。

### 插件的 MCP 诊断

声明了 MCP 服务器的插件会与 Pi 原生 MCP 配置进行比对。此项检查只读且仅提供建议：它会读取 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json` 和 `.pi/mcp.json`，并且只记录服务器名称、`enabled` 以及条目是否定义了传输方式（`command`、`url` 或 `type`）。它绝不会复制 env 或 token 等值，也不会写入任一文件。服务器名称比较时会将 `-` 和 `_` 视为等价。若项目条目定义了传输方式，就会取代同名的全局条目；若项目条目只设置 `enabled`，则会切换全局条目的启用状态。

渲染时，如果服务器未配置或已禁用，会发出警告并给出操作 `pi mcp add <id> -- <command> <args...>`。如果服务器只在 `.pi/mcp.json` 中启用，也会发出警告，说明只有在项目受信任时该服务器才会生效。如果文件不是有效 JSON，警告会使用固定消息指出文件路径，不会包含解析器错误文本。

会话开始时，父 Pi 扩展会再次执行检查。如果服务器只在 `.pi/mcp.json` 中启用，且项目尚未受信任（`ctx.isProjectTrusted()`），则会在该次会话启动时显示一条提示，说明服务器要等项目受信任（`/trust`）后才会生效。检查失败时保持静默，也不会在子会话中运行。

诊断只报告服务器已配置，不代表已连接。它无法检测 `--no-mcp` 或替换 Pi MCP 支持的 MCP 扩展。

## ChatGPT Plus/Pro OAuth

Pi 管理 ChatGPT 订阅的 OAuth 流程和凭据。在受信任的项目中以交互模式启动 Pi，运行 `/login openai-codex`（或运行 `/login` 并选择 OpenAI ChatGPT Plus/Pro 订阅选项），然后通过 `/model` 选择一个可用的 `openai-codex` 模型，并发送无害提示。参见 Pi 的 [provider 身份验证指南](https://pi.dev/docs/latest/providers)和[模型指南](https://pi.dev/docs/latest/models)。

Navori 不会读取、复制、生成、刷新或记录 Pi 的 `auth.json`，也不会静默回退到 OpenAI API key。若身份验证失败，请使用 Pi 的 `/login` 流程；不要向 Navori 提供凭据。自动化运行时测试不使用凭据；账户身份验证属于用户手动执行的冒烟测试。

## 手动冒烟测试

实时冒烟测试是唯一能够证明 TUI 对话框确实渲染、且模型遵守契约的证据。无凭据端到端测试无法证明这两点。请在 Pi 资源受信任的项目中执行，并在 [evals.md](../specs/0048-pi-paridad/evals.md) 中记录每一步。

1. 检查 `pi --version`；版本必须为 1.4.0 或更高。
2. 以交互模式启动 Pi，运行 `/login` 并选择 `openai-codex` ChatGPT Plus/Pro 订阅登录方式。Navori 不会检查凭据文件。
3. 运行 `/model`，选择子进程将使用的模型。
4. 运行 `navori render --apply`。
5. 批准计划：`navori plan update <feature> --decision approved --date <YYYY-MM-DD>`。
6. 实施：通过 `navori_subagent` 派发 `implementer`；其交接文件必须通过验证。
7. Scribe 文档：派发 `scribe` 编写文档。
8. Review：使用该 feature 派发 `reviewer`。
9. 通过质量门禁提交并推送。
10. 在 TUI 对话框中确认 PR，并检查对话框显示的正文。
11. 关闭验收标准：`navori plan update <feature> --progress A<n>=cumplido`。只有记录了证据后此命令才会成功。

当前状态：实时冒烟测试已于 2026-10-12 使用 Pi 1.1.0 运行（第 4 次运行，GREEN；第 1–3 次为 RED，已由 #1301/#1302 修复）。尚未在经过测试的 Pi 1.4.0 上重复。证据记录在 [evals.md](../specs/0048-pi-paridad/evals.md) 中。

有关要求以及实施/review 状态，请参见 [Pi 引擎规范](../specs/0040-pi-engine/requirements.md)和 [Pi first 规范](../specs/0047-pi-first/requirements.md)。
