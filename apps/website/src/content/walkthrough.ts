import type { Lang } from "../i18n/ui";

export type Scene =
  | "workspace"
  | "context"
  | "text"
  | "connections"
  | "team"
  | "limits"
  | "checks"
  | "memory";
export interface WalkthroughStep {
  scene: Scene;
  name: string;
  title: string;
  body: string;
}
export interface WalkthroughCopy {
  title: string;
  introduction: string;
  promptLabel: string;
  prompt: string;
  promptNote: string;
  example: string;
  project: string;
  workspace: string;
  workspaceNote: string;
  rules: readonly string[];
  files: readonly string[];
  assistant: string;
  textSearch: string;
  graphSearch: string;
  memory: string;
  change: string;
  safe: string;
  verified: string;
  readAll: string;
  pause: string;
  play: string;
  previous: string;
  next: string;
  replay: string;
  navigation: string;
  more: string;
  steps: readonly WalkthroughStep[];
}

/** Illustrative product story, shared by the rendered home and its Markdown edition. */
export const walkthrough: Record<Lang, WalkthroughCopy> = {
  en: {
    title: "One request. A better-prepared AI.",
    introduction:
      "The model writes the code. navori gives it the context, tools and checks around the work. Follow this example to see the difference.",
    promptLabel: "Your request",
    prompt: "Fix the sign-in button.",
    promptNote: "You describe the task. The harness prepares how to approach it.",
    example: "Illustrative example",
    project: "Your project",
    workspace: "Workspace",
    workspaceNote: "Shared rules for your projects",
    rules: ["Team conventions", "Available tools", "How to check the work"],
    files: ["Sign-in screen", "User validation", "Result"],
    assistant: "Your AI",
    textSearch: "Find the right text",
    graphSearch: "Understand the connections",
    memory: "Keep useful decisions",
    change: "A focused change",
    safe: "Boundaries checked",
    verified: "Checks passed",
    readAll: "Read the complete explanation",
    pause: "Pause",
    play: "Play",
    previous: "Previous step",
    next: "Next step",
    replay: "Start again",
    navigation: "Explore each step",
    more: "Explore the technical details",
    steps: [
      {
        scene: "workspace",
        name: "Shared rules",
        title: "It starts with your team's way of working.",
        body: "A workspace shares conventions and tools across projects. Your assistant starts with that common ground instead of relearning everything in each repository.",
      },
      {
        scene: "context",
        name: "Project context",
        title: "Then it learns what makes this project different.",
        body: "The project's own instructions add the details: its stack, important decisions and how changes should be checked. Shared rules and local context work together.",
      },
      {
        scene: "text",
        name: "tgrep",
        title: "Find the right place before changing anything.",
        body: "The tgrep plugin helps the assistant find precise text in the project. In this example, it looks for the sign-in button instead of reading every file.",
      },
      {
        scene: "connections",
        name: "CodeGraph",
        title: "See how the pieces fit together.",
        body: "CodeGraph helps explain relationships in the code: which screen uses which function and what a change could affect. Finding a word and understanding its connections are different jobs.",
      },
      {
        scene: "team",
        name: "Focused roles",
        title: "Give each part of the job a clear responsibility.",
        body: "navori can organize specialist roles to investigate, implement and review. Skills give them task-specific guidance. The goal is a focused change, with a clear scope.",
      },
      {
        scene: "limits",
        name: "Boundaries",
        title: "Useful tools also need limits.",
        body: "Permissions and guards check sensitive actions. Where the engine supports it, an action can be stopped or ask for approval. These controls have documented limits; they are not a promise of perfect protection.",
      },
      {
        scene: "checks",
        name: "Verification",
        title: "An answer is not proof that the change works.",
        body: "The project's checks and a review provide evidence about the result. navori helps make that verification part of the workflow, rather than accepting the assistant's confidence alone.",
      },
      {
        scene: "memory",
        name: "Memory",
        title: "The next task does not have to start from zero.",
        body: "With the engram plugin enabled, useful decisions and lessons can be kept for later sessions. Plugins add capabilities; you choose which ones your project uses.",
      },
    ],
  },
  es: {
    title: "Una petición. Una IA mejor preparada.",
    introduction:
      "El modelo escribe el código. navori le da contexto, herramientas y controles alrededor del trabajo. Sigue este ejemplo para entender qué cambia.",
    promptLabel: "Tu petición",
    prompt: "Arregla el botón de inicio de sesión.",
    promptNote: "Tú describes la tarea. El harness prepara cómo abordarla.",
    example: "Ejemplo ilustrativo",
    project: "Tu proyecto",
    workspace: "Workspace",
    workspaceNote: "Reglas compartidas entre tus proyectos",
    rules: ["Convenciones del equipo", "Herramientas disponibles", "Cómo comprobar el trabajo"],
    files: ["Pantalla de acceso", "Validación de usuario", "Resultado"],
    assistant: "Tu IA",
    textSearch: "Encuentra el texto correcto",
    graphSearch: "Entiende las conexiones",
    memory: "Conserva decisiones útiles",
    change: "Un cambio enfocado",
    safe: "Límites revisados",
    verified: "Pruebas correctas",
    readAll: "Leer la explicación completa",
    pause: "Pausar",
    play: "Reproducir",
    previous: "Paso anterior",
    next: "Paso siguiente",
    replay: "Volver a empezar",
    navigation: "Explora cada paso",
    more: "Ver el detalle técnico",
    steps: [
      {
        scene: "workspace",
        name: "Reglas compartidas",
        title: "Primero, la forma de trabajar de tu equipo.",
        body: "Un workspace comparte convenciones y herramientas entre proyectos. Tu asistente parte de esa base común, en vez de aprender todo otra vez en cada repositorio.",
      },
      {
        scene: "context",
        name: "Tu proyecto",
        title: "Después, lo que hace distinto a este proyecto.",
        body: "Las instrucciones del proyecto agregan sus detalles: tecnologías, decisiones importantes y cómo comprobar los cambios. Las reglas compartidas y el contexto local se complementan.",
      },
      {
        scene: "text",
        name: "tgrep",
        title: "Encuentra el lugar correcto antes de cambiar algo.",
        body: "El plugin tgrep ayuda al asistente a encontrar texto preciso dentro del proyecto. En este ejemplo, busca el botón de acceso, en lugar de leer todos los archivos.",
      },
      {
        scene: "connections",
        name: "CodeGraph",
        title: "Entiende cómo se conectan las piezas.",
        body: "CodeGraph ayuda a entender relaciones en el código: qué pantalla usa qué función y qué podría afectar un cambio. Encontrar una palabra y entender sus conexiones son trabajos distintos.",
      },
      {
        scene: "team",
        name: "Roles enfocados",
        title: "Cada parte del trabajo tiene una responsabilidad.",
        body: "navori puede organizar roles especializados para investigar, implementar y revisar. Las skills les dan orientación según la tarea. El objetivo es un cambio enfocado y con alcance claro.",
      },
      {
        scene: "limits",
        name: "Límites",
        title: "Las herramientas útiles también necesitan límites.",
        body: "Los permisos y las guardas revisan acciones sensibles. Donde el motor lo permite, una acción puede detenerse o pedir aprobación. Estos controles tienen límites documentados; no prometen protección perfecta.",
      },
      {
        scene: "checks",
        name: "Verificación",
        title: "Una respuesta no demuestra que el cambio funcione.",
        body: "Las pruebas del proyecto y una revisión aportan evidencia del resultado. navori ayuda a integrar esa comprobación al flujo, en vez de aceptar sólo la confianza del asistente.",
      },
      {
        scene: "memory",
        name: "Memoria",
        title: "La siguiente tarea no tiene que empezar de cero.",
        body: "Con el plugin engram habilitado, se pueden conservar decisiones y aprendizajes para sesiones futuras. Los plugins agregan capacidades; tú eliges cuáles usa tu proyecto.",
      },
    ],
  },
  "zh-CN": {
    title: "一个请求，让 AI 做好更多准备。",
    introduction:
      "模型负责编写代码，navori 为工作补充上下文、工具和检查。通过这个示例了解其中的区别。",
    promptLabel: "你的请求",
    prompt: "修复登录按钮。",
    promptNote: "你描述任务，harness 准备处理任务的方法。",
    example: "演示示例",
    project: "你的项目",
    workspace: "Workspace",
    workspaceNote: "多个项目共享的工作规则",
    rules: ["团队约定", "可用工具", "检查工作的方法"],
    files: ["登录页面", "用户验证", "结果"],
    assistant: "你的 AI",
    textSearch: "找到正确的文本",
    graphSearch: "理解代码的联系",
    memory: "保存有用的决策",
    change: "聚焦的修改",
    safe: "已检查边界",
    verified: "检查通过",
    readAll: "阅读完整说明",
    pause: "暂停",
    play: "播放",
    previous: "上一步",
    next: "下一步",
    replay: "重新开始",
    navigation: "探索每个步骤",
    more: "查看技术细节",
    steps: [
      {
        scene: "workspace",
        name: "共享规则",
        title: "先了解团队的工作方式。",
        body: "Workspace 在多个项目之间共享约定和工具。助手从共同基础出发，不必在每个仓库中重新学习一切。",
      },
      {
        scene: "context",
        name: "项目上下文",
        title: "再了解这个项目的不同之处。",
        body: "项目指令补充使用的技术、重要决策和检查修改的方法。共享规则与本地上下文相互配合。",
      },
      {
        scene: "text",
        name: "tgrep",
        title: "修改之前，先找到正确的位置。",
        body: "tgrep 插件帮助助手精确查找项目中的文本。在这个示例中，它定位登录按钮，而不是阅读所有文件。",
      },
      {
        scene: "connections",
        name: "CodeGraph",
        title: "理解各部分如何连接。",
        body: "CodeGraph 帮助解释代码关系：哪个页面使用哪个函数，修改可能影响什么。找到文本和理解联系是不同的任务。",
      },
      {
        scene: "team",
        name: "专注的角色",
        title: "为每部分工作明确责任。",
        body: "navori 可以组织调查、实现和审查等专业角色。Skills 为具体任务提供指导，让修改保持聚焦，范围清楚。",
      },
      {
        scene: "limits",
        name: "边界",
        title: "有用的工具也需要边界。",
        body: "权限和守卫检查敏感操作。在引擎支持的情况下，操作可以被阻止或要求批准。这些控制有明确限制，并不保证完美保护。",
      },
      {
        scene: "checks",
        name: "验证",
        title: "回答不等于修改有效的证据。",
        body: "项目检查与审查为结果提供证据。navori 帮助将验证纳入流程，而不是只接受助手自己的信心。",
      },
      {
        scene: "memory",
        name: "记忆",
        title: "下一个任务不必从零开始。",
        body: "启用 engram 插件后，有用的决策和经验可以保留到后续会话。插件提供额外能力，由你选择项目需要哪些。",
      },
    ],
  },
};
