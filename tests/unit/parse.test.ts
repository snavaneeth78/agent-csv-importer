import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import iconv from "iconv-lite";
import { buildTable, FileRejected, parseFile } from "@distru/csv-importer/core";

const vocab = new Set(["name", "sku", "price"]);
const enc = (s: string) => new TextEncoder().encode(s);
const table = (b: Uint8Array) => buildTable(parseFile(b), { vocabulary: vocab, maxRows: 1000 });

describe("file parsing (§9)", () => {
  test("xlsx: picks the sheet with data and asks when several have data", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "SKU"], ["A", "1"], ["B", "2"]]), "Products");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"], ["x"], ["y"]]), "Notes");
    const t = table(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
    expect(t.sheet).toBe("Products");
    expect(t.rows).toHaveLength(2);
    expect(t.unsure?.sheets).toEqual(["Products", "Notes"]);
  });

  test("wrong content behind a .csv name is rejected with a reason", () => {
    expect(() => parseFile(enc("<html><table></table></html>"))).toThrow(/HTML/);
    expect(() => parseFile(enc('[{"a":1}]'))).toThrow(/JSON/);
    expect(() => parseFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(FileRejected);
    expect(() => parseFile(new Uint8Array())).toThrow(/no data rows/);
    expect(() => table(enc("Name,SKU\n"))).toThrow(/no data rows/);
  });

  test("header row below title rows; blank and totals rows dropped; ragged rows flagged", () => {
    const t = table(enc("My export\n\nName,SKU,Price\nA,1,2\n\nB,2,3,EXTRA\nC,3\nTotal,,5\n"));
    expect(t.headerRow).toBe(2);
    expect(t.rows.map((r) => r.cells.Name)).toEqual(["A", "B", "C"]);
    expect(t.skippedRows).toBe(2);
    expect(t.rows[1].ragged).toBe(1);
    expect(t.rows[2].ragged).toBe(-1);
  });

  test("non-UTF-8 input is decoded; semicolons are sniffed", () => {
    const t = table(new Uint8Array(iconv.encode("Name;SKU;Price\nCrème brûlée gummies;C1;5\n", "win1252")));
    expect(t.rows[0].cells.Name).toBe("Crème brûlée gummies");
  });

  test("duplicate and blank headers get unique names", () => {
    expect(table(enc("Name,Price,Price,\nA,1,2,x\n")).headers).toEqual(["Name", "Price", "Price (2)", "Column 4"]);
  });
});
