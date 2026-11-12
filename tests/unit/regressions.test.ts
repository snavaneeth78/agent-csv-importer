import { describe, expect, test } from "vitest";
import iconv from "iconv-lite";
import { buildTable, FileRejected, parseDate, parseFile, parseNumber, parseQuantity, runTransforms, safeRegex } from "@distru/csv-importer/core";

const vocab = new Set(["name", "sku", "price"]);
const enc = (s: string) => new TextEncoder().encode(s);
const table = (b: Uint8Array) => buildTable(parseFile(b), { vocabulary: vocab, maxRows: 1000 });
const ctx = { valueMaps: {}, currency: "USD", field: "f" };

describe("numbers", () => {
  test("a minus inside the value is not a sign", () => {
    expect(parseNumber("10-20")).toBeNull();
    expect(parseNumber("2024-01-05")).toBeNull();
    expect(parseNumber("123-456")).toBeNull();
  });
  test("signs: leading, trailing, parentheses, exponent", () => {
    expect(parseNumber("-5")).toBe(-5);
    expect(parseNumber("5-")).toBe(-5);
    expect(parseNumber("(1,234.50)")).toBe(-1234.5);
    expect(parseNumber("+7")).toBe(7);
    expect(parseNumber("1e-5")).toBe(0.00001);
    expect(parseNumber("1e999")).toBeNull();
  });
});

describe("dates", () => {
  test("month-first by default, day-first on request, no time-zone shift", () => {
    expect(parseDate("03/05/2024")).toBe("2024-03-05");
    expect(parseDate("03/05/2024", "dd/mm/yyyy")).toBe("2024-05-03");
    expect(parseDate("2024-03-05T23:30:00-08:00")).toBe("2024-03-05");
    expect(parseDate("Jan 5, 2024")).toBe("2024-01-05");
  });
  test("bare numbers and impossible dates are rejected", () => {
    expect(parseDate("12")).toBeNull();
    expect(parseDate("45123")).toBeNull();
    expect(parseDate("02/30/2024")).toBeNull();
  });
});

describe("transform chain", () => {
  test("default fills a value an earlier step left empty", () => {
    expect(runTransforms([""], [{ op: "parse_number" }, { op: "default", value: 0 }], ctx).value).toBe(0);
  });
  test("a bad or backtracking pattern is an issue, never an exception or a hang", () => {
    expect(safeRegex("([")).toBeNull();
    expect(safeRegex("^(a+)+$")).toBeNull();
    const r = runTransforms(["abc"], [{ op: "regex_extract", pattern: "([" }], ctx);
    expect(r.value).toBeNull();
    expect(r.issues[0].code).toBe("bad_pattern");
    expect(runTransforms(["SKU-42"], [{ op: "regex_extract", pattern: "(\\d+)" }], ctx).value).toBe("42");
  });
  test("title case keeps apostrophes and accents", () => {
    expect(runTransforms(["o'brien's éclair"], [{ op: "case", mode: "title" }], ctx).value).toBe("O'brien's Éclair");
  });
});

describe("sizes", () => {
  test("a number is not read from the middle of another number", () => {
    expect(parseQuantity("1.234,5 g")).toBeNull();
    expect(parseQuantity("Blue Dream 3.5g", { inName: true })).toMatchObject({ kind: "explicit", value: 3.5, unit: "g" });
  });
});

describe("file parsing", () => {
  test("an unclosed quote rejects the file", () => {
    expect(() => table(enc('Name,SKU\n"Blue,A1\nRed,B1\nGreen,C1\n'))).toThrow(FileRejected);
  });
  test("repeated headers never collide with a literal header", () => {
    const t = table(enc("A,A,A (2),SKU\n1,2,3,X\n4,5,6,Y\n"));
    expect(new Set(t.headers).size).toBe(4);
    expect(Object.values(t.rows[0].cells)).toEqual(["1", "2", "3", "X"]);
  });
  test("UTF-16 with a BOM (Excel Unicode Text) is read", () => {
    const body = iconv.encode("Name\tSKU\nBlue Dream\tA1\nGelato\tB2\n", "utf-16le");
    const t = table(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), body])));
    expect(t.headers).toEqual(["Name", "SKU"]);
    expect(t.rows).toHaveLength(2);
  });
  test("a bracketed header is a CSV, JSON is still rejected", () => {
    expect(table(enc("[SKU],Name\nA1,Blue\nB2,Red\n")).rows).toHaveLength(2);
    expect(() => table(enc('[{"name":"x"}]'))).toThrow(FileRejected);
    expect(() => table(enc('{"name":"x"}'))).toThrow(FileRejected);
  });
  test("a product whose name starts with Total is kept; a totals row is dropped", () => {
    const t = table(enc("Name,SKU,Price\nTotal Wellness Tincture,A1,10\nGelato,B2,20\nTotal,,30\n"));
    expect(t.rows.map((r) => r.cells.Name)).toEqual(["Total Wellness Tincture", "Gelato"]);
    expect(t.skippedRows).toBe(1);
  });
});
