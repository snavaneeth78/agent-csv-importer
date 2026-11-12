/** Header normalization: lowercase, split camel/snake, drop punctuation and parentheticals, singularize. */
export function normalizeHeader(h: string): string {
  return tokens(h).join(" ");
}

export function tokens(h: string): string[] {
  return String(h ?? "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/#/g, " number ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .map((t) => ABBREVIATIONS[t] ?? t);
}

/** Common catalog header abbreviations, expanded so exact matching sees the full word. */
const ABBREVIATIONS: Record<string, string> = {
  prod: "product", nm: "name", desc: "description", cat: "category", subcat: "subcategory", wt: "weight",
  qty: "quantity", px: "price", mfr: "manufacturer", mfg: "manufacturer", pkg: "package",
};

function singular(t: string): string {
  if (t.length <= 3 || /(ss|us|is)$/.test(t)) return t;
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Unit hint written in a header, e.g. "Weight (oz)" -> "oz". */
export function headerUnitHint(h: string): string | undefined {
  const m = /[([]\s*(g|grams?|mg|oz|ounces?|lbs?|ml)\s*[)\]]/i.exec(h);
  if (!m) return undefined;
  const u = m[1].toLowerCase();
  return u.startsWith("gram") ? "g" : u.startsWith("ounce") ? "oz" : u.startsWith("lb") ? "lb" : u;
}

export function normValue(v: string): string {
  return String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}
