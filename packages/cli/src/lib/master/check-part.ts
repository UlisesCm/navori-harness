import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { PartsSchema, type Part } from "./schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";

const TASK_ENTRY = /^- \[[ xX]\](?: .*)?$/gm;
const TASK_TITLE = /^- \[[ xX]\] \*\*(T\d+)\*\*/;
const FIELDS = [
  "Archivos",
  "Interfaces",
  "Patrón",
  "Lectura",
  "Librerías",
  "Done",
  "Fuera de alcance",
] as const;
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
  if (!config.harness?.masterPlan) return ["harness.masterPlan is disabled"];
  const specsDir = config.sdd?.specsDir ?? "specs";
  const stage = activeStage(readMasterIndex(cwd, specsDir));
  if (!stage) return ["no active master-plan stage"];
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
  return checkPartFiles(cwd, spec, part, parsed.data.parts);
}

/** Pure-content validator for tests and for the linked spec on disk. */
export function validatePartSpec(
  cwd: string,
  part: Part,
  allParts: readonly Part[],
  tasks: string,
  design: string,
  requirements: string,
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
    const values = new Map<string, string>();
    for (const field of FIELDS) {
      const marker = `- **${field}:**`;
      const line = block.split("\n").find((candidate) => candidate.trimStart().startsWith(marker));
      const value = line?.trimStart().slice(marker.length).trim();
      if (!value) failures.push(`${taskId}: missing ${field}`);
      else values.set(field, value);
    }
    for (const name of values
      .get("Interfaces")
      ?.split(/[,;]+/)
      .map((s) => s.trim()) ?? []) {
      if (name && !design.includes(name))
        failures.push(`${taskId}: interface ${name} not in design.md`);
    }
    const pattern = values.get("Patrón")?.replace(/`/g, "").trim();
    if (pattern) {
      const path = resolve(cwd, pattern);
      if (!path.startsWith(`${resolve(cwd)}${sep}`) || !existsSync(path))
        failures.push(`${taskId}: pattern file does not exist: ${pattern}`);
    }
    const libraries = values.get("Librerías");
    if (libraries && !/^(ninguna|none)$/i.test(libraries)) {
      for (const library of libraries.split(/[,;]+/).map((s) => s.trim())) {
        if (!/^[\w@./-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(library))
          failures.push(`${taskId}: library needs exact version: ${library}`);
      }
    }
    const done = values.get("Done") ?? "";
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
): string[] {
  const paths = ["tasks.md", "design.md", "requirements.md"].map((name) => join(spec, name));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length) return missing.map((path) => `missing ${path}`);
  return validatePartSpec(
    cwd,
    part,
    allParts,
    ...(paths.map((path) => readFileSync(path, "utf8")) as [string, string, string]),
  );
}
