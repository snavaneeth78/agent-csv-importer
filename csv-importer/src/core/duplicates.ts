import type { CatalogProduct } from "./ports.ts";
import type { DupClass, FieldDiff, Json, RowAction, RowIssue, TargetSchema } from "./types.ts";
import { isBlank, normValue } from "./normalize.ts";

export interface CatalogMatch {
  dupClass: Exclude<DupClass, "dup_in_file">;
  distruId: string | null;
  diff: FieldDiff[];
  blankWithValue: string[];
  possibleDuplicate?: string;
  issues: RowIssue[];
}

export const normSku = (s: Json) => (isBlank(s as string) ? null : String(s).trim().toUpperCase());

function same(a: Json, b: Json): boolean {
  if (isBlank(a as string) && isBlank(b as string)) return true;
  if (isBlank(a as string) || isBlank(b as string)) return false; // blank vs 0 is a change
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 1e-9;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify([...(a as Json[] ?? [])].map(String).sort()) === JSON.stringify([...(b as Json[] ?? [])].map(String).sort());
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Classify one row against the tenant catalog snapshot (§6). Distru ID counts only if it is in this
 * tenant's snapshot; otherwise it is reported and the row falls back to SKU matching.
 */
export function matchCatalog(
  target: TargetSchema,
  output: Record<string, Json>,
  catalog: { byId: Map<string, CatalogProduct>; bySku: Map<string, CatalogProduct>; byName: Map<string, CatalogProduct> },
  mappedFields: Set<string>,
): CatalogMatch {
  const issues: RowIssue[] = [];
  const idField = target.idField;
  let product: CatalogProduct | undefined;
  if (idField && !isBlank(output[idField] as string)) {
    product = catalog.byId.get(String(output[idField]).trim());
    if (!product) issues.push({ field: idField, code: "distru_id_not_found", message: "Distru ID not found in your catalog", severity: "warning" });
  }
  const sku = normSku(output[target.uniqueKey]);
  if (!product && sku) product = catalog.bySku.get(sku);

  if (!product) {
    if (!sku) {
      const byName = catalog.byName.get(normValue(String(output[target.nameField] ?? "")));
      return { dupClass: "no_sku", distruId: null, diff: [], blankWithValue: [], possibleDuplicate: byName?.distruId, issues };
    }
    return { dupClass: "new", distruId: null, diff: [], blankWithValue: [], issues };
  }

  const diff: FieldDiff[] = [];
  const blankWithValue: string[] = [];
  for (const field of mappedFields) {
    if (field === idField || !(field in product.values)) continue;
    const immutable = target.immutable?.includes(field);
    const to = output[field] ?? null;
    const from = product.values[field] ?? null;
    if (isBlank(to as string)) {
      if (!isBlank(from as string) && !immutable) blankWithValue.push(field);
      continue;
    }
    if (!same(from, to)) diff.push({ field, from, to, ...(immutable ? { blocked: true } : {}) });
  }
  const sendable = diff.filter((d) => !d.blocked);
  return {
    dupClass: sendable.length ? "exists_changed" : "exists_unchanged",
    distruId: product.distruId,
    diff,
    blankWithValue,
    issues,
  };
}

/** First row wins: later rows with the same SKU (or Distru ID) are dup_in_file. Returns rowIndex -> first rowIndex. */
export function markInFileDuplicates(keys: { rowIndex: number; sku: string | null; distruId: string | null }[]): Map<number, number> {
  const first = new Map<string, number>();
  const dups = new Map<number, number>();
  for (const k of [...keys].sort((a, b) => a.rowIndex - b.rowIndex)) {
    const keyset = [k.distruId ? `id:${k.distruId}` : null, k.sku ? `sku:${normSku(k.sku)}` : null].filter(Boolean) as string[];
    const hit = keyset.map((x) => first.get(x)).find((x) => x !== undefined);
    if (hit !== undefined) { dups.set(k.rowIndex, hit); continue; }
    for (const x of keyset) first.set(x, k.rowIndex);
  }
  return dups;
}

export function defaultAction(dupClass: DupClass | null, valid: boolean, existingAction: "skip" | "update"): RowAction {
  if (!valid) return "skip";
  switch (dupClass) {
    case "new":
    case "no_sku":
      return "create";
    case "exists_changed":
      return existingAction;
    default:
      return "skip";
  }
}

export function indexCatalog(products: CatalogProduct[]) {
  const byId = new Map<string, CatalogProduct>();
  const bySku = new Map<string, CatalogProduct>();
  const byName = new Map<string, CatalogProduct>();
  for (const p of products) {
    byId.set(p.distruId, p);
    const s = normSku(p.sku);
    if (s) bySku.set(s, p);
    byName.set(normValue(p.name), p);
  }
  return { byId, bySku, byName };
}
