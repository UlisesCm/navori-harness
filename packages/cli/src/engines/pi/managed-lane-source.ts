import { MARKER_PREFIXES } from "../../lib/render/marker.ts";

/**
 * Spec 0048 D4 (R3, R15): the edit/write lane of the Pi extension, as a fragment of
 * `PI_EXTENSION_SOURCE`. It relies on the extension scope (`readFileSync`, `lstatSync`, `existsSync`,
 * `readlinkSync`, `realpathSync`, `isAbsolute`, `join`, `relative`, `resolve`, `dirname`, `basename`,
 * `sep`, `isRecord`, `PI_EXTENSION_DENIALS`) and declares nothing that collides with it. No backtick and no placeholder, so
 * it splices into the extension template as-is; the marker prefixes are injected from `marker.ts`,
 * the module that defines the grammar.
 *
 * What the lane blocks, in order, for a Pi `edit` or `write` (the path is normalized EXACTLY like
 * Pi's own tools do at execution, because Pi 1.1.0 hands `tool_call` the raw argument, with `@`, `~`
 * and unicode spaces still in it):
 *
 *   1. the control plane (`.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json`,
 *      `.pi/navori.json`), always;
 *   2. every `ownedPaths` entry of the manifest, existing or not (a destination Navori will write);
 *   3. a file that other engines or Pi render with managed blocks mixed with user text (AGENTS.md,
 *      skills, ...): a `write` when the file holds a managed block, an `edit` whose `oldText` lands
 *      inside one, cannot be located, or comes in a shape the lane does not know.
 *
 * A block is recognized by the real grammar only: an anchored (column 0, whole line) open marker and
 * a close marker with the same id, outside a code fence at prose level. A file that merely QUOTES a
 * marker mid-line, or an open with no close, holds no block and stays editable; so does every byte
 * outside a block, the user section included. Mid-flight mutation by a LATER extension handler is the
 * documented seatbelt boundary (spec 0048 F3). Fail-closed: anything the lane cannot evaluate blocks.
 */
export const PI_MANAGED_LANE_SOURCE = String.raw`
// ---- Navori managed-file lane (spec 0048 D4): edit/write against Navori-generated files.
const LANE_MARKERS = ${JSON.stringify(MARKER_PREFIXES)} as const;
const LANE_MIXED = /^(?:claude\.md|agents\.md|\.github\/copilot-instructions\.md|\.agents\/skills\/.+|\.claude\/.+|\.codex\/(?:config\.toml|agents\/.+|hooks\/.+)|\.cursor\/rules\/.+)$/;
const LANE_MAX_BYTES = 4 * 1024 * 1024;
const LANE_TICK = String.fromCharCode(96);
type LaneSpan = { id: string; start: number; end: number };

function laneEscape(text: string): string {
  return text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

/** Pi's own path normalization for its tools: strip a leading @, unicode spaces to spaces, expand ~. */
function laneExpand(raw: string): string {
  const text = (raw.startsWith("@") ? raw.slice(1) : raw).replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (text === "~") return home || text;
  if (text.startsWith("~/") && home) return home + text.slice(1);
  return text;
}

/** The real location of a path: the nearest existing ancestor resolved, the rest appended; symlinks, dangling ones included, followed. */
function laneReal(path: string, depth = 0): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.slice().reverse()); }
    catch {
      try {
        if (depth < 16 && lstatSync(head).isSymbolicLink()) return laneReal(resolve(dirname(head), readlinkSync(head)) + (tail.length ? sep + tail.slice().reverse().join(sep) : ""), depth + 1);
      } catch { /* Not a link, or not even there: keep climbing. */ }
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** Managed blocks of a text by the real grammar (anchored, balanced, prose level); offsets are into the LF-normalized text. */
function laneBlocks(text: string): LaneSpan[] {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const fence = new RegExp("^\\s*(" + LANE_TICK + LANE_TICK + LANE_TICK + "|~~~)");
  const spans: LaneSpan[] = [];
  for (const style of ["html", "shell"] as const) {
    const marker = LANE_MARKERS[style];
    const html = style === "html";
    const open = new RegExp("^" + laneEscape(marker.open) + "\\s+id=\"([^\"]+)\"" + (html ? "[^>]*-->" : ".*") + "\\s*$");
    const close = new RegExp("^" + laneEscape(marker.close) + "\\s+id=\"([^\"]+)\"" + (html ? "\\s*-->" : "") + "\\s*$");
    // The LAST close of each id, fence-blind: a close quoted inside a fence in the body can never shorten the protected span.
    const lastClose = new Map<string, number>();
    lines.forEach((line, index) => { const found = close.exec(line); if (found) lastClose.set(found[1]!, index); });
    let inFence = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (html && fence.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const found = open.exec(line);
      const end = found ? lastClose.get(found[1]!) : undefined;
      if (found && end !== undefined && end > index) {
        spans.push({ id: found[1]!, start: offsets[index]!, end: offsets[end]! + lines[end]!.length });
        index = end;
      }
    }
  }
  return spans;
}

/** Every oldText of an edit input (the edits array and the legacy top-level pair); undefined when the shape is not one the lane knows. */
function laneOldTexts(input: Record<string, unknown>): string[] | undefined {
  const texts: string[] = [];
  const take = (entry: unknown): boolean => {
    if (!isRecord(entry) || typeof entry.oldText !== "string" || entry.oldText.length === 0 || typeof entry.newText !== "string") return false;
    texts.push(entry.oldText.replace(/\r\n?/g, "\n"));
    return true;
  };
  if (input.edits !== undefined) {
    if (!Array.isArray(input.edits) || !input.edits.every(take)) return undefined;
  }
  if (input.oldText !== undefined || input.newText !== undefined) {
    if (!take(input)) return undefined;
  }
  return texts.length ? texts : undefined;
}

const LANE_RENDER = "Change the source and run navori render --apply (or navori sync); a direct edit is overwritten, or freezes the block.";

/**
 * Why a Pi edit/write must not run, or undefined to let it through. Never throws: an error is a
 * block, because an enforced control that cannot evaluate fails closed (spec 0048 R15).
 */
function managedLaneVerdict(cwd: string, toolName: string, rawInput: unknown, ownedPaths: string[]): string | undefined {
  try {
    const input = isRecord(rawInput) ? rawInput : {};
    const given = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    if (given === undefined || given.length === 0) return PI_EXTENSION_DENIALS.managedPath.prefix + toolName + " targets, so it is blocked. Pass a path.";
    const expanded = laneExpand(given);
    const target = laneReal(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
    const rel = relative(laneReal(resolve(cwd)), target);
    if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return undefined;
    const key = rel.split(sep).join("/").toLowerCase();
    const owned = ownedPaths.some((path) => path.toLowerCase() === key);
    const plane = key === ".pi/settings.json" || key === ".pi/navori.json" || key === ".pi/navori" || key.startsWith(".pi/navori/")
      || key === ".pi/extensions" || key.startsWith(".pi/extensions/");
    if (plane || owned) {
      return PI_EXTENSION_DENIALS.managedBlocked.prefix + toolName + ": " + rel + (plane ? " is part of the Pi control plane (.pi/navori, .pi/extensions, .pi/settings.json, .pi/navori.json), which decides whether the guards run. " : " is generated by Navori. ")
        + (owned ? LANE_RENDER + " " : "") + (plane ? "Anything else in the control plane is for the user to edit outside the agent." : "");
    }
    if (!LANE_MIXED.test(key)) return undefined;
    const stats = lstatSync(target, { throwIfNoEntry: false });
    if (!stats) return undefined;
    if (!stats.isFile()) return PI_EXTENSION_DENIALS.managedEvaluate.prefix + rel + " (not a regular file), so this " + toolName + " is blocked.";
    if (stats.size > LANE_MAX_BYTES) return PI_EXTENSION_DENIALS.managedInspect.prefix + rel + " for managed blocks (it is larger than 4 MiB), so this " + toolName + " is blocked.";
    const text = readFileSync(target, "utf8").replace(/\r\n?/g, "\n");
    const blocks = laneBlocks(text);
    if (!blocks.length) return undefined;
    const ids = blocks.map((block) => block.id).join(", ");
    if (toolName === "write") return PI_EXTENSION_DENIALS.managedBlocked.prefix + "write: " + rel + " holds managed blocks (" + ids + ") and write replaces the whole file. Use edit on text outside them. " + LANE_RENDER;
    const olds = laneOldTexts(input);
    if (olds === undefined) return PI_EXTENSION_DENIALS.managedBlocked.prefix + "edit: " + rel + " holds managed blocks (" + ids + ") and the edit arrived in a shape Navori cannot inspect. Send edits as a list of oldText/newText.";
    for (const old of olds) {
      let from = text.indexOf(old);
      if (from < 0) return PI_EXTENSION_DENIALS.managedBlocked.prefix + "edit: " + rel + " holds managed blocks (" + ids + ") and an oldText was not found exactly, so Navori cannot tell whether it falls inside one. Use the exact text, outside them.";
      for (; from >= 0; from = text.indexOf(old, from + 1)) {
        const hit = blocks.find((block) => from < block.end && from + old.length > block.start);
        if (hit) return PI_EXTENSION_DENIALS.managedBlocked.prefix + "edit: it changes the managed block " + hit.id + " in " + rel + ". " + LANE_RENDER;
      }
    }
    return undefined;
  } catch {
    return PI_EXTENSION_DENIALS.managedError.prefix + toolName + " (an unexpected error), so it is blocked.";
  }
}
`;
