import type { TargetProfile } from "./ports.ts";
import type { Json, MappingPlan, RowIssue, RowMeta } from "./types.ts";
import { runTransforms } from "./transforms.ts";
import { defaultTransforms } from "./cascade.ts";
import { groupsOf } from "./target.ts";
import { isBlank } from "./normalize.ts";

export interface ValidatedRow {
  output: Record<string, Json>;
  issues: RowIssue[];
  valid: boolean;
}

const isDerive = (v: Json) => !!v && typeof v === "object" && !Array.isArray(v) && "derive" in v;

/** Apply the confirmed plan to one row: transforms, user overrides, defaults, derived values, checks. */
export function validateRow(
  raw: Record<string, string>,
  overrides: Record<string, Json> | null,
  plan: MappingPlan,
  profile: TargetProfile,
  meta: RowMeta = {},
  refs: Record<string, string[]> = {},
): ValidatedRow {
  const target = profile.target;
  const output: Record<string, Json> = {};
  const issues: RowIssue[] = [];
  const tctx = (field: string) => ({ valueMaps: plan.valueMaps, currency: profile.currency, field });

  for (const m of plan.fields) {
    const r = runTransforms(m.sources.map((s) => raw[s] ?? ""), m.transforms, tctx(m.target));
    output[m.target] = r.value;
    issues.push(...r.issues);
  }

  for (const [field, value] of Object.entries(overrides ?? {})) {
    const fd = target.fields[field];
    if (!fd) continue;
    for (let i = issues.length - 1; i >= 0; i--) if (issues[i].field === field) issues.splice(i, 1);
    if (value === null || typeof value !== "string") { output[field] = value; continue; }
    const closed = fd.enumValues ?? (fd.ref?.mode === "must_exist" ? refs[field] : undefined);
    if (closed && fd.type !== "ref_list") {
      const hit = closed.find((o) => o.toLowerCase() === value.trim().toLowerCase());
      output[field] = hit ?? null;
      if (!hit) issues.push({ field, code: "bad_value", message: `"${value}" isn't a valid ${fd.header ?? field}. Use ${closed.length <= 6 ? closed.join(" or ") : "one of the listed values"}.`, severity: "error" });
      continue;
    }
    const r = runTransforms([value], defaultTransforms(fd), tctx(field));
    output[field] = r.value;
    issues.push(...r.issues);
  }

  for (const d of plan.defaultsApplied) {
    if (isBlank(output[d.target] as string) && !isDerive(d.value) && target.fields[d.target]) output[d.target] = d.value;
  }
  profile.hooks?.deriveRow?.(output, plan);

  const err = (field: string, code: string, message: string) => issues.push({ field, code, message, severity: "error" });
  const warn = (field: string, code: string, message: string) => issues.push({ field, code, message, severity: "warning" });

  for (const fd of Object.values(target.fields)) {
    const v = output[fd.name];
    if (fd.required && isBlank(v as string)) err(fd.name, "required", `${fd.header ?? fd.name} is required`);
    if (v === null || v === undefined) continue;
    if (fd.max && String(v).length > fd.max) err(fd.name, "too_long", `${fd.header ?? fd.name} is longer than ${fd.max} characters`);
    if (fd.type === "enum" && fd.enumValues && !fd.enumValues.includes(String(v))) err(fd.name, "bad_value", `"${v}" is not a valid ${fd.header ?? fd.name}`);
    if (fd.type === "integer" && typeof v === "number" && !Number.isInteger(v)) err(fd.name, "not_integer", `${fd.header ?? fd.name} must be a whole number`);
    if (fd.type === "currency" && String(v) !== profile.currency) err(fd.name, "currency", `Currency ${v} is not ${profile.currency}. Prices are never converted.`);
    if (fd.warnIf) {
      const s = String(v);
      if (fd.warnIf.includes("whitespace") && /\s/.test(s)) warn(fd.name, "sku_whitespace", "SKU contains whitespace");
      if (fd.warnIf.includes("looks_like_barcode") && /^\d{12,14}$/.test(s)) warn(fd.name, "sku_barcode", "SKU looks like a barcode");
    }
    if (fd.pattern === "upc") {
      const s = String(v);
      if (!/^\d{8,14}$/.test(s)) warn(fd.name, "upc_format", "UPC should be 8 to 14 digits");
      else if (s.length === 11) warn(fd.name, "upc_leading_zero", "UPC has 11 digits; a leading zero may have been lost");
    }
  }
  // Atomic groups: a value without its unit is an error, never a guess.
  for (const fd of Object.values(target.fields)) {
    if (!fd.unitField || isBlank(output[fd.name] as string)) continue;
    if (isBlank(output[fd.unitField] as string)) err(fd.unitField, "missing_unit", `${fd.header ?? fd.name} has no unit`);
  }
  void groupsOf;
  if (meta.ragged) warn("", "ragged_row", meta.ragged > 0 ? `Row had ${meta.ragged} extra cells (trimmed)` : `Row had ${-meta.ragged} missing cells (padded)`);

  for (const k of Object.keys(output)) if (output[k] === undefined) output[k] = null;
  return { output, issues, valid: !issues.some((i) => i.severity === "error") };
}
