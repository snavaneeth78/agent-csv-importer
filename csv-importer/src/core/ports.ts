import type { ImporterConfig } from "./config.ts";
import type { ColumnProfile } from "./profile.ts";
import type { CallOpts, ModelUsage } from "./usage.ts";
import type {
  Ctx, DupClass, FieldDef, ImportEvent, ImportEventType, ImportStatus, Json, MappingPlan, Method,
  RowAction, RowIssue, RowMeta, RowStatus, TargetSchema, Transform, ValueMapEntry,
} from "./types.ts";

// ---------- persistence (implemented by @distru/csv-importer/pg) ----------

export interface ImportSource {
  filename: string;
  size?: number;
  sha256?: string;
  url?: string;
}

export interface ImportStats {
  kind?: string;
  encoding?: string;
  sheets?: string[];
  totalRows?: number;
  skippedRows?: number;
  columns?: ColumnProfile[];
  resolvedByStage?: Partial<Record<Method | "none", number>>;
  matchMs?: number;
  /** Wall-clock ms per step (parse, snapshot, refs, profile, cascade, plan). */
  timings?: Record<string, number>;
  /** Stages switched off for this run (e.g. ["llm"]). */
  disabledStages?: string[];
  /** Model spend per step: "jev:columns", "llm:columns", "jev:values", "llm:values", "llm:edits". */
  usage?: Record<string, ModelUsage>;
  /** One entry per cascade stage that ran: what it resolved and how long it took. */
  matchStages?: {
    method: string; model?: string; ms: number; resolved: string[]; ignored: string[]; seen: number;
    error?: string;
    usage?: ModelUsage;
    /** Columns mapped as suggestions to confirm (Jev mid band). */
    suggested?: string[];
    /** Best answer per column that didn't clear the stage threshold. */
    nearMisses?: { source: string; target: string | null; score: number }[];
  }[];
  confirmingMessageIds?: string[];
  /** The last plan version written by the model merge, and the version it was built on. */
  modelMerge?: { from: number; to: number };
}

export interface ImportRecord {
  id: string;
  tenantId: string;
  createdBy: string;
  threadId: string | null;
  source: ImportSource;
  targetId: string;
  targetVersion: number;
  status: ImportStatus;
  plan: MappingPlan | null;
  planVersion: number;
  stats: ImportStats;
  /** `openImportId`: for duplicate_open_import, the open import that already holds this file. */
  error: { code: string; message: string; openImportId?: string } | null;
  refs: Record<string, string[]> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RowRecord {
  rowIndex: number;
  raw: Record<string, string>;
  output: Record<string, Json> | null;
  overrides: Record<string, Json> | null;
  issues: RowIssue[];
  sku: string | null;
  distruId: string | null;
  dupClass: DupClass | null;
  action: RowAction | null;
  status: RowStatus;
  followup: boolean;
  meta: RowMeta;
}

export type RowPatch = { rowIndex: number } & Partial<Omit<RowRecord, "rowIndex" | "raw">>;

export interface ChunkRecord {
  stage: "prepare" | "commit";
  chunkIndex: number;
  planVersion: number;
  status: "pending" | "running" | "done";
  attempts: number;
  response: Json;
}

export interface MemoryEntry {
  headerNorm: string;
  targetField: string;
  transforms: Transform[];
  typeSig: string;
  hits: number;
}

export interface CatalogProduct {
  distruId: string;
  sku: string | null;
  upc: string | null;
  name: string;
  values: Record<string, Json>;
  updatedAt: string;
}

export interface Repos {
  insertImport(rec: Omit<ImportRecord, "id" | "createdAt" | "updatedAt" | "tenantId">): Promise<ImportRecord>;
  getImport(id: string, opts?: { forUpdate?: boolean }): Promise<ImportRecord | null>;
  findOpenImportBySha(targetId: string, sha256: string): Promise<ImportRecord | null>;
  updateImport(id: string, patch: Partial<Pick<ImportRecord, "status" | "plan" | "planVersion" | "stats" | "error" | "refs" | "source">>): Promise<void>;
  listOpenImports(threadId?: string): Promise<ImportRecord[]>;

  appendEvent(importId: string, type: ImportEventType, actor: ImportEvent["actor"], payload: Record<string, Json>): Promise<number>;
  listEvents(importId: string, afterId: number, limit: number): Promise<ImportEvent[]>;

  insertRows(importId: string, rows: { rowIndex: number; raw: Record<string, string>; meta: RowMeta }[]): Promise<void>;
  deleteRows(importId: string): Promise<void>;
  sampleRaw(importId: string, limit: number): Promise<Record<string, string>[]>;
  distinctRaw(importId: string, column: string, limit: number): Promise<string[]>;
  rowsInRange(importId: string, fromIndex: number, toIndex: number): Promise<RowRecord[]>;
  getRows(importId: string, rowIndexes: number[]): Promise<RowRecord[]>;
  listRows(importId: string, q: { status?: RowStatus[]; action?: RowAction[]; dupClass?: DupClass[]; followup?: boolean; afterRowIndex?: number; limit: number }): Promise<RowRecord[]>;
  updateRows(importId: string, rows: RowPatch[]): Promise<void>;
  rowKeys(importId: string): Promise<{ rowIndex: number; sku: string | null; distruId: string | null; status: RowStatus }[]>;
  counts(importId: string): Promise<{ status: RowStatus; action: RowAction | null; dupClass: DupClass | null; followup: boolean; n: number }[]>;
  historyForSkus(importId: string, skus: string[]): Promise<Map<string, { importId: string; date: string }>>;
  /** Issue counts by code and field (no row data), for chat and summaries. */
  issueCounts(importId: string): Promise<{ code: string; field: string | null; severity: string; n: number; example: string; firstRow: number }[]>;

  getChunk(importId: string, stage: ChunkRecord["stage"], chunkIndex: number): Promise<ChunkRecord | null>;
  upsertChunk(importId: string, c: ChunkRecord): Promise<void>;
  listChunks(importId: string, stage: ChunkRecord["stage"]): Promise<ChunkRecord[]>;
  deleteChunks(importId: string, stage?: ChunkRecord["stage"]): Promise<void>;

  getMemory(targetId: string, headerNorms: string[]): Promise<MemoryEntry[]>;
  putMemory(targetId: string, entries: Omit<MemoryEntry, "hits">[]): Promise<void>;

  getSnapshotState(): Promise<{ status: "loading" | "ready"; cursor: string | null; refreshedAt: string | null } | null>;
  setSnapshotState(s: { status: "loading" | "ready"; cursor: string | null; refreshedAt?: string | null }): Promise<void>;
  upsertSnapshot(products: CatalogProduct[]): Promise<void>;
  clearSnapshot(): Promise<void>;
  snapshotLookup(q: { ids?: string[]; skus?: string[]; names?: string[] }): Promise<CatalogProduct[]>;
  snapshotDistinct(field: string): Promise<string[]>;

  putFile(importId: string, bytes: Uint8Array): Promise<void>;
  getFile(importId: string): Promise<Uint8Array | null>;
  deleteFile(importId: string): Promise<void>;
}

export interface Store {
  /** withTenant: one transaction with `SET LOCAL app.tenant_id` (RLS). */
  tx<T>(tenantId: string, fn: (r: Repos) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  /** System-role reads across tenants: ids only. */
  eventsAfter(afterId: number, limit: number): Promise<{ id: number; type: string; importId: string; tenantId: string; threadId: string | null; status: string }[]>;
}

export interface Queue {
  send(queue: string, data: Record<string, Json>, opts?: { singletonKey?: string; startAfterSeconds?: number }): Promise<void>;
}

// ---------- profile ports (Distru implements these) ----------

export interface SinkResult {
  /** Index into the uploaded rows. */
  errors: { index: number; message: string }[];
}

export interface Sink {
  upload(ctx: Ctx, args: { importId: string; mode: "create" | "update"; headers: string[]; rows: Record<string, string>[] }): Promise<SinkResult>;
}

export interface CatalogSource {
  page(ctx: Ctx, args: { cursor: string | null; limit: number; sort: "default" | "updated_desc" }): Promise<{ items: CatalogProduct[]; nextCursor: string | null }>;
}

export interface RefResolver {
  /** Allowed values per ref field. Fetched once per import. */
  resolve(ctx: Ctx, fields: FieldDef[], helpers: { snapshotDistinct(field: string): Promise<string[]> }): Promise<Record<string, string[]>>;
}

export class FollowupError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface FollowupClient {
  /** One product update (MCP distru-mutate-product, action UPDATE). Throws FollowupError. */
  update(ctx: Ctx, args: { distruId: string; values: Record<string, Json> }): Promise<void>;
}

export interface TargetProfile {
  target: TargetSchema;
  currency: string;
  sink: Sink;
  catalog: CatalogSource;
  refResolver: RefResolver;
  followup: FollowupClient;
  /** Alias tables used before fuzzy value matching, e.g. parser unit g -> UNIT_TYPE Gram. */
  valueAliases?: Record<string, Record<string, string>>;
  hooks?: {
    /** Add profile-specific defaults/derived mappings to a fresh plan. */
    afterMatch?(plan: MappingPlan, columns: ColumnProfile[]): void;
    /** Fill per-row derived values (product type, unit type default). */
    deriveRow?(output: Record<string, Json>, plan: MappingPlan): void;
  };
}

// ---------- scorers (implemented in @distru/csv-importer/scorers) ----------

export interface Candidate {
  source: string;
  target: string | null;
  score: number;
  rationale: string;
  transforms?: Transform[];
  /** Below the stage threshold but worth proposing: mapped as a suggestion the user confirms at Gate 1. */
  suggest?: boolean;
}

export interface StageInput {
  ctx: Ctx;
  target: TargetSchema;
  columns: ColumnProfile[];
  fields: FieldDef[];
  allColumns: ColumnProfile[];
  memory: MemoryEntry[];
  config: ImporterConfig;
}

export interface MatchStage {
  method: Method;
  /** Model behind the stage (Jev/LLM), "stub" for deterministic stand-ins. */
  model?: string;
  threshold: number;
  /**
   * Runs at the same time as the neighbouring concurrent stages, on the same columns; answers are then applied in
   * stage order, so an earlier stage still wins. The wait is the slowest call instead of the sum.
   */
  concurrent?: boolean;
  /** `error` means the stage couldn't run (model call failed); its columns fall through to the next stage. */
  run(input: StageInput): Promise<{ candidates: Candidate[]; final?: boolean; error?: string; usage?: ModelUsage }>;
}

export interface ValueStageInput {
  field: FieldDef;
  values: string[];
  allowed: string[];
  aliases: Record<string, string>;
}

export interface ValueStage {
  method: Method;
  run(input: ValueStageInput, opts?: CallOpts): Promise<{ value: string; match: string; score: number }[]>;
}

/** Jev: a bounded choice with a probability per option. */
export interface ChoiceScorer {
  /** e.g. "jev-latest", or "stub" for the deterministic stand-in. */
  readonly modelId?: string;
  choose(items: { id: string; state: Json; options: { id: string; label: string; hint?: string }[] }[], opts?: CallOpts): Promise<Record<string, Record<string, number>>>;
}

export interface PlanPatch {
  answers?: Record<string, string>;
  fields?: { target: string; sources: string[]; transforms?: Transform[] }[];
  ignore?: string[];
  valueMaps?: Record<string, Record<string, ValueMapEntry>>;
  defaults?: Record<string, Json>;
  assumeUnit?: Record<string, string>;
  sheet?: string;
  headerRow?: number;
  clearBlanks?: boolean;
  existingAction?: "skip" | "update";
  /** Fetch these fields' Distru lists again (e.g. after adding vendors in Distru) and re-match their values. */
  recheck?: string[];
}

export interface LlmMatcher {
  readonly modelId?: string;
  mapColumns(input: {
    /** `likely`: a short list of free fields whose names or value types fit the column best. A hint, not a limit. */
    columns: { source: string; samples: string[]; typeSig: string; likely?: string[] }[];
    /** Every field of the target in a fixed order. The same for every call, so the provider can cache it. */
    fields: { name: string; label: string; type: string; synonyms: string[] }[];
    /** Fields other columns already use; an answer naming one is dropped. */
    taken?: string[];
  }, opts?: CallOpts): Promise<{ source: string; target: string | null; confidence: number; rationale?: string }[]>;
  mapValues(input: { field: string; values: string[]; allowed: string[] }, opts?: CallOpts): Promise<Record<string, string | null>>;
  planPatch(input: { instruction: string; headers: string[]; fields: { name: string; label: string }[]; plan: Json }, opts?: CallOpts): Promise<PlanPatch>;
}
