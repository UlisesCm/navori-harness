import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { scanManagedDrift, suggestNextSteps } from "../lib/health.ts";
import { scanDistribution, type DistributionReport } from "../lib/distribution.ts";
import { computeHealthVerdict } from "./doctor.ts";
import { brand, dim as grey, color, sym, kv, accent } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";
import { readNavoriOwnership } from "../lib/json-ownership.ts";

/**
 * `status` — spec 0003 §3.5.3. A quick "where did this repo land?" snapshot:
 * config summary, enabled plugins, drift count, and suggested next steps.
 * Shares its health-check logic with `doctor` (lib/health.ts); `doctor` is the
 * verbose audit, `status` is the at-a-glance view.
 */
/**
 * The navori release that actually WROTE this harness, read from the `$navori`
 * stamp in `.claude/settings.json`.
 *
 * `config.version` is a different thing that shares the name (#604): it is the
 * PROJECT's version, defaulted to "1.0.0" at init and updated by nobody, so
 * printing it next to `preset`/`engines` read as "the version of my harness"
 * and was wrong in every repo. This is the number that answers that question.
 *
 * `null` when the repo renders no Claude engine (Codex-only) or was never
 * rendered — the honest answer, rather than falling back to a value that would
 * mean something else.
 */
export function readRenderedVersion(cwd: string): string | null {
  const path = resolve(cwd, ".claude/settings.json");
  if (!existsSync(path)) return null;
  try {
    return readNavoriOwnership(readFileSync(path, "utf-8"))?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The distribution row's body: the counts that are non-zero, joined (#778).
 *
 * Counts only — the sentence, the versions on each side and the remediation
 * command live in `doctor`, which is the verbose half of the pair. What `status`
 * owes the reader is that the question EXISTS, since it is the command run
 * casually and the one that reported a repo as healthy for two weeks.
 */
export function distributionSummary(
  report: DistributionReport,
  ts: ReturnType<typeof tc>["status"],
): string {
  const parts: string[] = [];
  if (report.uncommitted.length > 0) {
    parts.push(ts.distributionRowUncommitted(report.uncommitted.length));
  }
  if (report.unpushed) parts.push(ts.distributionRowUnpushed(report.unpushed.commits));
  if (report.base && report.base.files > 0) {
    parts.push(ts.distributionRowVsBase(report.base.files, report.base.ref));
  }
  if (report.base && report.base.behind > 0) {
    parts.push(ts.distributionRowBehind(report.base.behind, report.base.ref));
  }
  return parts.join(" · ");
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Quick snapshot: config, plugins, drift, and suggested next steps",
  },
  args: {
    cwd: { type: "string", description: "Directory to inspect (default: cwd)" },
    json: { type: "boolean", description: "Output as JSON (pipeable)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    if (!existsSync(configPath)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "config-missing", configPath }));
      } else {
        p.intro(brand("status"));
        p.cancel(tc(DEFAULT_LANG).common.noConfig(configPath));
      }
      process.exit(1);
    }

    let config: NavoriConfig;
    try {
      config = readConfig(configPath);
    } catch (err) {
      if (err instanceof ConfigError) {
        if (args.json) {
          console.log(JSON.stringify({ ok: false, error: "config-invalid", message: err.message }));
        } else {
          p.intro(brand("status"));
          p.cancel(err.message);
        }
        process.exit(1);
      }
      throw err;
    }

    const claudeMdExists = existsSync(`${cwd}/CLAUDE.md`);
    // The health verdict is the SAME one `doctor` computes, so `status`'s `ok`
    // (and exit code) can no longer contradict `doctor` on the same repo (#244).
    // `status` stays the lightweight snapshot; `doctor` remains the verbose audit.
    const verdict = computeHealthVerdict(cwd, config);
    const missingPlugins = verdict.missingPlugins;
    const drifts = scanManagedDrift(cwd, config);
    // #778: the git axis, summarized to one row. `status` is the at-a-glance
    // view, so it says HOW MANY and defers the sentence to `doctor` — but it
    // says it at all, which is the whole point: this is the command people run.
    const distribution = scanDistribution(cwd, config);
    const enabledPlugins = Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: verdict.ok,
            name: config.name,
            // Two different facts that used to share one name (#604): the
            // project's own version, and the navori release that rendered it.
            version: config.version,
            renderedVersion: readRenderedVersion(cwd),
            preset: config.preset,
            engines: config.engines,
            enabledPlugins,
            claudeMdExists,
            drift: drifts.length,
            distribution,
            missingPlugins: missingPlugins.map((m) => m.id),
            // Machine-readable contract: the prose stays stable in English so a
            // consumer never has to branch on config.language.
            nextSteps: suggestNextSteps({ claudeMdExists, missingPlugins, drifts }, "en"),
          },
          null,
          2,
        ),
      );
      // Mirror doctor's hard-issue exit code so a pipeline gets a consistent
      // signal from either command (#244). Drift alone never fails status.
      if (!verdict.ok) process.exit(2);
      return;
    }

    const lang = resolveLang(config.language);
    const ts = tc(lang).status;
    const nextSteps = suggestNextSteps({ claudeMdExists, missingPlugins, drifts }, lang);

    p.intro(brand("status"));
    p.note(
      kv([
        ["name", accent(config.name)],
        ["version (project)", config.version],
        ["version (navori)", readRenderedVersion(cwd) ?? grey(ts.none)],
        ["preset", config.preset],
        ["engines", config.engines.join(", ")],
        ["plugins", enabledPlugins.length > 0 ? enabledPlugins.join(", ") : grey(ts.none)],
        ["CLAUDE.md", claudeMdExists ? color.green(ts.present) : color.red(ts.missing)],
        ["drift", drifts.length > 0 ? color.yellow(`${drifts.length}`) : color.green("0")],
        // Absent — not "0" — when there is nothing to say, so a repo that does
        // not version its harness gains no row at all (#778).
        ...(distribution
          ? ([
              [
                "distribution",
                color.yellow(ts.distributionRow(distributionSummary(distribution, ts))),
              ],
            ] as Array<[string, string]>)
          : []),
      ]),
      ts.statusTitle(grey(cwd)),
    );
    p.note(nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), ts.nextStepsTitle);
    p.outro(verdict.ok ? color.green(ts.ok) : color.red(ts.issuesFound));
    // Consistent gate with doctor (#244): a repo doctor would fail with exit 2
    // must not report success from status.
    if (!verdict.ok) process.exit(2);
  },
});
