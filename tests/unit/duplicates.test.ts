import { describe, expect, test } from "vitest";
import { defaultAction, indexCatalog, markInFileDuplicates, matchCatalog, toTemplateRow, followupValues, type CatalogProduct } from "@distru/csv-importer/core";
import { productSchema } from "@distru/csv-importer/distru";

const product = (id: string, sku: string | null, name: string, values: Record<string, any> = {}): CatalogProduct =>
  ({ distruId: id, sku, upc: null, name, updatedAt: "2026-01-01T00:00:00Z", values: { name, sku, ...values } });

const catalog = indexCatalog([
  product("p1", "BD-35", "Blue Dream 3.5g", { unit_price: 35, tracking_method: "batch", description: "old" }),
  product("p2", "OG-70", "OG Kush 7g", { unit_price: 55 }),
]);
const mapped = new Set(["name", "sku", "unit_price", "tracking_method", "description", "distru_id"]);

describe("duplicates (§6)", () => {
  test("new, no_sku and possible duplicate by name", () => {
    expect(matchCatalog(productSchema, { name: "X", sku: "NEW-1" }, catalog, mapped).dupClass).toBe("new");
    const noSku = matchCatalog(productSchema, { name: "OG Kush 7g", sku: null }, catalog, mapped);
    expect(noSku.dupClass).toBe("no_sku");
    expect(noSku.possibleDuplicate).toBe("p2");
  });

  test("exists_unchanged vs exists_changed with a field diff; SKU match is case-insensitive", () => {
    expect(matchCatalog(productSchema, { name: "Blue Dream 3.5g", sku: "bd-35", unit_price: 35 }, catalog, mapped).dupClass).toBe("exists_unchanged");
    const changed = matchCatalog(productSchema, { name: "Blue Dream 3.5g", sku: "BD-35", unit_price: 40 }, catalog, mapped);
    expect(changed.dupClass).toBe("exists_changed");
    expect(changed.distruId).toBe("p1");
    expect(changed.diff).toEqual([{ field: "unit_price", from: 35, to: 40 }]);
  });

  test("a tracking-method change is shown but blocked, and alone is not a change", () => {
    const m = matchCatalog(productSchema, { name: "Blue Dream 3.5g", sku: "BD-35", unit_price: 35, tracking_method: "package" }, catalog, mapped);
    expect(m.diff).toEqual([{ field: "tracking_method", from: "batch", to: "package", blocked: true }]);
    expect(m.dupClass).toBe("exists_unchanged");
  });

  test("blank cells with a Distru value are tracked for 'blank clears'", () => {
    const m = matchCatalog(productSchema, { name: "Blue Dream 3.5g", sku: "BD-35", unit_price: 35, description: null }, catalog, mapped);
    expect(m.blankWithValue).toEqual(["description"]);
  });

  test("Distru ID counts only if it is in this tenant's snapshot", () => {
    const ok = matchCatalog(productSchema, { distru_id: "p2", name: "Renamed", sku: "ZZZ" }, catalog, mapped);
    expect(ok.distruId).toBe("p2");
    const foreign = matchCatalog(productSchema, { distru_id: "other_tenant_9", name: "A", sku: "BD-35", unit_price: 35 }, catalog, mapped);
    expect(foreign.issues[0].code).toBe("distru_id_not_found");
    expect(foreign.distruId).toBe("p1"); // fell back to SKU
  });

  test("in-file duplicates: first row wins", () => {
    const d = markInFileDuplicates([
      { rowIndex: 1, sku: "A", distruId: null }, { rowIndex: 2, sku: "a", distruId: null },
      { rowIndex: 3, sku: "B", distruId: "p9" }, { rowIndex: 4, sku: "C", distruId: "p9" }, { rowIndex: 5, sku: null, distruId: null },
    ]);
    expect([...d]).toEqual([[2, 1], [4, 3]]);
  });

  test("default actions", () => {
    expect(defaultAction("new", true, "skip")).toBe("create");
    expect(defaultAction("exists_changed", true, "skip")).toBe("skip");
    expect(defaultAction("exists_changed", true, "update")).toBe("update");
    expect(defaultAction("exists_unchanged", true, "update")).toBe("skip");
    expect(defaultAction("new", false, "update")).toBe("skip");
  });
});

describe("row edits on closed lists", async () => {
  const { validateRow, emptyPlan } = await import("@distru/csv-importer/core");
  const { MockDistru, createMockedProfile } = await import("@distru/csv-importer/distru");
  const profile = await createMockedProfile(new MockDistru("t1"));
  const plan = { ...emptyPlan(["Name"], 0), fields: [{ target: "name", sources: ["Name"], transforms: [{ op: "trim" as const }], score: 1, method: "exact" as const, rationale: "" }] };

  test("a valid value is accepted case-insensitively; an invalid one says what is allowed", () => {
    expect(validateRow({ Name: "A" }, { cannabinoid_unit: "percent" }, plan, profile).output.cannabinoid_unit).toBe("PERCENT");
    const bad = validateRow({ Name: "A" }, { cannabinoid_unit: "3.5" }, plan, profile);
    expect(bad.issues.find((i) => i.field === "cannabinoid_unit")?.message).toBe('"3.5" isn\'t a valid Cannabinoid Unit. Use MG or PERCENT.');
    expect(validateRow({ Name: "A" }, { vendor: "kiva" }, plan, profile, {}, { vendor: ["Kiva"] }).output.vendor).toBe("Kiva");
  });
});

describe("template output", () => {
  const out = { name: "Blue Dream 3.5g", sku: "BD-35", net_weight: 3.5, serving_size: null, net_weight_unit: "Gram", total_thc: 22, cannabinoid_unit: "PERCENT", active: true, unit_price: 35, tags: ["Indica"] };

  test("H-only columns in templateHeaders order; M fields and their whole group are left out", () => {
    const row = toTemplateRow(productSchema, out);
    expect(Object.keys(row)).toEqual(productSchema.templateHeaders);
    expect(row["Net Quantity per Unit"]).toBe(""); // weight group has an M field -> follow-up
    expect(row.Name).toBe("Blue Dream 3.5g");
    expect(row.Inactive).toBe("FALSE");
    expect(Object.keys(row)).not.toContain("Total THC");
  });

  test("rows needing follow-up are created inactive; follow-up carries the groups and real active", () => {
    expect(toTemplateRow(productSchema, out, { forceInactive: true }).Inactive).toBe("TRUE");
    expect(followupValues(productSchema, out)).toEqual({ net_weight: 3.5, net_weight_unit: "Gram", total_thc: 22, cannabinoid_unit: "PERCENT", tags: ["Indica"] });
  });

  test("blank clears write ## only for listed fields", () => {
    const row = toTemplateRow(productSchema, { name: "A", description: null, msrp: null }, { distruId: "p1", clear: new Set(["description"]) });
    expect(row.Description).toBe("##");
    expect(row.MSRP).toBe("");
    expect(row["Distru ID"]).toBe("p1");
  });
});
