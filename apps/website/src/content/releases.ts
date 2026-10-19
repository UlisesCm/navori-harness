/**
 * Curated release notes for the landing's "What's new" block and the full
 * /versiones (es) and /en/releases (en) pages.
 *
 * One entry per minor, newest first, written for people who use navori — what
 * they gain, not commit subjects. `landing-inventory.test.ts` fails when the
 * CLI's current minor has no entry here, so writing it is part of releasing.
 */

export interface LocalizedText {
  es: string;
  en: string;
  "zh-CN": string;
}

export interface ReleasePatch {
  /** Full version, e.g. "0.10.1". */
  version: string;
  /** ISO date (YYYY-MM-DD) of the patch's tag. */
  date: string;
  note: LocalizedText;
}

export interface ReleaseEntry {
  /** Minor key, e.g. "0.10". Compared numerically, never as a string. */
  minor: string;
  /** ISO date (YYYY-MM-DD) of the minor's first tag (vX.Y.0). */
  date: string;
  headline: LocalizedText;
  /** 3–5 user-facing bullets. */
  bullets: readonly [LocalizedText, LocalizedText, LocalizedText, ...LocalizedText[]];
  patches?: readonly ReleasePatch[];
}

export const RELEASES: readonly ReleaseEntry[] = [
  {
    minor: "0.12",
    patches: [
      {
        version: "0.12.1",
        date: "2026-10-14",
        note: {
          es: "Corrige clasificación, evidencia y escalamiento de planes; incorpora mejoras del master plan y controles de aprobación y perfiles de Codex. La integración de Codex continúa en validación.",
          en: "Fixes plan classification, evidence and escalation; adds master plan improvements and Codex approval and profile controls. Codex integration remains under validation.",
          "zh-CN":
            "修复计划分类、证据和升级流程，改善主计划，并新增 Codex 批准与配置控制。Codex 集成仍在验证中。",
        },
      },
    ],
    date: "2026-10-12",
    headline: {
      es: "Pi de primera clase, un gate más barato y retiros con migración",
      en: "First-class Pi, a cheaper gate and retirements with a migration path",
      "zh-CN": "Pi 成为一等引擎，更省成本的关卡，以及明确的迁移路径",
    },
    bullets: [
      {
        es: "Pi es un engine de primera clase y ya se ofrece en el wizard de init y en configure engines. Llega con paridad de guardas y hooks con Claude Code, y las acciones sensibles piden una aprobación escrita (yes, run it). Requiere Pi >= 1.1.0.",
        en: "Pi is a first-class engine and is now offered in the init wizard and in configure engines. It reaches guard and hook parity with Claude Code, and sensitive actions ask for a typed approval (yes, run it). Requires Pi >= 1.1.0.",
        "zh-CN":
          "Pi 已加入 init 向导和 configure engines，与 Claude Code 的安全守卫和钩子达到同等能力；敏感动作需输入 yes, run it 批准。要求 Pi >= 1.1.0。",
      },
      {
        es: "Nuevo navori gate <fast|full>: salida compacta con el veredicto en la primera línea y el log completo en .navori/state/gate/. Además, un gate scoped (qualityGate.scoped) que corre solo lo que tocó el diff, y un hook nativo del gate (qualityGate.nativeHooks) que evita correrlo dos veces.",
        en: "New navori gate <fast|full>: compact output with the verdict on the first line and the full log under .navori/state/gate/. Plus a scoped gate (qualityGate.scoped) that runs only what the diff touched, and a native gate hook (qualityGate.nativeHooks) that avoids running it twice.",
        "zh-CN":
          "新增 navori gate <fast|full>，首行给出简要结论，完整日志保存在 .navori/state/gate/。qualityGate.scoped 只检查差异涉及内容，qualityGate.nativeHooks 避免重复执行。",
      },
      {
        es: "navori update consulta npm, instala la última versión de la CLI tras tu confirmación y luego corre navori refresh, que es el update de antes (re-sincroniza el harness). Sin alias: si tus scripts usaban navori update para refrescar el harness, cámbialos a navori refresh.",
        en: "navori update checks npm, installs the latest CLI after your confirmation and then runs navori refresh, which is the old update (it re-syncs the harness). There is no alias: if your scripts used navori update to refresh the harness, switch them to navori refresh.",
        "zh-CN":
          "navori update 查询 npm，经确认安装最新 CLI，再运行原 update 所做的 navori refresh。没有兼容别名；脚本若以前用 update 刷新 harness，应改用 refresh。",
      },
      {
        es: "Retiros incompatibles: el comando navori global y el colector launchd ya no existen, doctor --json deja de emitir globalScope, y los plugins jscpd y semgrep salen del producto. Migra con navori render --apply, que poda sus assets si son de navori, y navori doctor, que reporta lo que quede.",
        en: "Breaking retirements: the navori global command and the launchd collector are gone, doctor --json no longer emits globalScope, and the jscpd and semgrep plugins leave the product. Migrate with navori render --apply, which prunes their assets when they are navori's own, and navori doctor, which reports any leftovers.",
        "zh-CN":
          "破坏性移除：navori global、launchd 收集器、doctor --json 的 globalScope 以及 jscpd、semgrep 插件。运行 navori render --apply 清理属于 navori 的资源，再用 doctor 检查遗留内容。",
      },
      {
        es: "Node >= 22.12 es el mínimo. progress/current.md tiene tope (el hook bloquea commits de agente que lo hagan crecer y doctor avisa) y harnessVersion funciona como piso anti-retroceso.",
        en: "Node >= 22.12 is the minimum. progress/current.md is now capped (the hook blocks agent commits that grow it and doctor warns) and harnessVersion works as an anti-rollback floor.",
        "zh-CN":
          "最低 Node >= 22.12。progress/current.md 新增容量上限，钩子阻止智能体提交使其超限，doctor 给出警告；harnessVersion 作为防回滚下限。",
      },
    ],
  },
  {
    minor: "0.11",
    date: "2026-09-29",
    headline: {
      es: "Estado del harness por checkout y un master plan guiado",
      en: "Per-checkout harness state and a guided master plan",
      "zh-CN": "每个 checkout 独立保存状态，并提供引导式主计划",
    },
    bullets: [
      {
        es: "El estado efímero del harness vive por checkout y sin atarse a un engine, en .navori/state/handoffs/. plan gate, plan check y receipt check buscan ahí los workplans y recibos, con el .claude/progress/ anterior como lectura de respaldo. Es una migración que conviene notar.",
        en: "Ephemeral harness state now lives per checkout and engine-neutral under .navori/state/handoffs/. plan gate, plan check and receipt check look there for workplans and receipts, with the old .claude/progress/ as a read fallback. It is a migration worth noticing.",
        "zh-CN":
          "临时状态按 checkout 存于引擎无关的 .navori/state/handoffs/。plan gate、plan check、receipt check 从此读取计划与收据，旧 .claude/progress/ 仅作为读取后备。需要关注这一迁移。",
      },
      {
        es: "Codex avanza hacia la paridad operativa, aunque todavía parcial: permisos por defecto, salida de hooks validada, permisos de revisión cruzada y un plan-gate que aconseja en Codex.",
        en: "Codex moves toward operational parity, though still partial: default permissions, validated hook output, cross-review permissions and an advisory plan-gate on Codex.",
        "zh-CN":
          "Codex 向操作能力对等推进，但仍部分完成：默认权限、已校验钩子输出、交叉审查权限及建议式 plan-gate。",
      },
      {
        es: "Nueva skill master-plan: guía un plan maestro por etapas para trabajo grande, con una spec propia.",
        en: "New master-plan skill: it guides a staged master plan for large work, backed by its own spec.",
        "zh-CN": "新增 master-plan 技能，通过独立规格引导大型工作分阶段执行。",
      },
      {
        es: "Nuevas skills de librerías: amqplib para RabbitMQ, los patrones de Mantine en cualquier repo con @mantine/core, y fastapi y pytest para repos Python, con detección de dependencias de desarrollo de Python.",
        en: "New library skills: amqplib for RabbitMQ, Mantine patterns for any repo with @mantine/core, and fastapi and pytest for Python repos, with Python dev-dependency detection.",
        "zh-CN":
          "新增 RabbitMQ 的 amqplib、适用于含 @mantine/core 仓库的 Mantine 模式，以及 Python 的 fastapi、pytest 技能，并检测 Python 开发依赖。",
      },
      {
        es: "Los gates de pre-commit, semgrep y jscpd ya no corren el gate del repo ancla sobre commits que caen en otro repositorio, e init infiere el workspace cuando uno ya registra el repo. Además, jscpd bloquea solo clones nuevos y hay arreglos en check-links, recibos, activación de tailwind-v4, variables extra de plugins y la convivencia en init.",
        en: "The pre-commit, semgrep and jscpd gates no longer run the anchor repo's gate on commits that land in another repository, and init infers the workspace when one already registers the repo. Also, jscpd blocks only new clones, with fixes to check-links, receipts, tailwind-v4 activation, plugin extra variables and init coexistence.",
        "zh-CN":
          "pre-commit、semgrep、jscpd 不再对其他仓库的提交运行锚点仓库关卡；init 可推断已注册工作区。jscpd 仅阻止新增重复，并修复链接检查、收据、tailwind-v4 激活、插件额外变量与 init 共存。",
      },
    ],
    patches: [
      {
        version: "0.11.1",
        date: "2026-10-02",
        note: {
          es: "Claude first: el harness deja de emitir lo que Claude Code ya trae de forma nativa, navori audit mide rangos y compara instantáneas, y llegan un guard de ruteo de búsqueda, confirmación cuando un gate no puede dar veredicto, soporte para Pi y un aviso diario de versión nueva.",
          en: "Claude first: the harness stops emitting what Claude Code already ships natively, navori audit measures ranges and compares snapshots, and there is a search-routing guard, confirmation when a gate cannot reach a verdict, Pi support and a daily new-version notice.",
          "zh-CN":
            "Claude 优先：不再生成 Claude Code 原生已有的内容；audit 支持区间和快照比较；新增搜索路由守卫、无法判定关卡时确认、Pi 支持和每日版本通知。",
        },
      },
      {
        version: "0.11.2",
        date: "2026-10-03",
        note: {
          es: "Paridad de Codex (spec 0041), verificada en vivo en Codex 0.160.0 con una tabla de garantías: role-guard y guard de spawn, plan-gate con archivo de despacho para multi-agente V2, confirmaciones por deny en publicación y general-purpose, master-plan y context-intake, guard de tgrep y consejo ante fallos repetidos de Bash. Los modelos de Codex se resuelven solos por familia desde el catálogo local (sol, luna, astra) y doctor revisa la confianza de Codex por worktree y avisa de un navori global desactualizado. Arreglos de render: navori:if en los agentes de Codex y poda de huérfanos.",
          en: "Codex parity (spec 0041), verified live on Codex 0.160.0 with a guarantee table: role-guard and spawn guard, plan-gate with a dispatch file for multi-agent V2, publication and general-purpose confirmations by deny, master-plan and context-intake, a tgrep guard and advice on repeated Bash failures. Codex models resolve automatically by family from the local catalog (sol, luna, astra), and doctor checks Codex trust per worktree and warns about a stale global navori. Render fixes: navori:if in Codex agents and orphan pruning.",
          "zh-CN":
            "Codex 对等能力（spec 0041）在 0.160.0 实测并给出保证表：角色与派发守卫、multi-agent V2 dispatch 文件、发布及 general-purpose 的拒绝式确认、master-plan/context-intake、tgrep 守卫和 Bash 重复失败建议。按本地目录 sol/luna/astra 自动解析模型；doctor 检查 worktree 信任和旧全局 navori；修复 navori:if 与孤立输出清理。",
        },
      },
      {
        version: "0.11.3",
        date: "2026-10-07",
        note: {
          es: "Entregas funcionales para specs: spec classify y spec check, sdd.deliveries con entregas, milestones y tareas, un gate completo por PR y un master-plan que reparte sus partes con las mismas reglas. sync reemplaza archivo por archivo (también los que no tienen marcadores), con --accept-new-files y diff para conservar o aceptar; monorepo.workspaceHarness suma el modo root. navori tools avisa de versiones nuevas de herramientas externas y doctor advierte de versiones con problema conocido (engram < 3.0.0). navori audit une resultados de revisión y recibo, mide disponibilidad, compara cohortes y calcula eficiencia por tarea. Hooks más seguros: el guard bloquea descartes de árbol completo con trabajo sin commitear, el publisher no reescribe historia, plan-gate pide confirmación y los bloqueos dicen qué hacer. Codex recibe un AGENTS.md más delgado y un guard de escrituras de engram, y ya no degrada el modelo renderizado.",
          en: "Functional deliveries for specs: spec classify and spec check, sdd.deliveries with deliveries, milestones and tasks, one full gate per PR and a master-plan that splits its parts with the same rules. sync replaces file by file (including markerless files), with --accept-new-files and a diff to keep or accept; monorepo.workspaceHarness gains the root mode. navori tools notices new releases of external tools and doctor warns about known-bad versions (engram < 3.0.0). navori audit joins review and receipt outcomes, measures availability, compares cohorts and computes per-task efficiency. Safer hooks: the guard blocks whole-tree discards with uncommitted work, the publisher cannot rewrite history, plan-gate asks for confirmation and blocks say what to do. Codex gets a thinner AGENTS.md and an engram write guard, and no longer downgrades the rendered model.",
          "zh-CN":
            "规格支持功能交付：spec classify/check、sdd.deliveries、交付/里程碑/任务、每 PR 一次 full，master-plan 同规则拆分。sync 可逐文件处理无标记文件，--accept-new-files 配合差异保留/接受；workspaceHarness 增加 root。tools 提示外部工具更新，doctor 警告 engram < 3.0.0。audit 关联 review/receipt，衡量可用性、分组与任务效率。钩子阻止丢弃未提交整树，publisher 不改写历史，plan-gate 要求确认并给出恢复步骤。Codex 的 AGENTS.md 更小，新增 engram 写入守卫，不再降低渲染模型。",
        },
      },
    ],
  },
  {
    minor: "0.10",
    date: "2026-09-23",
    headline: {
      es: "Planificación por niveles y un harness más difícil de romper",
      en: "Tiered planning and a harder-to-break harness",
      "zh-CN": "分级计划与更可靠的 harness",
    },
    bullets: [
      {
        es: "Los cambios se planifican por niveles: un clasificador decide cuánta planeación necesita cada tarea antes de despachar trabajo.",
        en: "Work is planned in tiers: a classifier decides how much planning each task needs before any work is dispatched.",
        "zh-CN": "派发前由分类器决定任务所需计划级别。",
      },
      {
        es: "El agente scribe puede quedarse con todo el Markdown del repo, para que los demás agentes no lo toquen.",
        en: "The scribe agent can own all of the repo's Markdown, so other agents leave it alone.",
        "zh-CN": "scribe 可独占仓库 Markdown，其他智能体不再修改。",
      },
      {
        es: "Se elimina toda atribución de IA en commits, PRs y código, y la regla aplica también a los comentarios.",
        en: "All AI attribution is removed from commits, PRs and code, and the rule now covers comments too.",
        "zh-CN": "提交、PR、代码和注释均移除 AI 归属信息。",
      },
      {
        es: "doctor verifica que el binario coincida con la versión fijada en el manifest y que el cableado MCP sea coherente.",
        en: "doctor checks that the binary matches the version pinned in the manifest and that MCP wiring is coherent.",
        "zh-CN": "doctor 检查可执行文件是否匹配清单固定版本，以及 MCP 接线一致性。",
      },
      {
        es: "Nuevas skills: Supabase, escribir skills propias, back-offices, y utilidades para rebase y limpieza de worktrees.",
        en: "New skills: Supabase, authoring your own skills, back-office patterns, and helpers for rebases and worktree cleanup.",
        "zh-CN": "新增 Supabase、编写技能、后台系统、rebase 与 worktree 清理技能。",
      },
    ],
    patches: [
      {
        version: "0.10.1",
        date: "2026-09-24",
        note: {
          es: "Nueve skills nuevas de librerías, un guard que también bloquea rutas absolutas a archivos managed, y avisos de binarios de plugins faltantes al iniciar.",
          en: "Nine new library skills, a guard that also blocks absolute paths to managed files, and warnings about missing plugin binaries on init.",
          "zh-CN": "新增九种库技能，守卫也拦截受管理文件的绝对路径，init 提示缺少插件可执行文件。",
        },
      },
    ],
  },
  {
    minor: "0.9",
    date: "2026-09-21",
    headline: {
      es: "Más agentes y cierres más confiables",
      en: "More agents and more dependable closes",
      "zh-CN": "更多智能体，更可靠的闭环",
    },
    bullets: [
      {
        es: "Nuevos agentes: scribe (escribe la documentación) y architect (diseña la solución antes de implementar).",
        en: "New agents: scribe (writes documentation) and architect (designs the solution before implementation).",
        "zh-CN": "新增 scribe 编写文档，architect 在实施前设计方案。",
      },
      {
        es: "Un advisor sugiere el modelo principal que conviene a tu sesión.",
        en: "An advisor suggests which main model fits your session.",
        "zh-CN": "advisor 为会话推荐适合的主模型。",
      },
      {
        es: "El gate detecta enlaces muertos en la documentación y pone techo de palabras a CLAUDE.md y a los bloques managed.",
        en: "The gate catches dead links in documentation and caps the word count of CLAUDE.md and managed blocks.",
        "zh-CN": "关卡检测文档失效链接，限制 CLAUDE.md 与受管理块字数。",
      },
      {
        es: "Nuevas skills secure-by-design y quality-attributes, y el recibo de revisión ahora se firma y verifica con un comando.",
        en: "New secure-by-design and quality-attributes skills, and the review receipt is now signed and checked with one command.",
        "zh-CN": "新增 secure-by-design 与 quality-attributes；一条命令即可签署和验证审查收据。",
      },
      {
        es: "Un quality gate que muere por timeout ya no se reporta como verde.",
        en: "A quality gate killed by a timeout is no longer reported as green.",
        "zh-CN": "因超时终止的质量关卡不再被报告为通过。",
      },
    ],
  },
  {
    minor: "0.8",
    date: "2026-09-09",
    headline: {
      es: "Búsqueda indexada con tgrep",
      en: "Indexed search with tgrep",
      "zh-CN": "使用 tgrep 索引搜索",
    },
    bullets: [
      {
        es: "Nuevo plugin tgrep: búsqueda de texto indexada, con su doctrina de uso ya integrada al harness.",
        en: "New tgrep plugin: indexed text search, with its usage doctrine built into the harness.",
        "zh-CN": "新增 tgrep 插件，将索引文本搜索及使用规则整合到 harness。",
      },
      {
        es: "codegraph arranca cargado desde el inicio de la sesión en vez de diferido.",
        en: "codegraph now starts loaded with the session instead of deferred.",
        "zh-CN": "codegraph 在会话启动时加载，不再延迟。",
      },
      {
        es: "navori audit --arm activa el modo audit en la sesión que ya está corriendo, sin depender del modelo.",
        en: "navori audit --arm turns on audit mode in the session already running, without relying on the model.",
        "zh-CN": "navori audit --arm 可在正在运行的会话启用审计，不依赖模型执行。",
      },
      {
        es: "Las métricas de audit miden mejor: la versión que corrió, el costo real de los hooks y los round-trips por tramo.",
        en: "Audit metrics measure better: the version that ran, the real cost of hooks and round-trips per stretch.",
        "zh-CN": "审计更准确记录实际版本、钩子成本与各段往返次数。",
      },
      {
        es: "El cierre de un ciclo deja el repo en la base sincronizada.",
        en: "Closing a cycle leaves the repo parked on the synced base.",
        "zh-CN": "循环结束后将仓库停在已同步的基础分支。",
      },
    ],
  },
  {
    minor: "0.7",
    date: "2026-09-02",
    headline: {
      es: "Más modos de permiso, harness ajenos y capa global",
      en: "More permission modes, foreign harnesses and the global layer",
      "zh-CN": "更多权限模式、外部 harness 与全局层",
    },
    bullets: [
      {
        es: "navori audit atribuye mejor: los hooks ya no se cargan a agentes que no los ejecutaron y muestra un histograma por modo de permiso.",
        en: "navori audit attributes more accurately: hooks are no longer charged to agents that didn't run them, and it shows a histogram per permission mode.",
        "zh-CN": "audit 改进归因，不把钩子成本计入未执行它的智能体，并按权限模式显示直方图。",
      },
      {
        es: "El harness reconoce los seis modos de permiso de Claude Code y doctor avisa cuando el tuyo no está soportado.",
        en: "The harness recognizes all six Claude Code permission modes, and doctor warns when yours isn't supported.",
        "zh-CN": "识别 Claude Code 的六种权限模式；doctor 对不支持的模式警告。",
      },
      {
        es: "doctor detecta harness ajenos que chocan con el tuyo y ofrece adoptarlos.",
        en: "doctor detects foreign harnesses that clash with yours and offers to adopt them.",
        "zh-CN": "doctor 识别冲突的外部 harness，并建议采用。",
      },
      {
        es: "Los agentes y skills pueden vivir en el scope global de tu máquina, y global uninstall retira solo lo que navori escribió.",
        en: "Agents and skills can live in your machine's global scope, and global uninstall removes only what navori wrote.",
        "zh-CN": "智能体与技能可放在机器全局作用域，global uninstall 仅移除 navori 写入内容。",
      },
      {
        es: "Un contexto always-on más ligero y skills al día con Keystone 8, Prisma 7 y Zod 4.",
        en: "A lighter always-on context and skills updated for Keystone 8, Prisma 7 and Zod 4.",
        "zh-CN": "常驻上下文更轻，技能更新到 Keystone 8、Prisma 7、Zod 4。",
      },
    ],
  },
  {
    minor: "0.6",
    date: "2026-08-20",
    headline: {
      es: "Diseño de solución y ticket triage",
      en: "Solution design and ticket triage",
      "zh-CN": "方案设计与工单分诊",
    },
    bullets: [
      {
        es: "Una capa de diseño de solución revisa el enfoque con un segundo análisis en contexto fresco antes de implementar.",
        en: "A solution-design layer reviews the approach with a second pass in a fresh context before implementation.",
        "zh-CN": "实施前以新上下文进行第二次设计审视。",
      },
      {
        es: "Al recibir un ticket, el harness separa el problema de la solución propuesta y verifica el tamaño real del cambio.",
        en: "When a ticket arrives, the harness separates the problem from the proposed solution and verifies the real size of the change.",
        "zh-CN": "接收工单时区分问题与建议方案，并验证真实变更规模。",
      },
      {
        es: "render y doctor administran el .gitignore del harness y revisan la higiene de git.",
        en: "render and doctor manage the harness .gitignore and check git hygiene.",
        "zh-CN": "render 和 doctor 管理 harness .gitignore，检查 git 卫生。",
      },
      {
        es: "Nuevo navori audit y modo audit por sesión, para ver qué hizo el harness en tus sesiones.",
        en: "New navori audit and per-session audit mode, to see what the harness did in your sessions.",
        "zh-CN": "新增 navori audit 和逐会话审计，了解 harness 实际行为。",
      },
      {
        es: "Nueva skill babysit-prs y cinco reglas más en el checklist de revisión.",
        en: "New babysit-prs skill and five more rules in the review checklist.",
        "zh-CN": "新增 babysit-prs 技能，审查清单增加五条规则。",
      },
      {
        es: "Las skills de librerías se detectan también por archivos del proyecto, no solo por dependencias.",
        en: "Library skills are also detected from project files, not only dependencies.",
        "zh-CN": "库技能也可通过项目文件检测，不只看依赖。",
      },
    ],
    patches: [
      {
        version: "0.6.5",
        date: "2026-08-28",
        note: {
          es: "navori audit se rediseña: una ficha por agente, el harness registra su propia ejecución y la activación ya no falla en silencio.",
          en: "navori audit is redesigned: a per-agent card, the harness records its own execution, and activation no longer fails silently.",
          "zh-CN": "audit 重构为逐智能体卡片，由 harness 记录自身执行，激活不再静默失败。",
        },
      },
    ],
  },
  {
    minor: "0.5",
    date: "2026-07-31",
    headline: {
      es: "Endurecimiento de seguridad y mejor doctor",
      en: "Security hardening and a better doctor",
      "zh-CN": "强化安全，改进 doctor",
    },
    bullets: [
      {
        es: "Se cierran varias vías de ataque: inyección de comandos en hooks generados, path traversal en workspaces y forja de marcadores.",
        en: "Several attack paths are closed: command injection in generated hooks, workspace path traversal and marker forgery.",
        "zh-CN": "关闭生成钩子的命令注入、工作区路径遍历、标记伪造等攻击路径。",
      },
      {
        es: "Nuevo harness global: una base por máquina en ~/.claude.",
        en: "New global harness: a per-machine base in ~/.claude.",
        "zh-CN": "新增全局 harness，在 ~/.claude 为每台机器设置基线。",
      },
      {
        es: "Nuevo dominio: una base de conocimiento del workspace que los agentes consultan.",
        en: "New domain knowledge base for the workspace that agents can consult.",
        "zh-CN": "新增工作区领域知识库，供智能体查询。",
      },
      {
        es: "doctor revisa más: codegraph, drift de hooks, engines y workspaces.",
        en: "doctor checks more: codegraph, hook drift, engines and workspaces.",
        "zh-CN": "doctor 扩展检查 codegraph、钩子漂移、引擎和工作区。",
      },
      {
        es: "Nuevos hooks de ciclo de vida (Stop, SubagentStop, PreCompact) y navori se hospeda a sí mismo con su propio harness.",
        en: "New lifecycle hooks (Stop, SubagentStop, PreCompact), and navori now runs on its own harness.",
        "zh-CN": "新增 Stop、SubagentStop、PreCompact 生命周期钩子，navori 开始使用自身 harness。",
      },
    ],
  },
  {
    minor: "0.4",
    date: "2026-07-29",
    headline: {
      es: "Contexto quirúrgico con codegraph",
      en: "Surgical context with codegraph",
      "zh-CN": "通过 codegraph 获取精确上下文",
    },
    bullets: [
      {
        es: "Nuevo plugin codegraph: los agentes obtienen contexto del código vía MCP en lugar de leer archivos completos.",
        en: "New codegraph plugin: agents get code context through MCP instead of reading whole files.",
        "zh-CN": "新增 codegraph 插件，智能体通过 MCP 获取代码上下文，无需读取完整文件。",
      },
      {
        es: "Al abrir una sesión, el harness inyecta rama, commits recientes y el estado de la tarea.",
        en: "On session start the harness injects the branch, recent commits and task state.",
        "zh-CN": "启动会话时注入分支、近期提交和任务状态。",
      },
      {
        es: "El recibo de revisión queda atado al contenido del diff, así una revisión no aplica a cambios posteriores.",
        en: "The review receipt is bound to the diff's content, so a review no longer covers later changes.",
        "zh-CN": "审查收据绑定差异内容，后续变更不再被旧审查覆盖。",
      },
      {
        es: "Permisos preconfigurados según tu preset para reducir los avisos, y el CLAUDE.md generado es más compacto y en inglés.",
        en: "Preset-aware permissions to cut prompts, and the generated CLAUDE.md is more compact and in English.",
        "zh-CN": "按预设设置权限以减少确认，生成的 CLAUDE.md 更小且使用英语。",
      },
    ],
  },
  {
    minor: "0.3",
    date: "2026-07-28",
    headline: {
      es: "Soporte completo para Codex, Cursor y Copilot",
      en: "Full support for Codex, Cursor and Copilot",
      "zh-CN": "全面支持 Codex、Cursor 和 Copilot",
    },
    bullets: [
      {
        es: "Nuevo engine Codex con AGENTS.md, orquestación y sandbox por rol, y checks propios en doctor.",
        en: "New Codex engine with AGENTS.md, orchestration and per-role sandboxing, plus its own doctor checks.",
        "zh-CN": "新增 Codex 引擎，提供 AGENTS.md、编排、逐角色沙箱及 doctor 检查。",
      },
      {
        es: "Adapters para Cursor y Copilot: el mismo harness se renderiza a cada herramienta.",
        en: "Adapters for Cursor and Copilot: the same harness renders to each tool.",
        "zh-CN": "新增 Cursor 和 Copilot 适配器，将同一 harness 渲染到各工具。",
      },
      {
        es: "render --all aplica el harness a todos tus repos registrados de una vez, y init --full instala todo.",
        en: "render --all applies the harness across all your registered repos at once, and init --full installs everything.",
        "zh-CN": "render --all 一次覆盖所有注册仓库，init --full 安装全部内容。",
      },
      {
        es: "Soporte para monorepos, presets nuevos (Bun/Keystone, React Native con Expo) y el agente auditor.",
        en: "Monorepo support, new presets (Bun/Keystone, React Native with Expo) and the auditor agent.",
        "zh-CN": "支持 monorepo，新增 Bun/Keystone、React Native/Expo 预设及 auditor。",
      },
      {
        es: "Los mensajes del CLI siguen el idioma configurado.",
        en: "CLI messages follow the configured language.",
        "zh-CN": "CLI 消息遵循配置语言。",
      },
    ],
  },
  {
    minor: "0.2",
    date: "2026-06-23",
    headline: {
      es: "Los cimientos del CLI",
      en: "The CLI foundations",
      "zh-CN": "CLI 的基础",
    },
    bullets: [
      {
        es: "El comando init detecta tu stack y genera navori.config.json junto con el harness de agentes.",
        en: "The init command detects your stack and generates navori.config.json along with the agent harness.",
        "zh-CN": "init 检测技术栈，生成 navori.config.json 与智能体 harness。",
      },
      {
        es: "render y sync mantienen los bloques managed al día sin tocar lo que escribiste tú.",
        en: "render and sync keep managed blocks up to date without touching what you wrote.",
        "zh-CN": "render 和 sync 更新受管理块，保留自定义内容。",
      },
      {
        es: "Presets, plugins y skills instalables con add, y doctor para diagnosticar el harness.",
        en: "Presets, plugins and skills installable with add, plus doctor to diagnose the harness.",
        "zh-CN": "add 安装预设、插件与技能，doctor 负责诊断。",
      },
    ],
  },
];
