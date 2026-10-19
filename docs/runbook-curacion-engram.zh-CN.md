> [English](runbook-curacion-engram.md) | [Español](runbook-curacion-engram.es.md) | [简体中文](runbook-curacion-engram.zh-CN.md)

# Runbook — engram 语料整理（#761，决策 1）

> **本文档不会修改任何内容。** 它是某项会产生修改的操作的书面流程：
> `~/.engram/engram.db`，即用户的个人存储，位于本仓库之外、git 之外，没有 diff，也无法撤销。完整读完本文，比恢复一次 `export` 更省事。
>
> 所有数字均于 **2026-09-13 21:04 CST** 根据 `engram v1.20.0` 测量。语料是持续变化的：**这些数字会漂移**。文末说明如何重新测量。

## 本文档的由来

[#761](https://github.com/UlisesCm/navori-harness/issues/761) 汇集了用户的两项决策。**决策 2**——让 `researcher` 和 `explorer` 使用 memory——**已经决定并交付**，提交为 `4dd7a78`（#768），其正文明确写着 *"Decisión 2 de #761"*。本文末尾附有证据，证明该项已关闭。

**决策 1**——整理语料——仍未决定，且 **PR 无权代为决定**。没有仓库文件需要修改：这是数据库变更，reviewer 看不到，`git revert` 也无法恢复。

本 runbook 是适合放进 PR 的交付物：它将未决问题转化为**信息充分的“是/否”选择**。内容包括测量得到的现状、按风险从低到高排列的步骤，以及证据表明需要的防护措施。

**这件事其实已经写过一次。** `specs/0005-search-efficiency-layer/design.md:137` 把同一操作标记为 **“一次性个人存储清理（操作，不是 navori 功能）”**，并在 `:206` 将其原样列为待决事项：*“现在执行一次性个人存储清理（§5.3），并与计划分开吗？”* #761 的决策 1 **就是几个月后从另一条路径重新发现的同一个问题**。保留本文就是为了避免第三次重新发现。

---

## ⛔ 不得在未检查时运行的操作

这一类有两个命令，按本能输入的语法运行会造成损害。它们放在前面，因为阅读顺序比逻辑顺序更重要。

### 陷阱 1 — `engram projects consolidate --all` 会合并不同仓库

在 **2026-09-13 21:04 CST** 运行时，`engram projects consolidate --all --dry-run` 提出了 **7 组**。**第 4 组具有破坏性**：

| 第 4 组 — 将合并到 `navori-harness` | obs |
|---|---:|
| `alertaciudadana` | 1 |
| `alertaciudadana_app` | 237 |
| `alertaciudadana_backend` | 227 |
| `alertaciudadana_backend_audit` | 1 |
| `navori` | 14 |
| `navori-ab-smoke2` | 0 |
| `navori-dashboard-template` | 96 |
| `navori-health` | 104 |
| **吸收总数** | **680** |

**来自真实不同仓库的 680 条 observations 会被合并到 `navori-harness` 中**（它当前有 681 条），把两个无关产品的 memory 混入本项目。**第 5 组**会把 `reports-server-bonum`（38 obs）并入 `notifications-server`（60 obs）。

**交互模式默认也不安全：**从仓库根目录运行且不带 `--all` 时，命令会识别出 `navori-harness`，并建议将 `navori`（14 obs）和 `navori-health`（104 obs）并入其中。这两个都是不同的代码库。对该提示的正确回答是 `none`，当时也确实如此选择。

**规则：禁止使用 `--all`。** 只能通过交互提示、逐组人工验证并选择明确编号。今天 dry-run 中的合法组——被吸收的一侧均为 0–3 obs——包括：

- `bonum-services-sessions` (1) → `services-sessions` (12)
- `poker-2` (3) → `poker` (3)
- `codex-spike` (0) + `codex-spike2` (0)
- `.g-p-683086de…-previous-dcdb38aa…` (1) → `g-p-683086de…` (3)
- `alertaciudadana` (1) 和 `alertaciudadana_backend_audit` (1) → **各自真正所属的仓库**

最后一点有个需要留意的例外：`alertaciudadana` 与 `alertaciudadana_backend_audit` 确实应该合并，但**第 4 组会把它们放入 `navori-harness`，而不是它们真正所属的仓库**。接受这组来保留合法项，也会一并接受灾难性合并。应分别处理，并从要作为 canonical 的那个仓库目录中运行。

dry-run 还提出了一组，**即使规模很小也不能接受**：第 2 组把 `con-harness`（4 obs）与 `sin-harness`（0 obs）合并。它们分别是对照实验的两个分支；合并后恰好会抹去它们有用的区别。操作前先验证。

### 陷阱 2 — `engram export --help` 会把导出内容写到名为 `--help` 的文件

`engram export` 将目标作为**位置参数**，没有帮助 flag。因此，`engram export --help` **不会显示帮助，而是把完整导出写入名为 `--help` 的文件**。测量结果：文件大小 **9.9 MB**，权限为 `-rw-r--r--`（644），其中明文保存了全部 **1,798** 条 `user_prompts` 行。

如果从仓库中运行，文件就会落在 **git 工作树内**，只差一次 `git add -A` 就会被永久提交。

因此有两条规则：

1. **备份绝不能写入任何仓库。** 目标路径必须位于所有工作树之外（例如 `~/` 下），并在运行后执行 `git status`，确认没有文件落进仓库。
2. **使用 `engram help`**（或 `engram --help`）查看 `engram` 的 flags。它会打印所有子命令的完整帮助，且**不会写入任何内容**。`engram help <subcommand>` 也安全，但会忽略参数并打印同一份全局帮助。

`engram <subcommand> -h` **不是可靠的途径**：有些命令可用（`engram doctor -h` 会打印真实 usage），有些则不行（`engram stats -h` 会忽略 flag，直接运行 `stats`）。对于首个参数为位置参数的子命令——`export`、`import`、`save`、`search`、`delete`——`-h` 可能会被当作参数：具体影响取决于子命令，只有 `export` 会写文件，但它们都不是安全的求助方式。**不要在这些命令中试用。**

---

## 语料现状（测量结果）

测量时间为 **2026-09-13 21:04 CST**，使用 `sqlite3 -readonly` 读取 `~/.engram/engram.db`。只读取计数和 key；没有任何 `observations.content` 或 `user_prompts.content` 离开数据库。

**数字会漂移，而且速度很快。** #760 周期中，`navori-harness` 的存活 observations 先后出现五个值：670 → 674 → 675 → 676 → **681**。基于下列数字采取行动前，都必须重新测量。

### `navori-harness` — 681 条存活 observations

| type | obs | % |
|---|---:|---:|
| `manual`（未整理的类型） | 217 | **32%** |
| `session_summary` | 132 | **19%** |
| `decision` | 96 | 14% |
| `project` | 60 | 9% |
| `discovery` | 48 | 7% |
| `architecture` | 39 | 6% |
| `bugfix` | 37 | 5% |
| `config` | 10 | 1% |
| `pattern` | 7 | 1% |
| `bug` | 6 | 1% |
| `learning` | 5 | <1% |
| `solution` · `bug_fix` | 各 4 | <1% |
| `task` · `reference` · `convention` | 各 3 | <1% |
| `preference` · `feedback` | 各 2 | <1% |
| `research` · `progress` · `incident` | 各 1 | <1% |

**Durable 类型**（`decision` + `architecture` + `convention` + `pattern`）合计 **145 = 21%**。换言之，每五次写入中有一次属于协议所描述的目标类型，而近三分之一的语料是默认类型 `manual`。

### 缺口

| 信号 | navori-harness | 占存活语料比例 |
|---|---:|---:|
| 缺少 `title` | **352** | 52% |
| 缺少 `topic_key` | **437** | 64% |
| `revision_count > 1` | 47 | 7% |
| soft-deleted | 0 | — |
| 有 `review_after` | 99 | 15% |
| `review_after` 已过期 | 0 | — |

缺少 `title` 的 352 条记录中，**64 条属于 durable 类型**（`decision` 41、`architecture` 23）。这是步骤 1 收益最高的部分：半年后有人会想找到它们，而目前只能逐条打开才能区分。

### `type` 词汇分散

`bugfix`（37）+ `bug`（6）+ `bug_fix`（4）是**同一概念的三个 key**。整个数据库中的数量为：`bugfix` 311、`bug` 45、`bug_fix` 9。只要这种情况持续，`mem_search --type bugfix` 就会漏掉 `navori-harness` 中 **47 条里的 10 条（21%）**，以及全库 **365 条里的 54 条（15%）**。

### `engram doctor` 返回 `blocked`

```
engram doctor --json --project navori-harness
```

→ `"status": "blocked"`，共 4 项检查，3 项 ok，**1 项 blocked**：

```
sync_mutation_required_fields — sync_mutation_payload_missing_required_fields
  observation payload missing required fields: title
  evidence: {"entity":"observation","entity_key":"obs-c08da4feeb4afbdd",
             "missing_fields":["title"],"op":"upsert","project":"navori-harness",
             "seq":15579,"target_key":"cloud"}
```

这是 observation **#2756**（`discovery`，存活，缺少标题）。可用以下命令查看详情：
`engram doctor --project navori-harness --check sync_mutation_required_fields`。

它与 352 条无标题记录是同一种症状，只是更底层：排队中的 sync mutation 缺少一个字段。**注意不要过度承诺：**给语料补标题会消除这类原因；是否也会清除这条具体 mutation（`seq` 15579）尚未验证。`doctor` 自己建议的下一步是 `engram cloud upgrade doctor --project navori-harness`——但此命令**不在 `engram help` 中**（已记录的 `cloud` 子命令为 `status`、`enroll`、`config` 和 `serve`）。运行前先确认该命令。

### `embedding IS NOT NULL` ⇒ **0 行**，但语义扫描并不依赖它们

`navori-harness` 和整个数据库（2,964 条存活 observations）都没有 embedding。**这不会使 `engram conflicts scan --semantic` 失效**：该路径使用通过 `ENGRAM_AGENT_CLI` 配置的 LLM runner，而不是 `embedding` 列。

于 **2026-09-14 14:05 CST** 验证：设置 `ENGRAM_AGENT_CLI=claude`、`--dry-run`、`--max-semantic 10`、并发为 1、每次调用超时 20 秒。扫描检查 689 条 observations，找到 3 个候选项，判断 1 项，跳过 2 项，报告 0 个语义错误；结果为 `inserted: 0` 和 `dry_run: true`。这次运行用了几分钟，发现阶段针对 parser 无法转成 query 的内容发出了 3 个 FTS5 错误，但最终 exit 0。它确实能提供候选项，但不是即时或穷尽式操作。

该运行前已持久化的关系来自人工判断：`engram conflicts stats --project navori-harness` 报告全库 `memory_relations` 的 131 行中，有 9 条经过判断（6 条 `not_conflict`、3 条 `related`）。`--dry-run` 没有新增任何关系。

### 全局情况

同一次运行中的 `engram stats` 和 `engram projects list`：**2,964** 条存活 observations · **1,162** 个 sessions · **1,798** 条 prompts · **37** 个 projects。全库有 **1,241** 条 observations 缺少 `title`（42%）。

---

## 操作步骤

按风险从低到高排序。**每一步都要单独授权**：第 1、2 步成本低且可逆；第 3、4 步需要格外小心。“先做 1 和 2，剩下的以后再说”是完整答案，也很可能是第一次执行时最合适的选择。

### 步骤 0 — 备份，不可省略

```
engram export ~/engram-backup-2026-09-13.json
```

已验证：exit 0；打印 `Exported to <path>` 以及三个计数（`Sessions` / `Observations` / `Prompts`）。生成的文件包含 `version`、`exported_at`、`sessions`、`observations` 和 **`prompts`**。

运行此命令时必须一并做到三件事：

- **放在所有仓库之外。** 参见陷阱 2。运行后检查当前所在工作树的 `git status`。
- **立即执行 `chmod 600`。** 文件初始权限为 `-rw-r--r--`（644），并包含 1,798 条明文 prompts。它与原始数据库面临相同的暴露风险。
- **用 `engram import <file>` 恢复**，该用法记录在 `engram help` 中。本次测量没有测试恢复。要测试时请使用 **`ENGRAM_DATA_DIR`**：它接受一个目录，并让二进制打开 `<directory>/engram.db`；`ENGRAM_DB` 不存在，会被静默忽略。导入前创建私有临时目录，并确认 `stats` 显示该路径且 observations 为零：



```sh
  restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/engram-restore.XXXXXX")"
  chmod 700 "$restore_dir"
  ENGRAM_DATA_DIR="$restore_dir" engram stats
  # Solo si Database apunta a "$restore_dir/engram.db" y Observations es 0:
  ENGRAM_DATA_DIR="$restore_dir" engram import ~/engram-backup-2026-09-13.json


```

  不要将 `ENGRAM_DATA_DIR` 指向 `~/.engram`；如果 `stats` 显示真实 store，也不要继续。

### 步骤 1 — 为缺少 `title` 的 observations 添加标题

**风险：无。** 这是纯新增：`mem_update(id, title)` 不会修改 `content`、`type` 或 `topic_key`。

`navori-harness` 中有 352 条候选记录。先处理其中 **64 条 durable 记录**（`decision` 41、`architecture` 23），这是未来 `mem_search` 最需要通过标题区分的部分。

标题应写成**结论本身，而不是主题标签**：搜索结果会优先显示标题；标题含糊时，读者只能打开整条 observation 才知道内容。

这一步也会处理 `doctor` 返回 `blocked` 的原因。结束后重新运行 doctor，检查该 finding 是否消失，或者是否需要执行 doctor 自己建议的后续步骤。

### 步骤 2 — 规范化 `type` 词汇

**风险：低。** 可逆且机械：通过 `mem_update` 将 `bug` → `bugfix`，`bug_fix` → `bugfix`。`navori-harness` 中有 10 条，全库有 54 条。

收益：`mem_search --type bugfix` 不再漏报。先决定范围是仅 `navori-harness`，还是覆盖全部 37 个 projects。两种范围使用相同标准，但工作量不同。

其他孤立类型（`solution` 4、`task` 3、`progress` 1、`incident` 1、`project` 60）**不会自动纳入这一步**：`project` 有 60 条，不是打字错误，而是有意使用的类型；重写前必须先弄清其用途。

### 步骤 3 — 合并语义重复项

**风险：中。由 agent 逐对判断。** 不运行批量操作。

从本次运行确认存活的两对开始：

| ids | type | topic_key |
|---|---|---|
| **2901** / **2902** | `discovery` / `manual` | `routing/tool-routing-audit` / `navori-audit-tool-routing-2026-09` |
| **2903** / **2904** | `discovery` / `manual` | `audit/skill-attribution` / `navori-skill-attribution-2026-09` |

**SQL 为什么找不到它们，这是本 runbook 的重点：**`navori-harness` 中，重复存活行的 `topic_key` 有 **0 个**，重复的 `normalized_hash` 也有 **0 个**。就是零。尽管如此，上述四条记录仍是两组关于同一事实的重复项。每对的 `type` **和** `topic_key` 都不相同——一个 key 遵循 `<area>/<slug>` 约定，另一个将月份写进 key——所以没有确定性规则能把它们归为一组。**脚本发现不了这类重复；阅读标题和内容的 agent 可以。** `specs/0005-search-efficiency-layer/design.md:129-130` 早已作出相同判断：*“这是判断工作 → agent，而不是机械 hook（脚本不知道什么是‘重要’）。”*

`engram conflicts scan --project navori-harness --dry-run --semantic` 在 `engram help` 中有文档说明，且**即使 embedding 为零，也会提出候选项**：它使用 `ENGRAM_AGENT_CLI` 指定的 runner。上方测量的运行找到 3 项并判断 1 项。结果仍只是需要先 review 再 apply 的提议。该命令摘要不显示具体配对，因此不能据此断言它是否包含此表中已经确认的两对。

实际合并方式：将内容归并到一条**符合约定的** `topic_key` observation 中，并对另一条执行 soft-delete（步骤 4）。

### 步骤 4 — 清理易变快照

**风险：最高。这是唯一会删除数据的步骤。**

- **使用 soft-delete，这是 `engram delete <obs_id>` 的默认行为。绝不要使用 `--hard`。** `--hard` 无法撤销，而当前语料中有 **0 条 soft-deleted**，因此回收区是空的，可以使用。
- **绝不删除 `decision` 或 `architecture`。** 这不是偏好，而是此 harness 所渲染协议的要求：`packages/plugins/engram/managed/engram-protocol.md:11` 写着 *“Never aggressive deletion, never delete a durable decision”*。
- 合法候选项：一次性测量、PR 状态、某次运行结果——也就是该会话的 `session_summary` 已经覆盖的内容。`mem_review(action: list)` 会列出已过 `review_after` 的记录；目前是 **99 条中的 0 条**，因此暂时不能通过这条路径产生候选项，需手动筛选。
- 本次测量没有运行 `engram delete <obs_id>`。该命令记录在 `engram help` 中。

### 授权摘要

| 步骤 | 操作 | 可逆 | 可单独授权 |
|---|---|---|---|
| 0 | `engram export` | 不适用 | 必须做，不是可选项 |
| 1 | 为 352 条记录添加标题 | 是（`mem_update`） | 是 |
| 2 | 规范化 `type` | 是（`mem_update`） | 是 |
| 3 | 合并重复项 | 如果是 soft-delete 则可逆 | 是，但每一对都需人工判断 |
| 4 | 清理易变记录 | 如果是 soft-delete 则可逆 | 是 |

---

## 诊断：始终只读，且不读取文本

**标准：**使用 `sqlite3 -readonly` 执行 `COUNT` / `GROUP BY`，或使用 `engram stats` / `engram doctor --json`。**绝不执行 `SELECT content`。绝不查询 `user_prompts` 表。** 本文中的所有测量都遵守这一标准。

### 为什么有此标准

`~/.engram/engram.db` 保存了**约 1,798 条用户 prompt 的明文**，权限为 **`-rw-r--r--`（644，任何本机用户都可读）**。使用 `stat -f "%Sp %z %N" ~/.engram/engram.db`（20.5 MB）和对 `user_prompts` 执行 `COUNT(*)` 验证。与它配套的 `engram.db-wal` 另有 4.3 MB，权限相同。

数量前的“约”并不是疏忽：`COUNT(*)` 返回 **1,797**，同一次运行一分钟后执行的 `engram stats` 返回 **1,798**。测量期间语料也在增长——所以本文的每个数字都附有时间。

这与未决决策 B6 所指出的 `~/.navori/audits` 暴露风险属于**同一类问题**——`.claude/progress/audit_deep_navori-audit.md:18`，在 `progress/current.md:153-154` 中标为 *“B6（prompts 以明文写入日志）”*——但**高出一个层级，数量也更多**：B6 讨论的是每个 session opt-in 的日志；这里是整个始终启用的 store。

**B6 仍未回答**（*“在报告中加隐私说明、权限设为 600，还是不处理？”*，`.claude/progress/audit_deep_navori-audit.md:126`）。此发现又增加了一个问题：无论对 `~/.navori/audits` 的决定是什么，都要考虑是否同样适用于 `~/.engram/engram.db` 和步骤 0 生成的 `.json`。

### 已遵循该标准的先例

`scripts/py/mine-topic-keys.py`——随 **PR [#784](https://github.com/UlisesCm/navori-harness/pull/784)** 交付，并于 2026-09-14 合并——已经按同样规则读取这个数据库，可作为范例：

- 它通过 URI **`mode=ro`** 打开数据库，不依赖注释中的承诺：*“脚本不发出 INSERT 是代码的属性，不是运行通道的属性。URI 让它变成运行通道的属性。”*
- 它在常量中声明**一个表和五列**，并据此构造 `SELECT`：`observations` × (`topic_key`、`type`、`revision_count`、`project`、`created_at`)。其中没有任何用户文本。
- 它的测试（`packages/cli/src/lib/__tests__/mine-topic-keys.test.ts`）会验证而不是只声称：*“不读取 observation 正文或 prompts 表”* 会断言源码**不包含** `user_prompts` 或 `content`；*“确实以只读方式打开 DB：INSERT 会被拒绝”* 则用真实数据库验证。

任何新增诊断查询都必须达到这一标准。

---

## 不要做什么，以及原因

每次有人正面检查这个问题时，下面两个想法都会再次出现。本文记录它们及其反驳，让下次只需读一段，而不必重新做一轮审计。

### 不要：在 navori 中加入版本管理的语料整理脚本

一个看似诱人的方案是 `scripts/curate-engram.py`，默认只读，只有显式 opt-in 的 `--apply` 才会修改。它有四个失败理由，其中任意一个都足以否决：

1. **重复实现其他产品已有的工具。** `engram v1.20.0` 已提供 `delete [--hard]`、`delete project`、`projects consolidate [--all] [--dry-run]`、`conflicts scan [--dry-run] [--apply] [--semantic]`、`doctor --json`、`stats`、`export` 和 `import`。仓库中的副本会在二进制下一次更新时产生偏差——而且已有迹象：`specs/0005` 曾提到一个 **v1.20.0 命令界面中不存在**的 `engram prune`。
2. **跨越目前清晰的边界。** 从 `packages/cli/src/`、`packages/core/` 和 `scripts/` 访问 `~/.engram/engram.db` 的 navori 代码为 **0 处**；与 engram 的耦合止于 `packages/plugins/engram/plugin.json`，它负责安装二进制、注册 MCP server 和渲染 doctrine。**store 属于 plugin，不属于 navori。** 这将成为 navori 首个直接打开其他产品 store 的代码。
3. **无法完成最重要的工作。** 步骤 3 中的两对重复项，其 `topic_key` 和 `normalized_hash` 都不同——测量结果分别为 0 和 0。语义重复项对**所有确定性规则都不可见**。
4. **此前已经决定。** `specs/0005-search-efficiency-layer/design.md:129-130`：*“这是判断工作 → agent，而不是机械 hook。”*

脚本唯一能提供的内容——缺少标题、类型异常、`review_after` 过期的候选列表——**已有三个现成界面覆盖**：`engram doctor --json`、`engram conflicts scan --dry-run --semantic` 和 `mem_review(action: list)`。测量期间语义扫描确实找到了候选项，但耗时几分钟；这是刻意执行的整理工具，不是每次 closeout 都能廉价运行的检查。

### 不要：新增 `/curate-memory` skill

`specs/0005:171` 已将其列为可选方案。现在它不合适有两个原因：

1. **Doctrine 已交付。** `packages/plugins/engram/managed/engram-protocol.md:11` 已准确说明整理内容和时机：*“Curation at close: in the SAME turn as the summary… Consolidate duplicates under their `topic_key`, promote what's durable, and delete only volatile observations…”*。此区块始终启用：它会随 `CLAUDE.md` 发给每个 agent 和 subagent。
2. **Doctrine 暂停规则正好适用于这里。** `specs/0025-disparadores-de-skill/design.md:234-239`：*“机制不会向 `CLAUDE.md` 添加新 prose，但会**重新交付已存在的 prose**。内容复制 always-on 区块的机制会让 body 重复付费。”* 整理 skill 正是这种情况。

**如果整理没有发生，原因不是缺少文字，而是没有执行整理。** 这就是全部论点，也是 #761 的交付物应该是本 runbook 而不是 skill 的原因。

---

## 决策 2：已有证据证明关闭

`4dd7a78`（#768，2026-09-13）——*“feat(agents): researcher 和 explorer 读取 memory，且只读取”*——改动 9 个文件，+105/−11。它为两个 agent 配置了 **`mem_search` + `mem_get_observation`，没有任何 writer**。于 2026-09-13 在代码树中验证：

| 项目 | 位置 |
|---|---|
| 全部 4 个资源的 `tools:` 都只有两个 reader，没有 writer | `.claude/agents/researcher.md:4` · `.claude/agents/explorer.md:4` · `packages/core/core-assets/agents/researcher.md:4` · `packages/core/core-assets/agents/explorer.md:4` |
| always-on 区块中的只读 toolset 条款 | `packages/plugins/engram/managed/engram-protocol.md:3` — *“If your `tools:` lists a reader (`mem_search`, `mem_get_observation`) and no writer, the pre-flight below is the whole block”* |
| 回归防护 | `packages/cli/src/lib/__tests__/mcp-capability-wiring.test.ts:298` — `describe("researcher and explorer read memory, and only read it (#761)")`；`WRITE_TOOLS` 在 `:302`，失败消息 *“reverses a deliberate decision — take it to the issue, not to this line”* 在 `:341` |

两个 `.claude/` resources 还配置了 `mcp__codegraph__codegraph_explore`（精确 tool，而不是 family wildcard，自 #838 起），但这不属于本项决策。

**不要重新讨论。** 决策 2 唯一剩余的工作是 issue housekeeping：编辑 #761 正文，或引用 `4dd7a78` 关闭其中这一部分。只要 issue 维持现状，下一位读者就会重新审计一项已经作出的决策——这正是产生本文的原因。

---

## 如何重新测量

上文所有结果均来自只读命令。决定前请刷新数字：

```
# 1. 总体状态 — 只读，不读取文本
engram stats
engram projects list
engram doctor --json --project navori-harness
engram doctor --project navori-harness --check sync_mutation_required_fields
engram conflicts stats --project navori-harness

# 2. 语料计数（sqlite3 -readonly，仅 COUNT/GROUP BY）
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT type, COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   GROUP BY type ORDER BY COUNT(*) DESC;"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE project='navori-harness' AND deleted_at IS NULL
   AND (title IS NULL OR title='');"
sqlite3 -readonly ~/.engram/engram.db \
  "SELECT COUNT(*) FROM observations WHERE deleted_at IS NULL AND embedding IS NOT NULL;"

# 3. consolidation groups — dry-run，绝不省略 --dry-run
engram projects consolidate --all --dry-run

# 4. store 权限
stat -f "%Sp %z %N" ~/.engram/engram.db ~/.engram/engram.db-wal
```

以上命令均于 2026-09-13 21:04 CST 使用 `engram v1.20.0` 和 `sqlite3 3.50.6` 验证。**这些命令都不会修改任何内容**，包括第 3 项的 `--dry-run`；但该命令若不带 `--dry-run` 就会修改，因此不要只输入一部分后执行。

## 参考资料

- `.claude/progress/audit_ticket_761.md` — 生成本 runbook 的审计，包含完整的 `file:line` 证据。
- `specs/0005-search-efficiency-layer/design.md` §5.2（`:116-135`）、§5.3（`:137-148`）、§9（`:199-206`）。
- `specs/0025-disparadores-de-skill/design.md:234-239` — doctrine 暂停规则。
- `packages/plugins/engram/managed/engram-protocol.md` — 渲染到 `CLAUDE.md` 的协议。
- [#761](https://github.com/UlisesCm/navori-harness/issues/761) · [#728](https://github.com/UlisesCm/navori-harness/issues/728) · [#768](https://github.com/UlisesCm/navori-harness/pull/768) · [#784](https://github.com/UlisesCm/navori-harness/pull/784)
