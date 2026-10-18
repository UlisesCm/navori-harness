> [English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

# Engines — 如何添加一个 provider

Engine 会将 harness（agents、skills、hooks 及引擎专属文件）转换为特定工具使用的格式：Claude Code 使用 `.claude/`，Codex 使用 `.codex/` 和 `AGENTS.md`，prose engines 使用 `AGENTS.md`/`.cursor/`/`.github/`。

本文档是后续 provider 必须实现的契约，也是实现检查清单。内容基于 Spec [0007](../../../../specs/0007-render-plan-unificado/design.md)（共享 spine）和 [0008](../../../../specs/0008-fase-c-claude-spine/design.md)（Claude 接入 spine）。

## 所有磁盘引擎共享的三层结构

```
resolveHarnessPlan ──▶ EngineAdapter (place*) ──▶ collectPlan ──▶ commitWrites
   (Capa 1, shared)      (Capa 2, por engine)       (Capa 3, shared, escribe una vez)
```

- **第 1 层 — `shared/harness-plan.ts`**：`resolveHarnessPlan(config, coreAssets, preset, { includeLeader })` 根据 config、preset 和 libraries 决定要输出**什么**（agents/skills/hooks）。它不处理路径或格式。所有引擎共用这一层；一致性测试（`__tests__/engine-parity.test.ts`）确保 Claude 和 Codex 从相同的资源清单开始。
- **第 2 层 — engine adapter（`<engine>/adapter.ts` 或内联实现）**：唯一因 provider 而异的层。它将每个计划中的 asset 映射为 `PlacementRequest`（目标路径和序列化方式），并声明 `extraFiles` 和 `orphanScans`。约 80 行声明式表格。
- **第 3 层 — `shared/execute-plan.ts`**：`collectPlan`（规划但不写入）加上 `commitWrites`（备份 → 原子写入 → chmod → 清理 → 报告）。这一层只实现一次，因此清理、防回滚或备份方面的修复会应用到所有引擎。

## `EngineAdapter` 契约（已冻结，定义于 `shared/execute-plan.ts`）

```ts
interface EngineAdapter {
  id: string;
  label?: string;                                    // nombre para el mensaje de error
  placeAgent(a: PlannedAgent, ctx): PlacementRequest | null;   // null = no lo emite
  placeSkill(s: PlannedSkill, ctx): PlacementRequest | null;
  placeHook(h: PlannedHook, ctx): PlacementRequest | null;
  extraFiles(ctx): PlacementRequest[];               // settings.json / config.toml / AGENTS.md
  orphanScans(plan, ctx): OrphanScan[];              // poda de huérfanos managed
}
```

Adapter 不声明备份范围：`commitWrites` 会根据将要写入或删除的文件推导备份内容（#405）。这样可以避免某个引擎备份不足（例如漏掉 `.mcp.json`）或过多（例如仅改 1 字节却备份整个 `.claude/`）。

这条规则不只适用于 engines：**render 的每次写入都必须经过这个统一入口**，包括不属于任何引擎的写入。`.gitignore`（仓库级，`shared/gitignore-harness.ts`）过去会直接写入，是最后一个绕过备份的地方——而这恰好是 Navori 不会新建、只会向用户已有文件注入区块的文件（#458）。新增写入时必须经过 `commitWrites`；`shared/__tests__/render-writes-backed-up.test.ts` 中的 guard 会检查这一点。

该 guard 有两个明确的限制，不能把上面的规则误读成比实现更广泛的保证。它会扫描 `src/engines/**` 和 `commands/render.ts`，因此从 render 调用的 `src/lib/**` 新写入会漏检（目前 render 的四个写入位置都在扫描范围内）。它还按**模块**判断：只要一个文件在任意位置调用 `commitWrites`/`createBackup`，即使旁边新增了原始写入也会通过。该测试的行为部分只覆盖 fixture 实际执行的路径。若要检查到语句级别，需要 ast-grep。

`PlacementRequest` 有两种形式：asset（`assetPath`，由 `renderManagedFile` 渲染）或已由 adapter 序列化的 `body`（`config.toml`、agent `.toml`）。`firstRenderSeed` 仅在首次 render 时初始化 header/trailer。

## 契约未涵盖内容的扩展点

- 有自有文件（settings、scripts 或类似 `CLAUDE.md` 的 pipeline）的引擎，应在 `render<Engine>Engine` 函数中构建这些文件，将自己的 `pending` 与 `collectPlan` 的结果合并，然后只调用**一次** `commitWrites`。这样可以共享备份行为、写入顺序和错误处理。可参考 `claude/index.ts`（CLAUDE.md pipeline，以及仅 Claude 使用的 spine 三方协调）。
- `commitWrites` 为合理差异提供了参数：`writeLast`（最后写入哪个文件）、`backupExclude`（引擎额外排除项；临时文件始终排除）、`engineLabel`、`removalsBestEffort`，以及 `collectPlan` 中本地化的跳过说明 `skipReason`。

## Provider #3 的 spike 检查清单（Phase 0 的四个未知项）

编写 adapter 前，先针对真实 CLI 解答以下四个问题（Spec 0004 §Phase 0 为 Codex 使用了这一方法）：

1. **Hook payload** — hook 会收到什么信息，通过哪个通道传入（stdin/env/arg）？有哪些事件（PreToolUse/SessionStart/Stop 等）？它们是否在 sandbox 中运行？
2. **Skill 发现机制** — 工具从哪个目录读取 skills？（Codex：`.agents/skills/<id>/SKILL.md`；Claude：`.claude/skills/<id>/SKILL.md`，必须采用目录形式——Claude Code 只会自动发现这种形式，不会发现平铺的 `<id>.md` 文件。）
3. **配置位置** — 项目配置存在哪里，采用什么格式？（Claude：`.claude/settings.json`；Codex：`.codex/config.toml`。）
4. **模型映射** — 工具如何命名模型？将 Claude 的 tiers（opus/sonnet/haiku）映射到具体 id（参见 `CODEX_MODEL_BY_CLAUDE_TIER` 和 `models.codexMap` 覆盖项，Spec 0007 M3）。

## DT-2 标准 — 何时进一步抽象（三次原则）

只有两种实现时，抽象容易凭空猜测；有三种实现后，才能基于真实案例提取共同点。Codex 和 Claude 已经共享 spine（第 1 层和第 3 层）。`EngineAdapter` 契约（第 2 层）应当**在 provider #3 的实现已知后调整**，而不是提前定型：固定的是三层结构，而非每个函数签名。出现引擎间分歧的 bug（“修复应用到了一个引擎，却漏了另一个”）也足以成为进一步抽象的理由。

## Split root 中的 skills（`.agents/skills/`）— 已封定（Spec 0007 M7）

Codex 从 `.agents/skills/<id>/SKILL.md` 发现仓库 skills。该目录是**跨工具**约定：遵循 `AGENTS.md`/`.agents/` 约定的其他 agents 也能读取。Codex 的其他配置位于 `.codex/`。

这种拆分（skills 放在 `.agents/`，其他内容放在 `.codex/`）已**封定**：它提供无需额外成本的多 provider 接缝。第三个同样读取 `.agents/skills/` 的 provider 可以直接共享 skills，无需重新 render。不要把它们合并成单一的引擎专属目录树。

**目标仓库的建议**：将 `.agents/skills/` 和 `.codex/` 纳入版本控制（它们由 Navori 管理，可用 `navori render` 重建，但在 PR diff 中仍有参考价值）。如果不想纳入版本控制，就把它们与 `.claude/` 一起添加到目标仓库的 `.gitignore` 中——Navori 不管理仓库的 `.gitignore`，由团队决定。

> **`.codex/hooks/` 与 worktrees**：与 `.claude/` 不同，将 `.codex/hooks/` 纳入版本控制并非仅为整洁。如果 `.codex/` 被 git 忽略或未跟踪，新建的 git worktree **不会继承它**。在该 worktree **中**启动的 Codex session 会以项目根目录（worktree 的 `.git` 标记）解析配置，找不到 `.codex/config.toml`，因此**不会注册 hooks**——破坏性命令 guard 会在没有提示的情况下失效。Codex 使用 *session cwd* 运行 hooks，也不提供项目根目录环境变量（相当于 `$CLAUDE_PROJECT_DIR`），所以通过路径解析无法修复。可靠的防护方式是将 `.codex/hooks/` **纳入 git 跟踪**，让它出现在每个 worktree 和 clone 中。文件未跟踪时，`navori doctor` 会发出警告（`guardNotVersioned`）。

## Prose engines（agents-md / cursor / copilot）— 不使用该 spine

这些引擎共享自己的 spine（`renderProseFile`），并且只是约 40 行的包装器。它们不会为每个文件分别输出 agents/skills/hooks；将其迁移到 `EngineAdapter` 只会增加改动，不会带来收益（Spec 0007 DT-1）。

每个 adapter 都会将自己的 `engine`（`"agents-md"`、`"cursor"`、`"copilot"`）传给 `renderProseFile`，这是必需的（#1273）。该函数会解析保留的条件键 `onCodex` 和 `onClaude`（两者都忽略 config）。只有 `engine === "claude"` 时 `onClaude` 才为 true：`CLAUDE.md` 会接收不变量以及 `intake-tickets` 和 `sdd` 的指针；prose engines（以及 Pi）不会加载 skills，因此会保留完整文本。
