import type { Lang } from "../i18n/ui";

interface ConversationLine {
  at: number;
  speaker: "user" | "coordinator" | "tool";
  text: string;
}

interface AnimationCopy {
  title: string;
  introduction: string;
  scene: string;
  labels: {
    decisions: string;
    context: string;
    relationships: string;
    files: string;
    processing: string;
    searching: string;
    ready: string;
  };
  beats: readonly string[];
  conversation: readonly ConversationLine[];
  transcript: string;
  explanation: string;
  timeline: string;
}

/** Authored illustration timing, not real tool output or a performance benchmark. */
export const sessionAnimation = {
  es: {
    title: "Primero, un asistente que entiende dónde está.",
    introduction:
      "Tú pides un cambio. Navori prepara el contexto y las herramientas con las que el asistente puede investigar. Así empieza esta conversación.",
    scene:
      "Un robot aparece al recibir una solicitud, abre archiveros de Engram y CodeGraph, encuentra un chip de tgrep y acelera su búsqueda al conectarlo.",
    labels: {
      decisions: "Decisiones",
      context: "Contexto",
      relationships: "Relaciones",
      files: "Archivos",
      processing: "Procesando…",
      searching: "Buscando…",
      ready: "Contexto listo",
    },
    beats: [
      "Entra tu solicitud",
      "El coordinador se pone en marcha",
      "Recupera decisiones de Engram",
      "Explora el código con CodeGraph",
      "Encuentra una herramienta para buscar",
      "Conecta tgrep y agiliza la búsqueda",
      "Ya tiene contexto para continuar",
    ],
    conversation: [
      { at: 0, speaker: "user", text: "El inicio de sesión falla. ¿Puedes corregirlo?" },
      { at: 2400, speaker: "coordinator", text: "Procesando… Primero voy a entender el proyecto." },
      { at: 4900, speaker: "tool", text: "Engram → consultando decisiones anteriores." },
      { at: 8500, speaker: "tool", text: "CodeGraph → explorando archivos y relaciones." },
      {
        at: 11600,
        speaker: "coordinator",
        text: "Encontré tgrep. Lo conecto para localizar texto en el código.",
      },
      { at: 14400, speaker: "tool", text: "tgrep → buscando coincidencias…" },
      {
        at: 19000,
        speaker: "coordinator",
        text: "Ya tengo el contexto y los archivos relevantes. Podemos continuar.",
      },
    ],
    transcript: "Leer la conversación completa",
    timeline: "Avance de la animación",
    explanation:
      "Una metáfora visual: Engram aporta memoria, CodeGraph ayuda a entender relaciones y tgrep busca texto. Son herramientas distintas y opcionales; la escena no mide su velocidad real.",
  },
  en: {
    title: "First, an assistant that knows where it is.",
    introduction:
      "You ask for a change. Navori prepares the context and tools the assistant can use to investigate. This is how the conversation begins.",
    scene:
      "A robot appears when a request arrives, opens Engram and CodeGraph filing cabinets, finds a tgrep chip and speeds up its search after connecting it.",
    labels: {
      decisions: "Decisions",
      context: "Context",
      relationships: "Relationships",
      files: "Files",
      processing: "Processing…",
      searching: "Searching…",
      ready: "Context ready",
    },
    beats: [
      "Your request arrives",
      "The coordinator gets started",
      "Retrieves decisions from Engram",
      "Explores code with CodeGraph",
      "Finds a tool for searching",
      "Connects tgrep and speeds up the search",
      "Has context to continue",
    ],
    conversation: [
      { at: 0, speaker: "user", text: "Login is failing. Can you fix it?" },
      { at: 2400, speaker: "coordinator", text: "Processing… First I'll understand the project." },
      { at: 4900, speaker: "tool", text: "Engram → retrieving earlier decisions." },
      { at: 8500, speaker: "tool", text: "CodeGraph → exploring files and relationships." },
      {
        at: 11600,
        speaker: "coordinator",
        text: "Found tgrep. I'll connect it to find text in the code.",
      },
      { at: 14400, speaker: "tool", text: "tgrep → searching for matches…" },
      {
        at: 19000,
        speaker: "coordinator",
        text: "I have the context and relevant files. We can continue.",
      },
    ],
    transcript: "Read the full conversation",
    timeline: "Animation progress",
    explanation:
      "A visual metaphor: Engram provides memory, CodeGraph helps understand relationships and tgrep searches text. These are separate, optional tools; the scene does not measure their real speed.",
  },
  "zh-CN": {
    title: "先让助手理解自己所处的项目。",
    introduction:
      "你提出修改需求。Navori 准备好助手调查问题时可用的上下文和工具。这段对话由此开始。",
    scene:
      "收到请求后，机器人出现，打开 Engram 与 CodeGraph 文件柜，找到 tgrep 芯片并接入，随后加快搜索动作。",
    labels: {
      decisions: "决策",
      context: "上下文",
      relationships: "关系",
      files: "文件",
      processing: "正在处理…",
      searching: "正在查找…",
      ready: "上下文已就绪",
    },
    beats: [
      "收到你的请求",
      "协调者开始工作",
      "从 Engram 检索决策",
      "通过 CodeGraph 探索代码",
      "找到搜索工具",
      "接入 tgrep 并加快搜索",
      "已掌握继续工作所需的上下文",
    ],
    conversation: [
      { at: 0, speaker: "user", text: "登录失败了，可以修复吗？" },
      { at: 2400, speaker: "coordinator", text: "正在处理…先了解一下这个项目。" },
      { at: 4900, speaker: "tool", text: "Engram → 正在查阅之前的决策。" },
      { at: 8500, speaker: "tool", text: "CodeGraph → 正在探索文件与关系。" },
      { at: 11600, speaker: "coordinator", text: "找到了 tgrep，接入后可以定位代码中的文本。" },
      { at: 14400, speaker: "tool", text: "tgrep → 正在查找匹配内容…" },
      { at: 19000, speaker: "coordinator", text: "上下文和相关文件已经找到，可以继续了。" },
    ],
    transcript: "阅读完整对话",
    timeline: "动画进度",
    explanation:
      "这是一种视觉比喻：Engram 提供记忆，CodeGraph 帮助理解关系，tgrep 搜索文本。它们是不同的可选工具；动画不代表真实速度测试。",
  },
} satisfies Record<Lang, AnimationCopy>;
