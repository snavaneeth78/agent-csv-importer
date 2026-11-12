import Papa from "papaparse";
import * as XLSX from "xlsx";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import { normalizeHeader, isBlank } from "./normalize.ts";

export class FileRejected extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ParsedSheet {
  name: string;
  rows: string[][];
}

export interface ParsedFile {
  kind: "csv" | "xlsx";
  encoding?: string;
  sheets: ParsedSheet[];
}

export interface Table {
  sheet?: string;
  headerRow: number;
  headers: string[];
  rows: { rowIndex: number; cells: Record<string, string>; ragged?: number }[];
  skippedRows: number;
  /** Set when header detection or sheet choice is unsure. */
  unsure?: { headerRow?: number[]; sheets?: string[] };
}

export function sniff(bytes: Uint8Array): "xlsx" | "cfb" | "text" {
  const b = bytes;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "xlsx";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "cfb";
  if (utf16Bom(b)) return "text";
  const head = Buffer.from(b.subarray(0, 512)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("%PDF")) throw new FileRejected("not_a_spreadsheet", "Not a spreadsheet (this is a PDF)");
  if (/^<(!doctype|html|\?xml|table)/i.test(head)) throw new FileRejected("not_a_spreadsheet", "Not a spreadsheet (this looks like HTML or XML)");
  // "[SKU],Name" is a CSV header; only reject what can open a JSON document.
  if (/^(\{\s*("|\})|\[\s*([[{"\]]|-?\d+\s*[,\]]))/.test(head)) throw new FileRejected("not_a_spreadsheet", "Not a spreadsheet (this looks like JSON)");
  const sample = b.subarray(0, 4096);
  let nul = 0;
  for (const x of sample) if (x === 0) nul++;
  if (nul > sample.length * 0.1) throw new FileRejected("not_a_spreadsheet", "Not a spreadsheet (binary content)");
  return "text";
}

const utf16Bom = (b: Uint8Array): "utf-16le" | "utf-16be" | null =>
  b[0] === 0xff && b[1] === 0xfe ? "utf-16le" : b[0] === 0xfe && b[1] === 0xff ? "utf-16be" : null;

export function parseFile(bytes: Uint8Array): ParsedFile {
  if (bytes.byteLength === 0) throw new FileRejected("empty", "File has no data rows");
  const kind = sniff(bytes);
  if (kind === "text") return parseText(bytes);
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: false, dense: true });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/password|encrypt/i.test(msg)) throw new FileRejected("password_protected", "This XLSX is password-protected. Remove the password and upload again.");
    throw new FileRejected("corrupt", "This spreadsheet is damaged or truncated and can't be read.");
  }
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: (XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true }) as any[][])
      .map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c)))),
  }));
  return { kind: "xlsx", sheets };
}

function parseText(bytes: Uint8Array): ParsedFile {
  const buf = Buffer.from(bytes);
  // Excel's "Unicode Text" export is UTF-16 with a BOM.
  let encoding: string = utf16Bom(bytes) ?? "utf-8";
  const utf8 = encoding === "utf-8" ? buf.toString("utf8") : "";
  if (utf8.includes("�")) {
    const det = jschardet.detect(buf.subarray(0, 64 * 1024));
    if (det.encoding && iconv.encodingExists(det.encoding)) encoding = det.encoding.toLowerCase();
  }
  // NUL can't be stored in Postgres jsonb and never belongs in a cell.
  const text = (encoding === "utf-8" ? utf8 : iconv.decode(buf, encoding)).replace(/^﻿/, "").replace(/\u0000/g, "");
  const bad = (text.match(/�/g) ?? []).length;
  if (text.length > 0 && bad / text.length > 0.05) throw new FileRejected("encoding", "Too many unreadable characters. Save the file as UTF-8 CSV and try again.");
  let res = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: "" });
  // Papa's sniffing gives up on narrow files (two columns and a trailing newline). Fall back to the header line.
  if (res.errors.some((e) => e.code === "UndetectableDelimiter")) {
    const first = text.slice(0, text.search(/\r?\n|$/));
    const best = ["\t", ";", "|"].map((d) => ({ d, n: first.split(d).length - 1 })).sort((x, y) => y.n - x.n)[0];
    if (best.n > 0) res = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: best.d });
  }
  // An unclosed quote swallows every following row into one cell. Refuse the file; never import a fraction of it silently.
  const quote = res.errors.find((e) => e.code === "MissingQuotes");
  if (quote) {
    throw new FileRejected("corrupt", `A quoted value is never closed${quote.row !== undefined ? ` (around line ${quote.row + 1})` : ""}, so the rows after it can't be read. Fix the quote and upload again.`);
  }
  const last = res.data.at(-1);
  if (last && last.length === 1 && last[0] === "") res.data.pop(); // trailing newline
  return { kind: "csv", encoding, sheets: [{ name: "Sheet1", rows: res.data.map((r) => r.map((c) => c ?? "")) }] };
}

const isBlankRow = (r: string[]) => r.every((c) => isBlank(c));
const isTotalsRow = (r: string[]) => {
  const first = r.find((c) => !isBlank(c)) ?? "";
  // The label alone ("Total", "Grand total:"), so a product named "Total Wellness Tincture" is kept.
  return /^((grand|sub)\s*)?totals?:?$|^sum:?$/i.test(first.trim());
};

/** Score the first 20 rows as header candidates. Higher = more header-like. */
export function scoreHeaderRows(rows: string[][], vocabulary: Set<string>): { row: number; score: number }[] {
  const out: { row: number; score: number }[] = [];
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i];
    const cells = r.filter((c) => !isBlank(c));
    if (cells.length < 2) { out.push({ row: i, score: 0 }); continue; }
    const textual = cells.filter((c) => !/^[\d.,$%€\s-]+$/.test(c)).length / cells.length;
    const known = cells.filter((c) => vocabulary.has(normalizeHeader(c))).length;
    const unique = new Set(cells.map((c) => c.trim().toLowerCase())).size / cells.length;
    const fill = cells.length / Math.max(...rows.slice(0, 20).map((x) => x.filter((c) => !isBlank(c)).length), 1);
    out.push({ row: i, score: textual * 0.3 + unique * 0.2 + fill * 0.2 + Math.min(known / 3, 1) * 0.3 });
  }
  return out;
}

export function buildTable(
  file: ParsedFile,
  opts: { sheet?: string; headerRow?: number; vocabulary: Set<string>; maxRows: number },
): Table {
  const withData = file.sheets.filter((s) => s.rows.filter((r) => !isBlankRow(r)).length > 1);
  if (withData.length === 0) throw new FileRejected("empty", "File has no data rows");
  let sheet = withData[0];
  let unsureSheets: string[] | undefined;
  if (opts.sheet) {
    sheet = file.sheets.find((s) => s.name === opts.sheet) ?? sheet;
  } else if (withData.length > 1) {
    sheet = [...withData].sort((a, b) => b.rows.length - a.rows.length)[0];
    unsureSheets = withData.map((s) => s.name);
  }

  const scores = scoreHeaderRows(sheet.rows, opts.vocabulary).sort((a, b) => b.score - a.score);
  let headerRow = opts.headerRow ?? scores[0].row;
  let unsureHeader: number[] | undefined;
  if (opts.headerRow === undefined && scores.length > 1 && scores[0].score - scores[1].score < 0.05 && scores[0].row !== 0) {
    unsureHeader = scores.slice(0, 3).map((s) => s.row);
  }

  const rawHeaders = sheet.rows[headerRow] ?? [];
  // Repeated headers get " (2)", " (3)"...; keep counting until the name is free ("A, A, A (2)").
  const used = new Set<string>();
  const headers = rawHeaders.map((h, i) => {
    const base = String(h ?? "").trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    return name;
  });
  // Drop trailing fully-empty columns.
  while (headers.length && headers[headers.length - 1].startsWith("Column ") &&
    sheet.rows.slice(headerRow + 1).every((r) => isBlank(r[headers.length - 1]))) headers.pop();

  const rows: Table["rows"] = [];
  let skipped = 0;
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i];
    if (isBlankRow(r) || isTotalsRow(r)) { skipped++; continue; }
    const cells: Record<string, string> = {};
    headers.forEach((h, j) => (cells[h] = String(r[j] ?? "").trim()));
    const extra = r.slice(headers.length).filter((c) => !isBlank(c)).length;
    const short = r.length < headers.length && file.kind === "csv";
    rows.push({ rowIndex: rows.length + 1, cells, ragged: extra > 0 ? extra : short ? -(headers.length - r.length) : undefined });
    if (rows.length > opts.maxRows) throw new FileRejected("too_many_rows", `File has more than ${opts.maxRows} rows`);
  }
  if (rows.length === 0) throw new FileRejected("empty", "File has no data rows");
  return {
    sheet: sheet.name,
    headerRow,
    headers,
    rows,
    skippedRows: skipped,
    unsure: unsureHeader || unsureSheets ? { headerRow: unsureHeader, sheets: unsureSheets } : undefined,
  };
}
