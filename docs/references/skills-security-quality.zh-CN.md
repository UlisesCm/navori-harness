> [English](skills-security-quality.md) | [Español](skills-security-quality.es.md) | [简体中文](skills-security-quality.zh-CN.md)

# Skills 安全与质量参考

最近审查：2026-10-12。本文记录内容来源，不是标准副本，也不构成默认安装授权。

## 已关闭的 skills 清单

| Skill 集合 | 支持的依赖/版本 | 官方来源 | 触发条件 | 验证证据 |
|---|---|---|---|---|
| Core：`verify-before-done`、`debug-failure`、`review-diff`、`security-invariants`、`locate-code` | Harness CLI 0.12.2 资源；每次发布更新此行 | https://github.com/ulisescm/navori-harness | 对应的 frontmatter 描述 | 资源上限、roster 与渲染测试 |
| 工作流：`resolve-ticket`、`solution-design`、`spec-bootstrap`、`dominio`、`follow-up-prs` | Harness CLI 0.12.2 资源；每次发布更新此行 | https://github.com/ulisescm/navori-harness | 对应的 frontmatter 描述 | 资源上限、roster 与渲染测试 |
| `zod-validation` | Zod 4.4.3 | https://zod.dev | 信任边界验证 | 锁定的包及片段回归 |
| `vitest` | Vitest 5.0.1 | https://vitest.dev | Vitest 测试 | 锁定的包及片段回归 |
| `citty` | Citty 0.1.6 | https://github.com/unjs/citty | Citty CLI 变更 | 锁定的声明回归 |
| `clack` | @clack/prompts 0.10.0 | https://clack.cc | 交互式 CLI 流程 | 锁定的包及资源回归 |

之前的 0.8.7 条目是审计基线；此表记录当前版本生成的资源，不将旧版本保留为受支持版本。

## 外部参考资料与供应商 skills 评估

| 项目 | 规范 URL 与不可变版本 | 条款 / 允许的用途 | 权限与隐私 | 负责人 | 可逆试点 |
|---|---|---|---|---|---|
| OWASP ASVS | https://github.com/OWASP/ASVS/releases/tag/v5.0.0 — 5.0.0 | CC BY-SA 4.0；引用选定控制项 ID，不复制检查清单 | 不访问工具；标准仅作为参考数据 | 安全负责人 | 仅映射 fixture；不改 roster、config 或 hooks |
| NIST SSDF | https://csrc.nist.gov/pubs/sp/800/218/final — SP 800-218 rev. 1.1 | NIST 公开出版物；在本地引用并总结 | 不访问工具 | 安全负责人 | 仅映射 fixture；不改 roster、config 或 hooks |
| SLSA | https://slsa.dev/spec/v1.1/ — v1.1 | CC BY 4.0；仅引用来源级别 | 不访问工具 | 安全负责人 | 仅映射 fixture；不改 roster、config 或 hooks |
| ISO/IEC 25010 | https://www.iso.org/standard/78176.html — 2023 版 | ISO 版权内容；仅用作属性模型，不复制文字或表格 | 不访问工具 | 架构负责人 | 矩阵 fixture 仅使用自有标准 |
| OpenAI security-best-practices | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | 适用仓库条款；重新分发前先评估 | 只读 fixture 审查；不启用 hooks 或工具 | 安全负责人 | 未安装；不改 roster、config 或 hooks；回滚无需操作 |
| OpenAI security-threat-model | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | 适用仓库条款；重新分发前先评估 | 只读 fixture 审查；不启用 hooks 或工具 | 安全负责人 | 未安装；不改 roster、config 或 hooks；回滚无需操作 |

今后任何采用都需要明确批准、记录权限与隐私审查、设定退出条件的有限试点，并在回滚时移除新增的 skill 或插件。默认配置仍是两个本地轻量 skills。
