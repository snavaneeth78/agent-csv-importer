import jw from "talisman/metrics/jaro-winkler.js";
import lev from "talisman/metrics/levenshtein.js";
import { normValue, tokens } from "./normalize.ts";

/** Jaro-Winkler similarity (talisman). */
export const jaroWinkler = (a: string, b: string): number => (jw as unknown as (a: string, b: string) => number)(a, b);

export const levenshtein = (a: string, b: string): number => (lev as unknown as (a: string, b: string) => number)(a, b);

/**
 * "Close spelling": Jaro-Winkler >= min AND at most ~15% of characters edited (min 1). Jaro-Winkler alone
 * rewards shared prefixes, so "producer"/"product" (0.92) or "potency"/"potency unit" (0.92) would pass.
 */
export function closeSpelling(a: string, b: string, min: number): number {
  const s = jaroWinkler(a, b);
  const budget = Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.15));
  return s >= min && levenshtein(a, b) <= budget ? s : 0;
}

/** Token-set Dice similarity over normalized header tokens. */
export function tokenSet(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export const valueSimilarity = (a: string, b: string) => jaroWinkler(normValue(a), normValue(b));
