import Papa from "papaparse";
import {
  FollowupError, toCsv, type CatalogProduct, type Ctx, type Json, type MappingPlan, type TargetProfile,
} from "../core/index.ts";
import { productSchema, PRODUCT_TYPES } from "./product.schema.ts";

/**
 * Generic MCP call. Distru wires its MCP client here (e.g. `client.callTool({ name, arguments })`), using
 * the actor's own short-lived token. The library never sees the token.
 */
export type McpCall = (ctx: Ctx, tool: string, args: Record<string, Json>) => Promise<any>;

export interface DistruProfileOptions {
  /** Full URL of POST /upload-products. */
  uploadUrl: string;
  mcp: McpCall;
  /** Adds auth headers to the upload request (short-lived actor token, minted by the harness). */
  uploadHeaders?: (ctx: Ctx) => Promise<Record<string, string>> | Record<string, string>;
  currency?: string;
  fetch?: typeof fetch;
}

const TYPE_RULES: [string, RegExp][] = [
  ["pre_roll", /pre-?rolls?|joints?|blunts?/],
  ["vape", /\bcarts?\b|cartridge|vape|\bpods?\b|disposable|\b510\b/],
  ["concentrate", /\bwax\b|shatter|resin|rosin|badder|budder|crumble|diamonds|sauce|concentrate|\bhash\b|kief/],
  ["edible", /gumm(y|ies)|chocolate|edible|cookie|brownie|candy|chews?\b|\bmints?\b/],
  ["beverage", /drink|beverage|soda|seltzer|\btea\b|\bshot\b/],
  ["tincture", /tincture|\bdrops\b/],
  ["topical", /topical|balm|lotion|salve|cream|\bpatch\b/],
  ["capsule", /capsule|softgel|tablet|\bpills?\b/],
  ["seed_clone", /\bseeds?\b|\bclones?\b/],
  ["accessory", /grinder|battery|lighter|papers|accessor|\btray\b|\bpipe\b|\bbong\b/],
  ["flower", /flower|\bbuds?\b|smalls|shake|popcorn|\beighth\b|\b(3\.5|7|14|28)\s?g\b/],
];

export function detectProductType(text: string): string | null {
  const t = text.toLowerCase();
  for (const [type, re] of TYPE_RULES) if (re.test(t)) return type;
  return null;
}

const TYPE_LABEL: Record<string, string> = {
  flower: "Flower", pre_roll: "Pre-Roll", vape: "Vape", concentrate: "Concentrate", edible: "Edible", beverage: "Beverage",
  tincture: "Tincture", topical: "Topical", capsule: "Capsule", seed_clone: "Seeds & Clones", accessory: "Accessory", other: "Other",
};

const isDerive = (plan: MappingPlan, field: string) => {
  const d = plan.defaultsApplied.find((x) => x.target === field);
  return !!d && typeof d.value === "object" && d.value !== null && !Array.isArray(d.value) && "derive" in d.value;
};

/** Maps an MCP product (assumed GraphQL-like camelCase shape) to importer field names. */
export function fromMcpProduct(p: any): CatalogProduct {
  const n = (x: any) => x?.name ?? null;
  return {
    distruId: String(p.id),
    sku: p.sku ?? null,
    upc: p.upc ?? null,
    name: p.name,
    updatedAt: p.updatedAt,
    values: {
      name: p.name, sku: p.sku ?? null, upc: p.upc ?? null, external_name: p.externalName ?? null, description: p.description ?? null,
      category: n(p.category), subcategory: n(p.subcategory), group: n(p.group), strain: n(p.strain), vendor: n(p.vendor), brand: n(p.brand),
      owner: n(p.owner), unit_type: n(p.unitType), tracking_method: p.trackingMethod ? String(p.trackingMethod).toLowerCase() : null,
      unit_price: p.unitPrice ?? null, wholesale_price: p.wholesalePrice ?? null, unit_cost: p.unitCost ?? null, msrp: p.msrp ?? null,
      units_per_case: p.unitsPerCase ?? null, net_weight: p.netWeight ?? null, serving_size: p.servingSize ?? null,
      net_weight_unit: n(p.netWeightUnit), total_thc: p.totalThc ?? null, total_cbd: p.totalCbd ?? null, cannabinoid_unit: p.cannabinoidUnit ?? null,
      threshold_min: p.minThreshold ?? null, threshold_max: p.maxThreshold ?? null, featured: p.featured ?? null,
      active: p.inactive === undefined ? null : !p.inactive, tags: (p.tags ?? []).map((t: any) => t.name),
    },
  };
}

/** Importer field values -> MCP distru-mutate-product input. */
export function toMcpProductInput(values: Record<string, Json>): Record<string, Json> {
  const ref = (v: Json) => (v === null ? null : { name: v });
  const map: Record<string, (v: Json) => [string, Json]> = {
    net_weight: (v) => ["netWeight", v], serving_size: (v) => ["servingSize", v], net_weight_unit: (v) => ["netWeightUnit", ref(v)],
    total_thc: (v) => ["totalThc", v], total_cbd: (v) => ["totalCbd", v], cannabinoid_unit: (v) => ["cannabinoidUnit", v],
    tags: (v) => ["tags", Array.isArray(v) ? v.map((t) => ({ name: t })) : v], active: (v) => ["inactive", v === null ? null : !v],
    name: (v) => ["name", v], sku: (v) => ["sku", v], upc: (v) => ["upc", v], external_name: (v) => ["externalName", v], description: (v) => ["description", v],
    category: (v) => ["category", ref(v)], subcategory: (v) => ["subcategory", ref(v)], group: (v) => ["group", ref(v)], strain: (v) => ["strain", ref(v)],
    vendor: (v) => ["vendor", ref(v)], brand: (v) => ["brand", ref(v)], owner: (v) => ["owner", ref(v)], unit_type: (v) => ["unitType", ref(v)],
    unit_price: (v) => ["unitPrice", v], wholesale_price: (v) => ["wholesalePrice", v], unit_cost: (v) => ["unitCost", v], msrp: (v) => ["msrp", v],
    units_per_case: (v) => ["unitsPerCase", v], threshold_min: (v) => ["minThreshold", v], threshold_max: (v) => ["maxThreshold", v], featured: (v) => ["featured", v],
  };
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(values)) if (map[k]) { const [kk, vv] = map[k](v); out[kk] = vv; }
  return out;
}

export function createDistruProductProfile(opts: DistruProfileOptions): TargetProfile {
  const doFetch = opts.fetch ?? fetch;
  const currency = opts.currency ?? "USD";
  return {
    target: productSchema,
    currency,
    valueAliases: {
      net_weight_unit: { g: "Gram", mg: "Milligram", oz: "Ounce", lb: "Pound", ml: "Milliliter" },
      unit_type: { g: "Gram", gram: "Gram", grams: "Gram", ea: "Each", each: "Each", unit: "Each", units: "Each", oz: "Ounce", lb: "Pound", ml: "Milliliter", mg: "Milligram" },
      product_type: { cart: "vape", cartridge: "vape", "pre-roll": "pre_roll", preroll: "pre_roll", "pre roll": "pre_roll", joint: "pre_roll", gummy: "edible", gummies: "edible", wax: "concentrate", "live resin": "concentrate", bud: "flower" },
      tracking_method: { lot: "batch", "batch tracked": "batch", pkg: "package", tag: "package" },
    },
    hooks: {
      afterMatch(plan) {
        const has = (f: string) => plan.fields.some((m) => m.target === f);
        const add = (target: string, value: Json, reason: string) => {
          if (!has(target) && !plan.defaultsApplied.some((d) => d.target === target)) plan.defaultsApplied.push({ target, value, reason });
        };
        add("product_type", { derive: "product_type" }, "Detected per row from category and name");
        add("unit_type", { derive: "unit_type" }, "By product type: flower is Gram, everything else is Each");
        add("category", { derive: "category" }, "From the detected product type (created in Distru if new)");
      },
      deriveRow(output, plan) {
        if (!output.product_type && isDerive(plan, "product_type")) {
          output.product_type = detectProductType([output.category, output.subcategory, output.name].filter(Boolean).join(" ")) ?? "other";
        }
        if (!output.unit_type && isDerive(plan, "unit_type")) output.unit_type = output.product_type === "flower" ? "Gram" : "Each";
        if (!output.category && isDerive(plan, "category") && output.product_type && output.product_type !== "other") {
          output.category = TYPE_LABEL[String(output.product_type)];
        }
        if (output.product_type && !PRODUCT_TYPES.includes(String(output.product_type))) output.product_type = "other";
      },
    },

    sink: {
      async upload(ctx, { importId, mode, headers, rows }) {
        const res = await doFetch(`${opts.uploadUrl}?mode=${mode}`, {
          method: "POST",
          headers: { "content-type": "text/csv", "x-import-id": importId, ...(await opts.uploadHeaders?.(ctx)) },
          body: toCsv(headers, rows),
        });
        if (res.status >= 500 || res.status === 429) throw new Error(`upload-products ${res.status}`);
        const text = await res.text();
        if (res.status >= 400) throw new Error(`upload-products rejected the file: ${res.status} ${text.slice(0, 200)}`);
        if (!text.trim()) return { errors: [] };
        // Error CSV: the uploaded columns plus "Row" (1-based) and "Errors".
        const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true });
        return { errors: parsed.data.map((r) => ({ index: Number(r.Row) - 1, message: r.Errors || "Rejected by Distru" })) };
      },
    },

    catalog: {
      async page(ctx, { cursor, limit, sort }) {
        const res = await opts.mcp(ctx, "distru-search-products", {
          status: "ANY", limit, cursor, ...(sort === "updated_desc" ? { sortBy: { field: "UPDATED_AT", direction: "DESC" } } : {}),
        });
        return { items: (res.items ?? []).map(fromMcpProduct), nextCursor: res.nextCursor ?? null };
      },
    },

    refResolver: {
      async resolve(ctx, fields, helpers) {
        const out: Record<string, string[]> = {};
        const names = (r: any) => (r.items ?? []).map((x: any) => x.name as string);
        for (const fd of fields) {
          const kind = fd.ref?.kind;
          if (!kind) continue;
          if (kind === "SUBCATEGORY" || kind === "STRAIN") out[fd.name] = await helpers.snapshotDistinct(fd.name);
          else if (kind === "VENDOR" || kind === "BRAND") out[fd.name] = names(await opts.mcp(ctx, "distru-search-companies", { relationship: kind }));
          else if (kind === "USER") out[fd.name] = names(await opts.mcp(ctx, "distru-search-users", {}));
          else out[fd.name] = names(await opts.mcp(ctx, "distru-search-lookups", { type: kind }));
        }
        return out;
      },
    },

    followup: {
      async update(ctx, { distruId, values }) {
        try {
          await opts.mcp(ctx, "distru-mutate-product", { action: "UPDATE", id: distruId, product: toMcpProductInput(values) });
        } catch (e: any) {
          throw new FollowupError(Number(e?.status ?? 500), String(e?.message ?? e));
        }
      },
    },
  };
}

/** Convenience for demo and tests: the real profile pointed at an in-memory MockDistru. */
export async function createMockedProfile(mock: import("./mock.ts").MockDistru, opts: { uploadUrl?: string } = {}): Promise<TargetProfile> {
  const { mockFetchFor } = await import("./mock.ts");
  return createDistruProductProfile({
    uploadUrl: opts.uploadUrl ?? "http://mock.distru.local/upload-products",
    mcp: mock.mcp,
    fetch: await mockFetchFor(mock),
    uploadHeaders: (ctx) => ({ "x-tenant-id": ctx.tenantId }),
  });
}
