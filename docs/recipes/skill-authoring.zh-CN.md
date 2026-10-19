> [English](skill-authoring.md) | [Español](skill-authoring.es.md) | [简体中文](skill-authoring.zh-CN.md)

# Recipe — 在 navori 中编写 SKILL.md

> Skill 文件契约：frontmatter、类型、字数上限和触发条件。
> 实现 spec 0003 §3.2.1（输出规范）和 §3.2.2（触发条件）。
> `packages/cli/src/lib/assets/__tests__/skill-caps.test.ts` 会检查 navori 打包的资源（core、presets、plugins）。
>
> **Skill 应放在哪里**——core、preset、plugin 还是项目本地——是另一个问题，在 [`../EXTENDING.md`](../EXTENDING.zh-CN.md) 中说明。本文假定你已经确定了位置。

## 文件位置

只有一种受支持的结构，因为这是 host 唯一会发现的格式：包含 `SKILL.md` 的**目录**。

```
.claude/skills/<id>/SKILL.md
```

使用此结构后，skill 可以立即加载。扁平格式（直接放在 `skills/` 根目录中的 `<id>.md`）属于 `.claude/commands/`，那是另一项功能。无论是 navori 渲染的 skills，还是你自己编写的 skills，都适用此规则。

## Frontmatter

```yaml
---
name: nextjs-app-router
description: Use when touching app/ in Next.js App Router — Server vs Client Components. Not for data fetching (see nextjs-data-fetching).
metadata:
  type: reference
  # maxWords: 520           # optional — override the type cap
  # maxWordsComposed: 700   # optional — ceiling for the ALREADY composed file (see below)
---
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | Skill ID（kebab-case）。 |
| `description` | 是 | 包含**激活触发条件**的一行描述（见下文）。 |
| `metadata.type` | 是 | `behavior` \| `reference` \| `tool`。必须放在 `metadata:` 下（#810）：顶层的 `type` 会被读取为 null。 |
| `metadata.maxWords` | 否 | 长度有明确理由时，提高该类型的字数上限。 |
| `metadata.maxWordsComposed` | 否 | plugin 扩展该 skill 时，限制最终组合文件的字数。 |

只有 `name`、`description` 和 `metadata` 能在各 engine（Claude Code、Codex、DeepSeek）之间通用；engine 专属键不会随之迁移。`description` 最多 500 个字符，这是三项限制中最严格的。当存在容易混淆的相邻 skill 时，描述末尾应使用 `Not for <neighboring skill>`。

## 各类型的字数上限

body（frontmatter 之后的所有内容）有字数上限。每次加载 skill 都会消耗 token，因此内容应保持精简。

| 类型 | 上限 | 用途 |
|---|---|---|
| `behavior` | ≤200 | 规定 agent 如何行动（例如 `verify-before-done`）。 |
| `reference` | ≤500 | 记录一种模式或技术栈（例如 `mantine-ui-patterns`）。 |
| `tool` | ≤300 | 封装外部工具。 |

Skill 超过上限时，测试会失败。若确实要超过上限，请声明 `maxWords: N`；覆盖必须明确、不能静默生效，并且**要在该字段旁边的注释中写明理由**。目前多个 core 资源使用了此设置，可用 `grep -rn 'maxWords:' packages/core/core-assets packages/plugins` 查看。

### `maxWordsComposed` — 会话实际加载的文件

`maxWords` 是**资源作者**的预算，衡量该文件自身的内容；不能因为 plugin 追加了一个章节，原本的理由就消失。`maxWordsComposed` 衡量的是**会话实际承担的预算**：最终的 `SKILL.md`，包含注入的所有 plugin 扩展和插入的项目值。

只有被其他内容扩展（`injectInto`）的 skill 才需要声明它。如果没有扩展该 skill，组合后的文件**就是**资源本身，`maxWords` 已足以衡量。真实示例：`review-diff` 声明 `maxWords: 1200` 和 `maxWordsComposed: 1450`——core 内容占 1200，plugin 扩展占 200，再留出空间给 render 插入该区块的 `project.criticalAreas`。

## `description` 中的触发条件

Host 会按需读取 skill 的 `description`，判断当前情形是否符合。触发条件会让 skill 在合适时机自动工作，因此它是文件中回报最高的一行：要包含激活动词，并说明什么时候该启用。

- ✅ `Aplica antes de tocar src/api/.`
- ✅ `Usar cuando definas contratos HTTP.`
- ✅ `Use when the user edits app/.`
- ↗ `Reglas de Medusa.` → 补充为 `Aplica cuando toques src/modules/.`
- ↗ `Automate browser interactions and test web pages.` → 说明了用途；还要说明何时启用

常见的西班牙语/英语动词都可接受（`Aplica`、`Usar`、`cuando`、`antes de`、`Use when/this`）：navori 资源使用英语编写，但你自己的 skill 可以使用自己的语言。

在文字型 engines（`AGENTS.md`、Codex、Cursor、Copilot）中，触发条件也会显示在 skills 索引里，只保留第一个分句并截断到 120 个字符，因此应把触发条件放在开头。`CLAUDE.md` 索引不再显示它（#908）：Claude Code 会从自己的原生列表读取完整 `description`。所有“何时使用”信息都应写在 `description` 中，而不是 body 的某个章节；只有 skill 激活后才会加载 body。

## 可选依赖：声明降级方案

如果 skill 依赖某项可能不存在于当前机器的能力——例如外部二进制、MCP 服务器、持久记忆——就在文件中写清缺少时该怎么办，不要假定它始终可用。否则，缺少依赖会被报告成“没有找到任何内容”，而不是“无法搜索”：这就是“silent skipping”反模式（#824）。通道不可用不等于结果为零；混淆两者会产生假阴性。`locate-code` 是一个例子：没有启用结构化或文本 provider 时，会退回到 `Grep`/手动阅读；未安装 `ast-grep` 时，会退回到 `Grep` 加有限范围阅读。每种降级方式都会说明自己的下一步，而不是默认读者知道该怎么做。

## 项目本地 skills

你在仓库中通过 `project.localSkills` 编写的 skill 遵循**相同的文件契约**，但有两点不同：

- **navori 从不修改它。** 它没有 managed 区块或 user-section；整个文件都由你拥有。
- **字数上限由你决定**——`skill-caps.test.ts` 检查的是打包资源。此处的上限仍是合适的参考，因为这些 token 的费用由你自己的会话承担。

`navori doctor` 会为此给出两条可操作的提示：声明的 ID 是否有对应文件（`missingLocalSkills`），以及 `description` 是否包含触发条件（`triggerlessSkills`）。它们是建议，不是阻断项，也不会改变最终判定。
