import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { PartsSchema, type Part } from "./schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";

const TASK_ENTRY = /^- \[[ xX]\](?: .*)?$/gm;
const TASK_TITLE = /^- \[[ xX]\] \*\*(T\d+)\*\*/;
type FieldKey =
  | "files"
  | "interfaces"
  | "pattern"
  | "reading"
  | "libraries"
  | "done"
  | "outOfScope";
type Lang = "es" | "en";

/** Canonical task field -> label per language; both are accepted when validating. */
const FIELDS: Record<FieldKey, Record<Lang, string>> = {
  files: { es: "Archivos", en: "Files" },
  interfaces: { es: "Interfaces", en: "Interfaces" },
  pattern: { es: "Patrón", en: "Pattern" },
  reading: { es: "Lectura", en: "Reading" },
  libraries: { es: "Librerías", en: "Libraries" },
  done: { es: "Done", en: "Done" },
  outOfScope: { es: "Fuera de alcance", en: "Out of scope" },
};
const CRITERION = /P\d+\.A\d+/g;

function hasNamedTestCase(done: string): boolean {
  const named =
    /(?:casos?\s+(?:de\s+)?test|test\s+cases?)\s*:?\s*[`"']([^`"']+)[`"']/i.exec(done)?.[1] ??
    /\bit\(\s*[`"']([^`"']+)[`"']\s*\)/i.exec(done)?.[1] ??
    /(?:casos?\s+(?:de\s+)?test|test\s+cases?)\s*:\s*([^,;\n]+)/i.exec(done)?.[1];
  return Boolean(named?.trim() && !/^(?:test|case|caso|P\d+\.A\d+)$/i.test(named.trim()));
}

/** Validate a linked part spec without modifying the repository. */
export function checkPart(cwd: string, partId: string): string[] {
  if (!/^P[1-9]\d*$/.test(partId)) return [`invalid part id ${partId}`];
  const config = readConfig(join(cwd, "navori.config.json"));
  const language: Lang = config.language === "en" ? "en" : "es";
  if (!config.harness?.masterPlan) return ["harness.masterPlan is disabled"];
  const specsDir = config.sdd?.specsDir ?? "specs";
  const stage = activeStage(readMasterIndex(cwd, specsDir));
  if (!stage) return ["no active master-plan stage"];
  if (stage.workflow === "deliveries")
    return [`${stage.dir}: deliveries workflow is not supported by legacy part checks`];
  const partsPath = join(masterDirPath(cwd, specsDir), stage.dir, "parts.json");
  if (!existsSync(partsPath)) return [`missing ${partsPath}`];
  const parsed = PartsSchema.safeParse(JSON.parse(readFileSync(partsPath, "utf8")) as unknown);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  const part = parsed.data.parts.find((item) => item.id === partId);
  if (!part) return [`part ${partId} is not in parts.json`];
  if (!part.spec) return [`part ${partId} has no linked spec`];
  const root = resolve(cwd, specsDir);
  const spec = resolve(cwd, part.spec);
  if (spec !== root && !spec.startsWith(`${root}${sep}`))
    return [`part ${partId} spec is outside specsDir`];
  return checkPartFiles(cwd, spec, part, parsed.data.parts, language);
}

/** Pure-content validator for tests and for the linked spec on disk. */
export function validatePartSpec(
  cwd: string,
  part: Part,
  allParts: readonly Part[],
  tasks: string,
  design: string,
  requirements: string,
  language: Lang = "es",
): string[] {
  const failures: string[] = [];
  const starts = [...tasks.matchAll(TASK_ENTRY)].map((match) => match.index);
  if (starts.length === 0) failures.push(`${part.id}: tasks.md has no tasks`);
  for (const [index, start] of starts.entries()) {
    const block = tasks.slice(start, starts[index + 1] ?? tasks.length);
    const taskId = TASK_TITLE.exec(block)?.[1];
    if (!taskId) {
      failures.push(`${part.id}: task ${index + 1} needs a **T<n>** heading`);
      continue;
    }
    const values = new Map<FieldKey, string>();
    for (const [key, labels] of Object.entries(FIELDS) as [FieldKey, Record<Lang, string>][]) {
      const markers = [labels.es, labels.en].map((label) => `- **${label}:**`);
      let value: string | undefined;
      for (const line of block.split("\n")) {
        const marker = markers.find((m) => line.trimStart().startsWith(m));
        if (marker) {
          value = line.trimStart().slice(marker.length).trim();
          break;
        }
      }
      if (!value) failures.push(`${taskId}: missing ${labels[language]}`);
      else values.set(key, value);
    }
    for (const name of values
      .get("interfaces")
      ?.split(/[,;]+/)
      .map((s) => s.trim()) ?? []) {
      if (name && !design.includes(name))
        failures.push(`${taskId}: interface ${name} not in design.md`);
    }
    const pattern = values.get("pattern")?.replace(/`/g, "").trim();
    if (pattern) {
      const path = resolve(cwd, pattern);
      if (!path.startsWith(`${resolve(cwd)}${sep}`) || !existsSync(path))
        failures.push(`${taskId}: pattern file does not exist: ${pattern}`);
    }
    const libraries = values.get("libraries");
    if (libraries && !/^(ninguna|none)$/i.test(libraries)) {
      for (const library of libraries.split(/[,;]+/).map((s) => s.trim())) {
        if (!/^[\w@./-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(library))
          failures.push(`${taskId}: library needs exact version: ${library}`);
      }
    }
    const done = values.get("done") ?? "";
    if (
      done &&
      (!/comando|command|`[^`]+`/i.test(done) ||
        !/esperado|expected|exit 0|green/i.test(done) ||
        !hasNamedTestCase(done) ||
        ![...done.matchAll(CRITERION)].some((match) => match[0].startsWith(`${part.id}.`)))
    )
      failures.push(
        `${taskId}: Done needs command, expected result, named test cases and acceptance ID`,
      );
  }
  const known = new Set(allParts.flatMap((p) => p.acceptance.map((a) => `${p.id}.${a.id}`)));
  const own = part.acceptance.map((a) => `${part.id}.${a.id}`);
  const cited = new Set<string>();
  const requirementBlocks = requirements
    .split(/(?=^\s*-?\s*\*\*R\d+\*\*)/m)
    .filter((block) => /^\s*-?\s*\*\*R\d+\*\*/.test(block));
  for (const block of requirementBlocks) {
    for (const match of block.matchAll(CRITERION)) {
      const id = match[0];
      cited.add(id);
      if (!known.has(id)) failures.push(`requirements.md cites nonexistent criterion ${id}`);
      else if (!id.startsWith(`${part.id}.`))
        failures.push(`warning: requirements.md cites criterion from another part ${id}`);
    }
  }
  for (const id of own)
    if (!cited.has(id)) failures.push(`criterion ${id} is not cited by any R<n>`);
  return failures;
}

function checkPartFiles(
  cwd: string,
  spec: string,
  part: Part,
  allParts: readonly Part[],
  language: Lang,
): string[] {
  const paths = ["tasks.md", "design.md", "requirements.md"].map((name) => join(spec, name));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length) return missing.map((path) => `missing ${path}`);
  return validatePartSpec(
    cwd,
    part,
    allParts,
    ...(paths.map((path) => readFileSync(path, "utf8")) as [string, string, string]),
    language,
  );
}
