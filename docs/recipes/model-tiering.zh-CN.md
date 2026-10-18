> [English](model-tiering.md) | [Español](model-tiering.es.md) | [简体中文](model-tiering.zh-CN.md)

# Recipe — 按 agent 配置模型档位和 effort

> 说明如何为 `{{models.<agent>}}` / `{{effort.<agent>}}` 选择值。这些占位符会由 render 插入每个 `.claude/agents/*.md` 的 frontmatter。
> 默认值位于 `packages/cli/src/lib/config/recommended.ts`（`RECOMMENDED_MODELS`、`RECOMMENDED_EFFORT`），并由 `init --recommended` / `--full` 写入 `navori.config.json`。由 `packages/cli/src/lib/__tests__/recommended.test.ts` 强制验证。

## 原则

根据每个 agent 的任务需求选择模型，不要给所有 agent 使用同一个档位：

- **机械工作**（映射目录、起草 commit）：选择便宜、快速的档位。
- **常规实现**（按已有计划编写代码、文本综合）：选择中档。
- **判断工作**（review、审计、架构决策）：选择顶档。

如果没有明确的配置，每个 subagent 都会继承会话模型（通常是最贵的模型），因此机械工作也会按判断工作的价格运行。

## 建议的默认值

这些是真实的 `ModelsSchema` / `EffortSchema` 键（`packages/cli/src/lib/config/schema.ts`），与 `core-assets/agents/` 下的文件 ID 对应。规范 roster 位于 `engines/shared/roster.ts`（`ROSTER_AGENTS`）。

| Agent | `models.<agent>` | `effort.<agent>` | 原因 |
|---|---|---|---|
| `orchestrator` | `opus` | `xhigh` | 负责协调、确定范围并裁决 `CHANGES_REQUESTED`；它是唯一纯判断角色，因此不降档。 |
| `architect` | `opus` | `xhigh` | 设计 2/3 级任务（级别由 `navori plan classify` 决定，与模型无关）：在任何人写代码前会阅读大量代码并权衡取舍；保持 orchestrator 档位（spec 0026 F），而不是降到综合任务档位。 |
| `implementer` | `sonnet` | `medium` | 根据已明确范围的任务编写代码；在编码方面，sonnet 的表现接近 opus，成本却低得多。 |
| `reviewer` | `sonnet` | `medium` | 根据 spec/quality gate 做 review——这是按契约进行综合，不是从头设计架构。 |
| `scout` | `sonnet` | `medium` | 针对范围明确的问题绘制地图和/或调查，并整理发现，而不是只列出文件。 |
| `auditor` | `sonnet` | `medium` | 架构审计（SOLID、安全、性能、边缘情况）更接近判断而不是综合；`auditor.md` 明确指出这一点。 |
| `publisher` | `haiku` | `low` | 根据已批准的 diff 起草 commit、PR 和评论——属于机械工作。 |
| `scribe` | `haiku` | `low` | 将已验证的证据序列化为 Markdown——和 publisher 一样属于机械工作。 |

## Effort 遵循相同逻辑

`effort.<agent>` 是同一维度上的另一个控制项：昂贵模型加高 effort，意味着每次调用消耗更多推理 token，也会调用更多工具。机械任务使用 `sonnet`/`low`，整体成本仍低于同一个 agent 使用 `opus`/`xhigh` 并在一个会话中运行 N 次的成本（例如 fan-out 中每个子地图各启动一个 `scout`）。`orchestrator` 的 `effort` 还会初始化 `settings.json` 中的 `effortLevel`，因为该角色是主 agent，不会作为 subagent 启动，因此没有其他位置可以设置它的档位。

## Codex

Codex 会独立解析模型和 effort。各系列默认值为 Opus → Sol、Sonnet → Luna、Haiku → Luna；`models.codexMap` 可以把每个档位映射到其他系列或完整 ID。完整 ID（例如 `gpt-6-sol`）是固定版本；系列名（例如 `sol`、`luna`、`astra`）会从 Codex 本地目录中选择最高且兼容的编号版本，例如 `gpt-6.1-sol`。

Claude 的 effort 只参与 Codex 解析：即使模型来自固定版本或 `codexMap`，Sonnet 配合 `medium` 也会转成 `high`。其他 effort 值保持不变（`Sonnet low` 仍是 `low`，`Sonnet high` 仍是 `high`）。按 agent 设置的显式覆盖值会在对应字段优先。

可在 `models.codexProfiles` 中按原生 TOML agent 名称定义覆盖值。键必须使用精确名称，例如 `implementer`；`orchestrator` 保留给主 agent，并使用 `.codex/config.toml`。每条记录可以独立设置 `model`、`effort` 或二者：

```json
{
  "models": {
    "codexProfiles": {
      "orchestrator": { "model": "gpt-6.1-sol", "effort": "xhigh" },
      "implementer": { "model": "luna", "effort": "medium" }
    }
  }
}
```

清单包括主 agent、已启用的 Codex agents，以及 navori 不管理的项目原生 TOML 文件。这些文件从 checkout 中读取；不会重写用户本地文件。render 会表达供未来启动使用的托管意图，并保留用户字段、同系列中较新的值以及由用户拥有的 agent TOML。

`models_cache.json` 中的条目只提供候选项。如果没有经过外部验证的来源、时间戳和上下文，新鲜度就是 `unknown`；如果目录缺失、格式错误或没有兼容条目，状态就是 `degraded`。缓存、mtime 和 slug 都不能证明当前可用性。`configured`、render 候选项和 `observed` 是不同状态：如果没有与已启动上下文关联的观察结果，有效结果仍然未知，应用状态为 `pending`。补救方式是启动新的 Codex 上下文，并在那里核实模型与 effort。本文不声称不同模型的质量等价。

Pi 保留其显式的 `codexMap` 使用方，但它只解析模型；effort 转换和按名称设置的覆盖值仅适用于 Codex。Claude 配置保持不变。

## 不要全部设置为顶档

成本按调用次数累积，而不是按会话累积。每个 agent 都用 `opus`/`xhigh`，不会提升不需要真实判断的任务质量，只会让每次调用都消耗预算。`init --recommended` / `--full` 会写入表格中的默认值；`init --yes` 什么都不写（每个 subagent 都会继承会话模型）。

## 何时提高档位

看具体信号，不凭直觉：同一复杂任务连续出现 2 次或更多 `CHANGES_REQUESTED` 循环（上限已记录在 `orquestacion.md`），说明 `implementer` 或遇到困难的角色当前档位无法应对该复杂度，而不是还需要重试。再次循环前，将该 agent 提高一个档位。

## 按修复项分档，不按整轮 review 分档

一次 review 产生 N 个发现时，不要把整轮都交给同一个高档位。应根据每项修复所需的能力分类，而不是根据它属于哪一轮分类。这是把上文“原则”应用到每项修复，而不是每个 agent；一轮内可以并存不同档位的子任务。

| 修复类型 | 示例 | 档位 |
|---|---|---|
| 机械工作 | 字符串表、JSON 编辑、一行说明、重命名 | 低/中 |
| 判断工作 | 设计决策、安全正则、移除语义 | 高 |
