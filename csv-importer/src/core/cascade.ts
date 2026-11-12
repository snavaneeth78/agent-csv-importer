import type { ImporterConfig } from "./config.ts";
import type { ColumnProfile } from "./profile.ts";
import type { Candidate, MatchStage, MemoryEntry } from "./ports.ts";
import type { Ctx, FieldDef, FieldMapping, Method, TargetSchema, Transform } from "./types.ts";
import { normalizeHeader, tokens } from "./normalize.ts";

export interface CascadeResult {
  fields: FieldMapping[];
  ignored: { source: string; reason: string }[];
  unresolved: ColumnProfile[];
  byStage: Partial<Record<Method | "none", number>>;
}

/** Default transform chain for a field, given the column it maps from. */
export function defaultTransforms(field: FieldDef, col?: ColumnProfile): Transform[] {
  const isInverted = () => {
    if (!col) return false;
    if (field.invert && field.header && col.headerNorm === normalizeHeader(field.header)) return true;
    const inv = (field.invertedSynonyms ?? []).map(normalizeHeader);
    return inv.some((s) => col.headerNorm === s || tokens(col.source).includes(s));
  };
  if (field.pattern === "quantity") return [{ op: "parse_quantity", part: "value", ...(col?.unitHint ? { assumeUnit: col.unitHint } : {}) }];
  if (field.pattern === "potency") {
    if (col && col.signals.percent === 0 && col.signals.mg === 0 && (col.maxNumber ?? 2) <= 1) return [{ op: "parse_percent", mode: "0_1" }];
    return [{ op: "parse_potency", part: "value" }];
  }
  switch (field.type) {
    case "string":
      return field.pattern === "upc" || field.warnIf?.includes("sci_notation") ? [{ op: "trim" }, { op: "fix_scientific_notation" }] : [{ op: "trim" }];
    case "number":
    case "integer":
      return [{ op: "parse_number" }];
    case "money":
      return [{ op: "parse_money" }];
    case "bool":
      return [{ op: "parse_bool", ...(isInverted() ? { invert: true } : {}) }];
    case "currency":
      return [{ op: "trim" }, { op: "case", mode: "upper" }];
    case "enum":
    case "ref":
      return [{ op: "trim" }, { op: "map_values", key: field.name }];
    case "ref_list":
      return [{ op: "split", sep: "," }, { op: "map_values", key: field.name }];
  }
}

/**
 * Runs each unresolved column through the stages in order (§4.1). A column stops at the first stage that
 * clears its threshold. A target is claimed by one column; on a conflict the higher score wins and the
 * loser drops to the next stage.
 */
export async function runCascade(input: {
  ctx: Ctx;
  target: TargetSchema;
  columns: ColumnProfile[];
  memory: MemoryEntry[];
  config: ImporterConfig;
  stages: MatchStage[];
  onResolved?: (m: FieldMapping) => void | Promise<void>;
}): Promise<CascadeResult> {
  const { target, config } = input;
  const fields: FieldMapping[] = [];
  const ignored: CascadeResult["ignored"] = [];
  const byStage: CascadeResult["byStage"] = {};
  const claimed = new Set<string>();
  const ignoredTpl = new Map(target.ignoredHeaders.map((i) => [normalizeHeader(i.header), i.reason]));

  // A file in Distru's own template keeps its empty columns mapped (blank cells can clear values).
  const tpl = new Set(target.templateHeaders.map(normalizeHeader));
  const isTemplateFile = input.columns.every((c) => ignoredTpl.has(c.headerNorm) || tpl.has(c.headerNorm));
  let unresolved: ColumnProfile[] = [];
  for (const c of input.columns) {
    if (ignoredTpl.has(c.headerNorm)) ignored.push({ source: c.source, reason: ignoredTpl.get(c.headerNorm)! });
    else if (c.nonBlank === 0 && !isTemplateFile) ignored.push({ source: c.source, reason: "Column is empty" });
    else unresolved.push(c);
  }

  for (const stage of input.stages) {
    if (unresolved.length === 0) break;
    const open = Object.values(target.fields).filter((f) => !claimed.has(f.name));
    const { candidates, final } = await stage.run({
      ctx: input.ctx, target, columns: unresolved, fields: open, allColumns: input.columns, memory: input.memory, config,
    });
    const accepted = candidates.filter((c) => c.score >= stage.threshold || (c.suggest && c.target)).sort((a, b) => b.score - a.score);
    const done = new Set<string>();
    for (const c of accepted) {
      if (done.has(c.source)) continue;
      if (c.target === null) {
        ignored.push({ source: c.source, reason: c.rationale });
        byStage.none = (byStage.none ?? 0) + 1;
        done.add(c.source);
        continue;
      }
      if (claimed.has(c.target) || !target.fields[c.target]) continue;
      const col = unresolved.find((u) => u.source === c.source)!;
      const m: FieldMapping = {
        target: c.target,
        sources: [c.source],
        transforms: c.transforms ?? defaultTransforms(target.fields[c.target], col),
        score: round(c.score),
        method: stage.method,
        rationale: c.rationale,
        ...(c.suggest && c.score < stage.threshold ? { needsConfirm: true } : {}),
      };
      fields.push(m);
      claimed.add(c.target);
      done.add(c.source);
      byStage[stage.method] = (byStage[stage.method] ?? 0) + 1;
      await input.onResolved?.(m);
    }
    unresolved = unresolved.filter((u) => !done.has(u.source));
    if (final) break;
  }
  return { fields, ignored, unresolved, byStage };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export type { Candidate };
