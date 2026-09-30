/**
 * UX contract gate (phase `ux`). `state.ux` records the user's choice
 * (`navori master ux <none|md|md-json>`); the checks here keep the choice and
 * the stage's `UX.md` / `ux.json` files consistent. Shared by `advance`/`check`
 * (ux -> executing) and by `status`/`close` (delivery may not skip the gate).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MasterState } from "./schema.ts";

/** Minimal context so both `CheckContext` and `status.ts` can call the checks. */
export interface UxContext {
  stagePath: string;
  stage: { dir: string };
  state: Pick<MasterState, "ux">;
}

/** The decision must be recorded before leaving phase `ux`. */
export function checkUxDecision(ctx: UxContext): string[] {
  if (ctx.state.ux !== undefined) return [];
  return [
    `${ctx.stage.dir}: falta la decisión de UX; registre una con: navori master ux <none|md|md-json>`,
  ];
}

/**
 * Seam for content validation of UX.md / ux.json (schema, coherence); runs only
 * once presence is consistent. Presence-only for now.
 */
export function checkUxContent(_ctx: UxContext): string[] {
  return [];
}

/**
 * Presence consistency between `state.ux` and the files on disk: `none` allows
 * neither file, `md` requires UX.md only, `md-json` requires both. With no decision
 * (legacy stages) only a ux.json without UX.md is inconsistent.
 */
export function checkUxArtifacts(ctx: UxContext): string[] {
  const dir = ctx.stage.dir;
  const hasMd = existsSync(join(ctx.stagePath, "UX.md"));
  const hasJson = existsSync(join(ctx.stagePath, "ux.json"));
  const choice = ctx.state.ux;
  const failures: string[] = [];
  if (choice === undefined) {
    if (hasJson && !hasMd) failures.push(`${dir}: ux.json existe sin UX.md`);
  } else if (choice === "none") {
    if (hasMd) failures.push(`${dir}: la decisión de UX es 'none' pero existe UX.md`);
    if (hasJson) failures.push(`${dir}: la decisión de UX es 'none' pero existe ux.json`);
  } else {
    if (!hasMd) failures.push(`${dir}: la decisión de UX es '${choice}' pero falta UX.md`);
    if (choice === "md-json" && !hasJson)
      failures.push(`${dir}: la decisión de UX es 'md-json' pero falta ux.json`);
    if (choice === "md" && hasJson)
      failures.push(`${dir}: la decisión de UX es 'md' pero existe ux.json`);
  }
  if (failures.length === 0 && hasMd) failures.push(...checkUxContent(ctx));
  return failures;
}
