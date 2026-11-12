import type { Json, RowIssue, Transform, ValueMapEntry } from "./types.ts";
import { parsePotency, parseQuantity, toUnit, type Quantity } from "./units.ts";
import { isBlank } from "./normalize.ts";

export interface TransformCtx {
  valueMaps: Record<string, Record<string, ValueMapEntry>>;
  currency: string;
  field: string;
}

export type TResult = { value: Json; issues: RowIssue[] };

const CURRENCY_SYMBOLS: [string, string][] = [
  ["US$", "USD"], ["CA$", "CAD"], ["C$", "CAD"], ["A$", "AUD"], ["$", "USD"], ["€", "EUR"], ["£", "GBP"],
];

/** "$1,234.50", "1.234,50", "€12", "12 USD" -> { amount, currency? } */
export function parseMoney(s: string): { amount: number; currency?: string } | null {
  let t = s.trim();
  let currency: string | undefined;
  const iso = /\b([A-Z]{3})\b/.exec(t);
  if (iso) { currency = iso[1]; t = t.replace(iso[0], ""); }
  for (const [sym, code] of CURRENCY_SYMBOLS) {
    if (t.includes(sym)) { currency ??= code; t = t.replace(sym, ""); break; }
  }
  const n = parseNumber(t);
  return n === null ? null : { amount: n, currency };
}

/** Locale-aware number parsing. The last separator followed by 1-2 digits (or a lone comma) is the decimal. */
export function parseNumber(s: string, locale: "auto" | "en" | "eu" = "auto"): number | null {
  let t = s.trim().replace(/\s/g, "");
  if (!t) return null;
  // A sign is a leading +/-, accounting parentheses or a trailing minus. Any other "-" ("10-20", a date) is not a number.
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^[+-]/.test(t)) { if (t[0] === "-") neg = !neg; t = t.slice(1); }
  else if (t.endsWith("-")) { neg = !neg; t = t.slice(0, -1); }
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(t)) {
    const sci = Number(t);
    return Number.isFinite(sci) ? sci * (neg ? -1 : 1) : null;
  }
  if (!/^[\d.,]+$/.test(t)) return null;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let decimal: "." | "," | null = null;
  if (locale === "en") decimal = ".";
  else if (locale === "eu") decimal = ",";
  else if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? "." : ",";
  else if (lastComma >= 0) decimal = /,\d{3}$/.test(t) && (t.match(/,/g)!.length > 1 || !/^0,/.test(t)) ? null : ",";
  else if (lastDot >= 0) decimal = /\.\d{3}$/.test(t) && t.match(/\./g)!.length > 1 ? null : ".";
  let clean = t;
  if (decimal === ",") clean = t.replace(/\./g, "").replace(",", ".");
  else if (decimal === ".") clean = t.replace(/,/g, "");
  else clean = t.replace(/[.,]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? n * (neg ? -1 : 1) : null;
}

const TRUE = new Set(["yes", "y", "true", "t", "1", "active", "enabled", "on", "x", "✓", "featured"]);
const FALSE = new Set(["no", "n", "false", "f", "0", "inactive", "disabled", "off", "discontinued", "archived"]);

export function parseBool(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (TRUE.has(t)) return true;
  if (FALSE.has(t)) return false;
  return null;
}

export function fixScientific(s: string): string | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?e\+?\d+$/i.test(t)) return null;
  return BigInt(Math.round(Number(t))).toString();
}

const MAX_REGEX_INPUT = 2000;
const regexCache = new Map<string, RegExp | null>();

/**
 * Compile an agent- or model-supplied pattern. Returns null for an invalid pattern, an over-long one, or one
 * with a quantified group that itself contains a quantifier ("(a+)+"), which can backtrack for seconds on one cell.
 */
export function safeRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  let re: RegExp | null = null;
  if (pattern.length <= 200 && !/\([^()]*[+*][^()]*\)[+*{]/.test(pattern)) {
    try { re = new RegExp(pattern); } catch { re = null; }
  }
  regexCache.set(pattern, re);
  return re;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/**
 * Date to YYYY-MM-DD without going through the process time zone. Numeric dates are month-first unless
 * `fmt` starts with "d" (e.g. "dd/mm/yyyy"). Bare numbers (Excel serials, "12") are rejected, not guessed.
 */
export function parseDate(s: string, fmt?: string): string | null {
  const t = s.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(t);
  if (iso) return ymd(+iso[1], +iso[2], +iso[3]);
  const num = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(t);
  if (num) {
    const year = num[3].length === 2 ? 2000 + +num[3] : +num[3];
    const dayFirst = /^d/i.test(fmt ?? "");
    return dayFirst ? ymd(year, +num[2], +num[1]) : ymd(year, +num[1], +num[2]);
  }
  if (!/[a-z]/i.test(t)) return null;
  const d = new Date(t); // "Jan 5, 2024": parsed as local time, so read local parts back
  return Number.isNaN(d.getTime()) ? null : ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function valueKey(v: string): string {
  return String(v).trim().toLowerCase();
}

function quantityPart(q: Quantity | null, part: "value" | "unit" | "serving", assumeUnit?: string): Json {
  if (!q) return null;
  if (q.kind === "explicit") {
    if (part === "value") return q.value;
    if (part === "unit") return q.unit;
    return q.serving?.value ?? null;
  }
  if (q.kind === "bare" && assumeUnit) return part === "value" ? q.value : part === "unit" ? assumeUnit : null;
  return null;
}

/**
 * Run a transform chain over the source cells. Never throws: a failure becomes a row issue and a null value.
 * Slang is resolved only through the confirmed value map `__slang:<field>`.
 */
export function runTransforms(sources: string[], transforms: Transform[], ctx: TransformCtx): TResult {
  const issues: RowIssue[] = [];
  const issue = (code: string, message: string, severity: RowIssue["severity"] = "error") =>
    issues.push({ field: ctx.field, code, message, severity });
  let v: Json = sources[0] ?? "";
  if (!transforms.some((t) => t.op === "concat") && sources.length > 1) v = sources.find((s) => !isBlank(s)) ?? "";

  for (const t of transforms) {
    // A null value skips the rest of the chain, except `default`, which exists to fill it.
    if (v === null) { if (t.op === "default") v = t.value; continue; }
    const s: string = typeof v === "string" ? v : String(v);
    switch (t.op) {
      case "trim": v = s.trim(); break;
      case "case": v = t.mode === "upper" ? s.toUpperCase() : t.mode === "lower" ? s.toLowerCase()
        : s.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_, pre: string, c: string) => pre + c.toUpperCase()); break;
      case "strip_chars": v = s.split("").filter((c) => !t.chars.includes(c)).join(""); break;
      case "regex_extract": {
        const re = safeRegex(t.pattern);
        if (!re) { issue("bad_pattern", "This column's extract pattern is not valid"); v = null; break; }
        const m = re.exec(s.slice(0, MAX_REGEX_INPUT));
        v = m ? m[t.group ?? 1] ?? m[0] : null;
        break;
      }
      case "split": v = t.index === undefined ? s.split(t.sep).map((x) => x.trim()).filter(Boolean) : s.split(t.sep)[t.index]?.trim() ?? null; break;
      case "concat": v = sources.filter((x) => !isBlank(x)).join(t.sep ?? " "); break;
      case "parse_number": {
        if (isBlank(s)) { v = null; break; }
        const n = parseNumber(s, t.locale);
        if (n === null) issue("not_a_number", `"${s}" is not a number`);
        v = n;
        break;
      }
      case "parse_money": {
        if (isBlank(s)) { v = null; break; }
        const m = parseMoney(s);
        if (!m) { issue("not_money", `"${s}" is not a price`); v = null; break; }
        if (m.currency && m.currency !== ctx.currency) {
          issue("currency", `Price in ${m.currency}; Distru prices are ${ctx.currency}. Not converted.`);
          v = null;
          break;
        }
        v = m.amount;
        break;
      }
      case "parse_percent": {
        if (isBlank(s)) { v = null; break; }
        const p = parsePotency(s);
        if (!p) { issue("not_a_percent", `"${s}" is not a percentage`); v = null; break; }
        v = t.mode === "0_1" && p.unit !== "PERCENT" ? Math.round(p.value * 100 * 1e6) / 1e6 : p.value;
        break;
      }
      case "fix_scientific_notation": {
        const fixed = fixScientific(s);
        if (fixed) { issue("sci_notation", `"${s}" was in scientific notation; digits may be lost`, "warning"); v = fixed; }
        break;
      }
      case "parse_quantity": {
        if (isBlank(s)) { v = null; break; }
        const slangMap = ctx.valueMaps[`__slang:${t.slangField ?? ctx.field}`];
        if (slangMap && valueKey(s) in slangMap && slangMap[valueKey(s)] === null) { v = null; break; } // user chose "leave blank"
        const slang = slangMap?.[valueKey(s)];
        const q = typeof slang === "string" ? parseQuantity(slang) : parseQuantity(s);
        if (!q) { if (t.part === "value") issue("not_a_size", `"${s}" is not a size`); v = null; break; }
        if (q.kind === "slang") { if (t.part === "value") issue("unconfirmed_slang", `"${s}" was not confirmed`); v = null; break; }
        if (q.kind === "count") { if (t.part === "value") issue("no_size", `"${s}" has a count but no size; add the size`, "warning"); v = null; break; }
        if (q.kind === "bare" && !t.assumeUnit) { if (t.part === "value") issue("no_unit", `"${s}" has no unit`); v = null; break; }
        v = quantityPart(q, t.part, t.assumeUnit);
        break;
      }
      case "extract_quantity_from_name": {
        const slang = ctx.valueMaps[`__slang:${t.slangField ?? ctx.field}`];
        let q = parseQuantity(s, { inName: true });
        if (q?.kind === "slang") {
          const confirmed = slang?.[q.slang];
          q = typeof confirmed === "string" ? parseQuantity(confirmed) : null;
        }
        // mg in a product name is almost always potency, not net weight.
        if (q?.kind === "explicit" && q.unit === "mg") q = null;
        v = quantityPart(q, t.part);
        break;
      }
      case "parse_potency": {
        if (isBlank(s)) { v = null; break; }
        const p = parsePotency(s);
        if (!p) { if (t.part === "value") issue("not_potency", `"${s}" is not a potency`); v = null; break; }
        v = t.part === "value" ? p.value : p.unit ?? t.assumeUnit ?? null;
        break;
      }
      case "parse_bool": {
        if (isBlank(s)) { v = null; break; }
        const b = parseBool(s);
        if (b === null) { issue("not_bool", `"${s}" is not yes/no`); v = null; break; }
        v = t.invert ? !b : b;
        break;
      }
      case "parse_date": {
        if (isBlank(s)) { v = null; break; }
        const d = parseDate(s, t.fmt);
        if (!d) { issue("not_date", `"${s}" is not a date`); v = null; break; }
        v = d;
        break;
      }
      case "map_values": {
        const map = ctx.valueMaps[t.key] ?? {};
        const mapOne = (x: string): Json | undefined => {
          if (isBlank(x)) return null;
          const hit = map[valueKey(x)];
          if (hit === undefined) { issue("unmapped_value", `"${x}" isn't an allowed value here`); return undefined; }
          if (hit === null) { issue("unknown_value", `"${x}" isn't in Distru; left blank`, "warning"); return null; }
          return typeof hit === "string" ? hit : hit.create;
        };
        if (Array.isArray(v)) v = v.map((x) => mapOne(String(x))).filter((x): x is Json => x !== undefined && x !== null);
        else v = mapOne(s) ?? null;
        break;
      }
      case "default": if (isBlank(s)) v = t.value; break;
    }
  }
  if (typeof v === "string" && v.trim() === "") v = null;
  return { value: v, issues };
}

export { toUnit };
