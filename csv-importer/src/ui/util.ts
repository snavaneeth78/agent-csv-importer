import { useCallback, useState } from "react";
import type { ImportStatus, Json } from "../core/index.ts";
import { ApiError, type ImportView } from "./api.ts";

export interface TargetField {
  name: string;
  label: string;
  section?: string;
  synonyms?: string[];
  required?: boolean;
  /** Written after upload through the follow-up path. */
  followup?: boolean;
  /** Allowed values for closed lists (enums, must-exist refs). */
  options?: string[];
}

export const ACTIVE: ImportStatus[] = ["queued", "parsing", "matching", "preparing", "committing"];
export const GATES: ImportStatus[] = ["mapping_review", "commit_review"];
export const TERMINAL: ImportStatus[] = ["completed", "partially_completed", "failed", "cancelled"];

export const STATUS_LABEL: Record<ImportStatus, string> = {
  queued: "Queued",
  parsing: "Reading file",
  matching: "Matching columns",
  mapping_review: "Review mapping",
  preparing: "Checking rows",
  commit_review: "Review import",
  committing: "Importing",
  completed: "Completed",
  partially_completed: "Partly completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const ACRONYMS = new Set(["sku", "upc", "id", "msrp"]);

export function humanize(name: string): string {
  const s = name.replace(/^__\w+:/, "").split(/[_\s]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fieldLabel(fields: TargetField[], name: string): string {
  return fields.find((f) => f.name === name)?.label ?? humanize(name);
}

/** Target fields from the view when the server sends them, otherwise the ones the plan mentions. */
export function targetFields(view: ImportView): TargetField[] {
  const sent = (view as ImportView & { targetFields?: TargetField[] }).targetFields;
  if (sent?.length) return sent;
  const names = new Set<string>();
  const plan = view.plan;
  for (const m of plan?.fields ?? []) names.add(m.target);
  for (const d of plan?.defaultsApplied ?? []) names.add(d.target);
  for (const q of plan?.questions ?? []) {
    if (q.kind === "map_column") for (const o of q.options ?? []) if (o.id !== "ignore") names.add(o.id);
  }
  return [...names].map((name) => ({ name, label: humanize(name) })).sort((a, b) => a.label.localeCompare(b.label));
}

export function fmtValue(v: Json | undefined): string {
  if (v === null || v === undefined || v === "") return "blank";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function fmtNum(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

export function confidenceTone(score: number): "high" | "mid" | "low" {
  return score >= 0.9 ? "high" : score >= 0.7 ? "mid" : "low";
}

/** Runs a mutation, refreshes the view, and turns a 409 into a reload notice. */
export function useAction(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNotice("Plan changed, reloaded");
      else setError((e as Error).message);
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }, [refresh]);
  return { busy, notice, error, run };
}
