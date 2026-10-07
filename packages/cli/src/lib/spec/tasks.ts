/**
 * Block-based `tasks.md` parser (spec 0044 D2; R4, R10).
 *
 * Grammar, one construct per Markdown element (keywords the machine reads are
 * English):
 *
 * - Delivery: `## E<n> — <title>`, optional trailing `(foundation)`. The
 *   separator may be `—`, `–`, `-` or `:`.
 * - LOC: `Estimated LOC: <n>` between the delivery heading and its first
 *   milestone. Optional.
 * - Milestone: `### M<n> — <title>`.
 * - Criterion: block `- **A<n>**` with optional `[observable]`, no checkbox.
 *   The command is the first backtick span that opens a line of the block
 *   (falling back to the first span, since a description may quote code);
 *   the expected output is the text after the LAST `→` / `->` of the block.
 * - Consumer: block `- **Consumes:** <consumer> → <contract>`.
 * - Task: block `- [ ] **T<n>** (R<a>, R<b>) — <what>`; `effect:` and
 *   `test:` may sit on any line of the block. `- [x]` marks it done.
 * - Retired task: `- [ ] ~~T<n>~~ …`; counts for neither size nor coverage.
 *
 * A block is its first line plus every following line up to the next
 * top-level list item or heading. Fenced regions (``` or ~~~, closed by the
 * same character and a run at least as long, as in CommonMark) are ignored
 * entirely.
 *
 * A file with no delivery heading outside fences is `legacy` (R14): its tasks
 * are counted with the generic `- [ ] ` checkbox pattern and nothing else is
 * parsed.
 *
 * The module is pure: text in, {@link ParsedTasks} out.
 */

/** What a task declares it changes (D2 `effect:`). */
export const TASK_EFFECTS = ["behavior", "docs", "tests", "schema"] as const;
export type TaskEffect = (typeof TASK_EFFECTS)[number];

/** One `- **A<n>**` acceptance criterion. Fields are raw: `check` judges them. */
export interface ParsedCriterion {
  id: string;
  observable: boolean;
  /** Text between the id and the command, separators trimmed. */
  description: string;
  /** First command span; empty when the block has none. */
  command: string;
  /** Text after the last arrow that follows the command; empty when absent. */
  expected: string;
  /** 1-based line of the block's first line. */
  line: number;
}

/** One `- [ ] **T<n>**` task (not retired). */
export interface ParsedTask {
  id: string;
  done: boolean;
  /** `R<n>` ids from the parenthesis after the task id. */
  requirements: string[];
  /** `undefined` when absent or not one of {@link TASK_EFFECTS}. */
  effect: TaskEffect | undefined;
  /** Raw `effect:` value, for diagnostics. */
  effectRaw: string | undefined;
  test: string | undefined;
  line: number;
}

/** One `- **Consumes:**` line. */
export interface ParsedConsumer {
  text: string;
  line: number;
}

export interface ParsedMilestone {
  id: string;
  title: string;
  line: number;
  criteria: ParsedCriterion[];
  consumers: ParsedConsumer[];
  tasks: ParsedTask[];
  retired: string[];
}

export interface ParsedDelivery {
  id: string;
  title: string;
  foundation: boolean;
  /** `undefined` when the delivery declares no `Estimated LOC:`. */
  estimatedLoc: number | undefined;
  line: number;
  milestones: ParsedMilestone[];
}

/** A checkbox item inside a delivery-format file that is not a well-formed task. */
export interface ParsedMalformedItem {
  line: number;
  text: string;
}

export type TasksFormat = "deliveries" | "legacy";

export interface ParsedTasks {
  format: TasksFormat;
  /** Empty in `legacy`. */
  deliveries: ParsedDelivery[];
  /** Tasks outside any milestone (delivery format only). */
  orphanTasks: ParsedTask[];
  /** Criteria outside any milestone (delivery format only). */
  orphanCriteria: ParsedCriterion[];
  /** Checkbox items without a `**T<n>**` id or `~~T<n>~~` (delivery format only). */
  malformed: ParsedMalformedItem[];
  /** Non-retired `- [ ] ` items; the task count in `legacy`. */
  legacyTaskCount: number;
}

export interface SourceLine {
  /** 1-based line number in the original text. */
  n: number;
  text: string;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const DELIVERY_HEADING = /^E(\d+)(?!\d)(?:\s*[—–:-]\s*|\s+|$)(.*)$/;
const MILESTONE_HEADING = /^M(\d+)(?!\d)(?:\s*[—–:-]\s*|\s+|$)(.*)$/;
const FOUNDATION = /\s*\(foundation\)\s*$/i;
const LOC_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?Estimated LOC:(?:\*\*)?\s*~?(\d[\d,_]*)/i;
const TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const CHECKBOX = /^- \[([ xX])\] (.*)$/;
const CRITERION_START = /^- \*\*(A\d+)\*\*/;
const CONSUMES_START = /^- \*\*Consumes:\*\*\s*(.*)$/;
const ARROW = /→|->/g;

/** Drops fenced regions (and their delimiters), keeping original line numbers. */
export function visibleLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (fence) {
      const close = new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const run = open[1] ?? "```";
      fence = { char: run.charAt(0), length: run.length };
      continue;
    }
    out.push({ n: index + 1, text: line });
  }
  return out;
}

/** Starts of blocks: a heading or a top-level list item at column 0. */
function isBlockStart(text: string): boolean {
  return HEADING.test(text) || TOP_LEVEL_ITEM.test(text);
}

/**
 * First backtick code span of `text` that begins a line, or the first span at
 * all. A delimiter run of N backticks closes at the next run of exactly N.
 */
function findCommand(text: string): { command: string; start: number; end: number } | undefined {
  let first: { command: string; start: number; end: number } | undefined;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index;
    while (text[runEnd] === "`") runEnd += 1;
    const length = runEnd - index;
    let search = runEnd;
    let close = -1;
    while (search < text.length) {
      const at = text.indexOf("`", search);
      if (at === -1) break;
      let end = at;
      while (text[end] === "`") end += 1;
      if (end - at === length) {
        close = at;
        break;
      }
      search = end;
    }
    if (close === -1) {
      index = runEnd;
      continue;
    }
    const span = {
      command: text.slice(runEnd, close).replace(/\s+/g, " ").trim(),
      start: index,
      end: close + length,
    };
    first ??= span;
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    if (text.slice(lineStart, index).trim() === "") return span;
    index = close + length;
  }
  return first;
}

function parseCriterion(id: string, block: string, line: number): ParsedCriterion {
  const firstLine = block.split("\n", 1)[0] ?? "";
  const found = findCommand(block);
  const idEnd = block.indexOf(`**${id}**`) + id.length + 4;
  const description = block
    .slice(idEnd, found?.start ?? block.length)
    .replace(/\[observable\]/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s—–:·-]+|[\s—–:·-]+$/g, "");
  let expected = "";
  if (found) {
    const tail = block.slice(found.end);
    const arrows = [...tail.matchAll(ARROW)];
    const last = arrows.at(-1);
    if (last?.index !== undefined) {
      expected = tail
        .slice(last.index + last[0].length)
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return {
    id,
    observable: /\[observable\]/i.test(firstLine),
    description,
    command: found?.command ?? "",
    expected,
    line,
  };
}

function parseTask(id: string, done: boolean, block: string, line: number): ParsedTask {
  // The block opens with this task's own `**T<n>**`, so the first id-plus-parens match is it.
  const requirementsText = /\*\*T\d+\*\*\s*\(([^)]*)\)/.exec(block)?.[1] ?? "";
  const requirements = [...requirementsText.matchAll(/R\d+/g)].map((m) => m[0]);
  const effectRaw = /\beffect:\s*([A-Za-z]+)/.exec(block)?.[1];
  const effect = TASK_EFFECTS.find((candidate) => candidate === effectRaw?.toLowerCase());
  const testRaw = /\btest:\s*([\s\S]*)$/.exec(block)?.[1];
  const test = testRaw
    ?.split(/\s·\s/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return {
    id,
    done,
    requirements,
    effect,
    effectRaw,
    test: test || undefined,
    line,
  };
}

/** Parses the text of a `tasks.md`. Never throws. */
export function parseTasks(text: string): ParsedTasks {
  const lines = visibleLines(text);
  const hasDelivery = lines.some((l) => {
    const heading = HEADING.exec(l.text);
    return heading?.[1] === "##" && DELIVERY_HEADING.test(heading[2] ?? "");
  });

  let legacyTaskCount = 0;
  for (const l of lines) {
    const box = CHECKBOX.exec(l.text);
    if (box && !/^~~T\d+~~/.test(box[2] ?? "")) legacyTaskCount += 1;
  }

  const result: ParsedTasks = {
    format: hasDelivery ? "deliveries" : "legacy",
    deliveries: [],
    orphanTasks: [],
    orphanCriteria: [],
    malformed: [],
    legacyTaskCount,
  };
  if (!hasDelivery) return result;

  let delivery: ParsedDelivery | undefined;
  let milestone: ParsedMilestone | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    if (!current) continue;
    const heading = HEADING.exec(current.text);
    if (heading) {
      const level = (heading[1] ?? "").length;
      const title = heading[2] ?? "";
      const deliveryMatch = level === 2 ? DELIVERY_HEADING.exec(title) : null;
      const milestoneMatch = level === 3 && delivery ? MILESTONE_HEADING.exec(title) : null;
      if (deliveryMatch) {
        const rawTitle = (deliveryMatch[2] ?? "").trim();
        delivery = {
          id: `E${deliveryMatch[1]}`,
          title: rawTitle.replace(FOUNDATION, "").trim(),
          foundation: FOUNDATION.test(rawTitle),
          estimatedLoc: undefined,
          line: current.n,
          milestones: [],
        };
        result.deliveries.push(delivery);
        milestone = undefined;
      } else if (milestoneMatch && delivery) {
        milestone = {
          id: `M${milestoneMatch[1]}`,
          title: (milestoneMatch[2] ?? "").trim(),
          line: current.n,
          criteria: [],
          consumers: [],
          tasks: [],
          retired: [],
        };
        delivery.milestones.push(milestone);
      } else if (level <= 2) {
        delivery = undefined;
        milestone = undefined;
      } else if (level === 3) {
        milestone = undefined;
      }
      continue;
    }

    if (delivery && !milestone && delivery.estimatedLoc === undefined) {
      const loc = LOC_LINE.exec(current.text);
      if (loc?.[1]) {
        delivery.estimatedLoc = Number.parseInt(loc[1].replace(/[,_]/g, ""), 10);
        continue;
      }
    }

    if (!TOP_LEVEL_ITEM.test(current.text)) continue;
    const blockLines = [current.text];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!next || isBlockStart(next.text)) break;
      blockLines.push(next.text);
      i += 1;
    }
    const block = blockLines.join("\n");

    const consumes = CONSUMES_START.exec(current.text);
    if (consumes) {
      milestone?.consumers.push({
        text: block
          .replace(/^- \*\*Consumes:\*\*/, "")
          .replace(/\s+/g, " ")
          .trim(),
        line: current.n,
      });
      continue;
    }
    const criterion = CRITERION_START.exec(current.text);
    if (criterion?.[1]) {
      const parsed = parseCriterion(criterion[1], block, current.n);
      (milestone ? milestone.criteria : result.orphanCriteria).push(parsed);
      continue;
    }
    const box = CHECKBOX.exec(current.text);
    if (!box) continue;
    const rest = box[2] ?? "";
    const retired = /^~~(T\d+)~~/.exec(rest)?.[1];
    if (retired) {
      milestone?.retired.push(retired);
      continue;
    }
    const taskId = /^\*\*(T\d+)\*\*/.exec(rest)?.[1];
    if (!taskId) {
      result.malformed.push({ line: current.n, text: rest });
      continue;
    }
    const task = parseTask(taskId, box[1] !== " ", block, current.n);
    (milestone ? milestone.tasks : result.orphanTasks).push(task);
  }
  return result;
}

/** Non-retired tasks of a parse, wherever they sit (milestones and orphans). */
export function allTasks(parsed: ParsedTasks): ParsedTask[] {
  return [
    ...parsed.deliveries.flatMap((d) => d.milestones.flatMap((m) => m.tasks)),
    ...parsed.orphanTasks,
  ];
}
