export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Run context. Always injected by the harness, never model-provided. */
export interface Ctx {
  tenantId: string;
  actor: string;
}

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "money"
  | "bool"
  | "enum"
  | "ref"
  | "ref_list"
  | "currency";

/** Value signal a column must show for stage 3 (pattern) to claim this field. */
export type ValuePattern = "upc" | "quantity" | "potency" | "money" | "bool" | "currency";

export type SkuWarning = "whitespace" | "sci_notation" | "looks_like_barcode";

export interface FieldDef {
  name: string;
  type: FieldType;
  /** Template header. Only fields whose header is in `templateHeaders` are uploaded as columns. */
  header?: string;
  /** H = help article template, M = MCP only, importer = importer-only (§3.2). */
  src: "H" | "M" | "importer";
  required?: boolean;
  default?: Json;
  synonyms: string[];
  /** Source headers that mean the inverse (e.g. "Discontinued" for `active`). */
  invertedSynonyms?: string[];
  max?: number;
  warnIf?: SkuWarning[];
  /** Field is stored inverted in the template (active -> Inactive). */
  invert?: boolean;
  enumValues?: string[];
  ref?: { kind: string; mode: "auto_create" | "must_exist" };
  /** Atomic field group (weight, potency). */
  group?: string;
  pattern?: ValuePattern;
  /** For quantity/potency fields: the field that receives the parsed unit. */
  unitField?: string;
  /** For quantity fields: the field that receives the per-serving size from pack notation. */
  servingField?: string;
  /** For quantity fields: a text field sizes can be copied from when no column exists. */
  extractFrom?: string;
}

export interface TargetSchema {
  id: string;
  version: number;
  uniqueKey: string;
  /** Field holding the external id used for updates (Distru ID). */
  idField?: string;
  nameField: string;
  /** UI grouping for field pickers (order matters). Fields not listed go under "Other". */
  sections?: { title: string; fields: string[] }[];
  /** Fields that can't change after create (never sent on update, never cleared). */
  immutable?: string[];
  templateHeaders: string[];
  /** Template columns recognized but not imported in v1, with the reason shown at Gate 1. */
  ignoredHeaders: { header: string; reason: string }[];
  fields: Record<string, FieldDef>;
}

export type Method = "template" | "memory" | "exact" | "pattern" | "fuzzy" | "jev" | "llm" | "user";

export type Transform =
  | { op: "trim" }
  | { op: "case"; mode: "upper" | "lower" | "title" }
  | { op: "strip_chars"; chars: string }
  | { op: "regex_extract"; pattern: string; group?: number }
  | { op: "split"; sep: string; index?: number }
  | { op: "concat"; sep?: string }
  | { op: "parse_number"; locale?: "auto" | "en" | "eu" }
  | { op: "parse_money" }
  | { op: "parse_percent"; mode: "auto" | "0_1" | "0_100" }
  | { op: "fix_scientific_notation" }
  | { op: "parse_quantity"; part: "value" | "unit" | "serving"; assumeUnit?: string; slangField?: string }
  | { op: "extract_quantity_from_name"; part: "value" | "unit" | "serving"; slangField?: string }
  | { op: "parse_potency"; part: "value" | "unit"; assumeUnit?: "PERCENT" | "MG" }
  | { op: "parse_bool"; invert?: boolean }
  | { op: "parse_date"; fmt?: string }
  | { op: "map_values"; key: string }
  | { op: "default"; value: Json };

export interface FieldMapping {
  target: string;
  sources: string[];
  transforms: Transform[];
  default?: Json;
  score: number;
  method: Method;
  rationale: string;
  /** Mapped from a mid-confidence suggestion; shown as "needs confirm" until the user confirms or changes it. */
  needsConfirm?: boolean;
}

export type QuestionKind =
  | "choose_sheet"
  | "choose_header_row"
  | "not_a_catalog"
  | "map_column"
  | "map_value"
  | "confirm_default"
  | "free_text";

export interface Question {
  id: string;
  kind: QuestionKind;
  prompt: string;
  options?: { id: string; label: string }[];
  suggested?: string;
  answer?: string;
  blocking: boolean;
  /** Machine context for applying the answer. */
  ref?: { field?: string; source?: string; value?: string };
  /** When `suggested` is a model's guess: who guessed and how sure. Below 0.4, "accept all" skips it. */
  guess?: { method: string; score: number };
  /** The file values this question is about, as written in the file (e.g. vendors missing from Distru). */
  values?: string[];
  /** Answered, but still blocks until something outside the plan changes (e.g. "I'll add them in Distru"). */
  waiting?: boolean;
}

/** A model's best answer that didn't clear its stage's bar. target null = "not a product field". */
export interface ModelGuess {
  target: string | null;
  score: number;
  method: string;
}

export type ValueMapEntry = string | { create: string } | null;

export interface MappingPlan {
  sheet?: string;
  headerRow: number;
  headers: string[];
  fields: FieldMapping[];
  ignoredColumns: { source: string; reason: string; guess?: ModelGuess }[];
  valueMaps: Record<string, Record<string, ValueMapEntry>>;
  defaultsApplied: { target: string; value: Json; reason: string }[];
  questions: Question[];
  /** Gate 2 option, off by default. */
  clearBlanks: boolean;
  /** Gate 2: what to do with rows that exist in Distru with changes. */
  existingAction: "skip" | "update";
}

export type ImportStatus =
  | "queued"
  | "parsing"
  | "matching"
  | "mapping_review"
  | "preparing"
  | "commit_review"
  | "committing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

export const TERMINAL: ImportStatus[] = ["completed", "partially_completed", "failed", "cancelled"];

/**
 * Row status. `uploaded` extends the spec list: the product was created inactive and still waits for
 * its follow-up mutation.
 */
export type RowStatus =
  | "pending"
  | "valid"
  | "invalid"
  | "uploaded"
  | "committed"
  | "needs_attention"
  | "failed"
  | "skipped";

export type DupClass = "dup_in_file" | "exists_unchanged" | "exists_changed" | "new" | "no_sku";
export type RowAction = "create" | "update" | "skip";

export interface RowIssue {
  field?: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface FieldDiff {
  field: string;
  from: Json;
  to: Json;
  /** Never sent (tracking method cannot change after create). */
  blocked?: boolean;
}

export interface RowMeta {
  diff?: FieldDiff[];
  /** Mapped fields that are blank in the file but have a value in Distru (cleared when clearBlanks). */
  blankWithValue?: string[];
  history?: { importId: string; date: string };
  possibleDuplicate?: string;
  firstRowIndex?: number;
  ragged?: number;
  /** Gate 2 per-row choice; survives re-validation. */
  userAction?: RowAction;
}

export type ImportEventType =
  | "status_changed"
  | "column_resolved"
  | "question_added"
  | "question_answered"
  | "plan_revised"
  | "chunk_progress"
  | "row_edited"
  | "gate_confirmed"
  | "error";

export interface ImportEvent {
  id: number;
  importId: string;
  type: ImportEventType;
  actor: "agent" | "user" | "system";
  payload: Record<string, Json>;
  createdAt: string;
}

export type ImportInput = { bytes: Uint8Array } | { url: string } | { stream: ReadableStream<Uint8Array> };
