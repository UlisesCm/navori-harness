import { describe, it, expect } from "vitest";
import { z } from "zod";
import { CONFIG_KEY_RULE, findUnknownConfigKeys, type ConfigObjectRule } from "../config.ts";
import { NavoriConfigSchema } from "../schema.ts";

/**
 * Strips the wrappers that do not change a value's JSON shape: optional,
 * nullable, default and pipes (`preprocess` keeps its output schema,
 * `transform` keeps its input one).
 */
function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodPipe) {
      current = (current.in instanceof z.ZodTransform ? current.out : current.in) as z.ZodType;
    } else {
      return current;
    }
  }
}

/**
 * Lists every difference between the advisory key map and the schema, as
 * `<path>: <reason>` lines, so a failure names the exact key to add or remove.
 */
function diffRule(schema: z.ZodType, rule: ConfigObjectRule, path: string): string[] {
  const target = unwrap(schema);
  if (target instanceof z.ZodArray) {
    const item = unwrap(target.element as z.ZodType);
    if (!(item instanceof z.ZodObject)) return [];
    return rule.arrayItems
      ? diffRule(item, rule.arrayItems, `${path}[]`)
      : [`${path}: schema has object items, rule has no arrayItems`];
  }
  if (target instanceof z.ZodRecord) {
    return rule.recordValues
      ? diffRule(target.valueType as z.ZodType, rule.recordValues, `${path}.*`)
      : [`${path}: schema is a record, rule has no recordValues`];
  }
  if (!(target instanceof z.ZodObject)) return [];

  const at = (key: string): string => (path ? `${path}.${key}` : key);
  const shape = target.shape as Record<string, z.ZodType>;
  const problems: string[] = [];
  for (const key of Object.keys(shape)) {
    if (!rule.keys.includes(key)) problems.push(`${at(key)}: in schema, missing from rule`);
  }
  for (const key of rule.keys) {
    if (!(key in shape)) problems.push(`${at(key)}: in rule, missing from schema`);
  }
  for (const [key, child] of Object.entries(shape)) {
    const inner = unwrap(child);
    const nested =
      inner instanceof z.ZodObject ||
      inner instanceof z.ZodRecord ||
      (inner instanceof z.ZodArray && unwrap(inner.element as z.ZodType) instanceof z.ZodObject);
    if (!nested) continue;
    const childRule = rule.children?.[key];
    if (!childRule) {
      problems.push(`${at(key)}: nested in schema, rule has no child entry`);
      continue;
    }
    problems.push(...diffRule(child, childRule, at(key)));
  }
  return problems;
}

describe("CONFIG_KEY_RULE mirrors NavoriConfigSchema (#1510)", () => {
  it("declares exactly the schema's keys at every nested level", () => {
    expect(diffRule(NavoriConfigSchema, CONFIG_KEY_RULE, "")).toEqual([]);
  });

  it("does not report schema keys the map used to miss", () => {
    const raw = {
      models: { codexProfiles: { implementer: { model: "sol", effort: "high" } } },
      project: { criticalPaths: ["src/auth/**"] },
    };
    expect(findUnknownConfigKeys(raw)).toEqual([]);
  });
});
