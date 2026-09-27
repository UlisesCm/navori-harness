import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { MasterStateSchema, PartsSchema, type PartState } from "./schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";

export interface PartChange {
  state?: string;
  reason?: string;
  spec?: string;
  issue?: string;
  accept?: string;
  command?: string;
  result?: string;
  approvedBy?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function containedSpec(cwd: string, specsDir: string, input: string): string {
  if (!input.trim() || input !== input.trim() || isAbsolute(input))
    throw new Error("--spec requires a repository-relative path without edge whitespace");
  const root = resolve(cwd, specsDir);
  const path = resolve(cwd, input);
  if (
    path === root ||
    !path.startsWith(`${root}${sep}`) ||
    !existsSync(path) ||
    !statSync(path).isDirectory()
  )
    throw new Error(`--spec must name an existing directory beneath ${specsDir}/`);
  const realRoot = realpathSync(root);
  const real = realpathSync(path);
  if (!real.startsWith(`${realRoot}${sep}`)) throw new Error("--spec resolves outside specsDir");
  return input;
}

function cleanOutsideSpecs(cwd: string, specsDir: string): boolean {
  const output = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const prefix = `${specsDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const entries = output.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const path = entry.slice(3).replace(/\\/g, "/");
    if (!path.startsWith(prefix)) return false;
    // Rename/copy records include an additional original path.
    if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C")) {
      const prior = entries[++i];
      if (!prior?.replace(/\\/g, "/").startsWith(prefix)) return false;
    }
  }
  return true;
}

/** Validate every requested mutation before writing parts.json. */
export function changeMasterPart(cwd: string, id: string, change: PartChange): void {
  if (!/^P[1-9]\d*$/.test(id)) throw new Error(`invalid part id: ${id}`);
  const config = readConfig(join(cwd, "navori.config.json"));
  if (!config.harness?.masterPlan)
    throw new Error("harness.masterPlan is disabled; run navori master init");
  const specsDir = config.sdd?.specsDir ?? "specs";
  const stage = activeStage(readMasterIndex(cwd, specsDir));
  if (!stage) throw new Error("no active stage; run navori master init");
  const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
  const state = MasterStateSchema.parse(
    JSON.parse(readFileSync(join(stagePath, "state.json"), "utf8")) as unknown,
  );
  if (state.phase === "closed") throw new Error("closed stage is read-only");
  const path = join(stagePath, "parts.json");
  const repoRoot = realpathSync(cwd);
  if (
    !realpathSync(stagePath).startsWith(`${repoRoot}${sep}`) ||
    !realpathSync(path).startsWith(`${repoRoot}${sep}`)
  )
    throw new Error("refusing to write parts.json outside repository");
  const document = PartsSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const part = document.parts.find((item) => item.id === id);
  if (!part) throw new Error(`part ${id} not found`);
  const updated = structuredClone(document);
  const target = updated.parts.find((item) => item.id === id)!;
  if (change.accept !== undefined) {
    if (
      change.state !== undefined ||
      change.reason !== undefined ||
      change.spec !== undefined ||
      change.issue !== undefined
    )
      throw new Error("--accept cannot be combined with other part mutations");
    if (part.state === "descartada" || part.state === "diferida")
      throw new Error(`${id} is ${part.state}`);
    const criterion = target.acceptance.find((item) => item.id === change.accept);
    if (!criterion) throw new Error(`criterion ${id}.${change.accept} not found`);
    const date = new Date().toISOString().slice(0, 10);
    if (criterion.method === "manual") {
      if (
        change.approvedBy !== "user" ||
        change.command !== undefined ||
        change.result !== undefined
      )
        throw new Error("manual acceptance requires only --approved-by user");
      criterion.evidence = { kind: "approval", approvedBy: "user", date };
    } else {
      if (change.approvedBy !== undefined || !change.command?.trim() || !change.result?.trim())
        throw new Error("run acceptance requires --command and --result, without --approved-by");
      if (criterion.method === "test") {
        const file = resolve(cwd, criterion.test.file);
        const repo = realpathSync(cwd);
        if (
          !file.startsWith(`${resolve(cwd)}${sep}`) ||
          !existsSync(file) ||
          !realpathSync(file).startsWith(`${repo}${sep}`) ||
          !change.command.includes(criterion.test.file)
        )
          throw new Error(`test command must reference existing ${criterion.test.file}`);
      } else if (change.command.trim() !== criterion.command.run.trim()) {
        throw new Error(`command must equal declared run: ${criterion.command.run}`);
      }
      if (!cleanOutsideSpecs(cwd, specsDir))
        throw new Error("working tree is dirty outside specsDir; commit tested code first");
      criterion.evidence = {
        kind: "run",
        command: change.command.trim(),
        result: change.result.trim(),
        commit: git(cwd, ["rev-parse", "HEAD"]),
        date,
      };
    }
  } else {
    if (
      change.command !== undefined ||
      change.result !== undefined ||
      change.approvedBy !== undefined
    )
      throw new Error("--command, --result and --approved-by require --accept");
    if (
      change.state === undefined &&
      change.reason === undefined &&
      change.spec === undefined &&
      change.issue === undefined
    )
      throw new Error("part requires a mutation");
    if (change.state !== undefined) {
      if (!["pendiente", "parcial", "hecho", "descartada", "diferida"].includes(change.state))
        throw new Error(`invalid state ${change.state}`);
      if (
        change.reason !== undefined &&
        change.state !== "descartada" &&
        change.state !== "diferida"
      )
        throw new Error("--reason is only valid with --state descartada or diferida");
      target.state = change.state as PartState;
      target.reason =
        change.state === "descartada" || change.state === "diferida"
          ? change.reason?.trim() || null
          : null;
      if ((target.state === "descartada" || target.state === "diferida") && !target.reason)
        throw new Error(`--state ${target.state} requires --reason`);
    } else if (change.reason !== undefined) throw new Error("--reason requires --state");
    if (change.spec !== undefined) target.spec = containedSpec(cwd, specsDir, change.spec);
    if (change.issue !== undefined) {
      if (target.issue !== null) throw new Error(`${id} already has issue ${target.issue}`);
      if (!/^[1-9]\d*$/.test(change.issue) || !Number.isSafeInteger(Number(change.issue)))
        throw new Error("--issue requires a positive integer");
      target.issue = Number(change.issue);
    }
  }
  const parsed = PartsSchema.parse(updated);
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
