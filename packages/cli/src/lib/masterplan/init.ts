/**
 * `navori master init <slug>` of the master plan v2 (spec 0063): creates the
 * one-page `PLAN.md` from the language template, turns `harness.masterPlan` on
 * and re-renders. It never overwrites a plan and never reformats the config.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runRender } from "../../commands/render.ts";
import { readConfig } from "../config/config.ts";
import { resolveLang, tc, type Lang } from "../i18n.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { type CommandOutput, fail, runPlanStatus } from "./report.ts";
import { planPath } from "./state.ts";

export interface InitOptions {
  /** Where `core-assets/master-plan/` is read from (tests use a fixture). */
  root?: string;
  /** Re-render step (tests stub it). */
  render?: (cwd: string) => { ok: boolean; reason?: string };
}

export const FLAG_EDIT = '"harness": { "masterPlan": true }';
export const RENDER_CMD = "navori render --apply";

/** Language template with `{{slug}}` and `{{target}}` filled in. */
export function renderTemplate(root: string, lang: Lang, slug: string, target: string): string {
  // Not `PLAN.md`: it would collide with v1's `plan.md` on case-insensitive filesystems.
  const file = join(root, "core-assets/master-plan", lang === "en" ? "en" : ".", "plan-v2.md");
  return readFileSync(file, "utf8").replaceAll("{{slug}}", slug).replaceAll("{{target}}", target);
}

/**
 * Sets `harness.masterPlan` with a raw JSON round-trip, only when the file is
 * in the canonical shape `writeConfig` produces (same criterion as
 * `recordHarnessVersion`); a hand-formatted file is left byte-identical.
 */
export function enableFlag(configPath: string): "set" | "unchanged" | "non-canonical" {
  const text = readFileSync(configPath, "utf8");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const harness = (raw.harness ?? {}) as Record<string, unknown>;
  if (harness.masterPlan === true) return "unchanged";
  if (JSON.stringify(raw, null, 2) + "\n" !== text) return "non-canonical";
  writeFileAtomic(
    configPath,
    JSON.stringify({ ...raw, harness: { ...harness, masterPlan: true } }, null, 2) + "\n",
  );
  return "set";
}

export function runPlanInit(
  cwd: string,
  slug: string | undefined,
  options: InitOptions = {},
): CommandOutput {
  const configPath = resolve(cwd, "navori.config.json");
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(configPath);
  } catch {
    return fail(tc(resolveLang(undefined)).master.initNoConfig(configPath));
  }
  const lang = resolveLang(config.language);
  const tr = tc(lang).master;
  if (config.sdd?.enabled === false) return fail(tr.initNeedsSdd);

  const file = planPath(cwd);
  const existed = existsSync(file);
  if (!existed) {
    if (!slug) return fail(tr.initNeedsSlug);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return fail(tr.initBadSlug(slug));
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(
      file,
      renderTemplate(options.root ?? getCoreRoot(), lang, slug, config.branchBase ?? "main"),
    );
  }

  const rel = file.slice(cwd.length + 1);
  try {
    if (enableFlag(configPath) === "non-canonical")
      return fail(tr.initFlagEdit(rel, configPath, FLAG_EDIT, RENDER_CMD));
  } catch {
    return fail(tr.initNoConfig(configPath));
  }
  const rendered = (options.render ?? runRender)(cwd);
  if (!rendered.ok) return fail(tr.initRenderFailed(rendered.reason ?? "unknown error"));

  if (!existed) return { stdout: `${tr.initCreated(rel)}\n`, stderr: "", code: 0 };
  const status = runPlanStatus(cwd, { lang, fetch: false });
  // A status failure (no remote yet) is reported, but the flag work above succeeded.
  return { stdout: `${tr.initKept(rel)}\n${status.stdout}`, stderr: status.stderr, code: 0 };
}
