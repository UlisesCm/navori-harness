import type { Lang } from "../i18n/ui";

interface SessionStage {
  name: string;
  title: string;
  body: string;
  message: string;
  tools: string;
}

interface LandingCopy {
  hero: { title: string; emphasis: string; body: string; explore: string };
  session: {
    title: string;
    body: string;
    example: string;
    console: string;
    user: string;
    assistant: string;
    prompt: string;
    robot: string;
    play: string;
    pause: string;
    replay: string;
    navigation: string;
    note: string;
    stages: readonly SessionStage[];
  };
  benefits: {
    title: string;
    body: string;
    rows: readonly { title: string; before: string; after: string }[];
    before: string;
    after: string;
  };
  adoption: {
    title: string;
    body: string;
    repo: string;
    repoBody: string;
    team: string;
    teamBody: string;
  };
  technical: { title: string; body: string; open: string };
  engines: { title: string; body: string };
  quickstart: { title: string; steps: readonly { title: string; body: string; code: string }[] };
  faq: readonly { q: string; a: string }[];
}

/** Plain-language product story; the session is an explicitly illustrative example. */
export const landingCopy = {
  es: {
    hero: {
      title: "Tu equipo tiene una forma de trabajar.",
      emphasis: "Tu IA también debería.",
      body: "Navori prepara a tus asistentes de programación con las reglas, el contexto y las revisiones de tu proyecto. Para que cada tarea siga un proceso que tu equipo pueda entender y comprobar.",
      explore: "Ver cómo funciona",
    },
    session: {
      title: "Una tarea. Un equipo de IA con un proceso.",
      body: "Hablas con un asistente que coordina el trabajo. Según la tarea, consulta el contexto, usa herramientas y recurre a otros agentes. Mira qué aporta cada parte.",
      example: "Simulación ilustrativa · las herramientas dependen de tu configuración",
      console: "La conversación",
      user: "Tú",
      assistant: "Coordinador",
      prompt: "El inicio de sesión falla. ¿Puedes corregirlo?",
      robot: "Asistente que coordina el trabajo",
      play: "Continuar recorrido",
      pause: "Pausar recorrido",
      replay: "Repetir recorrido",
      navigation: "Etapas del trabajo",
      note: "Tú defines las reglas y apruebas lo que lo requiera. Las capacidades y los controles disponibles cambian según el asistente y los plugins que uses.",
      stages: [
        {
          name: "Contexto",
          title: "Primero entiende tu proyecto",
          body: "Consulta las reglas del equipo, las guías de trabajo y las decisiones guardadas. Así sabe qué debe respetar antes de proponer un cambio.",
          message:
            "Voy a revisar las reglas del proyecto y lo que ya sabemos del inicio de sesión.",
          tools: "Reglas del proyecto · skills · memoria opcional",
        },
        {
          name: "Herramientas",
          title: "Busca dónde está el problema",
          body: "Usa herramientas para encontrar el código relevante y entender sus relaciones. Las herramientas le permiten consultar información y ejecutar acciones concretas.",
          message: "Busco dónde se valida el acceso y qué otras partes dependen de ese código.",
          tools: "Búsqueda de código · terminal · integraciones",
        },
        {
          name: "Subagentes",
          title: "Reparte el trabajo cuando hace falta",
          body: "Puede encargar una investigación o un cambio a otro agente con una función definida. El coordinador reúne los resultados y mantiene el hilo de la tarea.",
          message: "Encargo la corrección a un agente y reúno sus resultados para revisarlos.",
          tools: "Investigación · implementación · coordinación",
        },
        {
          name: "Revisión",
          title: "Comprueba antes de darlo por terminado",
          body: "El proceso pide pruebas del proyecto y una revisión del cambio. Los permisos y controles del asistente delimitan las acciones que puede ejecutar.",
          message:
            "Ahora toca ejecutar las pruebas y revisar el cambio. Si algo falla, hay que corregirlo.",
          tools: "Pruebas · revisión · permisos",
        },
        {
          name: "Memoria",
          title: "Guarda lo que servirá la próxima vez",
          body: "Con el plugin de memoria, las decisiones y sus motivos pueden recuperarse en futuras sesiones. El siguiente trabajo parte de lo que el equipo ya aprendió.",
          message:
            "Dejo el cambio listo para tu revisión y guardo la decisión si la memoria está habilitada.",
          tools: "Decisiones · motivos · próximas sesiones",
        },
      ],
    },
    benefits: {
      title: "Lo que cambia para tu equipo.",
      body: "El valor está en compartir una forma de trabajar: qué debe saber el asistente, cómo se organiza y qué necesita comprobar.",
      before: "El problema habitual",
      after: "Lo que aporta Navori",
      rows: [
        {
          title: "El contexto deja de depender de una persona",
          before: "Las reglas viven en conversaciones y hay que volver a explicarlas.",
          after:
            "El proyecto conserva instrucciones y guías que los asistentes pueden consultar. La memoria opcional añade decisiones de sesiones anteriores.",
        },
        {
          title: "El trabajo tiene responsabilidades claras",
          before: "Un mismo asistente investiga, cambia y evalúa sin un proceso compartido.",
          after:
            "Defines funciones para investigar, implementar y revisar. La tarea determina qué especialistas hacen falta.",
        },
        {
          title: "La entrega tiene algo que puedes comprobar",
          before: "“Ya quedó” no explica qué se revisó ni qué pruebas se ejecutaron.",
          after:
            "Configuras las comprobaciones del proyecto y un proceso de revisión. Tu equipo puede evaluar el cambio y la evidencia antes de aceptarlo.",
        },
      ],
    },
    adoption: {
      title: "Empieza en un proyecto. Compártelo cuando tenga sentido.",
      body: "No necesitas definir el proceso de toda la empresa para probarlo. Configura un repositorio y ajusta sus reglas con tu equipo.",
      repo: "Las reglas de este proyecto",
      repoBody:
        "Una configuración versionada reúne los asistentes, las guías y las comprobaciones. Puedes revisarla junto con el código.",
      team: "Lo que comparten varios proyectos",
      teamBody:
        "Si lo necesitas, un workspace permite compartir configuración y conocimiento entre repositorios. Es una capa opcional.",
    },
    technical: {
      title: "¿Quieres ver qué hay debajo?",
      body: "La configuración, las herramientas y la referencia completa están aquí para quien vaya a implementarlo.",
      open: "Explorar los detalles técnicos",
    },
    engines: {
      title: "Trabaja con los asistentes que ya conoces.",
      body: "Navori genera las instrucciones y los recursos para cada entorno. Cada asistente conserva sus propias capacidades de ejecución y control.",
    },
    quickstart: {
      title: "Pruébalo en un proyecto de tu equipo.",
      steps: [
        {
          title: "Inicia la configuración",
          body: "Desde la carpeta de tu proyecto, ejecuta el asistente de instalación.",
          code: "npx navori init",
        },
        {
          title: "Elige cómo trabajar",
          body: "Selecciona tu asistente y una base para tu tecnología. Después puedes ajustar las reglas y las pruebas.",
          code: "navori.config.json",
        },
        {
          title: "Revisa y empieza",
          body: "Revisa los archivos generados con tu equipo. Abre tu asistente y prueba el proceso con una tarea concreta.",
          code: "git diff",
        },
      ],
    },
    faq: [
      {
        q: "¿Qué es Navori, en palabras simples?",
        a: "Es una herramienta para configurar cómo trabajan los asistentes de programación en un proyecto: qué reglas conocen, qué funciones asumen y qué revisan antes de entregar un cambio.",
      },
      {
        q: "¿Reemplaza a Claude Code, Codex o mi editor?",
        a: "No. Prepara instrucciones y recursos para los asistentes que usas. El asistente sigue siendo quien ejecuta el trabajo.",
      },
      {
        q: "¿Necesito ser desarrollador para entender su valor?",
        a: "No. Puedes evaluar qué contexto comparte el equipo, cómo reparte el trabajo y qué evidencia pide al entregar. La instalación y las comprobaciones del código deben revisarse con el equipo técnico.",
      },
      {
        q: "¿Funciona igual en todos los asistentes?",
        a: "Comparte una configuración de origen, pero cada entorno admite distintas funciones. La delegación, los permisos y los controles dependen del asistente y de los plugins habilitados.",
      },
      {
        q: "¿Puedo empezar con un solo proyecto?",
        a: "Sí. Puedes configurar un repositorio y ajustar sus reglas. Compartir configuración entre proyectos mediante un workspace es opcional.",
      },
      {
        q: "¿Sigue haciendo falta revisión humana?",
        a: "Sí. Las pruebas y la revisión de agentes aportan evidencia; tu equipo sigue decidiendo si el cambio resuelve el problema y puede aceptarse.",
      },
    ],
  },
  en: {
    hero: {
      title: "Your team has a way of working.",
      emphasis: "Your AI should, too.",
      body: "Navori equips your coding assistants with your project's rules, context and reviews. So each task follows a process your team can understand and check.",
      explore: "See how it works",
    },
    session: {
      title: "One task. An AI team with a process.",
      body: "You talk to an assistant that coordinates the work. Depending on the task, it consults context, uses tools and brings in other agents. See what each part contributes.",
      example: "Illustrative simulation · tools depend on your configuration",
      console: "The conversation",
      user: "You",
      assistant: "Coordinator",
      prompt: "Login is failing. Can you fix it?",
      robot: "Assistant coordinating the work",
      play: "Continue walkthrough",
      pause: "Pause walkthrough",
      replay: "Replay walkthrough",
      navigation: "Stages of the work",
      note: "You set the rules and approve actions that require it. Available capabilities and controls differ by assistant and enabled plugins.",
      stages: [
        {
          name: "Context",
          title: "Understand your project first",
          body: "Consults team rules, working guides and saved decisions to understand what a proposed change must respect.",
          message: "I'll review the project rules and what we already know about login.",
          tools: "Project rules · skills · optional memory",
        },
        {
          name: "Tools",
          title: "Find where the problem lives",
          body: "Uses tools to locate relevant code and understand its relationships. Tools let the assistant retrieve information and take specific actions.",
          message: "I'm finding where access is validated and which parts depend on that code.",
          tools: "Code search · terminal · integrations",
        },
        {
          name: "Subagents",
          title: "Share the work when needed",
          body: "Can assign research or a change to another agent with a defined role. The coordinator brings the results together and keeps track of the task.",
          message: "I'll assign the fix to an agent and bring its results together for review.",
          tools: "Research · implementation · coordination",
        },
        {
          name: "Review",
          title: "Check before calling it finished",
          body: "The process calls for project tests and a review of the change. The assistant's permissions and controls limit the actions it can execute.",
          message: "Time to run tests and review the change. Any failures need to be addressed.",
          tools: "Tests · review · permissions",
        },
        {
          name: "Memory",
          title: "Keep what will help next time",
          body: "With the memory plugin, decisions and their reasons can be retrieved in future sessions. The next task starts with what the team has already learned.",
          message:
            "I'll leave the change ready for your review and save the decision if memory is enabled.",
          tools: "Decisions · reasons · future sessions",
        },
      ],
    },
    benefits: {
      title: "What changes for your team.",
      body: "The value is a shared way of working: what the assistant should know, how work is organized and what needs to be checked.",
      before: "A common problem",
      after: "What Navori adds",
      rows: [
        {
          title: "Context stops depending on one person",
          before: "Rules live in conversations and need to be explained again.",
          after:
            "The project keeps instructions and guides assistants can consult. Optional memory adds decisions from past sessions.",
        },
        {
          title: "Work has clear responsibilities",
          before: "One assistant investigates, changes and evaluates without a shared process.",
          after:
            "Define roles for research, implementation and review. The task determines which specialists are needed.",
        },
        {
          title: "A delivery comes with something to check",
          before: "“Done” doesn't tell you what was reviewed or which tests ran.",
          after:
            "Configure project checks and a review process. Your team can assess the change and its evidence before accepting it.",
        },
      ],
    },
    adoption: {
      title: "Start with one project. Share when it makes sense.",
      body: "You don't need a company-wide process to try it. Configure one repository and adjust its rules with your team.",
      repo: "This project's rules",
      repoBody:
        "Versioned configuration brings together assistants, guides and checks. Review it alongside the code.",
      team: "What several projects share",
      teamBody:
        "When needed, a workspace shares configuration and knowledge across repositories. It's an optional layer.",
    },
    technical: {
      title: "Want to look underneath?",
      body: "Configuration, tools and the full reference are here for the people implementing it.",
      open: "Explore the technical details",
    },
    engines: {
      title: "Work with assistants you already know.",
      body: "Navori generates instructions and resources for each environment. Each assistant retains its own execution and control capabilities.",
    },
    quickstart: {
      title: "Try it in one of your team's projects.",
      steps: [
        {
          title: "Start the setup",
          body: "Run the setup assistant from your project's directory.",
          code: "npx navori init",
        },
        {
          title: "Choose how to work",
          body: "Select your assistant and a starting point for your technology. Then adjust the rules and tests.",
          code: "navori.config.json",
        },
        {
          title: "Review and start",
          body: "Review the generated files with your team. Open your coding assistant and try the process on a concrete task.",
          code: "git diff",
        },
      ],
    },
    faq: [
      {
        q: "What is Navori in simple terms?",
        a: "A tool for configuring how coding assistants work on a project: which rules they know, which roles they take and what they check before delivering a change.",
      },
      {
        q: "Does it replace Claude Code, Codex or my editor?",
        a: "No. It prepares instructions and resources for the assistants you use. The assistant still executes the work.",
      },
      {
        q: "Do I need to be a developer to understand its value?",
        a: "No. You can assess what context the team shares, how it assigns work and what evidence it requests on delivery. Review installation and code checks with the technical team.",
      },
      {
        q: "Does it work the same in every assistant?",
        a: "It shares source configuration, but environments support different features. Delegation, permissions and controls depend on the assistant and enabled plugins.",
      },
      {
        q: "Can I start with one project?",
        a: "Yes. Configure a repository and adjust its rules. Sharing configuration across projects through a workspace is optional.",
      },
      {
        q: "Is human review still needed?",
        a: "Yes. Tests and agent reviews provide evidence; your team still decides whether the change solves the problem and can be accepted.",
      },
    ],
  },
  "zh-CN": {
    hero: {
      title: "团队有自己的工作方式。",
      emphasis: "AI 也应该遵循。",
      body: "Navori 为编程助手配置项目规则、上下文和审查流程，让每项任务都遵循团队能够理解和核验的过程。",
      explore: "了解工作原理",
    },
    session: {
      title: "一项任务，一个有流程的 AI 团队。",
      body: "你与负责协调工作的助手对话。它根据任务查阅上下文、使用工具，并邀请其他智能体参与。看看每个部分如何发挥作用。",
      example: "示意模拟 · 工具取决于你的配置",
      console: "对话",
      user: "你",
      assistant: "协调者",
      prompt: "登录失败了，可以修复吗？",
      robot: "负责协调工作的助手",
      play: "继续演示",
      pause: "暂停演示",
      replay: "重新演示",
      navigation: "工作阶段",
      note: "由你制定规则并批准需要授权的操作。可用能力与控制机制因助手和启用的插件而异。",
      stages: [
        {
          name: "上下文",
          title: "先理解你的项目",
          body: "查阅团队规则、工作指南和已保存的决策，了解提出变更前需要遵守什么。",
          message: "我先查看项目规则，以及已有的登录相关信息。",
          tools: "项目规则 · skills · 可选记忆",
        },
        {
          name: "工具",
          title: "找到问题所在",
          body: "使用工具定位相关代码并理解依赖关系。工具让助手获取信息并执行具体操作。",
          message: "我正在查找访问校验的位置，以及哪些部分依赖这些代码。",
          tools: "代码搜索 · 终端 · 集成",
        },
        {
          name: "子智能体",
          title: "在需要时分配工作",
          body: "可以将调研或修改交给职责明确的其他智能体。协调者汇总结果，并跟进整个任务。",
          message: "我将修复工作交给一个智能体，并汇总结果供审查。",
          tools: "调研 · 实现 · 协调",
        },
        {
          name: "审查",
          title: "完成前先检查",
          body: "流程要求运行项目测试并审查变更。助手的权限和控制机制限定它可以执行的操作。",
          message: "现在运行测试并审查变更。如果出现失败，需要先修正。",
          tools: "测试 · 审查 · 权限",
        },
        {
          name: "记忆",
          title: "保留对下次有用的信息",
          body: "启用记忆插件后，未来的会话可以检索决策及其原因。下一项工作可以从团队已有的经验开始。",
          message: "我会将变更留待你审查，并在启用记忆时保存相关决策。",
          tools: "决策 · 原因 · 后续会话",
        },
      ],
    },
    benefits: {
      title: "团队的工作会有哪些变化。",
      body: "价值在于共享工作方式：助手应当知道什么、如何组织工作，以及需要核验什么。",
      before: "常见问题",
      after: "Navori 带来的改变",
      rows: [
        {
          title: "上下文不再依赖某一个人",
          before: "规则留在对话里，需要反复解释。",
          after: "项目保存助手可查阅的指令和指南。可选的记忆功能补充过去会话中的决策。",
        },
        {
          title: "工作具有明确的职责",
          before: "同一个助手负责调研、修改和评估，却没有共享流程。",
          after: "为调研、实现和审查定义角色。由任务决定需要哪些专家。",
        },
        {
          title: "交付带有可核验的依据",
          before: "一句“完成了”无法说明审查内容或运行过哪些测试。",
          after: "配置项目检查和审查流程。团队可以在接受变更前评估变更及其证据。",
        },
      ],
    },
    adoption: {
      title: "从一个项目开始，需要时再共享。",
      body: "无需先制定全公司的流程。先配置一个代码仓库，与团队一起调整规则。",
      repo: "这个项目的规则",
      repoBody: "版本化配置汇集助手、指南和检查，可与代码一起审查。",
      team: "多个项目共享的知识",
      teamBody: "需要时，workspace 可以在代码仓库之间共享配置和知识。这是可选的一层。",
    },
    technical: {
      title: "想了解底层细节？",
      body: "配置、工具和完整参考资料供负责实施的人进一步查阅。",
      open: "查看技术细节",
    },
    engines: {
      title: "使用你熟悉的助手。",
      body: "Navori 为各环境生成指令和资源。每个助手保留自身的执行能力与控制机制。",
    },
    quickstart: {
      title: "在团队的一个项目中试用。",
      steps: [
        { title: "开始配置", body: "在项目目录中运行配置向导。", code: "npx navori init" },
        {
          title: "选择工作方式",
          body: "选择助手和适合技术栈的起点，再调整规则与测试。",
          code: "navori.config.json",
        },
        {
          title: "审查并开始",
          body: "与团队审查生成的文件，打开编程助手，用一个具体任务试用流程。",
          code: "git diff",
        },
      ],
    },
    faq: [
      {
        q: "简单来说，Navori 是什么？",
        a: "它是一种配置编程助手工作方式的工具，包括助手应知道的规则、承担的角色，以及交付变更前应完成的检查。",
      },
      {
        q: "它会取代 Claude Code、Codex 或编辑器吗？",
        a: "不会。它为你使用的助手准备指令和资源，实际工作仍由助手执行。",
      },
      {
        q: "不是开发者也能理解它的价值吗？",
        a: "可以。你可以评估团队共享的上下文、工作分配方式和交付证据。安装与代码检查需要和技术团队一起审查。",
      },
      {
        q: "所有助手中的功能都相同吗？",
        a: "配置来源可以共享，但各环境支持的功能不同。委派、权限和控制机制取决于助手与启用的插件。",
      },
      {
        q: "可以先从一个项目开始吗？",
        a: "可以。先配置一个代码仓库并调整规则。通过 workspace 跨项目共享配置是可选的。",
      },
      {
        q: "仍然需要人工审查吗？",
        a: "需要。测试与智能体审查提供证据，团队仍需决定变更是否解决了问题、是否可以接受。",
      },
    ],
  },
} satisfies Record<Lang, LandingCopy>;
