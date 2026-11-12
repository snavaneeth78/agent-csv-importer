import { describe, expect, test } from "vitest";
import { parsePotency, parseQuantity, runTransforms } from "@distru/csv-importer/core";

const explicit = (s: string) => {
  const q = parseQuantity(s);
  if (q?.kind !== "explicit") throw new Error(`${s} -> ${JSON.stringify(q)}`);
  return q;
};

describe("unit parser (§4.2): explicit units are kept as written, never converted", () => {
  test.each([
    ["3.5g", 3.5, "g"], ["3.5 g", 3.5, "g"], ["3.5 grams", 3.5, "g"], ["3,5g", 3.5, "g"],
    ["1/8 oz", 0.125, "oz"], ["1/4 oz", 0.25, "oz"], ["1/2 oz", 0.5, "oz"], ["1 oz", 1, "oz"], ["2 ounces", 2, "oz"],
    ["1/4 lb", 0.25, "lb"], ["1/2 lb", 0.5, "lb"], ["1 lb", 1, "lb"], ["5 lbs", 5, "lb"],
    ["100mg", 100, "mg"], ["100 mg THC", 100, "mg"],
    ["1ml", 1, "ml"], ["0.5 mL", 0.5, "ml"], [".5ml cart", 0.5, "ml"],
    ["half oz", 0.5, "oz"], ["1,000g", 1000, "g"],
  ])("%s -> %s %s", (input, value, unit) => {
    const q = explicit(input);
    expect(q.value).toBe(value);
    expect(q.unit).toBe(unit);
  });

  test.each([
    ["eighth", 3.5], ["8th", 3.5], ["1/8", 3.5], ["quarter", 7], ["qtr", 7], ["1/4", 7], ["half", 14], ["zip", 28],
    ["qp", 112], ["hp", 224], ["p", 448],
  ])("slang %s is only proposed as %s g", (input, grams) => {
    const q = parseQuantity(input);
    expect(q).toEqual({ kind: "slang", slang: expect.any(String), proposed: { value: grams, unit: "g" } });
  });

  test("pack notation: net = count x size, serving = size", () => {
    for (const s of ["5 x 0.5g", "5pk 0.5g", "0.5g x 5"]) {
      const q = explicit(s);
      expect(q).toMatchObject({ value: 2.5, unit: "g", serving: { value: 0.5, unit: "g" }, count: 5 });
    }
  });

  test("count with no size has no weight", () => {
    expect(parseQuantity("5pk")).toEqual({ kind: "count", count: 5 });
    expect(parseQuantity("(10ct)")).toEqual({ kind: "count", count: 10 });
  });

  test("bare numbers are not given a unit", () => {
    expect(parseQuantity("3.5")).toEqual({ kind: "bare", value: 3.5 });
  });

  test("names: sizes are found, 'p' and bare fractions are not slang", () => {
    expect(parseQuantity("Blue Dream 3.5g", { inName: true })).toMatchObject({ kind: "explicit", value: 3.5, unit: "g" });
    expect(parseQuantity("Blue Dream Eighth", { inName: true })).toMatchObject({ kind: "slang", slang: "eighth" });
    expect(parseQuantity("Purple P", { inName: true })).toBeNull();
    expect(parseQuantity("10 gummies", { inName: true })).toBeNull();
  });

  test("potency: % and mg", () => {
    expect(parsePotency("22.5%")).toEqual({ value: 22.5, unit: "PERCENT" });
    expect(parsePotency("22.5 % THC")).toEqual({ value: 22.5, unit: "PERCENT" });
    expect(parsePotency("100mg")).toEqual({ value: 100, unit: "MG" });
    expect(parsePotency("22.5")).toEqual({ value: 22.5 });
  });
});

describe("parse_quantity transform", () => {
  const ctx = (slang: Record<string, string | null> = {}) => ({ valueMaps: { "__slang:net_weight": slang }, currency: "USD", field: "net_weight" });

  test("unconfirmed slang is an error, never a guess", () => {
    const r = runTransforms(["eighth"], [{ op: "parse_quantity", part: "value" }], ctx());
    expect(r.value).toBeNull();
    expect(r.issues[0].code).toBe("unconfirmed_slang");
  });

  test("confirmed slang uses the confirmed value", () => {
    const t = [{ op: "parse_quantity", part: "value" } as const];
    expect(runTransforms(["eighth"], t, ctx({ eighth: "3.5 g" })).value).toBe(3.5);
    expect(runTransforms(["eighth"], t, ctx({ eighth: "4 g" })).value).toBe(4);
    expect(runTransforms(["eighth"], [{ op: "parse_quantity", part: "unit" }], ctx({ eighth: "1/8 oz" })).value).toBe("oz");
  });

  test("slang answered 'leave blank' is blank, not an error", () => {
    const r = runTransforms(["eighth"], [{ op: "parse_quantity", part: "value" }], ctx({ eighth: null }));
    expect(r).toEqual({ value: null, issues: [] });
  });

  test("bare numbers need a declared unit", () => {
    expect(runTransforms(["28"], [{ op: "parse_quantity", part: "value" }], ctx()).issues[0].code).toBe("no_unit");
    expect(runTransforms(["28"], [{ op: "parse_quantity", part: "unit", assumeUnit: "g" }], ctx()).value).toBe("g");
  });

  test("names keep their text; mg in names is ignored as potency", () => {
    expect(runTransforms(["Gummies 10pk 100mg"], [{ op: "extract_quantity_from_name", part: "value" }], ctx()).value).toBeNull();
    expect(runTransforms(["Blue Dream 7g"], [{ op: "extract_quantity_from_name", part: "value" }], ctx()).value).toBe(7);
  });

  test("money: locale and currency", () => {
    const t = [{ op: "parse_money" } as const];
    expect(runTransforms(["$1,234.50"], t, ctx()).value).toBe(1234.5);
    expect(runTransforms(["1.234,50"], t, ctx()).value).toBe(1234.5);
    const eur = runTransforms(["€12"], t, ctx());
    expect(eur.value).toBeNull();
    expect(eur.issues[0].code).toBe("currency");
  });
});
