import type { ImportStatus } from "./types.ts";

const T: Record<ImportStatus, ImportStatus[]> = {
  queued: ["parsing", "cancelled", "failed"],
  parsing: ["matching", "failed"],
  matching: ["mapping_review", "failed"],
  mapping_review: ["mapping_review", "preparing", "cancelled", "parsing"],
  preparing: ["commit_review", "failed"],
  commit_review: ["commit_review", "mapping_review", "committing", "cancelled"],
  committing: ["completed", "partially_completed", "failed"],
  completed: ["committing"],
  partially_completed: ["committing"],
  failed: [],
  cancelled: [],
};

export class ConflictError extends Error {
  code = "conflict";
}

export class StateError extends Error {
  code = "invalid_state";
}

export function assertTransition(from: ImportStatus, to: ImportStatus) {
  if (!T[from].includes(to)) throw new StateError(`Can't move import from ${from} to ${to}`);
}

export interface Chunk {
  index: number;
  from: number;
  to: number;
}

/** Chunks of `size` rows over 1-based row indexes. Up to `size` rows run as one chunk. */
export function chunkRanges(totalRows: number, size: number): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0, from = 1; from <= totalRows; i++, from += size) out.push({ index: i, from, to: Math.min(from + size - 1, totalRows) });
  return out;
}

/** Follow-up time estimate shown at Gate 2. */
export function followupMinutes(rows: number, ratePerSecond: number): number {
  return Math.ceil(rows / ratePerSecond / 60);
}
