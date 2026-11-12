import type { Json, RowAction, TargetSchema } from "./types.ts";
import { followupFields, templateFields } from "./target.ts";
import { isBlank } from "./normalize.ts";

/** Distru's clear token for update mode. */
export const CLEAR = "##";

export function formatCell(v: Json): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.map(formatCell).join(", ");
  return String(v);
}

/**
 * One template row (H fields only, in templateHeaders order). M-only fields and whole groups that contain
 * one are left blank: they go through the follow-up path.
 */
export function toTemplateRow(
  target: TargetSchema,
  output: Record<string, Json>,
  opts: { distruId?: string | null; forceInactive?: boolean; onlyFields?: Set<string>; clear?: Set<string> } = {},
): Record<string, string> {
  const tpl = templateFields(target);
  const byHeader = new Map(Object.values(target.fields).filter((f) => f.header).map((f) => [f.header!, f]));
  const row: Record<string, string> = {};
  for (const h of target.templateHeaders) {
    const fd = byHeader.get(h)!;
    let cell = "";
    if (fd.name === target.idField) cell = opts.distruId ?? "";
    else if (tpl.has(fd.name) && (!opts.onlyFields || opts.onlyFields.has(fd.name) || opts.clear?.has(fd.name))) {
      let v = output[fd.name];
      if (fd.invert && typeof v === "boolean") v = !v;
      if (fd.invert && opts.forceInactive) v = true;
      cell = formatCell(v);
      if (!cell && opts.clear?.has(fd.name)) cell = CLEAR;
    } else if (fd.invert && opts.forceInactive) cell = "TRUE";
    row[h] = cell;
  }
  return row;
}

/** Values for the follow-up mutation: pending M-only groups plus the real `active` value. */
export function followupValues(
  target: TargetSchema,
  output: Record<string, Json>,
  opts: { onlyFields?: Set<string>; clear?: Set<string>; includeTemplateFields?: boolean } = {},
): Record<string, Json> {
  const fu = followupFields(target);
  const tpl = templateFields(target);
  const out: Record<string, Json> = {};
  for (const fd of Object.values(target.fields)) {
    if (fd.src === "importer" || fd.name === target.idField) continue;
    const eligible = fu.has(fd.name) || (opts.includeTemplateFields && tpl.has(fd.name));
    if (!eligible || (opts.onlyFields && !opts.onlyFields.has(fd.name))) continue;
    const v = output[fd.name];
    if (!isBlank(v as string) && !(Array.isArray(v) && v.length === 0)) out[fd.name] = v;
    else if (opts.clear?.has(fd.name)) out[fd.name] = null;
  }
  return out;
}

/** Whether a row needs a follow-up mutation after upload. */
export function needsFollowup(target: TargetSchema, output: Record<string, Json>, action: RowAction, uploadSupportsUpdate: boolean, changed?: string[]): boolean {
  if (action === "update") {
    if (!uploadSupportsUpdate) return true;
    const fu = followupFields(target);
    return (changed ?? Object.keys(output)).some((f) => fu.has(f));
  }
  if (action === "create") return Object.keys(followupValues(target, output)).length > 0;
  return false;
}

export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}
