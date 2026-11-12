import { headerUnitHint, isBlank, normalizeHeader } from "./normalize.ts";
import { isSizeCell, parsePotency, parseQuantity } from "./units.ts";
import { fixScientific, parseBool, parseMoney, parseNumber } from "./transforms.ts";

export type TypeSig = "empty" | "upc" | "quantity" | "percent" | "money" | "currency" | "bool" | "integer" | "number" | "text";

export interface ColumnProfile {
  source: string;
  index: number;
  headerNorm: string;
  unitHint?: string;
  samples: string[];
  nonBlank: number;
  distinct: number;
  typeSig: TypeSig;
  signals: Record<"upc" | "quantity" | "slang" | "bare" | "percent" | "mg" | "money" | "currencySymbol" | "currency" | "bool" | "integer" | "number", number>;
  maxNumber?: number;
}

const ISO = /^[A-Z]{3}$/;

export function profileColumns(headers: string[], rows: Record<string, string>[]): ColumnProfile[] {
  return headers.map((h, index) => {
    const vals = rows.map((r) => r[h]).filter((v) => !isBlank(v)).map((v) => String(v).trim());
    const n = vals.length || 1;
    const ratio = (pred: (v: string) => boolean) => vals.filter(pred).length / n;
    const nums = vals.map((v) => parseNumber(v)).filter((x): x is number => x !== null);
    // A size inside longer text ("Blue Dream 3.5g") is a name, not a size cell; it only counts as text.
    const q = vals.map((v) => { const x = parseQuantity(v); return x?.kind === "explicit" && !isSizeCell(v) ? null : x; });
    const signals = {
      upc: ratio((v) => /^\d{8,14}$/.test(v) || (!!fixScientific(v) && fixScientific(v)!.length >= 8)),
      quantity: q.filter((x) => x?.kind === "explicit" && x.unit !== "mg").length / n,
      slang: q.filter((x) => x?.kind === "slang").length / n,
      bare: q.filter((x) => x?.kind === "bare").length / n,
      percent: ratio((v) => /%\s*$|%\s*(thc|cbd)/i.test(v)),
      mg: q.filter((x) => x?.kind === "explicit" && x.unit === "mg").length / n,
      money: ratio((v) => parseMoney(v) !== null),
      currencySymbol: ratio((v) => /[$€£]/.test(v)),
      currency: ratio((v) => ISO.test(v)),
      bool: ratio((v) => parseBool(v) !== null),
      integer: ratio((v) => /^-?\d+$/.test(v)),
      number: nums.length / n,
    };
    return {
      source: h,
      index,
      headerNorm: normalizeHeader(h),
      unitHint: headerUnitHint(h),
      samples: [...new Set(vals)].slice(0, 8),
      nonBlank: vals.length,
      distinct: new Set(vals.map((v) => v.toLowerCase())).size,
      typeSig: sigOf(vals.length, signals),
      signals,
      maxNumber: nums.length ? Math.max(...nums) : undefined,
    };
  });
}

function sigOf(count: number, s: ColumnProfile["signals"]): TypeSig {
  const T = 0.95;
  if (count === 0) return "empty";
  if (s.upc >= T) return "upc";
  if (s.quantity + s.slang >= T && s.quantity > 0) return "quantity";
  if (s.percent >= T) return "percent";
  if (s.currencySymbol >= T && s.money >= T) return "money";
  if (s.currency >= T) return "currency";
  if (s.bool >= T && s.integer < T) return "bool";
  if (s.integer >= T) return "integer";
  if (s.number >= T) return "number";
  return "text";
}

const NUMERIC: TypeSig[] = ["integer", "number", "money"];

/** Column-memory type check: a remembered column must still hold the same kind of values. */
export function sigCompatible(stored: string, current: TypeSig): boolean {
  if (current === "empty" || stored === current) return true;
  if (NUMERIC.includes(stored as TypeSig) && NUMERIC.includes(current)) return true;
  if ((stored === "quantity" && current === "number") || (stored === "number" && current === "quantity")) return true;
  if (stored === "upc" && (current === "integer" || current === "text")) return true;
  if (stored === "text" && current !== "money" && current !== "number" && current !== "percent") return true;
  return false;
}
