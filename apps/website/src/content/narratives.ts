import type { Lang } from "../i18n/ui";

/** Full narrative copy shared by the reusable page templates and agent exports. */
export const narratives = {
  "deep-dive.0": {
    en: "Orchestrator",
    es: "Orchestrator",
    "zh-CN": "编排者",
  },
  "deep-dive.1": {
    en: "orchestrator",
    es: "orquestador",
    "zh-CN": "orchestrator",
  },
  "deep-dive.2": {
    en: "The brain of the operation: it breaks down the task, hands out the work, and puts the pieces back together.",
    es: "El cerebro de la operación: descompone la tarea, reparte el trabajo y junta las piezas.",
    "zh-CN": "负责拆分任务、分配工作，并把结果整合为完整方案。",
  },
  "deep-dive.3": {
    en: "The main agent embodies it, not a separate subagent — it's the session's center of gravity. It reads the ticket, decides how many subtasks to split into, launches the workers in parallel, and finally integrates their results into one coherent solution. It uses the most capable model (opus) because its job is to reason and decide, not read files.",
    es: "Lo encarna el agente principal, no un subagente aparte — es el centro de gravedad de la sesión. Lee el ticket, decide en cuántas subtareas se parte, lanza a los trabajadores en paralelo y al final integra sus resultados en una sola solución coherente. Usa el modelo más capaz (opus) porque su trabajo es razonar y decidir, no leer archivos.",
    "zh-CN":
      "由主智能体直接承担这个角色，而非另建子智能体。它读取任务，决定如何拆分，并行启动执行者，最后将结果整合为一致的解决方案。使用能力最强的模型（opus），因为它的职责是推理与决策，而非阅读文件。",
  },
  "deep-dive.4": {
    en: "Scout",
    es: "Scout",
    "zh-CN": "侦察者",
  },
  "deep-dive.5": {
    en: "read-only",
    es: "read-only",
    "zh-CN": "只读",
  },
  "deep-dive.6": {
    en: "The one that maps an area or answers one pointed question by searching the code.",
    es: "El que mapea un área o responde una pregunta puntual buscando en el código.",
    "zh-CN": "通过搜索代码映射一个区域，或回答一个明确问题。",
  },
  "deep-dive.7": {
    en: "Before a refactor or a big feature, the orchestrator sends it to map a module — what files exist, how they connect, and where the flow enters — or to dig up a fact it needs to decide, like 'how is login validated today?'. It reads only excerpts —not whole files— and writes its findings to a separate file instead of filling the main thread: a map or a pointed answer, never open-ended exploration or a dump.",
    es: "Antes de un refactor o una feature grande, el orchestrator lo manda a mapear un módulo —qué archivos existen, cómo se conectan y por dónde entra el flujo— o a investigar un dato puntual —'¿cómo se valida hoy el login?'—. Lee solo extractos —no archivos enteros— y escribe sus hallazgos en un archivo aparte en vez de llenar el hilo principal: un mapa o una respuesta puntual, nunca exploración abierta ni un volcado.",
    "zh-CN":
      "在重构或大型功能开始前，orchestrator 让它映射模块：文件、关系与流程入口；也可调查决策所需的事实，如当前登录如何校验。它只读相关片段，把发现写入独立文件，返回地图或明确答案，不进行无边界探索，也不倾倒文件内容。",
  },
  "deep-dive.8": {
    en: "Auditor",
    es: "Auditor",
    "zh-CN": "审计者",
  },
  "deep-dive.9": {
    en: "analysis / read-only",
    es: "análisis / read-only",
    "zh-CN": "分析 / 只读",
  },
  "deep-dive.10": {
    en: "The one that studies a hard ticket, or audits a module in depth, before anyone touches code.",
    es: "El que estudia un ticket difícil o audita a fondo un módulo antes de que nadie toque código.",
    "zh-CN": "在任何人改代码前，研究复杂工单或深入审计模块。",
  },
  "deep-dive.11": {
    en: "It covers three encargos: auditing a ticket (root cause, affected areas, a split plan) before implementing; auditing an area with no ticket involved (bugs, security holes, performance problems, architecture violations, uncovered edge cases) before refactoring it; or challenging a spec's design in fresh context. It never edits production code: it delivers a report or verdict on disk so the implementer doesn't start blind.",
    es: 'Cubre tres encargos: auditar un ticket (causa raíz, áreas afectadas, plan de partición) antes de implementar; auditar un área sin ticket de por medio (bugs, huecos de seguridad, rendimiento, violaciones de arquitectura, casos borde) antes de refactorizarla; o desafiar ("challenge") el diseño de una spec en contexto fresco. Nunca edita código de producción: entrega un reporte o veredicto en disco para que el implementer no arranque a ciegas.',
    "zh-CN":
      "它负责三类任务：实施前审计工单，确认根因、受影响区域和拆分计划；无工单时在重构前审计漏洞、性能、架构问题与边界场景；或在新上下文中质疑规格设计。它不编辑生产代码，而是将报告或结论写入磁盘，让 implementer 有据可依。",
  },
  "deep-dive.12": {
    en: "Architect",
    es: "Architect",
    "zh-CN": "架构师",
  },
  "deep-dive.13": {
    en: "design / read-only",
    es: "diseño / read-only",
    "zh-CN": "设计 / 只读",
  },
  "deep-dive.14": {
    en: "The one that explores alternatives and recommends by fit with the project — always on for level-2 and level-3 tasks.",
    es: "El que explora alternativas y recomienda por encaje con el proyecto — siempre activo en tareas de nivel 2 y 3.",
    "zh-CN": "探索备选方案，按项目适配程度推荐；始终参与二级和三级任务。",
  },
  "deep-dive.15": {
    en: "It steps in on every level-2 task (an advanced workplan) or level-3 task (a full spec): it explores at least three paths — existing pattern, extension, new abstraction —, drops the ones that don't fit in one line with its evidence, and recommends whichever best meets the project's decision criteria, not the cheapest option by default. It never decides alone and never decomposes into tasks: it presents the options with the recommended one first, the user picks, and the orchestrator builds the workplan afterward. Always enabled, with the highest model and effort (opus, effort xhigh) — exploring alternatives and weighing tradeoffs is its only job.",
    es: "Entra en toda tarea de nivel 2 (workplan avanzado) o nivel 3 (spec completa): explora al menos tres caminos — patrón existente, extensión, abstracción nueva —, descarta en una línea los que no encajan con su evidencia, y recomienda el que mejor cumple los criterios de decisión del proyecto, no el más barato por default. Nunca decide por sí solo ni descompone en tareas: presenta las opciones con la recomendada primero, el usuario elige y el orchestrator arma el workplan después. Siempre habilitado, con el modelo y el esfuerzo más altos (opus, esfuerzo xhigh) — explorar alternativas y sopesar tradeoffs es su único trabajo.",
    "zh-CN":
      "所有二级高级工作计划和三级完整规格均需要架构师。它至少探索现有模式、扩展和新抽象三条路径，为不合适的方案给出简明证据，按项目标准推荐，而非默认挑选最便宜的方案。它不独自决定，也不拆分任务：先给出推荐和选项，由用户选择，再由 orchestrator 制定计划。始终启用最高模型与推理强度（opus、xhigh），专注比较方案与权衡。",
  },
  "deep-dive.16": {
    en: "Implementer",
    es: "Implementer",
    "zh-CN": "实施者",
  },
  "deep-dive.17": {
    en: "writes",
    es: "escribe",
    "zh-CN": "写入",
  },
  "deep-dive.18": {
    en: "The one that writes the code: it takes ONE scoped task and finishes it.",
    es: "El que escribe el código: toma UNA tarea acotada y la deja lista.",
    "zh-CN": "接受一个明确限定的任务，并把代码工作完成。",
  },
  "deep-dive.19": {
    en: "It receives a well-defined subtask from the orchestrator, implements it respecting the repo's rules (CLAUDE.md), and doesn't call it done until the quality gate is green: lint and tests passing. An intermediate model (sonnet) balances code quality and cost.",
    es: "Recibe una subtarea bien definida del orchestrator, la implementa respetando las reglas del repo (CLAUDE.md) y no la da por terminada hasta dejar el quality gate en verde: lint y tests pasando. Un modelo intermedio (sonnet) equilibra calidad de código y costo.",
    "zh-CN":
      "从 orchestrator 接收清晰子任务，按照仓库规则（CLAUDE.md）实施，只有 lint 和测试等质量关卡通过后才报告完成。中等能力模型（sonnet）平衡代码质量与成本。",
  },
  "deep-dive.20": {
    en: "Reviewer",
    es: "Reviewer",
    "zh-CN": "审查者",
  },
  "deep-dive.21": {
    en: "gate",
    es: "gate",
    "zh-CN": "质量关卡",
  },
  "deep-dive.22": {
    en: "The one that reviews and approves or rejects. It doesn't edit: it judges.",
    es: "El que revisa y aprueba o rechaza. No edita: juzga.",
    "zh-CN": "审查并批准或拒绝，不修改代码。",
  },
  "deep-dive.23": {
    en: "It reviews the implementer's work against the project's rules and gates. It approves or rejects with concrete reasons. A strict second opinion before code moves on — which is why it uses a model that can judge with criteria.",
    es: "Revisa el trabajo del implementer contra las reglas del proyecto y los gates. Aprueba o rechaza con motivos concretos. Es una segunda opinión estricta antes de que el código avance — por eso usa un modelo capaz de juzgar con criterio.",
    "zh-CN":
      "按照项目规则与质量关卡审查 implementer 的工作，给出具体的批准或拒绝理由。这是在代码继续流转前的严格第二意见，因此需要有判断能力的模型。",
  },
  "deep-dive.24": {
    en: "Publisher",
    es: "Publisher",
    "zh-CN": "发布者",
  },
  "deep-dive.25": {
    en: "git/gh",
    es: "git/gh",
    "zh-CN": "git/gh",
  },
  "deep-dive.26": {
    en: "The one that drafts the commit, opens the Pull Request, and posts comments on Jira/GitHub.",
    es: "El que redacta el commit, abre el Pull Request y publica comentarios en Jira/GitHub.",
    "zh-CN": "草拟提交，创建 Pull Request，并发布 Jira/GitHub 评论。",
  },
  "deep-dive.27": {
    en: "Once the work is approved, it writes the commit message in the repo's format (Conventional) and opens the PR with a title and description. It runs checks against git/gh before touching the network, and posts informational comments always with a draft first. A mechanical, scoped task: a lightweight model is enough.",
    es: "Cuando el trabajo está aprobado, escribe el mensaje de commit con el formato del repo (Conventional) y abre el PR con título y descripción. Corre chequeos contra git/gh antes de tocar la red, y publica comentarios informativos siempre con borrador previo. Tarea mecánica y acotada: un modelo ligero basta.",
    "zh-CN":
      "工作获批后，它按仓库 Conventional 格式撰写提交信息和 PR 标题、说明。联网前检查 git/gh；发布信息性评论前先给出草稿。工作机械且范围明确，轻量模型即可。",
  },
  "deep-dive.28": {
    en: "Scribe",
    es: "Scribe",
    "zh-CN": "文档员",
  },
  "deep-dive.29": {
    en: "documentation",
    es: "documentación",
    "zh-CN": "文档",
  },
  "deep-dive.30": {
    en: "The only one that writes Markdown: it serializes already-verified evidence into the artifact at hand.",
    es: "El único que escribe Markdown: serializa evidencia ya verificada en el artefacto que toca.",
    "zh-CN": "唯一编写 Markdown 的角色，将已验证证据整理为目标文档。",
  },
  "deep-dive.31": {
    en: "When the harness has `harness.scribeOwnsMarkdown` on, it's the only role that touches `.md` files: it turns another agent's structured evidence into its Markdown report, or drafts the prose a `markdownRequest` asks for, in its own separate commit. It doesn't investigate or invent claims — only what the evidence already supports.",
    es: "Cuando el harness tiene activo `harness.scribeOwnsMarkdown`, es el único rol que toca archivos `.md`: convierte la evidencia estructurada de otro agente en su reporte Markdown, o redacta la prosa que un `markdownRequest` pide, en un commit propio y separado. No investiga ni inventa reclamos — solo lo que la evidencia ya sostiene.",
    "zh-CN":
      "启用 harness.scribeOwnsMarkdown 时，只有它可以编辑 .md 文件：将其他智能体的结构化证据转换为 Markdown 报告，或按 markdownRequest 撰写文档，并使用独立提交。它不调查、不虚构结论，只整理证据已支持的内容。",
  },
  "deep-dive.32": {
    en: "Publish & document",
    es: "Publicar y documentar",
    "zh-CN": "发布与文档",
  },
  "deep-dive.33": {
    en: "Fast and cheap for mechanical tasks.",
    es: "Rápido y barato para tareas mecánicas.",
    "zh-CN": "机械任务使用快速、低成本模型。",
  },
  "deep-dive.34": {
    en: "Read, write & audit",
    es: "Leer, escribir y auditar",
    "zh-CN": "阅读、编写与审计",
  },
  "deep-dive.35": {
    en: "Balance of quality and cost.",
    es: "Equilibrio entre calidad y costo.",
    "zh-CN": "平衡质量和成本。",
  },
  "deep-dive.36": {
    en: "Decide & design",
    es: "Decidir y diseñar",
    "zh-CN": "决策与设计",
  },
  "deep-dive.37": {
    en: "The muscle where judgment matters.",
    es: "El músculo donde el criterio importa.",
    "zh-CN": "把强能力用在需要判断之处。",
  },
  "deep-dive.38": {
    en: "Complexity ≤ 3, at most one non-trivial file, no critical-area floor.",
    es: "Complejidad ≤ 3, a lo sumo un archivo no trivial, sin piso de área crítica.",
    "zh-CN": "复杂度 ≤ 3，最多一个非平凡文件，且没有关键区域的最低级别要求。",
  },
  "deep-dive.39": {
    en: "None — a direct change, with an exemption classify confirms.",
    es: "Ninguno — cambio directo, con exención confirmada por classify.",
    "zh-CN": "无需独立计划；classify 确认可直接执行的豁免。",
  },
  "deep-dive.40": {
    en: "The common case: most planned tasks land here.",
    es: "El caso común: la mayoría de las tareas con plan caen aquí.",
    "zh-CN": "常见情况，大多数计划任务属于此级别。",
  },
  "deep-dive.41": {
    en: "Simple workplan (plan-simple skill): objective, A<n> criteria with command and expected output, out of scope, files, progress, decisions.",
    es: "Workplan simple (skill plan-simple): objetivo, criterios A<n> con comando y salida esperada, fuera de alcance, archivos, progreso, decisiones.",
    "zh-CN":
      "简单工作计划（plan-simple 技能）：目标、带命令与期望输出的 A<n> 标准、范围外事项、文件、进度和决策。",
  },
  "deep-dive.42": {
    en: "Complexity ≥ 8, or a critical-area floor, money/credentials/PII, multi-repo, a new dependency, a shared contract, or a migration.",
    es: "Complejidad ≥ 8, o un piso de área crítica, dinero/credenciales/PII, multi-repo, dependencia nueva, contrato compartido o migración.",
    "zh-CN": "复杂度 ≥ 8，或涉及关键区域、资金/凭据/个人信息、多仓库、新依赖、共享契约或迁移。",
  },
  "deep-dive.43": {
    en: "Advanced workplan (plan-advanced skill) + the architect explores alternatives and recommends; the user picks before the verdict.",
    es: "Workplan avanzado (skill plan-advanced) + el architect explora alternativas y recomienda; el usuario elige antes del veredicto.",
    "zh-CN": "高级工作计划（plan-advanced 技能）；架构师探索并推荐选项，用户先选择，再形成结论。",
  },
  "deep-dive.44": {
    en: "The user accepted a spec.",
    es: "El usuario aceptó una spec.",
    "zh-CN": "用户已接受规格。",
  },
  "deep-dive.45": {
    en: "specs/<feature>/{requirements,design,tasks}.md — the architect writes design.md, no separate workplan.",
    es: "specs/<feature>/{requirements,design,tasks}.md — el architect escribe design.md, sin workplan aparte.",
    "zh-CN":
      "specs/<feature>/{requirements,design,tasks}.md；架构师编写 design.md，不另建工作计划。",
  },
  "deep-dive.46": {
    en: "Harness",
    es: "Harness",
    "zh-CN": "Harness",
  },
  "deep-dive.47": {
    en: "The 'harness' around the AI assistant: the rules, agents, and automations that make it work the way your team expects, not on a whim.",
    es: "El 'arnés' de trabajo: el conjunto de reglas, agentes y automatizaciones que rodean al asistente de IA para que trabaje como tu equipo espera, no a su antojo.",
    "zh-CN": "围绕 AI 助手的规则、智能体和自动化体系，让它按照团队期望工作，而非自行其是。",
  },
  "deep-dive.48": {
    en: "Agent / subagent",
    es: "Agente / subagente",
    "zh-CN": "智能体 / 子智能体",
  },
  "deep-dive.49": {
    en: "An assistant with a specific role (explore, write, review). The main agent splits work across specialized subagents.",
    es: "Un asistente con un rol específico (explorar, escribir, revisar). El agente principal reparte el trabajo entre subagentes especializados.",
    "zh-CN": "负责特定角色（探索、编写、审查）的助手。主智能体把工作分配给专门的子智能体。",
  },
  "deep-dive.50": {
    en: "Skill",
    es: "Skill",
    "zh-CN": "技能",
  },
  "deep-dive.51": {
    en: "A reusable guide for a concrete task ('how to create an endpoint', 'how to verify before calling something done'). The agent loads it when needed.",
    es: "Una guía reutilizable para una tarea concreta ('cómo crear un endpoint', 'cómo verificar antes de dar algo por hecho'). El agente la carga cuando la necesita.",
    "zh-CN": "完成具体任务的可复用指南，例如如何创建接口、如何验证完成；智能体按需加载。",
  },
  "deep-dive.52": {
    en: "Hook",
    es: "Hook",
    "zh-CN": "钩子",
  },
  "deep-dive.53": {
    en: "An automation that fires at a fixed moment —e.g. run the tests before every commit— so nobody has to remember.",
    es: "Una automatización que se dispara en un momento fijo —por ejemplo, correr los tests antes de cada commit— sin que nadie tenga que acordarse.",
    "zh-CN": "在固定时机触发的自动化，如每次提交前运行测试，无需人为记住。",
  },
  "deep-dive.54": {
    en: "Quality gate",
    es: "Quality gate",
    "zh-CN": "质量关卡",
  },
  "deep-dive.55": {
    en: "The quality bar: the commands (lint, tests) that must pass to call a change done.",
    es: "La barrera de calidad: los comandos (lint, tests) que deben pasar para dar un cambio por terminado.",
    "zh-CN": "判定变更完成前必须通过的命令，如 lint 与测试。",
  },
  "deep-dive.56": {
    en: "SDD",
    es: "SDD",
    "zh-CN": "SDD",
  },
  "deep-dive.57": {
    en: "Spec-Driven Development: instead of rules living in someone's head, they're written and versioned next to the code, updated with one command.",
    es: "Spec-Driven Development: en vez de que las reglas vivan en la cabeza de alguien, se escriben y se versionan junto al código, y se actualizan con un comando.",
    "zh-CN": "规格驱动开发：规则写在代码旁并随版本管理，可用一条命令更新，而非仅存于个人脑中。",
  },
  "deep-dive.58": {
    en: "Preset",
    es: "Preset",
    "zh-CN": "预设",
  },
  "deep-dive.59": {
    en: "A config bundle per stack type (Vite + React, NestJS, monorepo…). navori detects your stack and picks the right preset.",
    es: "Un paquete de configuración por tipo de stack (Vite + React, NestJS, monorepo…). navori detecta tu stack y elige el preset adecuado.",
    "zh-CN":
      "按技术栈打包的配置，如 Vite + React、NestJS 或 monorepo。navori 检测技术栈并选择对应预设。",
  },
  "deep-dive.60": {
    en: "Engram",
    es: "Engram",
    "zh-CN": "Engram",
  },
  "deep-dive.61": {
    en: "The persistent memory: it stores decisions and learnings so the assistant recalls them next session.",
    es: "La memoria persistente: guarda decisiones y aprendizajes para que el asistente los recuerde en la siguiente sesión.",
    "zh-CN": "持久记忆，保存决策与经验，使助手能在下次会话恢复。",
  },
  "deep-dive.62": {
    en: "Managed block",
    es: "Bloque managed",
    "zh-CN": "受管理块",
  },
  "deep-dive.63": {
    en: "A chunk of CLAUDE.md marked 'managed by navori': it updates itself without touching what you wrote around it.",
    es: "Un fragmento de CLAUDE.md marcado como 'gestionado por navori': se actualiza solo, sin pisar lo que tú escribiste alrededor.",
    "zh-CN": "CLAUDE.md 中标记为 managed by navori 的片段，可更新而不覆盖周围的自定义内容。",
  },
  "deep-dive.64": {
    en: "legacyPaths",
    es: "legacyPaths",
    "zh-CN": "legacyPaths",
  },
  "deep-dive.65": {
    en: "The folders of old code you flag so agents treat them carefully and don't impose new rules on them.",
    es: "Las carpetas de código viejo que marcas para que los agentes las traten con cuidado y no les impongan reglas nuevas.",
    "zh-CN": "你标记的旧代码目录，智能体会谨慎处理，不强加新规则。",
  },
  "deep-dive.66": {
    en: "Isolated context per subagent",
    es: "Contexto aislado por subagente",
    "zh-CN": "各子智能体上下文隔离",
  },
  "deep-dive.67": {
    en: "Each subagent runs in its own window and returns only the conclusion. The orchestrator's thread never fills with the dump of files it read.",
    es: "Cada subagente corre en su propia ventana y devuelve solo la conclusión. El hilo del orchestrator nunca se llena con el volcado de los archivos que leyó.",
    "zh-CN": "每个子智能体在独立窗口运行，只返回结论。orchestrator 的线程不会堆满读取的文件。",
  },
  "deep-dive.68": {
    en: "One model per role",
    es: "Un modelo por rol",
    "zh-CN": "按角色分配模型",
  },
  "deep-dive.69": {
    en: "Each agent uses the right model: a light one to read and explore, the powerful one only to decide and review. You don't pay a premium model to read files.",
    es: "Cada agente usa el modelo justo: uno ligero para leer y explorar, el potente solo para decidir y revisar. No pagas un modelo caro por leer archivos.",
    "zh-CN": "阅读和探索使用轻模型，决策与审查使用强模型，避免让高成本模型承担文件阅读。",
  },
  "deep-dive.70": {
    en: "Excerpt-level reads",
    es: "Lectura por extractos",
    "zh-CN": "按片段阅读",
  },
  "deep-dive.71": {
    en: "Scout reads the relevant fragments, not whole files. It locates — it does not photocopy.",
    es: "Scout lee los fragmentos relevantes, no archivos completos. Localiza, no fotocopia.",
    "zh-CN": "Scout 只读相关片段，不读取全部文件。它负责定位，而非复制整库。",
  },
  "deep-dive.72": {
    en: "Skills on demand",
    es: "Skills bajo demanda",
    "zh-CN": "按需加载技能",
  },
  "deep-dive.73": {
    en: "The skill catalog is referenced by index; the heavy content loads only when the task calls for it.",
    es: "El catálogo de skills se referencia por índice; el contenido pesado se carga solo cuando la tarea lo pide.",
    "zh-CN": "技能目录用索引引用，只有任务需要时才加载完整内容。",
  },
  "deep-dive.74": {
    en: "Compact managed blocks",
    es: "Bloques managed compactos",
    "zh-CN": "精简受管理块",
  },
  "deep-dive.75": {
    en: "Canonical ordering sorts and dedupes the rules in CLAUDE.md. No pasted copies, no noise piling up session after session.",
    es: "El orden canónico ordena y deduplica las reglas en CLAUDE.md. Sin copias pegadas ni ruido que se acumula sesión tras sesión.",
    "zh-CN": "规范排序与去重保持 CLAUDE.md 简洁，避免复制与逐会话累积的噪声。",
  },
  "deep-dive.76": {
    en: "Survives session closes and context compactions.",
    es: "Sobrevive a cierres de sesión y a las compactaciones de contexto.",
    "zh-CN": "会话结束和上下文压缩之后仍然保留。",
  },
  "deep-dive.77": {
    en: "mem_save stores decisions, root-caused bugs, and conventions; mem_search recalls them on startup.",
    es: "mem_save guarda decisiones, bugs con causa raíz y convenciones; mem_search los recupera al arrancar.",
    "zh-CN": "mem_save 保存决策、已查明根因的错误和约定；mem_search 在启动时找回。",
  },
  "deep-dive.78": {
    en: "The protocol is injected into the orchestrator: it saves proactively, without being asked.",
    es: "El protocolo se inyecta en el orchestrator: guarda de forma proactiva, sin que se lo pidas.",
    "zh-CN": "协议注入 orchestrator，主动保存，无需提醒。",
  },
  "deep-dive.79": {
    en: "Ships with navori by default (always-on). You never re-explain last week's context.",
    es: "Va siempre con navori (always-on). No re-explicas el contexto de la semana pasada.",
    "zh-CN": "navori 默认始终启用。无需重复解释上周的上下文。",
  },
  "deep-dive.80": {
    en: "Cross-repo config in ~/.navori/workspaces/<org>.json, outside any single repo.",
    es: "Config cross-repo en ~/.navori/workspaces/<org>.json, fuera de cada repo.",
    "zh-CN": "跨仓库配置位于 ~/.navori/workspaces/<org>.json，不属于某个单独仓库。",
  },
  "deep-dive.81": {
    en: "Org-wide defaults: quality gate, branch base, shared conventions.",
    es: "Defaults de organización: quality gate, branch base y convenciones compartidas.",
    "zh-CN": "组织级默认值：质量关卡、基础分支和共享约定。",
  },
  "deep-dive.82": {
    en: "Tickets as version-controlled files inside the workspace.",
    es: "Tickets como archivos versionables dentro del workspace.",
    "zh-CN": "任务以可版本管理的文件保存在工作区内。",
  },
  "deep-dive.83": {
    en: "workspace render applies the standard to every registered repo in one pass.",
    es: "workspace render aplica el estándar a todos los repos registrados de una pasada.",
    "zh-CN": "workspace render 一次将标准应用到所有已注册仓库。",
  },
  "deep-dive.84": {
    en: "Project mode, right from init",
    es: "Modo del proyecto, desde el init",
    "zh-CN": "init 时选择项目模式",
  },
  "deep-dive.85": {
    en: "You pick the terrain: greenfield (move fast), in production (guard regressions), or legacy migration (watch legacy↔new compatibility). The choice shapes how the agents work.",
    es: "Eliges el terreno: greenfield (muévete rápido), en producción (cuida regresiones) o migración legacy (cuida la compatibilidad legacy↔nuevo). La decisión moldea cómo trabajan los agentes.",
    "zh-CN":
      "选择全新项目（快速推进）、生产项目（防止回归）或旧系统迁移（维护新旧兼容），从而决定智能体工作方式。",
  },
  "deep-dive.86": {
    en: "legacyPaths the agents respect",
    es: "legacyPaths que los agentes respetan",
    "zh-CN": "智能体遵守 legacyPaths",
  },
  "deep-dive.87": {
    en: "You flag the legacy folders and the orchestrator, implementer, and reviewer know it: different rules apply there, and they don't impose new conventions on code that isn't theirs to touch.",
    es: "Marcas las carpetas legacy y el orchestrator, el implementer y el reviewer lo saben: ahí aplican reglas distintas y no imponen convenciones nuevas sobre código que no les toca.",
    "zh-CN":
      "标记旧代码目录后，orchestrator、implementer 和 reviewer 会遵守差异化规则，不对无权改动的旧代码强加新约定。",
  },
  "deep-dive.88": {
    en: "auditor before migrating",
    es: "auditor antes de migrar",
    "zh-CN": "迁移前先审计",
  },
  "deep-dive.89": {
    en: "Facing a structural migration (legacy → new backend, monolith → microservices), the agent dissects root cause, affected areas, and compatibility before anyone writes code.",
    es: "Ante una migración estructural (legacy → nuevo backend, monolito → microservicios), el agente diseca causa raíz, áreas afectadas y compatibilidad antes de que nadie escriba código.",
    "zh-CN":
      "面对结构迁移，如旧后端到新后端、单体到微服务，先分析根因、影响区域与兼容性，再编写代码。",
  },
  "deep-dive.90": {
    en: "Migration-aware skills",
    es: "Skills conscientes de la migración",
    "zh-CN": "理解迁移的技能",
  },
  "deep-dive.91": {
    en: "verify-before-done, debug-failure, and review-diff catch the inconsistent states where legacy and new code coexist — the most expensive bug in a half-done migration.",
    es: "verify-before-done, debug-failure y review-diff detectan estados inconsistentes cuando conviven código legacy y nuevo — el error más caro de una migración a medias.",
    "zh-CN":
      "verify-before-done、debug-failure 与 review-diff 能识别新旧代码共存时的不一致状态，减少半完成迁移中代价最高的错误。",
  },
  "deep-dive.92": {
    en: "Simplicity > cleverness",
    es: "Simplicidad > cleverness",
    "zh-CN": "简单优先",
  },
  "deep-dive.93": {
    en: "The standard before writing a line: is it the simplest thing? readable in 6 months? does it keep the existing pattern? No clever solutions nobody understands later.",
    es: "El estándar antes de escribir una línea: ¿es lo más simple? ¿legible en 6 meses? ¿mantiene el patrón existente? Nada de soluciones ingeniosas que nadie entiende después.",
    "zh-CN":
      "写代码前先问：是否最简单，六个月后是否可读，是否沿用现有模式？避免以后无人理解的技巧。",
  },
  "deep-dive.94": {
    en: "any forbidden",
    es: "any prohibido",
    "zh-CN": "禁止 any",
  },
  "deep-dive.95": {
    en: "unknown + narrowing, explicit types. The only exception is a // justified any: <reason> — last resort, not a shortcut that turns into debt.",
    es: "unknown + narrowing, tipado explícito. La única excepción es un // any justificado: <razón> — último recurso, no atajo que se vuelve deuda.",
    "zh-CN":
      "使用 unknown、类型收窄与显式类型。唯一例外为带原因的 // justified any: <reason>，只作最后手段，不作便捷捷径。",
  },
  "deep-dive.96": {
    en: "Defensive hooks",
    es: "Hooks defensivos",
    "zh-CN": "防御性钩子",
  },
  "deep-dive.97": {
    en: "guard-destructive intercepts dangerous commands; quality-gate runs lint + tests before every commit.",
    es: "guard-destructive intercepta comandos peligrosos; quality-gate corre lint + tests antes de cada commit.",
    "zh-CN": "guard-destructive 拦截危险命令；quality-gate 在每次提交前运行 lint 与测试。",
  },
  "deep-dive.98": {
    en: "deny / ask permissions",
    es: "Permisos deny / ask",
    "zh-CN": "deny / ask 权限",
  },
  "deep-dive.99": {
    en: "Sensitive operations are blocked or require explicit confirmation. Defense in depth, not a single barrier.",
    es: "Las operaciones sensibles se bloquean o piden confirmación explícita. Defensa en profundidad, no una sola barrera.",
    "zh-CN": "敏感操作被阻止，或需要明确确认。使用多层防御，而非单一屏障。",
  },
  "deep-dive.100": {
    en: "It's not copy-pasting .claude/",
    es: "No es copy-paste de .claude/",
    "zh-CN": "无需复制 .claude/",
  },
  "deep-dive.101": {
    en: "A versioned source of truth and idempotent render. Copying folders between repos doesn't scale or survive an update; navori does.",
    es: "Una fuente de verdad versionada y render idempotente. Copiar carpetas entre repos no escala ni sobrevive a una actualización; navori sí.",
    "zh-CN": "版本化事实来源与幂等渲染，让跨仓库配置可以扩展并持续更新，避免手动复制目录。",
  },
  "deep-dive.102": {
    en: "It's not a static template",
    es: "No es una plantilla estática",
    "zh-CN": "持续维护而非静态模板",
  },
  "deep-dive.103": {
    en: "It detects your real stack —Mantine, Redux, NestJS, pnpm monorepo— and assembles the preset. The standards don't erode because they're versioned and update with one command.",
    es: "Detecta tu stack real —Mantine, Redux, NestJS, monorepo pnpm— y arma el preset. Los estándares no se erosionan porque están versionados y se actualizan con un comando.",
    "zh-CN":
      "检测真实技术栈，包括 Mantine、Redux、NestJS 和 pnpm monorepo，组合适合的预设。标准通过版本管理和一条更新命令持续维护。",
  },
  "deep-dive.104": {
    en: "Production and legacy, first-class",
    es: "Producción y legacy de primera clase",
    "zh-CN": "重视生产与旧系统",
  },
  "deep-dive.105": {
    en: "Most tools assume a clean repo. navori starts from reality: code that already runs, legacy dependencies, and half-done migrations.",
    es: "La mayoría de las herramientas asumen un repo limpio. navori parte de la realidad: código que ya corre, dependencias legacy y migraciones a medias.",
    "zh-CN": "很多工具假设仓库从零开始；navori 关注真实运行的代码、旧依赖和进行中的迁移。",
  },
  "deep-dive.106": {
    en: "Batteries included and wired",
    es: "Batería incluida y cableada",
    "zh-CN": "功能齐备且相互连接",
  },
  "deep-dive.107": {
    en: "Persistent memory, security and duplication gates, multi-agent orchestration, and a cross-repo standard. All polished and connected, not a README with manual steps.",
    es: "Memoria persistente, gates de seguridad y duplicación, orquestación multi-agente y estándar cross-repo. Todo pulido y conectado, no un README con pasos manuales.",
    "zh-CN":
      "持久记忆、安全与重复关卡、多智能体编排、跨仓库标准均已连通，无需照着 README 手动拼装。",
  },
  "deep-dive.108": {
    en: "Claude Code",
    es: "Claude Code",
    "zh-CN": "Claude Code",
  },
  "deep-dive.109": {
    en: "Anthropic",
    es: "Anthropic",
    "zh-CN": "Anthropic",
  },
  "deep-dive.110": {
    en: "The agent runtime navori materializes.",
    es: "El runtime de agentes que navori materializa.",
    "zh-CN": "navori 为其生成配置的智能体运行时。",
  },
  "deep-dive.111": {
    en: "engram",
    es: "engram",
    "zh-CN": "engram",
  },
  "deep-dive.112": {
    en: "Gentleman-Programming",
    es: "Gentleman-Programming",
    "zh-CN": "Gentleman-Programming",
  },
  "deep-dive.113": {
    en: "Persistent memory across sessions via MCP.",
    es: "Memoria persistente entre sesiones vía MCP.",
    "zh-CN": "通过 MCP 提供跨会话持久记忆。",
  },
  "deep-dive.114": {
    en: "GitHub CLI",
    es: "GitHub CLI",
    "zh-CN": "GitHub CLI",
  },
  "deep-dive.115": {
    en: "GitHub",
    es: "GitHub",
    "zh-CN": "GitHub",
  },
  "deep-dive.116": {
    en: "Issues and PRs from the terminal.",
    es: "Issues y PRs desde la terminal.",
    "zh-CN": "在终端管理 issue 与 PR。",
  },
  "deep-dive.117": {
    en: "Atlassian CLI",
    es: "Atlassian CLI",
    "zh-CN": "Atlassian CLI",
  },
  "deep-dive.118": {
    en: "Atlassian",
    es: "Atlassian",
    "zh-CN": "Atlassian",
  },
  "deep-dive.119": {
    en: "Jira tickets as a source of work.",
    es: "Tickets de Jira como fuente de trabajo.",
    "zh-CN": "将 Jira 工单作为工作来源。",
  },
  "deep-dive.120": {
    en: "codegraph",
    es: "codegraph",
    "zh-CN": "codegraph",
  },
  "deep-dive.121": {
    en: "colbymchenry",
    es: "colbymchenry",
    "zh-CN": "colbymchenry",
  },
  "deep-dive.122": {
    en: "Code graph over MCP: locate and measure impact without reading files.",
    es: "Grafo de código sobre MCP: localizar y medir impacto sin leer archivos.",
    "zh-CN": "通过 MCP 查询代码图，定位和衡量影响，无需读取整份文件。",
  },
  "deep-dive.123": {
    en: "AGENTS.md",
    es: "AGENTS.md",
    "zh-CN": "AGENTS.md",
  },
  "deep-dive.124": {
    en: "The universal agent-instructions spec — the multi-engine baseline.",
    es: "La spec universal de instrucciones para agentes — la base multi-engine.",
    "zh-CN": "通用智能体指令规范，是多引擎的基线。",
  },
  "deep-dive.125": {
    en: "Claude Code subagents",
    es: "Subagentes de Claude Code",
    "zh-CN": "Claude Code 子智能体",
  },
  "deep-dive.126": {
    en: "The orchestrator + workers pattern in isolated context.",
    es: "El patrón de orquestador + trabajadores en contexto aislado.",
    "zh-CN": "在隔离上下文中运行 orchestrator 与执行者的模式。",
  },
  "deep-dive.127": {
    en: "Spec-Driven Development",
    es: "Spec-Driven Development",
    "zh-CN": "规格驱动开发",
  },
  "deep-dive.128": {
    en: "Versioning skills, rules, and conventions as part of the repo.",
    es: "Versionar skills, reglas y convenciones como parte del repo.",
    "zh-CN": "将技能、规则与约定作为仓库一部分进行版本管理。",
  },
  "deep-dive.129": {
    en: "gentle-ai",
    es: "gentle-ai",
    "zh-CN": "gentle-ai",
  },
  "deep-dive.130": {
    en: "Gentleman-Programming",
    es: "Gentleman-Programming",
    "zh-CN": "Gentleman-Programming",
  },
  "deep-dive.131": {
    en: "Ecosystem configurator with SDD, persistent memory, and organic routing by task complexity.",
    es: "Configurador de ecosistema con SDD, memoria persistente y routing orgánico por complejidad de tarea.",
    "zh-CN": "支持 SDD、持久记忆与按任务复杂度自然路由的生态配置器。",
  },
  "deep-dive.132": {
    en: "gstack",
    es: "gstack",
    "zh-CN": "gstack",
  },
  "deep-dive.133": {
    en: "garrytan",
    es: "garrytan",
    "zh-CN": "garrytan",
  },
  "deep-dive.134": {
    en: "Role-chained skills; host auto-detection with a config per host; cross-model review.",
    es: "Skills encadenadas por rol; auto-detección de host con un config por host; cross-model review.",
    "zh-CN": "角色串联技能、宿主自动检测及独立配置，以及跨模型审查。",
  },
  "deep-dive.135": {
    en: "harness-sdd",
    es: "harness-sdd",
    "zh-CN": "harness-sdd",
  },
  "deep-dive.136": {
    en: "betta-tech",
    es: "betta-tech",
    "zh-CN": "betta-tech",
  },
  "deep-dive.137": {
    en: "EARS notation, requirement↔test traceability, and the filesystem as the spec's state machine.",
    es: "Notación EARS, trazabilidad requisito↔test y el filesystem como máquina de estados de la spec.",
    "zh-CN": "EARS 表述、需求与测试追踪，以及用文件系统表达规格状态机。",
  },
  "deep-dive.138": {
    en: "ejemplo-harness-subagentes",
    es: "ejemplo-harness-subagentes",
    "zh-CN": "ejemplo-harness-subagentes",
  },
  "deep-dive.139": {
    en: "betta-tech",
    es: "betta-tech",
    "zh-CN": "betta-tech",
  },
  "deep-dive.140": {
    en: "The Orchestrator/Implementer/Reviewer pattern and state on disk: chat only carries references.",
    es: "El patrón Orchestrator/Implementer/Reviewer y el estado en disco: por chat solo pasan referencias.",
    "zh-CN": "Orchestrator/Implementer/Reviewer 模式与磁盘状态，聊天仅传递引用。",
  },
  "deep-dive.141": {
    en: "superpowers",
    es: "superpowers",
    "zh-CN": "superpowers",
  },
  "deep-dive.142": {
    en: "obra",
    es: "obra",
    "zh-CN": "obra",
  },
  "deep-dive.143": {
    en: "Subagent-driven development: a fresh agent per task and specs a junior can follow.",
    es: "Subagent-driven development: agente fresco por tarea y specs que un junior puede seguir.",
    "zh-CN": "子智能体驱动开发：每项任务使用新的智能体，规格清楚到初级开发者也能执行。",
  },
  "deep-dive.144": {
    en: "ponytail",
    es: "ponytail",
    "zh-CN": "ponytail",
  },
  "deep-dive.145": {
    en: "DietrichGebert",
    es: "DietrichGebert",
    "zh-CN": "DietrichGebert",
  },
  "deep-dive.146": {
    en: "The anti-over-engineering decision ladder: lazy in the solution, never in the reading.",
    es: "La escalera de decisión anti-over-engineering: flojo en la solución, nunca en la lectura.",
    "zh-CN": "防止过度设计的决策阶梯：方案保持简单，阅读保持认真。",
  },
  "deep-dive.147": {
    en: "codegraph",
    es: "codegraph",
    "zh-CN": "codegraph",
  },
  "deep-dive.148": {
    en: "colbymchenry",
    es: "colbymchenry",
    "zh-CN": "colbymchenry",
  },
  "deep-dive.149": {
    en: "Surgical context from a pre-indexed graph instead of grep/read loops.",
    es: "Contexto quirúrgico vía grafo pre-indexado en vez de loops de grep/read.",
    "zh-CN": "通过预索引代码图获取精确上下文，替代反复搜索与阅读。",
  },
  "deep-dive.150": {
    en: "graphify",
    es: "graphify",
    "zh-CN": "graphify",
  },
  "deep-dive.151": {
    en: "Graphify-Labs",
    es: "Graphify-Labs",
    "zh-CN": "Graphify-Labs",
  },
  "deep-dive.152": {
    en: "A deterministic knowledge graph of code and docs, committed to the repo like managed assets.",
    es: "Knowledge graph determinista de código y docs, commiteado al repo como los managed assets.",
    "zh-CN": "确定性的代码与文档知识图，像受管理资源一样提交到仓库。",
  },
  "deep-dive.153": {
    en: "caveman",
    es: "caveman",
    "zh-CN": "caveman",
  },
  "deep-dive.154": {
    en: "JuliusBrussee",
    es: "JuliusBrussee",
    "zh-CN": "JuliusBrussee",
  },
  "deep-dive.155": {
    en: "Token efficiency as a cross-cutting skill: brevity without losing technical exactness.",
    es: "Eficiencia de tokens como skill transversal: brevedad sin perder exactitud técnica.",
    "zh-CN": "把 token 效率作为贯穿技能：简洁同时保持技术准确。",
  },
  "deep-dive.156": {
    en: "Goose",
    es: "Goose",
    "zh-CN": "Goose",
  },
  "deep-dive.157": {
    en: "Agentic AI Foundation",
    es: "Agentic AI Foundation",
    "zh-CN": "Agentic AI Foundation",
  },
  "deep-dive.158": {
    en: "Portable YAML recipes to share workflows across a team and CI/CD.",
    es: "Recipes portables en YAML para compartir workflows en equipo y CI/CD.",
    "zh-CN": "可移植的 YAML 配方，让团队和 CI/CD 共享工作流。",
  },
  "deep-dive.159": {
    en: "Pi",
    es: "Pi",
    "zh-CN": "Pi",
  },
  "deep-dive.160": {
    en: "Earendil",
    es: "Earendil",
    "zh-CN": "Earendil",
  },
  "deep-dive.161": {
    en: "Primitives, not features: on-demand skills and extensibility over baked-in workflows.",
    es: "Primitivas, no features: skills on-demand y extensibilidad sobre workflows horneados.",
    "zh-CN": "优先基本构件，以按需技能与可扩展性替代内置工作流。",
  },
  "deep-dive.162": {
    en: "clack",
    es: "clack",
    "zh-CN": "clack",
  },
  "deep-dive.163": {
    en: "citty",
    es: "citty",
    "zh-CN": "citty",
  },
  "deep-dive.164": {
    en: "zod",
    es: "zod",
    "zh-CN": "zod",
  },
  "deep-dive.165": {
    en: "Astro",
    es: "Astro",
    "zh-CN": "Astro",
  },
  "deep-dive.166": {
    en: "Tailwind CSS",
    es: "Tailwind CSS",
    "zh-CN": "Tailwind CSS",
  },
  "deep-dive.167": {
    en: "Have the prerequisites",
    es: "Ten los requisitos",
    "zh-CN": "准备前置条件",
  },
  "deep-dive.168": {
    en: "Node.js 22.12+, Claude Code and —if the repo uses persistent memory— the engram binary. In step 3, doctor tells you exactly what's missing.",
    es: "Node.js 22.12+, Claude Code y —si el repo usa memoria persistente— el binario de engram. En el paso 3, doctor te dice exactamente qué falta.",
    "zh-CN":
      "需要 Node.js 22.12+、Claude Code，以及使用持久记忆时的 engram 可执行文件。第三步的 doctor 会准确说明缺少什么。",
  },
  "deep-dive.169": {
    en: "Clone and rebuild the harness",
    es: "Clona y reconstruye el harness",
    "zh-CN": "克隆并重建 harness",
  },
  "deep-dive.170": {
    en: "The repo already ships navori.config.json (the source of truth). A single command rebuilds every configured engine identically for the whole team. Idempotent: running it twice changes nothing.",
    es: "El repo ya trae navori.config.json (la fuente de verdad). Un solo comando reconstruye todos los engines configurados de forma idéntica para el equipo. Idempotente: correrlo dos veces no cambia nada.",
    "zh-CN":
      "仓库已有唯一事实来源 navori.config.json。一条命令就能为全队一致地重建所有已配置引擎，重复运行也不会产生变化。",
  },
  "deep-dive.171": {
    en: "Verify with doctor",
    es: "Verifica con doctor",
    "zh-CN": "使用 doctor 验证",
  },
  "deep-dive.172": {
    en: "doctor confirms everything is up to date and, if a tool is missing (e.g. engram), hands you the exact install command. No guessing.",
    es: "doctor confirma que todo está al día y, si te falta una herramienta (por ejemplo engram), te da el comando exacto para instalarla. Sin adivinar.",
    "zh-CN": "doctor 确认一切已更新；若缺少 engram 等工具，会给出准确安装命令，无需猜测。",
  },
  "deep-dive.173": {
    en: "Work as usual",
    es: "Trabaja normal",
    "zh-CN": "正常开始工作",
  },
  "deep-dive.174": {
    en: "Open Claude Code and you're set: same agents, same skills, same quality gate, same team memory. When someone updates the config, run sync to catch up without touching your code.",
    es: "Abre Claude Code y listo: mismos agentes, mismas skills, mismo quality gate y la misma memoria de equipo. Cuando alguien actualice la config, corre sync para ponerte al día sin tocar tu código.",
    "zh-CN":
      "打开 Claude Code，即可使用相同智能体、技能、质量关卡与团队记忆。配置更新后运行 sync，同步规则并保留代码。",
  },
  "deep-dive.175": {
    en: "Deep dive",
    es: "A fondo",
    "zh-CN": "深入了解",
  },
  "deep-dive.176": {
    en: "What navori delivers under the hood: multi-agent orchestration, one model per role, persistent memory with engram, org-wide workspaces, standards and gates — built for production code and legacy migrations.",
    es: "Qué aporta navori por dentro: orquestación multi-agente, un modelo por rol, memoria persistente con engram, workspaces de organización, estándares y gates — pensado para código en producción y migraciones legacy.",
    "zh-CN":
      "了解 navori 的内部能力：多智能体编排、按角色分配模型、engram 持久记忆、组织工作区、标准与关卡，适用于生产代码和旧系统迁移。",
  },
  "deep-dive.177": {
    en: "Deep dive",
    es: "A fondo",
    "zh-CN": "深入了解",
  },
  "deep-dive.178": {
    en: "What navori delivers",
    es: "Qué aporta navori",
    "zh-CN": "navori 的内部能力",
  },
  "deep-dive.179": {
    en: "under the hood.",
    es: "por dentro.",
    "zh-CN": "逐层解析。",
  },
  "deep-dive.180": {
    en: "navori isn't a generic scaffolder. It's an",
    es: "navori no es un scaffolder genérico. Es un harness",
    "zh-CN": "navori 是一个具有",
  },
  "deep-dive.181": {
    en: "opinionated",
    es: "opinado",
    "zh-CN": "明确主张的",
  },
  "deep-dive.182": {
    en: "harness, built for code that already lives in production —with legacy dependencies and half-finished migrations, not lab repos—. It turns Claude Code into a team with non-negotiable standards, memory that persists, and one shared standard across all your repos. Here's why, layer by layer, it's a foundation worth building on.",
    es: ", pensado para código que ya vive en producción —con dependencias legacy y migraciones a medias, no repos de laboratorio—. Convierte a Claude Code en un equipo con estándares no negociables, memoria que persiste y un mismo estándar en todos tus repos. Aquí está, capa por capa, por qué es la base sobre la que vale la pena construir.",
    "zh-CN":
      "harness，面向已经在生产环境运行、存在旧依赖及未完成迁移的真实代码。它把 Claude Code 组织成遵守标准、共享记忆与跨仓库规范的团队。下面逐层解释它为何适合作为基础。",
  },
  "deep-dive.183": {
    en: "New to terms like",
    es: "¿Nuevo en términos como",
    "zh-CN": "还不熟悉这些术语：",
  },
  "deep-dive.184": {
    en: "harness",
    es: "harness",
    "zh-CN": "harness",
  },
  "deep-dive.185": {
    en: "skill",
    es: "skill",
    "zh-CN": "技能",
  },
  "deep-dive.186": {
    en: ", or",
    es: "o",
    "zh-CN": "或",
  },
  "deep-dive.187": {
    en: "SDD",
    es: "SDD",
    "zh-CN": "SDD",
  },
  "deep-dive.188": {
    en: "Start with the quick glossary ↓",
    es: "Empieza por el diccionario rápido ↓",
    "zh-CN": "先查看简明术语表 ↓",
  },
  "deep-dive.189": {
    en: "Before you start",
    es: "Antes de empezar",
    "zh-CN": "开始之前",
  },
  "deep-dive.190": {
    en: "Quick glossary",
    es: "Diccionario rápido",
    "zh-CN": "简明术语表",
  },
  "deep-dive.191": {
    en: "No jargon. Tap any term to see what it means in one sentence.",
    es: "Sin jerga. Toca cualquier término para ver qué significa en una frase.",
    "zh-CN": "点击术语，用一句话理解含义。",
  },
  "deep-dive.192": {
    en: "01 · Orchestration",
    es: "01 · Orquestación",
    "zh-CN": "01 · 编排",
  },
  "deep-dive.193": {
    en: "A team of agents,",
    es: "Un equipo de agentes,",
    "zh-CN": "一支智能体团队，",
  },
  "deep-dive.194": {
    en: "not a single thread.",
    es: "no un solo hilo.",
    "zh-CN": "协作完成任务。",
  },
  "deep-dive.195": {
    en: "The main agent",
    es: "El agente principal",
    "zh-CN": "主智能体",
  },
  "deep-dive.196": {
    en: "embodies the orchestrator",
    es: "encarna al orchestrator",
    "zh-CN": "直接承担 orchestrator 角色",
  },
  "deep-dive.197": {
    en: "—the center of gravity—. Instead of doing everything in one thread, it decomposes the task and splits it across subagents that work in parallel and return only their conclusion. Each has a strict role and the right model for it.",
    es: "—el centro de gravedad—. En lugar de hacer todo en un mismo hilo, descompone la tarea y la reparte entre subagentes que trabajan en paralelo y devuelven solo su conclusión. Cada uno tiene un rol estricto y el modelo justo para él.",
    "zh-CN":
      "，作为会话中心拆分任务。子智能体并行工作，只返回结论。每个角色都有严格职责与合适的模型。",
  },
  "deep-dive.198": {
    en: "Tap a card to see what each role does ↓",
    es: "Toca una tarjeta para ver a qué se dedica cada rol ↓",
    "zh-CN": "点击卡片，了解每个角色的职责 ↓",
  },
  "deep-dive.199": {
    en: "Each role, its model — efficiency in time and tokens",
    es: "Cada rol, su modelo — eficiencia en tiempo y tokens",
    "zh-CN": "角色与模型：时间及 token 效率",
  },
  "deep-dive.200": {
    en: "All configurable in",
    es: "Todo configurable en",
    "zh-CN": "全部可在",
  },
  "deep-dive.201": {
    en: ". You don't pay a premium model to read files: muscle where decisions happen, speed where you explore. The architect also runs at the highest effort (",
    es: ". No pagas un modelo caro por leer archivos: el músculo va donde se decide, la velocidad donde se explora. El architect corre además con el esfuerzo más alto (",
    "zh-CN": "中配置。让强模型负责决策，让轻模型快速探索。架构师使用最高推理强度（",
  },
  "deep-dive.202": {
    en: "): the cost stays bounded because it only runs on level-2 and level-3 tasks, and that level is decided by",
    es: "): el costo queda acotado porque solo entra en tareas de nivel 2 y 3, y ese nivel lo decide",
    "zh-CN": "），只参与二级和三级任务，因此成本有界。级别由",
  },
  "deep-dive.203": {
    en: ", not the model.",
    es: ", no el modelo.",
    "zh-CN": "确定，而非模型自行判断。",
  },
  "deep-dive.204": {
    en: "the orchestrator, on a complex task",
    es: "el orchestrator, en una tarea compleja",
    "zh-CN": "复杂任务中的 orchestrator",
  },
  "deep-dive.205": {
    en: "Before dispatching, a plan level — proportional to risk",
    es: "Antes de delegar, un nivel de plan — proporcional al riesgo",
    "zh-CN": "派工前先按风险确定计划级别",
  },
  "deep-dive.206": {
    en: "The orchestrator classifies every task with",
    es: "El orchestrator clasifica cada tarea con",
    "zh-CN": "orchestrator 使用",
  },
  "deep-dive.207": {
    en: "— a complexity score of 0 to 10 from verifiable signals, never loose chat prose — and picks the matching plan level.",
    es: "— una complejidad de 0 a 10 desde señales verificables, nunca prosa suelta en el chat — y elige el nivel de plan correspondiente.",
    "zh-CN": "，按可验证信号计算 0–10 复杂度分数，选择对应级别，而非凭聊天中的笼统描述。",
  },
  "deep-dive.208": {
    en: "Level",
    es: "Nivel",
    "zh-CN": "级别",
  },
  "deep-dive.209": {
    en: "When",
    es: "Cuándo",
    "zh-CN": "适用情况",
  },
  "deep-dive.210": {
    en: "Artifact",
    es: "Artefacto",
    "zh-CN": "产物",
  },
  "deep-dive.211": {
    en: "A",
    es: "Un hook",
    "zh-CN": "由",
  },
  "deep-dive.212": {
    en: "hook denies dispatching the",
    es: "niega el despacho del",
    "zh-CN": "钩子限制派发",
  },
  "deep-dive.213": {
    en: "implementer",
    es: "implementer",
    "zh-CN": "implementer",
  },
  "deep-dive.214": {
    en: "unless the task carries a workplan that passes",
    es: "si la tarea no trae un workplan que pase",
    "zh-CN": "，任务必须携带通过",
  },
  "deep-dive.215": {
    en: ", or a level-0 exemption",
    es: ", o una exención de nivel 0 confirmada por",
    "zh-CN": "的工作计划，或由",
  },
  "deep-dive.216": {
    en: "confirms. Two reviewer rejections (",
    es: ". Dos rechazos del reviewer (",
    "zh-CN": "确认的零级豁免。连续两次审查拒绝（",
  },
  "deep-dive.217": {
    en: ") require the next level's artifacts before a third dispatch — at level 2 or 3, the gate escalates to the user instead of a third attempt.",
    es: ") exigen los artefactos del nivel siguiente antes de un tercer despacho — en nivel 2 o 3, el gate escala al usuario en vez de un tercer intento.",
    "zh-CN": "）后，第三次派发前必须补充更高级别产物；二级或三级则直接交由用户决定，而非继续尝试。",
  },
  "deep-dive.218": {
    en: "02 · The real terrain",
    es: "02 · El terreno real",
    "zh-CN": "02 · 真实环境",
  },
  "deep-dive.219": {
    en: "Built for production,",
    es: "Hecho para producción,",
    "zh-CN": "面向生产，",
  },
  "deep-dive.220": {
    en: "not for demos.",
    es: "no para demos.",
    "zh-CN": "立足真实代码。",
  },
  "deep-dive.221": {
    en: "Almost every tool assumes a clean, greenfield repo. navori starts from a real team's reality: code already running in production, legacy dependencies, and half-done migrations. From",
    es: "Casi todas las herramientas asumen un repo limpio y greenfield. navori parte de la realidad de un equipo: código que ya corre en producción, dependencias legacy y migraciones a medias. Desde el",
    "zh-CN":
      "多数工具假设仓库干净且从零开始。navori 关注团队现实：生产代码、旧依赖与进行中的迁移。通过",
  },
  "deep-dive.222": {
    en: "you pick the terrain, and that choice shapes how the agents work.",
    es: "eliges el terreno, y esa decisión moldea cómo trabajan los agentes.",
    "zh-CN": "选择工作环境，从而决定智能体如何工作。",
  },
  "deep-dive.223": {
    en: "navori init — project mode",
    es: "navori init — modo del proyecto",
    "zh-CN": "navori init — 项目模式",
  },
  "deep-dive.224": {
    en: "03 · Efficiency",
    es: "03 · Eficiencia",
    "zh-CN": "03 · 效率",
  },
  "deep-dive.225": {
    en: "Fewer tokens",
    es: "Menos tokens",
    "zh-CN": "减少 token",
  },
  "deep-dive.226": {
    en: "by design.",
    es: "por diseño.",
    "zh-CN": "从设计开始。",
  },
  "deep-dive.227": {
    en: "Orchestration isn't just about speed — it's context economy. The main thread stays clean because the heavy lifting happens in isolated windows —each with its own model— that return only what matters.",
    es: "La orquestación no es solo velocidad: es economía de contexto. El hilo principal se mantiene limpio porque el trabajo pesado ocurre en ventanas aisladas —cada una con su modelo— que solo devuelven lo esencial.",
    "zh-CN":
      "编排也管理上下文成本。繁重工作在独立窗口和独立模型中执行，只返回必要结论，主线程因此保持清晰。",
  },
  "deep-dive.228": {
    en: "The contrast",
    es: "El contraste",
    "zh-CN": "对比",
  },
  "deep-dive.229": {
    en: "without a harness",
    es: "sin harness",
    "zh-CN": "没有 harness",
  },
  "deep-dive.230": {
    en: "One thread reads whole files, piles everything into context, and drags it turn after turn until it saturates.",
    es: "Un solo hilo lee archivos enteros, acumula todo en el contexto y lo arrastra turno tras turno hasta saturarse.",
    "zh-CN": "单线程读取整份文件，将全部内容堆入上下文，逐轮携带直到窗口耗尽。",
  },
  "deep-dive.231": {
    en: "with navori",
    es: "con navori",
    "zh-CN": "使用 navori",
  },
  "deep-dive.232": {
    en: "Subagents explore in parallel and return conclusions. The orchestrator reasons over summaries, not dumps. Engram keeps what must be remembered outside the context window.",
    es: "Los subagentes exploran en paralelo y devuelven conclusiones. El orchestrator razona sobre resúmenes, no sobre volcados. Engram guarda lo que hay que recordar fuera del contexto.",
    "zh-CN":
      "子智能体并行探索并返回结论，orchestrator 基于摘要推理。Engram 把需要长期记住的内容保存在上下文窗口外。",
  },
  "deep-dive.233": {
    en: "04 · Memory",
    es: "04 · Memoria",
    "zh-CN": "04 · 记忆",
  },
  "deep-dive.234": {
    en: "Engram:",
    es: "Engram:",
    "zh-CN": "Engram：",
  },
  "deep-dive.235": {
    en: "memory that persists.",
    es: "memoria que persiste.",
    "zh-CN": "持久保存记忆。",
  },
  "deep-dive.236": {
    en: "An LLM's context is ephemeral: close the session and it's forgotten. Engram is the persistent memory navori enables by default. Decisions, root-caused bugs, and conventions get saved and recalled across sessions — and survive context compactions.",
    es: "El contexto de un LLM es efímero: se cierra la sesión y se olvida. Engram es la memoria persistente que navori habilita por default. Las decisiones, los bugs con causa raíz y las convenciones se guardan y se recuperan entre sesiones —y sobreviven a las compactaciones—.",
    "zh-CN":
      "LLM 上下文是临时的，会话关闭后就会遗忘。navori 默认启用 Engram，使决策、已查明根因的错误与约定可跨会话保存、找回，并在上下文压缩后继续存在。",
  },
  "deep-dive.237": {
    en: "today's session · next week's session",
    es: "sesión de hoy · sesión de la próxima semana",
    "zh-CN": "今天的会话 · 下周的会话",
  },
  "deep-dive.238": {
    en: "05 · Org scale",
    es: "05 · Escala de organización",
    "zh-CN": "05 · 组织扩展",
  },
  "deep-dive.239": {
    en: "One workspace,",
    es: "Un workspace,",
    "zh-CN": "一个工作区，",
  },
  "deep-dive.240": {
    en: "all your repos.",
    es: "todos tus repos.",
    "zh-CN": "覆盖所有仓库。",
  },
  "deep-dive.241": {
    en: "When you run 15 repos, you don't want 15 standards. The workspace is a cross-repo layer: define your org's quality gate, branch base, and conventions once, and every repo inherits them. The team works the same way no matter which project they're in.",
    es: "Cuando manejas 15 repos, no quieres 15 estándares. El workspace es una capa cross-repo: defines el quality gate, la branch base y las convenciones de tu organización una vez, y cada repo las hereda. El equipo trabaja igual, sin importar en qué proyecto esté.",
    "zh-CN":
      "管理十五个仓库时，无需维护十五套标准。工作区提供跨仓库层，统一定义组织质量关卡、基础分支与约定，由各仓库继承。团队切换项目时仍采用同一工作方式。",
  },
  "deep-dive.242": {
    en: "the org standard, to every repo",
    es: "el estándar de la org, a todos los repos",
    "zh-CN": "组织标准应用到每个仓库",
  },
  "deep-dive.243": {
    en: "06 · Guardrails",
    es: "06 · Guardarraíles",
    "zh-CN": "06 · 保护机制",
  },
  "deep-dive.244": {
    en: "Standards and gates",
    es: "Estándares y gates",
    "zh-CN": "用标准和关卡",
  },
  "deep-dive.245": {
    en: "that protect the work.",
    es: "que protegen el trabajo.",
    "zh-CN": "保护工作成果。",
  },
  "deep-dive.246": {
    en: "An agent with write access needs barriers. navori brings non-negotiable standards —simplicity, strict typing— and security and quality gates as part of the harness, not an optional extra. And it keeps them versioned alongside the rest of the config.",
    es: "Un agente con permiso de escritura necesita barreras. navori trae estándares no negociables —simplicidad, tipado estricto— y gates de seguridad y calidad como parte del harness, no como un extra opcional. Y los mantiene versionados junto al resto de la config.",
    "zh-CN":
      "拥有写入权限的智能体需要约束。navori 将简单性、严格类型、安全与质量关卡作为 harness 的必要组成，并与其余配置一同版本管理。",
  },
  "deep-dive.247": {
    en: "07 · The difference",
    es: "07 · La diferencia",
    "zh-CN": "07 · 差异",
  },
  "deep-dive.248": {
    en: "Why navori,",
    es: "Por qué navori,",
    "zh-CN": "为什么选 navori，",
  },
  "deep-dive.249": {
    en: "and not a generic scaffolder.",
    es: "y no un scaffolder genérico.",
    "zh-CN": "它与通用脚手架有何不同。",
  },
  "deep-dive.250": {
    en: "There are many ways to give an AI assistant instructions. Few survive the second month, a real team, or a repo with history. This is what navori does that the alternatives don't — or don't do as polished.",
    es: "Hay muchas formas de darle instrucciones a un asistente de IA. Pocas sobreviven al segundo mes, a un equipo de verdad o a un repo con historia. Esto es lo que navori hace y las alternativas no —o no tan pulido—.",
    "zh-CN":
      "给 AI 助手指令有很多方式，但很少能长期适应真实团队及有历史的仓库。以下能力展示 navori 的不同之处。",
  },
  "deep-dive.251": {
    en: "08 · For your team",
    es: "08 · Para tu equipo",
    "zh-CN": "08 · 团队协作",
  },
  "deep-dive.252": {
    en: "Join a repo",
    es: "Súmate a un repo",
    "zh-CN": "加入一个",
  },
  "deep-dive.253": {
    en: "that already runs navori.",
    es: "que ya usa navori.",
    "zh-CN": "已经使用 navori 的仓库。",
  },
  "deep-dive.254": {
    en: "You commit the config once to each repo; the team just follows it. Nobody hand-rolls a harness or copies",
    es: "Tú subes la config una vez a cada repo; el equipo solo la sigue. Nadie arma un harness a mano ni copia",
    "zh-CN": "每个仓库只需提交一次配置，团队随后遵循它。无需手写 harness，也无需在项目间复制",
  },
  "deep-dive.255": {
    en: "between projects. These are the commands each person runs on the way in.",
    es: "entre proyectos. Estos son los comandos que corre cada quien al entrar.",
    "zh-CN": "。以下是每位成员加入项目时运行的命令。",
  },
  "deep-dive.256": {
    en: "In short, for the team:",
    es: "En resumen para el equipo:",
    "zh-CN": "团队成员只需：",
  },
  "deep-dive.257": {
    en: "and start working with the same harness you use.",
    es: "y a trabajar con el mismo harness que tú.",
    "zh-CN": "即可使用相同 harness 开始工作。",
  },
  "deep-dive.258": {
    en: "From theory",
    es: "De la teoría",
    "zh-CN": "从理论",
  },
  "deep-dive.259": {
    en: "to the repo, in a minute.",
    es: "al repo, en un minuto.",
    "zh-CN": "一分钟落地到仓库。",
  },
  "deep-dive.260": {
    en: "All of this materializes with a single adoption command. The rest is rendering whenever you change something.",
    es: "Todo esto se materializa con un solo comando de adopción. El resto es renderizar cuando cambies algo.",
    "zh-CN": "一条采用命令就能生成这些内容，之后配置变化时重新渲染即可。",
  },
  "deep-dive.261": {
    en: "See the Quickstart",
    es: "Ver el Quickstart",
    "zh-CN": "查看快速开始",
  },
  "deep-dive.262": {
    en: "Command reference",
    es: "Referencia de comandos",
    "zh-CN": "命令参考",
  },
  "deep-dive.263": {
    en: "Credits",
    es: "Créditos",
    "zh-CN": "致谢",
  },
  "deep-dive.264": {
    en: "Shoulders of",
    es: "Hombros de",
    "zh-CN": "站在巨人的",
  },
  "deep-dive.265": {
    en: "giants.",
    es: "gigantes.",
    "zh-CN": "肩膀上。",
  },
  "deep-dive.266": {
    en: "navori wasn't born in a vacuum: it integrates excellent tools and synthesizes ideas from open projects and standards. Credit for each piece belongs to whoever built it.",
    es: "navori no nació en el vacío: integra herramientas excelentes y sintetiza ideas de proyectos y estándares abiertos. El mérito de cada pieza es de quien la construyó.",
    "zh-CN": "navori 集成了优秀工具，也从开源项目与标准中吸收想法。每项成果的贡献属于其原作者。",
  },
  "deep-dive.267": {
    en: "Builds on",
    es: "Se apoya en",
    "zh-CN": "基础工具",
  },
  "deep-dive.268": {
    en: "Ideas & standards",
    es: "Ideas y estándares",
    "zh-CN": "思想与标准",
  },
  "deep-dive.269": {
    en: "Projects that inspired it",
    es: "Proyectos que lo inspiraron",
    "zh-CN": "启发本项目的开源项目",
  },
  "deep-dive.270": {
    en: "navori took ideas from these projects; codegraph is also integrated as a plugin. Per-project notes live in",
    es: "De estos proyectos navori tomó ideas; a codegraph además lo integra como plugin. Las notas por proyecto viven en",
    "zh-CN": "navori 借鉴了这些项目，其中 codegraph 同时作为插件集成。逐项目说明见",
  },
  "deep-dive.271": {
    en: "Built with",
    es: "Construido con",
    "zh-CN": "使用的技术",
  },
  "quickstart.0": {
    en: "Install the CLI",
    es: "Instala el CLI",
    "zh-CN": "安装 CLI",
  },
  "quickstart.1": {
    en: "No global install required. Use npx, pnpm dlx, or bunx — whatever you use day-to-day.",
    es: "No necesitas instalación global. Usa npx, pnpm dlx o bunx — lo que uses normalmente.",
    "zh-CN": "无需全局安装。使用日常习惯的 npx、pnpm dlx 或 bunx 即可。",
  },
  "quickstart.2": {
    en: "Answer the wizard",
    es: "Responde el wizard",
    "zh-CN": "回答向导",
  },
  "quickstart.3": {
    en: "init detects your stack and asks a few questions. In under a minute you get navori.config.json + the managed harness for the engines you picked. No official preset for your stack? Scaffold a local one with `navori preset init <id>` — it's wired into the config.",
    es: "init detecta tu stack y te hace unas preguntas. En menos de un minuto tienes navori.config.json + el harness managed de los engines que elegiste. ¿Tu stack no trae preset oficial? Créalo local con `navori preset init <id>` y queda conectado al config.",
    "zh-CN":
      "init 检测技术栈并询问必要信息，一分钟内生成 navori.config.json 和所选引擎的受管理 harness。没有官方预设？使用 `navori preset init <id>` 创建本地预设并自动接入配置。",
  },
  "quickstart.4": {
    en: "Commit and work as usual",
    es: "Commitea y trabaja normal",
    "zh-CN": "提交并正常工作",
  },
  "quickstart.5": {
    en: "navori.config.json is the single source of truth. Managed blocks are clearly marked — everything else is yours.",
    es: "El navori.config.json es la única fuente de verdad. Los bloques managed están marcados — el resto es tuyo.",
    "zh-CN": "navori.config.json 是唯一事实来源。受管理块有明确标记，其余内容由你管理。",
  },
  "quickstart.6": {
    en: "Re-render whenever you change something",
    es: "Cuando cambies algo, vuelve a renderizar",
    "zh-CN": "变化后重新渲染",
  },
  "quickstart.7": {
    en: "add already renders in the same step. For everything else (hand-editing the config, switching presets), render previews by default; --apply writes. sync only touches managed blocks; your custom code is left alone.",
    es: "add ya renderiza en el mismo paso. Para todo lo demás (editar el config a mano, cambiar de preset), render por default hace preview; --apply escribe. sync solo toca los bloques managed, tu código personalizado queda intacto.",
    "zh-CN":
      "add 在同一步自动渲染。手动编辑配置、切换预设等其他操作后，render 默认预览，--apply 才写入。sync 仅处理受管理块，保留自定义代码。",
  },
  "quickstart.8": {
    en: "You have Node.js 22.12 or higher installed.",
    es: "Tienes Node.js 22.12 o superior instalado.",
    "zh-CN": "已安装 Node.js 22.12 或更高版本。",
  },
  "quickstart.9": {
    en: "You're inside a git repo (init doesn't touch .git but assumes it exists).",
    es: "Estás dentro de un repo git (init no toca .git, pero asume que existe).",
    "zh-CN": "当前位于 git 仓库内。init 不修改 .git，但假设它存在。",
  },
  "quickstart.10": {
    en: "navori renders to six engines: Claude Code, Codex, AGENTS.md, Cursor, Copilot and Pi. You pick which ones in the wizard.",
    es: "navori renderiza a seis engines: Claude Code, Codex, AGENTS.md, Cursor, Copilot y Pi. Eliges cuáles en el wizard.",
    "zh-CN":
      "navori 可渲染六种引擎：Claude Code、Codex、AGENTS.md、Cursor、Copilot 和 Pi，由向导选择。",
  },
  "quickstart.11": {
    en: "render previews by default: nothing is written until you pass --apply.",
    es: "render hace preview por default: nada se escribe hasta que pasas --apply.",
    "zh-CN": "render 默认仅预览，直到传入 --apply 才写入。",
  },
  "quickstart.12": {
    en: "Quickstart",
    es: "Quickstart",
    "zh-CN": "快速开始",
  },
  "quickstart.13": {
    en: "From zero to productive with navori in 4 steps.",
    es: "De cero a productivo con navori en 4 pasos.",
    "zh-CN": "四步开始使用 navori。",
  },
  "quickstart.14": {
    en: "Quickstart",
    es: "Quickstart",
    "zh-CN": "快速开始",
  },
  "quickstart.15": {
    en: "From zero to productive",
    es: "De cero a productivo",
    "zh-CN": "从零开始高效工作",
  },
  "quickstart.16": {
    en: "in four steps.",
    es: "en cuatro pasos.",
    "zh-CN": "只需四步。",
  },
  "quickstart.17": {
    en: "This guide assumes Node 22.12+ and an initialized git repo. If you already have a hand-rolled .claude/, navori coexists without overwriting it.",
    es: "Esta guía asume que tienes Node 22.12+ y un repo git inicializado. Si ya tienes un .claude/ a mano, navori coexiste sin pisarlo.",
    "zh-CN":
      "本指南要求 Node 22.12+ 与已初始化的 git 仓库。如果已有手写的 .claude/，navori 可以共存并保留其内容。",
  },
  "quickstart.18": {
    en: "Before you start",
    es: "Antes de empezar",
    "zh-CN": "开始之前",
  },
  "quickstart.19": {
    en: "Next",
    es: "Siguiente",
    "zh-CN": "下一步",
  },
  "quickstart.20": {
    en: "navori init",
    es: "navori init",
    "zh-CN": "navori init",
  },
  "quickstart.21": {
    en: "navori add",
    es: "navori add",
    "zh-CN": "navori add",
  },
  "quickstart.22": {
    en: "navori sync",
    es: "navori sync",
    "zh-CN": "navori sync",
  },
} as const;

/** Resolve a required narrative; all three editions are explicit. */
export function narrative(lang: Lang, key: keyof typeof narratives): string {
  return narratives[key][lang];
}

/** Technical examples retained verbatim across all editions. */
export const narrativeExamples = {
  "deep-dive": [
    "node --version   # v22.12 or higher\n# Claude Code installed on your machine",
    "$ git clone <repo> && cd <repo>\n$ npx navori render --apply\n\n✓ configured engines rebuilt from the config",
    "$ npx navori doctor\n\n◇ All good — nothing pending.\n⇡ engram — missing from PATH:\n   brew install gentleman-programming/tap/engram \\\n     && claude plugin install engram",
    "# already productive with the team's harness\n\n# when the repo config changes:\n$ npx navori@latest sync",
    "config.models",
    "xhigh",
    "classify",
    "orchestrator › splits the ticket into 3 subtasks\n  ├─ scout       → map the module        (own context · sonnet)\n  ├─ scout       → how is it validated?  (own context · sonnet)\n  └─ implementer → applies the change   → quality gate ✓  (sonnet)\n       └─ reviewer → approves against CLAUDE.md          (sonnet)\norchestrator › synthesizes and delegates the commit → publisher  (haiku)",
    "navori plan classify",
    "PreToolUse",
    "navori plan check",
    "classify",
    "CHANGES_REQUESTED",
    "init",
    '? What terrain are you on?\n    greenfield   — new code, move fast\n  › production   — in production, guard regressions\n    migration    — legacy migration, watch\n                   legacy↔new compatibility\n\n→ legacyPaths: [ "src/old-api", "legacy/" ]\n  the orchestrator, implementer, and reviewer\n  treat those paths with different rules.',
    '# today — after fixing a bug\nmem_save "The 360 report breaks if languages[] is empty.\n          Root cause: missing guard in report.py. Fix: default []."\n\n# next week — new session, context at zero\nmem_search "360 report languages"\n→ recalls the decision, the root cause, and the fix.\n  You don\'t re-explain it.',
    "$ navori workspace init acme\n$ navori workspace set-default acme \\\n    --branch-base main --commits conventional-es\n$ navori workspace add-repo acme ./web-app\n$ navori workspace add-repo acme ./api-core\n  … 13 more repos\n\n$ navori workspace render acme\n✓ 15 repos rendered with the same standard",
    ".claude/",
    "clone → npx navori render --apply → npx navori doctor",
    "docs/inspiration.md",
  ],
  quickstart: [
    "# npm\nnpx navori init\n\n# pnpm\npnpm dlx navori init\n\n# bun\nbunx navori init",
    "? Wizard › English\n→ stack: Next.js · pnpm\n? Engines › claude, codex\n? Preset › nextjs\n? Plugins › engram, codegraph, tgrep\n\n✓ navori.config.json\n✓ rendered:\n   CLAUDE.md · AGENTS.md\n   .claude/  ·  agents · skills · hooks · settings\n✓ Done — 34 created",
    '$ git add navori.config.json CLAUDE.md .claude/\n$ git commit -m "chore: bootstrap navori harness"',
    "# Add a plugin (renders on its own)\n$ npx navori add codegraph\n\n# Upgrade to the latest version\n$ npx navori@latest update\n\n# Something drifted?\n$ npx navori doctor",
  ],
} as const;
