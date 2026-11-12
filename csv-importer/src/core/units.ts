/**
 * Deterministic cannabis unit & quantity parser (tech spec §4.2).
 * Rule 1: explicit units are kept exactly as written. Never converts between units.
 * Rule 2: slang with no unit is only *proposed*; the caller must confirm it at Gate 1.
 */
export type Unit = "g" | "mg" | "oz" | "lb" | "ml";

export type Quantity =
  | { kind: "explicit"; value: number; unit: Unit; serving?: { value: number; unit: Unit }; count?: number }
  | { kind: "slang"; slang: string; proposed: { value: number; unit: Unit } }
  | { kind: "count"; count: number }
  | { kind: "bare"; value: number };

export const SLANG: Record<string, number> = {
  eighth: 3.5, "8th": 3.5, "1/8": 3.5,
  quarter: 7, qtr: 7, "1/4": 7,
  half: 14, "1/2": 14,
  zip: 28,
  qp: 112, hp: 224, p: 448,
};

const UNIT_WORDS: [RegExp, Unit][] = [
  [/^(mg|milligrams?)$/i, "mg"],
  [/^(g|gr|gm|grams?)$/i, "g"],
  [/^(oz|ounces?)$/i, "oz"],
  [/^(lbs?|pounds?)$/i, "lb"],
  [/^(ml|milliliters?|millilitres?)$/i, "ml"],
];

const UNIT = "(milligrams?|mg|grams?|gram|gm|gr|g|ounces?|oz|pounds?|lbs?|millilit(?:er|re)s?|ml)";
const NUM = "(\\d+\\s*/\\s*\\d+|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?|\\.\\d+|half|quarter|eighth)";
const END = "(?![a-z])";

const RE_PACK_PRE = new RegExp(`(\\d+)\\s*(?:x|×|pk|-?pack|ct|count)\\s*(?:of\\s*)?${NUM}\\s*${UNIT}${END}`, "i");
const RE_PACK_POST = new RegExp(`${NUM}\\s*${UNIT}\\s*(?:x|×)\\s*(\\d+)${END}`, "i");
// Not mid-number: "1.234,5 g" must not read as 234.5 g.
const RE_EXPLICIT = new RegExp(`(?<![\\d.,/])${NUM}\\s*${UNIT}${END}`, "i");
const RE_COUNT = /\(?\b(\d+)\s*(?:pk|-?pack|ct|count)\b\)?/i;
const RE_BARE = /^\s*(\d+(?:[.,]\d+)?|\.\d+)\s*$/;

export function toUnit(word: string): Unit | undefined {
  for (const [re, u] of UNIT_WORDS) if (re.test(word.trim())) return u;
  return undefined;
}

export function parseNum(s: string): number {
  const t = s.trim().toLowerCase();
  if (t === "half") return 0.5;
  if (t === "quarter") return 0.25;
  if (t === "eighth") return 0.125;
  if (t.includes("/")) {
    const [a, b] = t.split("/").map((x) => Number(x.trim()));
    return a / b;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return Number(t.replace(",", "."));
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Parse a whole cell. `allowBareSlangP` keeps the one-letter "p" from matching inside names. */
export function parseQuantity(input: string, opts: { inName?: boolean } = {}): Quantity | null {
  const s = String(input ?? "").trim();
  if (!s) return null;

  let m = RE_PACK_PRE.exec(s);
  if (m) {
    const count = Number(m[1]);
    const size = parseNum(m[2]);
    const unit = toUnit(m[3])!;
    return { kind: "explicit", value: round(count * size), unit, serving: { value: size, unit }, count };
  }
  m = RE_PACK_POST.exec(s);
  if (m) {
    const size = parseNum(m[1]);
    const unit = toUnit(m[2])!;
    const count = Number(m[3]);
    return { kind: "explicit", value: round(count * size), unit, serving: { value: size, unit }, count };
  }
  m = RE_EXPLICIT.exec(s);
  if (m) return { kind: "explicit", value: round(parseNum(m[1])), unit: toUnit(m[2])! };

  const slang = findSlang(s, opts.inName ?? false);
  if (slang) return { kind: "slang", slang, proposed: { value: SLANG[slang], unit: "g" } };

  m = RE_COUNT.exec(s);
  if (m) return { kind: "count", count: Number(m[1]) };

  if (!opts.inName) {
    m = RE_BARE.exec(s);
    if (m) return { kind: "bare", value: round(parseNum(m[1])) };
  }
  return null;
}

/** Words a size cell may carry next to the size ("100 mg THC", ".5ml cart", "5pk 0.5g", "Eighth (3.5g)"). */
const SIZE_QUALIFIERS = new Set([
  "thc", "cbd", "total", "cart", "cartridge", "each", "ea", "net", "wt", "weight", "approx", "pack", "pk", "ct", "count", "of", "per", "unit", "x",
  ...Object.keys(SLANG),
]);

/**
 * True when the cell is only a size: nothing but the size and qualifier words is left once the size is removed.
 * "Blue Dream 3.5g" has a size in it, but it is a name, so a column of those is not a quantity column.
 */
export function isSizeCell(input: string): boolean {
  const s = String(input ?? "").trim();
  const m = RE_PACK_PRE.exec(s) ?? RE_PACK_POST.exec(s) ?? RE_EXPLICIT.exec(s);
  if (!m) return false;
  const rest = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).toLowerCase();
  return rest.split(/[^a-z0-9]+/).filter(Boolean).every((w) => SIZE_QUALIFIERS.has(w) || /^\d+(pk|ct)?$/.test(w));
}

function findSlang(s: string, inName: boolean): string | undefined {
  const lower = s.toLowerCase().trim();
  if (!inName) {
    const key = lower === "8th" ? "8th" : lower.replace(/\s+/g, "");
    if (key in SLANG) return key;
    return undefined;
  }
  // In names: only unambiguous words, never "p" or bare fractions.
  const m = /\b(eighth|8th|quarter|qtr|zip|qp|hp)\b/.exec(lower);
  return m?.[1];
}

/** Potency cell: "22.5%", "100mg", "100 mg THC", "22.5". */
export function parsePotency(input: string): { value: number; unit?: "PERCENT" | "MG" } | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  let m = /^(\d+(?:[.,]\d+)?|\.\d+)\s*%/.exec(s);
  if (m) return { value: parseNum(m[1]), unit: "PERCENT" };
  m = /^(\d+(?:[.,]\d+)?|\.\d+)\s*mg\b/i.exec(s);
  if (m) return { value: parseNum(m[1]), unit: "MG" };
  m = /^(\d+(?:[.,]\d+)?|\.\d+)(\s*(thc|cbd|total))?\s*$/i.exec(s);
  if (m) return { value: parseNum(m[1]) };
  return null;
}
