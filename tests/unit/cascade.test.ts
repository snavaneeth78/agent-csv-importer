import { describe, expect, test } from "vitest";
import { applyPatch, finalizePlan, emptyPlan, openBlocking, profileColumns, resolveConfig, runCascade, type MemoryEntry } from "@distru/csv-importer/core";
import { MockDistru, createMockedProfile, productSchema } from "@distru/csv-importer/distru";
import { MockJev, MockLlm, defaultStages, defaultValueStages } from "@distru/csv-importer/scorers";

const config = resolveConfig();
const ctx = { tenantId: "t1", actor: "u1" };

function table(headers: string[], rows: string[][]) {
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

async function cascade(headers: string[], rows: string[][], opts: { memory?: MemoryEntry[]; jev?: boolean; llm?: boolean } = {}) {
  const columns = profileColumns(headers, table(headers, rows));
  const stages = defaultStages({ config, jev: opts.jev ? new MockJev() : undefined, llm: opts.llm ? new MockLlm() : undefined });
  const res = await runCascade({ ctx, target: productSchema, columns, memory: opts.memory ?? [], config, stages });
  return { res, columns, by: Object.fromEntries(res.fields.map((f) => [f.sources[0], `${f.target}/${f.method}`])) };
}

describe("mapping cascade (§4.1)", () => {
  test("stage 0: template fast path skips every other stage", async () => {
    const { by } = await cascade(["Name", "SKU", "Unit Price", "Inactive"], [["A", "S1", "10", "FALSE"]]);
    expect(by).toEqual({ Name: "name/template", SKU: "sku/template", "Unit Price": "unit_price/template", Inactive: "active/template" });
  });

  test("stage 1: memory wins only when the value type still matches", async () => {
    const memory: MemoryEntry[] = [{ headerNorm: "zz price", targetField: "msrp", transforms: [{ op: "parse_money" }], typeSig: "money", hits: 3 }];
    const ok = await cascade(["Product", "ZZ Price"], [["A", "$10.00"], ["B", "$12.00"]], { memory });
    expect(ok.by["ZZ Price"]).toBe("msrp/memory");
    const text = await cascade(["Product", "ZZ Price"], [["A", "call us"], ["B", "ask"]], { memory });
    expect(text.by["ZZ Price"]).not.toBe("msrp/memory");
  });

  test("stage 1: a remembered mapping is dropped when the values can't fill the field", async () => {
    const memory: MemoryEntry[] = [{ headerNorm: "potency", targetField: "cannabinoid_unit", transforms: [], typeSig: "integer", hits: 1 }];
    const { by } = await cascade(["Name", "Potency"], [["A", "22"], ["B", "24"]], { memory });
    expect(by.Potency).toBe("total_thc/exact");
  });

  test("stage 2: exact names and synonyms, with normalization", async () => {
    const { by } = await cascade(["product_name", "Item Code", "Barcode", "Retail ($)", "Discontinued"], [["A", "X1", "012345678905", "$5", "no"]]);
    expect(by).toMatchObject({ product_name: "name/exact", "Item Code": "sku/exact", Barcode: "upc/exact", "Retail ($)": "unit_price/exact", Discontinued: "active/exact" });
  });

  test("exact header wins even when the values are dirty (bad values become row errors, not a remap)", async () => {
    const { by } = await cascade(["Name", "Unit Price", "THC %"], [["A", "abc", "20%"], ["B", "free", "21%"], ["C", "12.50", "22%"]], { jev: true, llm: true });
    expect(by["Unit Price"]).toBe("unit_price/exact");
  });

  test("inverted synonyms flip the bool", async () => {
    const { res } = await cascade(["Name", "Discontinued"], [["A", "yes"]]);
    expect(res.fields.find((f) => f.target === "active")!.transforms).toEqual([{ op: "parse_bool", invert: true }]);
  });

  test("stage 3: value patterns claim columns with unhelpful headers", async () => {
    const { by } = await cascade(["Name", "col_b", "col_c"], [["A", "012345678905", "3.5g"], ["B", "012345678912", "7g"]]);
    expect(by.col_b).toBe("upc/pattern");
    expect(by.col_c).toBe("net_weight/pattern");
  });

  test("stage 3: product names that contain a size are names, not a quantity column", async () => {
    const headers = ["Prodct Name", "SKU Cd", "Qty", "Unt"];
    const rows = [["Blue Dream 3.5g", "BD-35", "3.5", "gm"], ["OG Kush 7g", "OGK-7", "7", "gm"], ["Gelato 1g", "GEL-1", "1", "g"], ["Sour Diesel 28g", "SD-28", "28", "grams"]];
    const { by, columns } = await cascade(headers, rows);
    expect(columns.find((c) => c.source === "Prodct Name")!.signals.quantity).toBe(0);
    expect(by["Prodct Name"]).toBe("name/fuzzy");
  });

  test("size cells may carry a qualifier word and still read as sizes", () => {
    const vals = ["3.5g", "100 mg THC", ".5ml cart", "5pk 0.5g", "Eighth (3.5g)", "1/8 oz"];
    const [col] = profileColumns(["Size"], vals.map((v) => ({ Size: v })));
    expect(col.signals.quantity + col.signals.mg).toBe(1);
  });

  test("stage 3: a % column with no CBD in the header is Total THC", async () => {
    const { by } = await cascade(["Name", "Strength", "CBD Level"], [["A", "22%", "1%"], ["B", "24%", "0.5%"]]);
    expect(by.Strength).toBe("total_thc/pattern");
    expect(by["CBD Level"]).toBe("total_cbd/pattern");
  });

  test("Jev bands: >= 0.75 accepted, 0.40-0.75 suggested (skips the LLM), below or 'none' goes to the LLM", async () => {
    const jev = { modelId: "t", choose: async (items: { id: string }[]): Promise<Record<string, Record<string, number>>> => Object.fromEntries(items.map((it) => [it.id,
      (it.id === "Amt" ? { unit_price: 0.9 } : it.id === "Count" ? { units_per_case: 0.57, none: 0.3 } : { none: 0.6, unit_cost: 0.2 }) as Record<string, number>])) };
    const seen: string[] = [];
    const llm = { modelId: "t", mapColumns: async (i: { columns: { source: string }[] }) => { seen.push(...i.columns.map((c) => c.source)); return []; }, mapValues: async () => ({}), planPatch: async () => ({}) };
    const columns = profileColumns(["Name", "Amt", "Count", "Value"], [{ Name: "A", Amt: "45", Count: "12", Value: "9" }]);
    const res = await runCascade({ ctx, target: productSchema, columns, memory: [], config, stages: defaultStages({ config, jev, llm }) });
    expect(res.fields.find((f) => f.sources[0] === "Amt")).toMatchObject({ target: "unit_price", method: "jev" });
    expect(res.fields.find((f) => f.sources[0] === "Amt")?.needsConfirm).toBeUndefined();
    expect(res.fields.find((f) => f.sources[0] === "Count")).toMatchObject({ target: "units_per_case", needsConfirm: true });
    // "not a field" on top below the bar: the LLM gets it. Count (a suggestion) never reaches the LLM.
    expect(seen).toEqual(["Value"]);
  });

  test("a failed model call is reported, not silent", async () => {
    const config2 = resolveConfig({ scorers: { timeoutMs: { jev: 50, llm: 50 } } });
    const broken = { choose: async () => { throw new Error("401 Incorrect API key provided: sk-or-v1-abcdef123456") } };
    const [jev] = defaultStages({ config: config2, jev: broken }).filter((s) => s.method === "jev");
    const columns = profileColumns(["Weird"], [{ Weird: "x" }]);
    const res = await jev.run({ ctx, target: productSchema, columns, fields: Object.values(productSchema.fields), allColumns: columns, memory: [], config: config2 });
    expect(res.error).toBe("401 Incorrect API key provided: [key]");
  });

  test("stage 4: fuzzy needs a compatible type", async () => {
    const { by } = await cascade(["Product Nme", "Wholesale Prce"], [["A", "5.00"]]);
    expect(by["Product Nme"]).toBe("name/fuzzy");
    expect(by["Wholesale Prce"]).toBe("wholesale_price/fuzzy");
  });

  test("one column per target: the higher score wins, the loser drops to the next stage", async () => {
    const { res } = await cascade(["Name", "Product Name"], [["A", "B"]]);
    const names = res.fields.filter((f) => f.target === "name");
    expect(names).toHaveLength(1);
    expect(res.fields.find((f) => f.sources[0] === "Product Name")?.target).not.toBe("name");
  });

  test("stages 5 and 6 only see what is left", async () => {
    const { res, by } = await cascade(["Name", "Maker", "Internal Ref"], [["A", "Kiva", "X1"]], { jev: true, llm: true });
    expect(by.Maker).toBe("brand/llm");
    // Never accepted outright: either left for the user, or a Jev suggestion that needs confirming.
    const ref = res.fields.find((f) => f.sources[0] === "Internal Ref");
    expect(ref ? ref.needsConfirm : res.unresolved.some((c) => c.source === "Internal Ref")).toBe(true);
    expect(res.byStage.exact).toBe(1);
  });

  test("abbreviated headers are expanded before matching", async () => {
    const { by } = await cascade(["Prod Title", "Cat", "Wt", "Mfr", "Potency"], [["Blue Dream", "Flower", "3.5", "Kiva", "22"], ["OG", "Flower", "7", "Wyld", "24"]]);
    expect(by).toMatchObject({ "Prod Title": "name/exact", Cat: "category/exact", Wt: "net_weight/exact", Mfr: "brand/exact", Potency: "total_thc/exact" });
  });

  test("fuzzy is typo-level only: shared prefixes are not close spellings", async () => {
    const { by } = await cascade(["Name", "Potencyy", "Producr Name"], [["A", "22", "x"]]);
    expect(by["Producr Name"]).not.toBe("name/fuzzy");
    expect(by.Potencyy).toBe("total_thc/fuzzy");
  });

  test("Jev/LLM failure degrades to needs-you, never throws", async () => {
    const columns = profileColumns(["Name", "Weird"], table(["Name", "Weird"], [["A", "x"]]));
    const broken = { choose: async () => { throw new Error("down"); } };
    const res = await runCascade({ ctx, target: productSchema, columns, memory: [], config: resolveConfig({ scorers: { timeoutMs: { jev: 50, llm: 50 } } }), stages: defaultStages({ config: resolveConfig({ scorers: { timeoutMs: { jev: 50, llm: 50 } } }), jev: broken }) });
    expect(res.unresolved.map((c) => c.source)).toEqual(["Weird"]);
  });
});

describe("plan finalize", () => {
  async function plan(headers: string[], rows: string[][]) {
    const mock = new MockDistru("t1");
    const profile = await createMockedProfile(mock);
    const data = table(headers, rows);
    const { res, columns } = await cascade(headers, rows);
    const p = emptyPlan(headers, 0);
    p.fields = res.fields;
    p.ignoredColumns = [...res.ignored, ...res.unresolved.map((c) => ({ source: c.source, reason: "Not matched (needs you)" }))];
    const refs = { vendor: ["Green Valley Farms"], brand: ["Kiva", "Wyld"], unit_type: ["Each", "Gram", "Ounce", "Milligram", "Pound", "Milliliter"], net_weight_unit: ["Each", "Gram", "Ounce", "Milligram", "Pound", "Milliliter"], category: ["Flower"] };
    const deps = { profile, columns, refs, valueStages: defaultValueStages({ config }), distinct: async (s: string) => [...new Set(data.map((r) => r[s]).filter(Boolean))] };
    return { p: await finalizePlan(p, deps), deps, columns };
  }

  test("slang becomes a blocking confirm question; answering it sets the value map", async () => {
    const { p, deps, columns } = await plan(["Name", "Size"], [["A", "eighth"], ["B", "3.5g"]]);
    const q = p.questions.find((x) => x.id === "slang:net_weight:eighth")!;
    expect(q).toMatchObject({ kind: "confirm_default", blocking: true, suggested: "3.5 g" });
    expect(openBlocking(p)).toHaveLength(1);
    const { plan: next } = applyPatch(p, { answers: { [q.id]: "3.5 g" } }, productSchema, columns);
    const fin = await finalizePlan(next, deps);
    expect(openBlocking(fin)).toHaveLength(0);
    expect(fin.valueMaps["__slang:net_weight"]).toEqual({ eighth: "3.5 g" });
  });

  test("unit field derived from the size column; parser units map to Distru unit types", async () => {
    const { p } = await plan(["Name", "Size"], [["A", "3.5g"], ["B", "1 oz"]]);
    expect(p.fields.find((f) => f.target === "net_weight_unit")?.sources).toEqual(["Size"]);
    expect(p.valueMaps.net_weight_unit).toEqual({ g: "Gram", oz: "Ounce" });
  });

  test("sizes are copied from names when there is no size column", async () => {
    const { p } = await plan(["Name", "SKU"], [["Blue Dream 3.5g", "A"], ["OG 7g", "B"]]);
    expect(p.fields.find((f) => f.target === "net_weight")?.transforms[0]).toEqual({ op: "extract_quantity_from_name", part: "value" });
  });

  test("a must-exist column with no value in Distru asks once about the column, suggesting a list the values match", async () => {
    const { p } = await plan(["Name", "Vendor"], [["A", "Kiva"], ["B", "Wyld"]]);
    const q = p.questions.find((x) => x.id === "check:vendor")!;
    expect(q).toMatchObject({ blocking: true, suggested: "brand" });
    expect(p.questions.some((x) => x.id.startsWith("value:vendor:"))).toBe(false);
    expect(p.fields.find((f) => f.target === "vendor")!.score).toBeLessThanOrEqual(0.4);
  });

  test("an exact Vendor header holding vendors Distru doesn't have asks what to do with them, not whether it's Vendor", async () => {
    const { p } = await plan(["Name", "Vendor"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"], ["C", "High Mountain Farms"]]);
    expect(p.questions.some((x) => x.id === "check:vendor")).toBe(false);
    const q = p.questions.find((x) => x.id === "missing:vendor")!;
    expect(q).toMatchObject({ blocking: true, suggested: "match", values: ["Coastal Cultivators", "Green Leaf Co", "High Mountain Farms"] });
    expect(q.options?.map((o) => o.id)).toEqual(["add", "match", "blank"]);
    expect(openBlocking(p).map((x) => x.id)).toEqual(["missing:vendor"]);
  });

  test("a guessed header (synonym) holding unknown names still asks whether it's the right field", async () => {
    const { p } = await plan(["Name", "Supplier"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"]]);
    expect(p.questions.find((x) => x.id === "check:vendor")?.values).toEqual(["Coastal Cultivators", "Green Leaf Co"]);
    expect(p.questions.some((x) => x.id === "missing:vendor")).toBe(false);
  });

  test("leaving missing vendors blank settles the column with no per-value questions", async () => {
    const { p, deps, columns } = await plan(["Name", "Vendor"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"]]);
    const fin = await finalizePlan(applyPatch(p, { answers: { "missing:vendor": "blank" } }, productSchema, columns).plan, deps);
    expect(openBlocking(fin)).toHaveLength(0);
    expect(fin.questions.filter((x) => x.answer === undefined)).toHaveLength(0);
    expect(fin.valueMaps.vendor).toEqual({ "coastal cultivators": null, "green leaf co": null });
  });

  test("matching missing vendors keeps a picker per value; picking one fills the value map", async () => {
    const { p, deps, columns } = await plan(["Name", "Vendor"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"]]);
    expect(p.questions.find((x) => x.id === "value:vendor:coastal cultivators")?.values).toEqual(["Coastal Cultivators"]);
    const fin = await finalizePlan(applyPatch(p, { answers: { "missing:vendor": "match", "value:vendor:coastal cultivators": "Green Valley Farms" } }, productSchema, columns).plan, deps);
    expect(openBlocking(fin)).toHaveLength(0);
    expect(fin.valueMaps.vendor["coastal cultivators"]).toBe("Green Valley Farms");
    expect(fin.questions.find((x) => x.id === "missing:vendor")?.values).toEqual(["Green Leaf Co"]);
  });

  test("\"I'll add them in Distru\" keeps the import waiting until a re-check finds them", async () => {
    const { p, deps, columns } = await plan(["Name", "Vendor"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"]]);
    const waiting = await finalizePlan(applyPatch(p, { answers: { "missing:vendor": "add" } }, productSchema, columns).plan, deps);
    expect(waiting.questions.find((x) => x.id === "missing:vendor")).toMatchObject({ answer: "add", waiting: true });
    expect(openBlocking(waiting).map((x) => x.id)).toEqual(["missing:vendor"]);
    expect(waiting.questions.some((x) => x.id.startsWith("value:vendor:"))).toBe(false);

    // Re-check against a stale list: still waiting. Against the updated list: settled.
    const stale = await finalizePlan(applyPatch(waiting, { recheck: ["vendor"] }, productSchema, columns).plan, deps);
    expect(openBlocking(stale).map((x) => x.id)).toEqual(["missing:vendor"]);
    const refs = { ...deps.refs, vendor: [...deps.refs.vendor, "Coastal Cultivators", "Green Leaf Co"] };
    const done = await finalizePlan(applyPatch(stale, { recheck: ["vendor"] }, productSchema, columns).plan, { ...deps, refs });
    expect(openBlocking(done)).toHaveLength(0);
    expect(done.questions.some((x) => x.id === "missing:vendor")).toBe(false);
    expect(done.valueMaps.vendor).toEqual({ "coastal cultivators": "Coastal Cultivators", "green leaf co": "Green Leaf Co" });
  });

  test("a re-check keeps blanks the user chose on purpose", async () => {
    const { p, deps, columns } = await plan(["Name", "Vendor"], [["A", "Coastal Cultivators"], ["B", "Green Leaf Co"]]);
    const chose = await finalizePlan(applyPatch(p, { answers: { "missing:vendor": "match", "value:vendor:green leaf co": "__blank" } }, productSchema, columns).plan, deps);
    const { plan: next } = applyPatch(chose, { recheck: ["vendor"] }, productSchema, columns);
    expect(next.valueMaps.vendor).toEqual({ "green leaf co": null });
  });

  test("unit spellings the size parser knows map to Distru unit types (gm is Gram)", async () => {
    const { p } = await plan(["Name", "Unt"], [["A", "gm"], ["B", "g"], ["C", "grams"]]);
    expect(p.valueMaps.unit_type).toMatchObject({ gm: "Gram", g: "Gram", grams: "Gram" });
    expect(p.questions.some((q) => q.id.startsWith("value:unit_type:"))).toBe(false);
  });

  test("a misspelled name column with sizes inside the names is the name, not a size column", async () => {
    const headers = ["Prodct Name", "SKU Cd", "Qty", "Unt"];
    const { p } = await plan(headers, [["Blue Dream 3.5g", "BD-35", "3.5", "gm"], ["OG Kush 7g", "OGK-7", "7", "gm"], ["Gelato 1g", "GEL-1", "1", "g"], ["Sour Diesel 28g", "SD-28", "28", "grams"]]);
    expect(p.fields.find((f) => f.sources.includes("Prodct Name") && !f.rationale.startsWith("derived:"))?.target).toBe("name");
    expect(p.questions.some((q) => q.id === "not_a_catalog")).toBe(false);
  });

  test("keeping a checked column stays answered across later rebuilds", async () => {
    const { p, deps, columns } = await plan(["Name", "Vendor"], [["A", "Kiva"], ["B", "Wyld"]]);
    const kept = await finalizePlan(applyPatch(p, { answers: { "check:vendor": "keep" } }, productSchema, columns).plan, deps);
    // Any later revise rebuilds the plan again; the "keep" must survive it.
    const again = await finalizePlan(applyPatch(kept, { ignore: [] }, productSchema, columns).plan, deps);
    expect(again.questions.find((x) => x.id === "check:vendor")?.answer).toBe("keep");
    expect(openBlocking(again).some((x) => x.id === "check:vendor")).toBe(false);
  });

  test("the same column check covers fixed lists (product type holding product names)", async () => {
    const { p } = await plan(["Name", "Type"], [["A", "Blue Dream"], ["B", "OG Kush"]]);
    const q = p.questions.find((x) => x.id === "check:product_type");
    expect(q?.options?.map((o) => o.id)).toEqual(expect.arrayContaining(["keep", "external_name", "description", "ignore"]));
  });

  test("must-exist refs: unknown vendor asks, auto-create refs are kept as new", async () => {
    const { p } = await plan(["Name", "Vendor", "Category"], [["A", "Unknown Farms", "Topicals"]]);
    expect(p.questions.find((q) => q.id === "value:vendor:unknown farms")).toBeTruthy();
    expect(p.valueMaps.category["topicals"]).toEqual({ create: "Topicals" });
  });

  test("value matching is typo-level: a different company is asked about, not substituted", async () => {
    const { p } = await plan(["Name", "Vendor"], [["A", "Green Leaf Farms"], ["B", "Green Valey Farms"]]);
    expect(p.valueMaps.vendor["green valey farms"]).toBe("Green Valley Farms");
    expect(p.valueMaps.vendor["green leaf farms"]).toBeNull();
    expect(p.questions.find((q) => q.id === "value:vendor:green leaf farms")?.suggested).toBe("__blank");
  });

  test("bare potency numbers ask % or mg; the answer reaches the derived unit", async () => {
    const { p, deps, columns } = await plan(["Name", "Potency"], [["A", "22"], ["B", "24"]]);
    const q = p.questions.find((x) => x.id === "potunit:Potency")!;
    expect(q).toMatchObject({ blocking: true, suggested: "PERCENT" });
    const { plan: next } = applyPatch(p, { answers: { [q.id]: "PERCENT" } }, productSchema, columns);
    const fin = await finalizePlan(next, deps);
    expect(openBlocking(fin)).toHaveLength(0);
    expect(fin.fields.find((f) => f.target === "cannabinoid_unit")!.transforms).toEqual([{ op: "parse_potency", part: "unit", assumeUnit: "PERCENT" }]);
  });

  test("create-if-new fields keep their values; models never swap them for a different existing value", async () => {
    const mock = new MockDistru("t1");
    const profile = await createMockedProfile(mock);
    const headers = ["Name", "Group"];
    const data = table(headers, [["A", "Top Shelf"], ["B", "House"]]);
    const { res, columns } = await cascade(headers, [["A", "Top Shelf"], ["B", "House"]]);
    const p0 = emptyPlan(headers, 0);
    p0.fields = res.fields;
    const eager = { method: "llm" as const, run: async ({ values }: { values: string[] }) => values.map((v) => ({ value: v, match: "Premium", score: 0.9 })) };
    const p = await finalizePlan(p0, { profile, columns, refs: { group: ["Premium", "House Line"] }, valueStages: [...defaultValueStages({ config }), eager], distinct: async (s: string) => [...new Set(data.map((r) => r[s]))] });
    expect(p.valueMaps.group).toEqual({ "top shelf": { create: "Top Shelf" }, house: { create: "House" } });
  });

  test("a Jev suggestion becomes a confirm question; 'yes' clears it", async () => {
    const { p, deps, columns } = await plan(["Name", "Count"], [["A", "12"], ["B", "6"]]);
    p.fields.push({ target: "units_per_case", sources: ["Count"], transforms: [{ op: "parse_number" }], score: 0.57, method: "jev", rationale: "Suggested by Jev (57%), needs your confirm", needsConfirm: true });
    p.ignoredColumns = p.ignoredColumns.filter((i) => i.source !== "Count");
    const withQ = await finalizePlan(p, deps);
    const q = withQ.questions.find((x) => x.id === "confirm:Count")!;
    expect(q).toMatchObject({ blocking: false, suggested: "yes" });
    const { plan: next } = applyPatch(withQ, { answers: { [q.id]: "yes" } }, productSchema, columns);
    const fin = await finalizePlan(next, deps);
    expect(fin.fields.find((f) => f.target === "units_per_case")?.needsConfirm).toBe(false);
    expect(fin.questions.some((x) => x.id === "confirm:Count")).toBe(false);
  });

  test("value matching runs each stage once across all fields, in parallel", async () => {
    const mock = new MockDistru("t1");
    const profile = await createMockedProfile(mock);
    const headers = ["Name", "Vendor", "Brand"];
    const rows = [["A", "Acme", "Zeta"], ["B", "Beta", "Yolo"]];
    const data = table(headers, rows);
    const { res, columns } = await cascade(headers, rows);
    const p0 = emptyPlan(headers, 0);
    p0.fields = res.fields;
    let inFlight = 0, peak = 0, calls = 0;
    const slow = { method: "llm" as const, run: async () => { calls++; inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return []; } };
    await finalizePlan(p0, { profile, columns, refs: { vendor: ["Green Valley Farms"], brand: ["Kiva"] }, valueStages: [...defaultValueStages({ config }), slow], distinct: async (s: string) => [...new Set(data.map((r) => r[s]))] });
    expect(calls).toBe(2);
    expect(peak).toBe(2);
  });

  test("an unresolved column pre-selects the model's best guess with its confidence", async () => {
    const { p, deps } = await plan(["Name", "Origin", "Value"], [["A", "Green Leaf", "45"], ["B", "Sunrise", "80"]]);
    p.fields = p.fields.filter((f) => f.sources[0] === "Name");
    p.ignoredColumns = [
      { source: "Origin", reason: "Not matched (needs you)", guess: { target: "vendor", score: 0.39, method: "jev" } },
      { source: "Value", reason: "Not matched (needs you)", guess: { target: null, score: 0.6, method: "jev" } },
    ];
    const fin = await finalizePlan(p, deps);
    const origin = fin.questions.find((q) => q.id === "column:Origin")!;
    expect(origin).toMatchObject({ suggested: "vendor", guess: { method: "jev", score: 0.39 } });
    expect(origin.options![0]).toEqual({ id: "vendor", label: "Vendor (Jev 39%)" });
    const value = fin.questions.find((q) => q.id === "column:Value")!;
    expect(value.suggested).toBe("ignore");
    expect(value.options!.at(-1)!.label).toBe("Ignore (Jev 60%: not a field)");
  });

  test("no name column -> not a product list", async () => {
    const { p } = await plan(["Date", "Amount"], [["2026-01-01", "5"]]);
    expect(openBlocking(p).map((q) => q.kind)).toContain("not_a_catalog");
  });

  test("defaults are listed, never silent", async () => {
    const { p } = await plan(["Name"], [["Blue Dream 3.5g"]]);
    expect(p.defaultsApplied.map((d) => d.target)).toEqual(expect.arrayContaining(["tracking_method", "unit_type", "product_type", "active"]));
  });
});
