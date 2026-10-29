> [English](CONTRIBUTING.md) | [Español](CONTRIBUTING.es.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# 如何为 navori 做贡献

**请先阅读 [`docs/DIRECTION.md`](./docs/DIRECTION.zh-CN.md)。** 该文档是 navori 目标、目的、非目标和不变量的权威来源，对人类和 AI 智能体同样适用。如果你的想法与某项不变量冲突，或重新提出某个非目标，请先在 `specs/` 中新建或修改 spec，再改代码；不要通过一个未纳入计划的 PR 引入这类改动。

## 编码前

1. 先读 `docs/DIRECTION.md`，再读 `docs/architecture.md`（了解渲染流程和五个层次），以及你准备修改的领域所对应的 spec（`specs/000X-*.md`）。遵守每份 spec 的 `Status`（`proposed` / `planning only — NO implementar` / `EJECUTADA`），并且**要对照代码确认状态**，因为代码的信息更新。几份 spec 写在实现之前，标题仍保留了当时的状态：0001 和 0002 虽然内容已投入使用，仍标为 `proposed`；另有 11 份 spec 尚未声明状态。查看代码和 `git log`，即可在一分钟内确认实际情况；仍待决策的事项会明确标记为 `planning only — NO implementar hasta aprobación`。
2. **动手前先确定改动在哪一层最有效**，参阅 [`docs/EXTENDING.md`](./docs/EXTENDING.zh-CN.md)。五种落点按成本从低到高排列，成本最低的方案通常最有效。如果已有 skill 涵盖该主题，可把内容补充到该 skill（用户区段或 `injectInto`），让相关智能体更快获得指导，并沿用已经建立的权威来源。该指南还列出四个问题，帮助你完善提案、降低 PR 的评审阻力。
3. 问问自己：这是最简单的方案吗？六个月后仍然容易读懂吗？符合现有模式吗？简单胜过炫技。

## 安装依赖

在仓库根目录运行 `bun install`。根目录的 `package.json` 声明了 `"trustedDependencies": ["esbuild", "sharp"]`；如果没有这项配置，Bun 会跳过它们的 postinstall 脚本（此前用 pnpm 时，这里会报错而不是警告）。这两个依赖都需要运行自己的脚本：esbuild 会下载 Vitest 所依赖的原生二进制文件；sharp 会针对 Astro 网站使用的 libvips 进行编译。明确列出并提交这两项依赖，可让新克隆的仓库直接完成安装，无需人工批准。

## 质量门（关闭 `packages/cli` 的改动前必须通过）

质量门分为两个级别：

- **快速检查** — 已纳入版本控制的 pre-commit hook（`bun hooks:install`）运行 `bun check:fast`（format、jscpd、ast-grep、lint、typecheck），不运行测试。`qualityGate.fast` 是 `bun run check:fast`，因此智能体的提交 hook（`quality-gate-pre-commit.sh`，在 `git commit` 上触发的 PreToolUse）与版本化 pre-commit 执行相同的检查链。CI 的 `fast` job 在 `dev` 及面向 `dev` 的 PR 上运行，也会执行 `check:dup` 和 `check:ast`，但不运行测试。
- **完整检查** — 下文介绍的 `bun check`。CI 的 `quality` job 会在面向 `main` 的 PR 和推送到 `main` 时运行它；失败会导致 PR 检查失败。只有这个级别会运行测试并检查覆盖率。

1. **在 monorepo 根目录运行 `bun check`。** 它是 `navori.config.json` 中 `qualityGate.full` 的别名；该配置是质量门的**唯一事实来源**。`CLAUDE.md` 中的 managed 区块以及 `publisher` 使用的命令都由该配置生成。不要把质量门复制到本文或其他文件中，否则副本会逐渐过时。这种情况以前发生过（因此有 `repo-config-gate.test.ts`；详见本节末尾）。

   这条命令有几个容易踩到的细节：
   - **使用 `bun run test:coverage`，不要只运行 `bun test`。** 前者运行同一套测试，另外还运行 `check-coverage-floor.mjs`；它不仅检查覆盖率下限，也会发现 `KNOWN_ZERO` 中的过期条目（这些是 navori 发布但没有测试的模块）。只运行 `bun test` 会漏掉这项检查；过去已经因此出现过 gate 通过但 CI 失败的情况。
   - **`bun run format:check`（oxfmt）不在 `packages/cli` 下运行**，而是在仓库根目录运行，也是最容易漏掉的一步。用 `bun run format` 修复格式问题。
   - **`blame.ignoreRevsFile`**：运行 `git config blame.ignoreRevsFile .git-blame-ignore-revs`，让 `git blame` 跳过根目录 `.git-blame-ignore-revs` 中列出的大规模格式化提交（例如迁移到 oxfmt 的提交 #889）。**只有提交进入 `main` 后**，才能把它加入该文件（通过 `dev` → `main` 的 PR，并使用 merge commit）；不要在同一个最终以 squash 合入 `dev` 的 ticket PR 中添加。Squash 会重写 SHA，使该条目不再是 `main` 的祖先（#986、#1004）。作为质量门的一部分，`bun run check:blame-ignore` 会逐条验证这两个条件：该提交是 `origin/main` 的祖先，并且其 diff 属于机械式改动。
   - **两个质量门在同一工作树上运行相同的 `test:coverage`**（例如同一会话中的两个智能体，而不是使用不同 worktree）会争用 `packages/cli/coverage/` 并发生冲突（#909）。运行前导出 `NAVORI_COVERAGE_DIR=coverage-<algo único>`，即可隔离本次结果。`vitest.config.ts` 和 `check-coverage-floor.mjs` 读取同一个变量；未设置时回退到 `coverage`。正常质量门和 CI 使用默认值，因此不要修改它。

   - **测试临时文件按文件清理。** 每个 spec 在导入前都会获得一个隔离目录，其中有自己的 `HOME` 和备份；该文件的本地 hooks 结束后，目录会被删除。每次 watch 周期以及只加载 `setupFiles` 的配置也会执行这项清理。结束时会恢复环境变量。hook 为慢速删除预留 30 秒，并为直接子进程等待 1 秒；磁盘已满时，这段时间仍可能不够。`dist` 锁目录使用 `NAVORI_TEST_COORDINATION_BASE`，子进程会继承它；当 fixture 使用的 `TMPDIR`/`TMP`/`TEMP` 改变时，该目录仍保持稳定。
   - 调查期间如需保留生成的 fixture 和报告，请设置 `NAVORI_KEEP_TEST_ARTIFACTS=1`。未设置时，即使 Vitest 或覆盖率下限检查失败，`test:coverage` 生成的报告也会被删除。若设置了 `NAVORI_COVERAGE_DIR`，该目录归你所有，会始终保留。如果清理流程为了诊断、仍在运行的直接子进程或中断而保留证据，输出会给出确切路径。`HOME` guard 测试会保留对应测试文件的目录。

     生命周期清理适用于 Vitest 的标准 worker，以及继承环境变量的 Node/Bun 子进程。进程跟踪通过 Node 的实验性 channel 追踪直接子进程；它不保证清理已脱离的孙进程、移除了环境变量的进程，或同时省略 `setupFiles` 和 `globalSetup` 的自定义配置。在导入配置文件或其 setup files 时临时赋值，会发生在隔离之前。`SIGKILL` 或重启会阻止清理和路径报告。系统不会扫描历史目录，也不保证磁盘配额或最大占用空间。

   **本地预检查：oxlint + jscpd 5.4.0 + ast-grep 0.45.3**；后两者作为根目录 devDependencies，使用精确版本。`check:dup` 会根据已纳入版本控制的 `.jscpd-baseline.json` 扫描整个仓库。通过时不输出信息；失败时会用详细模式重新运行，并将新发现标记为 `[NEW]`。`check:dup:baseline` 对应 `jscpd --update-baseline`。`check:ast` 对应 `ast-grep test --skip-snapshot-tests && ast-grep scan`（规则位于 `ast-grep/rules`，测试位于 `ast-grep/rule-tests`，配置文件为 `sgconfig.yml`）。缺少工具会导致检查失败，绝不会跳过。脚本明确调用 `./node_modules/.bin/jscpd` 和 `./node_modules/.bin/ast-grep`，所以即使系统有全局二进制文件，没有运行 `bun install` 仍会失败。`report/`（jscpd JSON reporter 的输出目录）已列入 `.gitignore`。

   `qualityGate.full`（`bun check`）的执行顺序为：format:check、lint、typecheck、check:dup、check:ast、check:links、check:render、check:assets、check:doc-budgets、check:blame-ignore、check:size、test:coverage。`check:scoped` 与之相同，但不运行 test:coverage；`check:fast`（pre-commit）运行 format:check、check:dup、check:ast、lint、typecheck。

   **重复代码基线。** 当前有 22 个指纹，测试通过 `DUP_BASELINE_CEILING = 22` 限制其数量。只有在格式变更或升级 jscpd 导致已有重复代码片段发生位移时，才运行 `bun run check:dup:baseline` 重新生成，并在 PR 中说明理由。删除某个重复片段后，也要重新生成基线并降低上限（ratchet）。测试文件同样会被扫描。

   **抑制规则。** 只允许 `// ast-grep-ignore: <rule-id>`（忽略注释缺少 ID 会触发 `no-bare-ast-grep-ignore`），以及紧挨语句上方的 `// any justified: <razón>`；后者只抑制 `no-unjustified-double-cast`（`as unknown as`），**不会**抑制 oxlint 的 `no-explicit-any`。如果同一行同时需要抑制这两种工具（目前位于 `packages/cli/src/lib/gate/run.ts` 和 `packages/cli/src/commands/add.ts`），在调用上方加 `// ast-grep-ignore: no-shell-exec`，在该行末尾加 `// nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true`，并加上 `// prettier-ignore`，防止 oxfmt 移动该注释。两个注释都要保留：`main` 上的 `semgrep` job 仍会读取 `nosemgrep`。ast-grep 规则包括：no-shell-exec、no-unjustified-double-cast、no-explicit-any（oxlint 不检查的目录：`apps/website/src`、`scripts`、`packages/core`、`packages/plugins`、`.pi/extensions`）、no-bare-ast-grep-ignore、no-bash-eval。已知覆盖缺口：ast-grep 不检查 `.astro`、`.mjs`、`.py` 和几乎所有 `.sh`（no-bash-eval 除外）；这些文件只有在 `main` 上才由 semgrep 覆盖。

   **CI 与 semgrep。** `quality`（`main`）和 `fast`（`dev`）job 都运行 `check:dup` 和 `check:ast`。`semgrep` job 只在 `main` 上运行（推送和面向 `main` 的 PR）：使用按 digest 固定版本的官方 Docker 镜像、`p/default`、带 `--baseline-commit` 和 `--error` 的 diff-scan（只会阻止新增发现），并将 SARIF 上传到 code scanning。所有 workflow actions 都固定到 SHA，这是测试的要求。此仓库不再使用 navori 的 jscpd/semgrep 插件，但产品仍会分发这些插件。

2. **如果改动会影响渲染**，请在仓库根目录运行 `bun run check:render`。此仓库采用自托管模式：`.claude/` 和 `CLAUDE.md` 是 `navori render` 的输出，因此 PR 必须包含镜像重新渲染（在根目录运行 `bun run render:apply`；其完整命令是 `bun run --filter navori build && node packages/cli/dist/index.js render --apply`），否则 `quality` job 会失败（#421）。**这条命令中的 build 不可省略。** 不先构建，渲染会拿上一次 build 的 assets 与当前结果比较，而不是使用工作树中的 assets；它可能报告 `unchanged`，而 `--apply` 甚至会还原镜像。这个别名可确保整条命令链完整执行。以下四类改动中的任何一类都要求重新渲染：
   - **core assets**：`packages/core/core-assets/**`。
   - **plugin assets**：`packages/plugins/*/{managed,scripts,skills,hooks}/**`，以及声明这些 assets 的 `plugin.json`。build 会通过 `packages/cli/scripts/copy-assets.mjs` 将它们与 core assets 一样打包，然后渲染到 `CLAUDE.md` 的区块和 `.claude/` 下的文件中。**#429 就是这样漏过的**：它改了 plugin asset 而非 core asset，导致镜像有一天没有更新。
   - **`packages/cli/package.json` 版本升级**：每个 managed 区块的 marker 都会记录 `readCliVersion()`，所以升级版本会使**整个**镜像过期。实测从 0.6.0 升到 0.6.1 时，`updated` 了 **30 个文件**，其中包括 `CLAUDE.md` 的 16 个区块。`chore(release)` 提交也不例外；参见 `README.md` 中的 "Releases"。
   - **此仓库的 `navori.config.json`**，它定义了哪些内容会被渲染。

   检查会先重新构建再渲染，这是有意为之：`dist/assets/` 是 build 时复制的 core 和 plugin assets。使用旧 `dist` 渲染时，比较的是旧 assets，可能会静默通过。

   有两条规则通常要等踩过坑才会记住（#435）：

   - **基线移动后，原来的渲染结果就会过期。** 每次 rebase 或 merge `dev` 后，都要再次运行 `bun run render:apply`。当前镜像基于之前的 assets；如果期间合入了另一个修改 assets 的 PR，你的镜像就已经过期。#421 开发期间，这种情况连续发生了三次。
   - **不要手动解决 managed 区块内的冲突。** 采用基线版本，再运行 `bun run render:apply` 重新生成。每个区块都带有对应内容的 `hash`；手动编辑会把它标记为*用户已修改*，于是 `render --apply` **不再覆盖它**，并将其报告为 `user-modified-skipped`。这种 drift 之后只能通过 `navori sync` 修复。这很容易踩坑：Git 冲突出现时，人们通常会直接编辑；但这里这样做会把一个命令能解决的问题，变成需要理解 marker 模型的问题。

3. **如果第 2 步应用了改动，渲染树的 golden snapshot 也会改变。** 使用 `cd packages/cli && bun run test:golden`（约 1 秒）重新生成，并在提交前**阅读 diff**。五个 fixture 分别对应一个 engine，位于 `packages/cli/src/engines/__tests__/__golden__/<engine>.snap`。它们之所以存在，是因为约 11 个 wiring 测试只检查零散 token，无法展示完整输出（#394）。如果无法解释 diff 中的变化，就应调查；不要用 `-u` 把它当作噪声压平。

   第 2 步中有一类触发因素**不会**影响 golden snapshot：版本升级。snapshot 会规范化 marker 中的 `version=` 和 `hash=`，因此升级版本会改动镜像中的 30 个文件，但 golden 中**零行变化**。这是有意设计的；如果不做规范化，每次发布都会让 snapshot 失效，最终失去参考价值。

`repo-config-gate.test.ts` 会从**两个方向**检查质量门与 `ci.yml` 是否一致：workflow 新增了 gate 未声明的步骤，或者 gate 新增了 CI 没有运行的步骤，测试都会失败并指出具体步骤。例外项保存在 `EXEMPT_FROM_LOCAL_GATE` 和 `EXEMPT_FROM_CI` 两张表中；每项都必须填写原因，并且会双向检查是否存在过期条目。目前的例外项如下：

- **`check:assets:ci`**（属于 `EXEMPT_FROM_LOCAL_GATE`）：它是带 `--strict` 的 `check:assets`。严格检查依赖 CI 有意提供、而新克隆仓库不具备的 tags，所以本地 gate 会因环境原因失败，而不是因为代码本身有问题。
- **`check:assets`**（属于 `EXEMPT_FROM_CI`）：CI 运行更严格的超集 `check:assets:ci`。

对于**纯文档**（.md）改动，运行 `bun run lint` 和 `bun run format:check` 即可，无需运行完整测试套件。
**“纯文档”指仓库文档，不包括 assets。** `packages/core/core-assets/` 或 `packages/plugins/*/` 下的 `.md` 是渲染 harness 的源文件，因此无论扩展名是什么，都要执行第 2、3 步（更新镜像和 golden snapshot）。

## 本地开发周期

- **`bun run test:affected`** 只运行相对于 `dev` merge-base 受改动影响的测试，包括未提交的改动和删除。
  这是迭代快捷方式，不是验收凭据：收尾时的 `bun check` 和 CI 仍会运行完整测试套件。Vitest 配置、
  `tsconfig*`、`package.json`、lockfile 或 `bunfig.toml` 发生变化，或找不到 merge-base 时，会运行全部测试。
- **`bun run bench:tests`** 和 **`bun run bench:hooks`** 会将每个文件的耗时及每个 hook 的成本写入
  `.navori/state/bench/`（`--runs` 的中位数，默认 3 次），并记录 `loadavg`。系统负载较高时的测量不适合比较。
- **单文件预算：** `packages/cli/test-budget.json` 为每项测试设置 `defaultMs`（20 秒）；`exceptions[]`
  可提高某个文件的预算，每个例外都必须提供 `reason`。`check-test-budget.mjs --report` 会在文件超出预算时失败。
  CI 的 `quality` job 使用 `NAVORI_TEST_BUDGET_FACTOR=2` 执行此检查。
- **`navori gate probe`** 在缓存的绿色结果与当前字节完全一致时返回 0，否则返回 1；它不会运行质量门。
  pre-commit 使用它（`navori gate probe --clean`）在命中时跳过 `qualityGate.fast`；缓存命中不能替代验证结论。
- **`NAVORI_TEST_WORKERS`**（正整数）设置 Vitest 的 worker 数量。未设置时，数量为
  `min(CPUs - 1, 4, 文件描述符预算)`。

## Rust 迁移分支（`navori-rust` 本地）

仅适用于 `migration/rust`（[spec 0057](specs/0057-migracion-rust/requirements.md)）；`dev` 与 npm
仍然只使用 TypeScript。

- **与 TS CLI 并存安装：** `cargo install --path crates/navori-cli --locked` 会安装 `navori-rust`，
  且不会替换 `navori`（`command -v navori` 的路径保持不变）。`navori-rust --version` 报告内部
  预发布版本 `0.13.0-rust.<n>`。
- **委托：** 未列入 `crates/ported.json` 的子命令交给 TS CLI（依次为 `NAVORI_TS_CLI`、本检出的
  `packages/cli/dist`、`PATH` 中的 `navori`）。请先运行 `bun run build`。
- **原生命令：** `render` 在仅 Claude、无 workspace 的根目录中以原生方式运行，支持 `--cwd`、
  `--dry-run`、`--json`、`--apply` 与 `--force`，且仅在无颜色时（stdout 不是 TTY、未设置 `FORCE_COLOR`，且
  `CI` 仅与 `NO_COLOR` 同时出现）；其他情况在输出前委托。若 `~/.navori/registry.json` 以其他名称
  列出该仓库，apply 也会委托。其来源行显示 `core: (embedded)`，原生命令在 spec 0060 之前不显示更新提示。
- **原生 hook：** `ported.json` 中的 hook 仅在 `PATH` 中有 `navori-rust` 时以原生方式运行；否则运行
  渲染出的 shell。`NAVORI_HOOK_IMPL=shell` 强制使用 shell，`NAVORI_HOOK_IMPL=rust` 强制原生评估，
  无法评估时直接失败而不是回退。影子观测记录在 `.navori/state/rust-shadow/`
  （`navori tools rust-shadow report`）。
- **与 `dev` 同步：** 只用 merge，不用 rebase。从 `origin/migration/rust` 建分支，运行
  `git merge origin/dev`，并向 `migration/rust` 发起 PR。若缺少超过 7 天的 `dev` 第一父提交，CI
  的 `freshness` job 会失败。
- **检查：** `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  `cargo test --workspace`、`bun run oracle:rust` 以及 `node scripts/js/rust-manifest-check.mjs`。

## 文案预算：哪些会设上限，哪些只报告

navori 注入的所有文案都留在每个会话的常驻上下文中，因此会不断累积：每个学到新内容的会话都会添加内容，却没有机制修剪。启动时会加载**两种内容面**，设计上分别处理。

| 内容面 | 编写方 | 是否设上限？ | 监测方 |
|---|---|---|---|
| managed assets（`core-assets/managed/`、`presets/*/managed/`、`plugins/*/managed/`） | navori | **是**，按文件计算 | gate 中的 `bun run check:doc-budgets` |
| 计算生成的区块（`contexto-proyecto`、`agentes-disponibles`） | navori，根据使用方配置生成 | **是**，公式为 `base + k · filas` | `navori doctor`（只报告） |
| marker 之外由使用方维护的文案 | 仓库所有者 | **绝不设上限** | 只报告 |
| `.claude/context/*.md` | navori | **暂不设上限**（#919） | `navori doctor`（只报告） |
| `AGENTS.md`（各 engine 的文案） | navori | **不设上限**，按 host 上限报告 | `navori doctor`（达到 80% 后显示黄色警告） |

上限只定义在一个位置：`packages/cli/src/lib/assets/doc-budgets.ts`。它放在 `src/lib/`，而不是 `scripts/` 下的 JSON 文件中，因为 npm 发布 `["dist", "README.md"]`。使用方仓库中的 `doctor` 必须读取相同的数值，因此这些数值必须包含在发布 bundle 中。政策是：每个上限都要比实测值至少高 **5%**，并且提出上调的改动必须说明理由。把上限设成刚好通过的数值，最终导致 `CLAUDE.md` 达到 2548/2550。

有三项决定可能不太直观：

- **不限制使用方自己的文案。** navori 无权限制其他仓库的 `CLAUDE.md`。本仓库自身就有 536 个自有文案词和 1771 个 managed 词。分别报告（“你的 X 个，navori 的 Y 个”）即可。
- **计算区块不能用固定常数设限。** 这里的 `contexto-proyecto` 有 54 个词，而 `bonum-dashboard` 有 335 个，是这里的 6.2 倍；唯一原因是后者在 `project.*` 中声明了更多条目，这正是该工具的预期用法。`k` 有意设置得**宽松**：上限按每个配置项的成本增长，而不是惩罚拥有这些配置项的仓库。
- **`doctor` 的报告不会改变 `ok` 结果，也不会导致 `--strict` 失败。** 全局 registry 有 30 个仓库；若把这类报告纳入最终判定，合法文案会让这些仓库在上限调整当天集体变红。`render` 也不会固定打印一条提示；只有本次运行确实越过上限时才会警告。

阅读指标时还要注意一点：**没有上限的区块不参与比较**。navori 不纳入预算的区块（通常是已移除、却仍留在旧文件中的区块）会增加总词数，却对上限贡献 0。把它算进比值会导致指标凭空报告超限。实测 `bonum-webapp` 的 `CLAUDE.md`：`engram-protocol`（497）加上 `codegraph-protocol`（255），占报告超出部分 **1207 个词中的 752 个**，即 62%。这些区块会单独计数，并在独立行中注明，不会隐藏起来。

文案内容面（`AGENTS.md`，由 `codex`、`agents-md`、`cursor` 和 `copilot` 共用）按**字节**而非词数衡量，原因是这里唯一存在的限制来自 host。Codex 从根目录向下拼接文件；达到 `project_doc_max_bytes`（默认 32 KiB）后便**停止添加后续文件**，且不会提示。静默截断无法通过词数上限发现。navori 只报告自己的部分：整个链条还包含用户的 `~/.codex/AGENTS.md` 和嵌套的 `AGENTS.md`，所以测量结果只是一个**下限**。这里也不按区块测量：`AGENTS.md` 会渲染为一个 `navori-agents` 区块；若按区块报告，结果会是 `ceiling 0, overBy 0`，永远不可能失败。对每个区块分别诊断会改变已部署文件的 marker 拓扑，属于关键区域，因此需要单独制定 spec。

决定如何处理警告时，必须区分：**“文件太大”和“文件已过期”不是一回事。** 旧版本渲染的 `CLAUDE.md` 可能还保留已经缩减的区块。在 `bonum-webapp` 中，运行 `navori render --apply` 会减少 1175 个词（−37%），且不需要仓库所有者作出决定。因此 `doctor` 会优先报告过期状态：这是唯一不需要决策就能处理的问题。

编写 managed 文案时，还应记住报告中提到的最后一个数字：**每个 subagent 都会在自己的上下文中重新加载 `CLAUDE.md` 和项目规则**（Claude Code 文档 "What loads at startup"；只有 `omitClaudeMd` 能阻止此行为）。没有固定的倍率，ticket 会决定启动多少个智能体；但 implementer→reviewer→publisher 流程中，每个智能体都会各自加载一次该文件，主会话还会加载一次。**这是 Claude 特有的情况，不能推广到其他 engine**：Codex subagent 从自己的 agent 文件启动，并要求提供 `developer_instructions`；所以当 `engines` 不包含 `claude` 时，报告会省略这一行。

## Hook partial 及其行为测试

`core-assets/hooks/_partials/` 中的 partial 通过 `# navori:include <nombre>` 纳入 hook。只有被 **core hook** 引用的 partial 才有保留价值；只有运行该 hook 的测试明确列出它时，它才可信。[hook-includes.test.ts](packages/cli/src/lib/render/__tests__/hook-includes.test.ts) 会机械地检查这两个条件：

- 新 partial 必须有 core consumer，或列入 `PLUGIN_ONLY_PENDING_REMOVAL`。该列表仅适用于唯一 consumer 是 plugin 的 partial；删除 plugin 时也要一并删除对应条目。
- 不在该列表中的每个 partial，都必须在 `PARTIAL_BEHAVIOUR_TESTS` 中有一行 `{ hook, file, title }`：`hook` 是引用它的 core hook；`file` 是验证其行为的测试文件；`title` 是测试的准确名称，必须原样出现在 `file` 中。测试文件还必须提到对应的 hook。
- 如果某一行找不到对应的 partial（即条目已过期），检查同样会失败。

因此，新增 partial 却没有行为测试会让测试套件失败，不会悄悄通过。

## 提交与 PR

- 提交信息：使用 Conventional 格式，以墨西哥西班牙语编写，并保持原子性（`feat|fix|chore|docs(scope): mensaje`）。
- 每个 ticket 都要从 `dev` 创建新分支，并向 `dev` 提交 PR（CI 会运行 format、lint 和 typecheck，不运行测试）。通过 PR 将 `dev` 合入 `main` 时要使用 merge commit，不要 squash；该 PR 必须通过完整质量门。
- 在 `/bonum` 仓库中，不要提交本地 harness（`CLAUDE.md`、`.claude/`）。
