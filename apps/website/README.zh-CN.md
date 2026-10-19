[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

# @navori/website

Navori 的公开首页和文档站点。使用 Astro 和 Tailwind CSS v4 构建，并发布到 GitHub Pages。

## 开发

```bash
# 在 monorepo 根目录执行（Bun 1.4.2；仓库要求 Node.js >=24）
bun install
bun run --cwd apps/website dev
# 打开 http://localhost:4321
```

## 构建

```bash
bun run --cwd apps/website build
bun run --cwd apps/website preview
```

构建会先运行 Astro，再执行 `scripts/check-i18n.ts`。该检查器会验证生成的页面、语言和片段链接、Markdown 替代文件、本地化索引、命令与叙述内容覆盖率、兼容地址以及 sitemap 清单。

## 路由与本地化

英语是默认规范地址，位于 `/`。西班牙语页面使用 `/es/`；简体中文页面使用 `/zh-cn/`。Astro 的默认 locale 是 `en`，默认语言不带前缀。`SITE_URL` 设置站点来源地址，`SITE_BASE` 设置基础路径；两者默认值分别对应 `astro.config.mjs` 中的根目录部署。

为保持向后兼容，站点还会生成静态 `/en/…` 页面，指向规范英语地址；`/versiones` 指向 `/es/releases`。这些都是带有 `noindex, follow`、meta refresh 和小段脚本的 HTML 兼容页面；脚本会保留 URL 片段。它们不是 HTTP 301 重定向。sitemap 会排除这些兼容地址，也会排除 `.md` 和 `.txt` 资源。

当前构建会生成 **99 个规范 HTML 页面**、每页对应一个 Markdown 替代文件，以及 **3 个本地化 `llms.txt` 索引**。每种语言均包含首页、快速入门、深入介绍、发布信息以及 29 个 CLI 命令页面，因此共有 99 个页面。另有 34 个静态兼容页面：33 个 `/en/…` 地址，以及 `/versiones`。

## 内容与源文件

本地化页面共用 Astro 页面组件和内容源，不会为每种语言维护一套独立的页面实现。`src/i18n/ui.ts` 中的首页叙述包含交互式流程图的八个步骤：到达（Arrives）、上下文（Context）、编排（Orchestrates）、定位（Locates）、执行（Works）、防护（Guards）、筛选（Filters）和结束（Closes）。`src/content/narratives.ts` 提供深入介绍页面中 Orchestrator、Scout、Auditor、Architect、Implementer、Reviewer、Publisher 和 Scribe 八个角色的文案。这些源内容同时供 HTML 组件和 Markdown 替代文件使用；Markdown 导出还会包含交互界面中可能隐藏的流程图状态和技术示例。

```text
apps/website/
├── astro.config.mjs              # 语言路由、基础路径和 sitemap
├── scripts/
│   ├── check-i18n.ts             # 构建期间检查生成结果与链接
│   └── gen-og.mjs                # 手动生成 Open Graph SVG/PNG
├── src/
│   ├── components/pages/         # 共用首页、快速入门、深入介绍和发布页面
│   ├── components/sections/      # 可复用的首页区块
│   ├── content/
│   │   ├── commands.ts           # 本地化命令文档
│   │   ├── guides.ts              # 规范指南清单及本地化 URL
│   │   ├── markdown.ts            # 页面替代文件和 llms.txt 索引
│   │   ├── narratives.ts          # HTML 和 Markdown 共用的深入介绍文案
│   │   └── pages.ts               # 规范路由、兼容地址和片段
│   ├── i18n/
│   │   ├── locales.ts             # 支持的语言及其本地名称
│   │   └── ui.ts                  # 本地化界面和流程图文案
│   └── pages/
│       ├── [...localized].astro   # 规范 /es/ 和 /zh-cn/ 页面
│       ├── [...page].md.ts        # 每个规范页面对应的 Markdown 文件
│       ├── [locale]/llms.txt.ts   # 本地化的代理发现索引
│       ├── index.astro            # 位于 / 的规范英语首页
│       ├── llms.txt.ts            # 根目录英语索引
│       ├── robots.txt.ts          # 爬取策略和 sitemap 链接
│       └── en/                    # 静态英语兼容地址
└── public/
    ├── og*.svg and og*.png        # 已提交的分享卡片源文件和渲染图
    └── schema/                    # 已发布的 JSON Schema
```

`src/content/pages.ts` 中的共享路由清单为每个主题和语言定义一个规范地址。英语页面不带语言前缀，另外两种语言使用各自配置的前缀。添加页面或命令时，应更新对应的内容源，并确保本地化页面、Markdown 替代文件、语言链接、片段和 sitemap 均有效。构建检查器会指出缺失或不同步的资源。

monorepo 使用 Bun `1.4.2`，站点开发和构建要求 Node.js `>=24`（见根目录 `package.json`）。已发布的 CLI 有单独的运行时最低要求：Node.js `>=22.12`（见 `packages/cli/package.json`）；CLI 的较低要求不能替代 monorepo 的开发环境要求。

## `llms.txt` 与爬虫策略

站点会在英语根目录以及每种非默认语言的目录中生成 `llms.txt` 索引。每个索引都会列出该语言的网站页面、命令文档、代码仓库主指南、当前 CLI 版本和 Node.js 要求，并链接到 HTML 与 Markdown 资源。Markdown 文件是由相同 Astro 页面组件渲染的替代版本；它们保留可见内容，并补充交互界面中可能隐藏的叙述状态。

`llms.txt` 是可选的代理发现辅助索引，不会取代网站页面，也不保证代理一定会使用其中的内容，更不保证搜索引擎会索引或提升排名。此站点不提供 MCP 服务器。

`robots.txt` 保留现有的默认允许策略（`User-agent: *` / `Allow: /`），并为具名 AI 爬虫显式列出 `Allow: /`。它也会公布英语 `llms.txt` 索引和 sitemap。GitHub Pages 项目站点位于仓库路径下，而爬虫会从域名根目录读取 `robots.txt`；因此，此生成策略只有在使用自定义域名或用户根目录 Pages 站点时才具有权威性。

## Open Graph 分享卡片

手动运行 `node apps/website/scripts/gen-og.mjs` 重新生成已提交的分享卡片。脚本从 `src/consts.ts` 读取公开统计数量，从 `packages/cli/package.json` 读取当前版本和 Node.js 要求。每种语言都会生成一份 SVG 源文件和对应的 PNG 渲染图：`og.svg`/`og.png`、`og-en.svg`/`og-en.png` 和 `og-zh-CN.svg`/`og-zh-CN.png`。

生成器会从仓库现有的包管理器安装中解析 `sharp`，而不会把它声明为网站的独立依赖。由于这些资源很少变动，生成过程不会放入网站构建中。如果无法解析 `sharp`，脚本会报错退出，不会留下过期 PNG。

## 部署

GitHub Action `.github/workflows/deploy-website.yml` 会在推送到 `main` 且改动涉及 `apps/website/**` 时构建并发布到 GitHub Pages。

**首次部署前：**在代码仓库的 `Settings → Pages` 中，将 **Source: GitHub Actions** 设为发布来源。

若项目站点位于 `<user>.github.io/<repo>/`，请设置以下 repository variables：

- `SITE_URL` = `https://<user>.github.io`
- `SITE_BASE` = `/<repo>/`

若站点是 `<user>.github.io` 根目录站点，请保留默认值。

## 设计

- **字体：**展示标题使用 Instrument Serif，正文使用 Geist Sans，代码使用 Geist Mono。
- **配色：**sky `#0EA5E9` 和 violet `#7C3AED` 搭配暖象牙色 `#FAFAF7`；深色模式使用夜蓝 `#0A0E1A`。
- **视觉模式：**不对称分栏主视觉，搭配 CSS 动画终端、细微背景网格，以及范围受控的 sky 到 violet 径向光晕。
