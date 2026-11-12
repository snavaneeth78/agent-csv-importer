import Papa from "papaparse";
import type { Ctx, Json } from "../core/index.ts";
import { productSchema } from "./product.schema.ts";

/** In-memory stand-in for Distru: the product catalog behind MCP and POST /upload-products. Demo and tests only. */

export const STRAINS = ["Blue Dream", "OG Kush", "Sour Diesel", "Gelato", "Wedding Cake", "GSC", "Zkittlez", "Runtz", "Purple Punch", "Jack Herer", "Durban Poison", "Pineapple Express", "Gorilla Glue", "Ice Cream Cake", "Mac 1"];
export const BRANDS = ["Kiva", "Stiiizy", "Raw Garden", "Wyld", "Cookies", "Jeeter", "Pax", "Select"];
export const VENDORS = ["Green Valley Farms", "Emerald Supply Co", "Humboldt Growers", "Pacific Distribution", "Sunset Cultivation"];
export const CATEGORIES = ["Flower", "Pre-Roll", "Vape", "Edible", "Concentrate", "Tincture"];
export const UNIT_TYPES = ["Each", "Gram", "Milligram", "Ounce", "Pound", "Milliliter"];
export const GROUPS = ["House Line", "Premium", "Value"];
export const TAGS = ["Indica", "Sativa", "Hybrid", "Staff Pick", "New"];
export const USERS = ["Alex Rivera", "Sam Chen", "Jordan Lee"];

export interface MockProduct {
  id: string;
  name: string;
  sku: string | null;
  upc: string | null;
  externalName?: string | null;
  description?: string | null;
  category?: { name: string } | null;
  subcategory?: { name: string } | null;
  group?: { name: string } | null;
  strain?: { name: string } | null;
  vendor?: { name: string } | null;
  brand?: { name: string } | null;
  owner?: { name: string } | null;
  unitType?: { name: string } | null;
  trackingMethod?: string;
  unitPrice?: number | null;
  wholesalePrice?: number | null;
  unitCost?: number | null;
  msrp?: number | null;
  unitsPerCase?: number | null;
  netWeight?: number | null;
  servingSize?: number | null;
  netWeightUnit?: { name: string } | null;
  totalThc?: number | null;
  totalCbd?: number | null;
  cannabinoidUnit?: string | null;
  minThreshold?: number | null;
  maxThreshold?: number | null;
  featured?: boolean;
  inactive: boolean;
  tags?: { name: string }[];
  tenantId: string;
  updatedAt: string;
}

/** The 50 seeded products. SKUs follow `<STRAIN-INITIALS>-<SIZE>` so fixtures can overlap with them. */
export function seedCatalog(tenantId = "tenant_demo"): MockProduct[] {
  const sizes: [string, number, string][] = [["3.5g", 3.5, "35"], ["7g", 7, "70"], ["1g Pre-Roll", 1, "PR1"]];
  const out: MockProduct[] = [];
  let i = 0;
  for (const strain of STRAINS) {
    for (const [label, w, code] of sizes) {
      if (out.length >= 50) break;
      const isPr = label.includes("Pre-Roll");
      const sku = `${strain.split(" ").map((s) => s[0]).join("").toUpperCase()}-${code}`;
      out.push({
        id: `prod_${1000 + i}`,
        name: `${strain} ${label}`,
        sku,
        upc: String(850000000000 + i * 7).padStart(12, "0"),
        category: { name: isPr ? "Pre-Roll" : "Flower" },
        strain: { name: strain },
        brand: { name: BRANDS[i % BRANDS.length] },
        vendor: { name: VENDORS[i % VENDORS.length] },
        unitType: { name: isPr ? "Each" : "Gram" },
        trackingMethod: "BATCH",
        unitPrice: isPr ? 12 : w === 7 ? 55 : 35,
        unitCost: isPr ? 5 : w === 7 ? 24 : 15,
        netWeight: w,
        netWeightUnit: { name: "Gram" },
        totalThc: 20 + (i % 10),
        cannabinoidUnit: "PERCENT",
        inactive: false,
        tenantId,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      });
      i++;
    }
  }
  // Ensure exactly 50: top up with edibles.
  while (out.length < 50) {
    out.push({ id: `prod_${1000 + i}`, name: `Wyld Gummies ${i}`, sku: `WG-${i}`, upc: null, category: { name: "Edible" }, unitType: { name: "Each" }, trackingMethod: "BATCH", unitPrice: 20, inactive: false, tenantId, updatedAt: new Date(Date.UTC(2026, 0, 2) + i * 60_000).toISOString() });
    i++;
  }
  return out;
}

export class McpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class MockDistru {
  products: MockProduct[];
  uploads: { importId: string; mode: string; headers: string[]; rows: Record<string, string>[]; at: string }[] = [];
  mutations: { importId?: string; id: string; product: Record<string, Json>; at: string }[] = [];
  /** Test hook: return an HTTP status to fail a mutate call for that product id. */
  failMutation?: (id: string, attempt: number) => number | undefined;
  /** Test hook: fail a search-products page (simulates a crash mid-snapshot). */
  failSearch?: (cursor: string | null) => boolean;
  searchCalls: { cursor: string | null; sorted: boolean }[] = [];
  /** Test hook: reject an upload before anything is written (simulates /upload-products being down). */
  rejectUpload?: () => boolean;
  /** Test hook: throw after applying an upload (simulates a crash before the checkpoint). */
  crashAfterUpload?: () => boolean;
  private attempts = new Map<string, number>();
  private seq = 5000;

  constructor(private tenantId = "tenant_demo", seed = true) {
    this.products = seed ? seedCatalog(tenantId) : [];
  }

  private now() {
    return new Date().toISOString();
  }

  /** MCP tool dispatcher (the subset the importer uses). */
  mcp = async (ctx: Ctx, tool: string, args: Record<string, any>): Promise<any> => {
    const mine = this.products.filter((p) => p.tenantId === ctx.tenantId);
    switch (tool) {
      case "distru-search-products": {
        this.searchCalls.push({ cursor: args.cursor ?? null, sorted: !!args.sortBy });
        if (this.failSearch?.(args.cursor ?? null)) throw new McpError(503, "search-products unavailable");
        const sorted = args.sortBy?.field === "UPDATED_AT" ? [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [...mine].sort((a, b) => a.id.localeCompare(b.id));
        const start = args.cursor ? Number(args.cursor) : 0;
        const limit = Number(args.limit ?? 500);
        const items = sorted.slice(start, start + limit);
        return { items, nextCursor: start + limit < sorted.length ? String(start + limit) : null };
      }
      case "distru-search-lookups": {
        const lists: Record<string, string[]> = {
          PRODUCT_CATEGORY: [...new Set([...CATEGORIES, ...mine.map((p) => p.category?.name).filter(Boolean) as string[]])],
          PRODUCT_GROUP: [...new Set([...GROUPS, ...mine.map((p) => p.group?.name).filter(Boolean) as string[]])],
          PRODUCT_TAG: TAGS,
          UNIT_TYPE: UNIT_TYPES,
        };
        return { items: (lists[args.type] ?? []).map((name) => ({ name })) };
      }
      case "distru-search-companies":
        return { items: (args.relationship === "BRAND" ? BRANDS : VENDORS).map((name) => ({ name })) };
      case "distru-search-users":
        return { items: USERS.map((name) => ({ name })) };
      case "distru-mutate-product": {
        const n = (this.attempts.get(args.id) ?? 0) + 1;
        this.attempts.set(args.id, n);
        const fail = this.failMutation?.(args.id, n);
        if (fail) throw new McpError(fail, `mutate-product failed with ${fail}`);
        const p = mine.find((x) => x.id === args.id);
        if (!p) throw new McpError(404, "Product not found");
        Object.assign(p, args.product, { updatedAt: this.now() });
        this.mutations.push({ id: args.id, product: args.product, at: this.now() });
        return { id: p.id };
      }
      default:
        throw new McpError(400, `Unknown tool ${tool}`);
    }
  };

  /** POST /upload-products. Returns the error CSV ("" when every row was accepted). */
  upload(tenantId: string, importId: string, mode: "create" | "update", csv: string): string {
    if (this.rejectUpload?.()) throw new McpError(503, "upload-products unavailable");
    const parsed = Papa.parse<Record<string, string>>(csv.trim(), { header: true });
    const headers = parsed.meta.fields ?? [];
    const rows = parsed.data;
    this.uploads.push({ importId, mode, headers, rows, at: this.now() });
    const errors: (Record<string, string> & { Row: string; Errors: string })[] = [];
    const byHeader = Object.fromEntries(Object.values(productSchema.fields).filter((f) => f.header).map((f) => [f.header!, f.name]));
    void byHeader;
    const mine = this.products.filter((p) => p.tenantId === tenantId);
    const skus = new Set(mine.map((p) => p.sku));
    const byId = new Map(mine.map((p) => [p.id, p]));
    rows.forEach((r, i) => {
      const fail = (msg: string) => errors.push({ ...r, Row: String(i + 1), Errors: msg });
      if (mode === "create" && !r.Name) return fail("Name is required");
      if (r.Vendor && !VENDORS.includes(r.Vendor)) return fail(`Vendor "${r.Vendor}" is not a company relationship`);
      if (r.Brand && !BRANDS.includes(r.Brand)) return fail(`Brand "${r.Brand}" is not a company relationship`);
      const blank = (v?: string) => (v === undefined || v === "" ? undefined : v === "##" ? null : v);
      const num = (v?: string) => { const b = blank(v); return b === undefined ? undefined : b === null ? null : Number(b); };
      const ref = (v?: string) => { const b = blank(v); return b === undefined ? undefined : b === null ? null : { name: b }; };
      const fields: Partial<MockProduct> = {
        name: blank(r.Name) ?? undefined, sku: blank(r.SKU), upc: blank(r.UPC), externalName: blank(r["External Name"]), description: blank(r.Description),
        category: ref(r["Product Category"]), subcategory: ref(r.Subcategory), group: ref(r.Group), strain: ref(r.Strain), vendor: ref(r.Vendor), brand: ref(r.Brand),
        owner: ref(r.Owner), unitType: ref(r["Unit Type Name"]), trackingMethod: blank(r["Tracking Method"])?.toUpperCase(),
        unitPrice: num(r["Unit Price"]), wholesalePrice: num(r["Wholesale Price"]), unitCost: num(r["Unit Cost"]), msrp: num(r.MSRP),
        unitsPerCase: num(r["Units per Case"]), netWeight: num(r["Net Quantity per Unit"]), servingSize: num(r["Serving Size"]),
        minThreshold: num(r["Min Threshold"]), maxThreshold: num(r["Max Threshold"]),
        featured: r.Featured ? r.Featured === "TRUE" : undefined, inactive: r.Inactive ? r.Inactive === "TRUE" : (undefined as any),
      };
      for (const k of Object.keys(fields) as (keyof MockProduct)[]) if (fields[k] === undefined) delete fields[k];
      if (mode === "create") {
        if (r.SKU && skus.has(r.SKU)) return fail(`SKU ${r.SKU} already exists`);
        if (r.SKU) skus.add(r.SKU);
        this.products.push({ id: `prod_${this.seq++}`, inactive: false, trackingMethod: "BATCH", sku: null, upc: null, ...fields, name: r.Name, tenantId, updatedAt: this.now() } as MockProduct);
      } else {
        const p = byId.get(r["Distru ID"]);
        if (!p) return fail("Distru ID not found");
        delete fields.trackingMethod;
        Object.assign(p, fields, { updatedAt: this.now() });
      }
    });
    if (this.crashAfterUpload?.()) throw new Error("simulated crash after upload");
    if (!errors.length) return "";
    return Papa.unparse(errors, { columns: [...headers, "Row", "Errors"] });
  }
}

/** The real Distru profile wired to a MockDistru: upload via an in-process fetch, MCP via mock.mcp. */
export async function mockFetchFor(mock: MockDistru): Promise<typeof fetch> {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const mode = (u.searchParams.get("mode") ?? "create") as "create" | "update";
    const headers = new Headers(init?.headers);
    const tenantId = headers.get("x-tenant-id") ?? "tenant_demo";
    const body = mock.upload(tenantId, headers.get("x-import-id") ?? "", mode, String(init?.body ?? ""));
    return new Response(body, { status: 200, headers: { "content-type": "text/csv" } });
  }) as typeof fetch;
}
