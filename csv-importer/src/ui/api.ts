import type { DupClass, ImportEvent, ImportStatus, Json, RowAction, RowIssue, RowStatus } from "../core/index.ts";
import type { ImportView, PlanPatch, RowRecord } from "../core/index.ts";

export type { ImportView, RowRecord };

export interface RowQuery {
  status?: RowStatus[];
  dupClass?: DupClass[];
  action?: RowAction[];
  cursor?: number;
  limit?: number;
}

export interface RowEdit {
  rowIndex: number;
  field: string;
  value: Json;
}

export interface ExportData {
  headers: string[];
  rows: Record<string, string>[];
  followups: { id: string; product: Record<string, Json> }[];
}

export interface ImportApi {
  get(id: string): Promise<ImportView>;
  events(id: string, afterId: number): Promise<ImportEvent[]>;
  rows(id: string, q: RowQuery): Promise<{ rows: RowRecord[]; nextCursor: number | null }>;
  revise(id: string, body: { planVersion: number; patch?: PlanPatch; instruction?: string }): Promise<{ planVersion: number; changed: string[]; status: ImportStatus }>;
  confirmMapping(id: string, planVersion: number): Promise<{ status: ImportStatus }>;
  rowActions(id: string, body: { planVersion: number; existingAction?: "skip" | "update"; rowOverrides?: Record<number, RowAction>; clearBlanks?: boolean }): Promise<{ planVersion: number }>;
  editRows(id: string, body: { planVersion: number; edits: RowEdit[] }): Promise<{ planVersion: number; rows: { rowIndex: number; status: RowStatus | null; issues: RowIssue[] }[] }>;
  confirmCommit(id: string, planVersion: number): Promise<{ status: ImportStatus }>;
  cancel(id: string): Promise<{ status: ImportStatus }>;
  /** Start a failed import's file again; returns the new (or reused open) import. */
  retry(id: string): Promise<{ importId: string; status: ImportStatus; reused: boolean }>;
  retryFollowups(id: string): Promise<{ requeued: number }>;
  exportJson(id: string): Promise<ExportData>;
  errorsCsvUrl(id: string): string;
  exportCsvUrl(id: string): string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export function httpImportApi(base = "/api"): ImportApi {
  const url = (id: string, path = "") => `${base}/imports/${encodeURIComponent(id)}${path}`;
  const call = async <T>(input: string, body?: unknown): Promise<T> => {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetch(input, body === undefined ? { signal } : {
      signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: string } | null;
      throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`);
    }
    return res.json() as Promise<T>;
  };
  return {
    get: (id) => call(url(id)),
    events: (id, afterId) => call(url(id, `/events?afterId=${afterId}`)),
    rows: (id, q) => {
      const p = new URLSearchParams();
      if (q.status?.length) p.set("status", q.status.join(","));
      if (q.dupClass?.length) p.set("dupClass", q.dupClass.join(","));
      if (q.action?.length) p.set("action", q.action.join(","));
      if (q.cursor !== undefined) p.set("cursor", String(q.cursor));
      if (q.limit !== undefined) p.set("limit", String(q.limit));
      return call(url(id, `/rows?${p}`));
    },
    revise: (id, body) => call(url(id, "/revise"), body),
    confirmMapping: (id, planVersion) => call(url(id, "/confirm-mapping"), { planVersion }),
    rowActions: (id, body) => call(url(id, "/row-actions"), body),
    editRows: (id, body) => call(url(id, "/edit-rows"), body),
    confirmCommit: (id, planVersion) => call(url(id, "/confirm-commit"), { planVersion }),
    cancel: (id) => call(url(id, "/cancel"), {}),
    retry: (id) => call(url(id, "/retry"), {}),
    retryFollowups: (id) => call(url(id, "/retry-followups"), {}),
    exportJson: (id) => call(url(id, "/export.json")),
    errorsCsvUrl: (id) => url(id, "/errors.csv"),
    exportCsvUrl: (id) => url(id, "/export.csv"),
  };
}
