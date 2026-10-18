> [English](setup-proveedores-externos.md) | [Español](setup-proveedores-externos.es.md) | [简体中文](setup-proveedores-externos.zh-CN.md)

# Recipe — 安装后设置 codegraph 和 tgrep

在执行 `navori add codegraph` / `navori add tgrep`（或 `navori init --full` 启用 tgrep；codegraph 需要明确选择加入）后，按照以下步骤让 MCP 服务器和索引正常响应。内容摘自 `docs/research/search-v2.md` §6.1，不包括该文档还涉及的内部 dogfood 流程（branch、base SHA、Git hooks）。

## 适用情形

经 T31 评估后，codegraph 仅可通过 opt-in 启用，不再包含在新执行 `navori init --full` 安装的默认配置中。已有启用该插件的配置保持不变。若要在自己的配置中禁用它，请设置 `enabled: false` 并运行 `navori sync`；不要删除该键，因为缺少键不等于插件已禁用。

这些步骤仅适用于自带二进制和索引的两个插件：`codegraph`（MCP 服务器，`packages/plugins/codegraph`）和 `tgrep`（CLI 与服务器，`packages/plugins/tgrep`）。其他插件（`engram`、`gh`、`acli`）无需这些步骤；`navori add <plugin>` 已会使其二进制可用。

## 步骤

1. 确认二进制可用：`codegraph --version` / `tgrep --version`。如果 `navori add` 没有安装它（你拒绝了安装，或你的平台不支持自动安装命令），请使用 `navori doctor` 显示的命令安装。
2. 在项目根目录初始化 codegraph 索引：



```
   codegraph init .


```

   如果索引已存在，`init` 会失败。请使用 `codegraph index --force` 重建，不要再次运行 `init`。
3. 在同一根目录启动 tgrep。先检查是否已有服务器运行：



```
   tgrep status .


```

   如果没有服务器，请在专用终端中启动：



```
   tgrep serve .


```

   只要终端保持打开，服务器就会运行。navori 不会终止外部进程，因此关闭该终端即可停止服务器。如果无法保持终端打开，请使用 `tgrep index .`（磁盘模式，不运行服务器：搜索仍然可用，但索引不会自动更新）。
4. 从同一根目录打开（或重启）Claude Code，并在主机询问时批准 codegraph MCP 服务器。按设计，此批准需要交互完成；navori 从不预先授权在仓库自身声明的 MCP 服务器。
5. 验证两者都能响应：从 agent 发起一次真实的 `codegraph_explore` 调用，并使用 `tgrep search -n -- "algo" .` 搜索。从此以后，如果任一索引过时，`navori doctor` 会发出提示。

## 说明

- `codegraph init` 会创建带有自身 `.gitignore` 的 `.codegraph/`，不需要手动忽略它。`tgrep index`/`serve` 不会写入自己的 ignore 文件；如果你的模式（`local`/`full`）没有涵盖 `.tgrep/`，请自行添加。
- 禁用插件（`navori remove codegraph` / `navori remove tgrep`）不会删除已生成到磁盘的索引。
