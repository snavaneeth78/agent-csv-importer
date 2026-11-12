import { defineTarget, f } from "../core/index.ts";

export const PRODUCT_TYPES = [
  "flower", "pre_roll", "vape", "concentrate", "edible", "beverage", "tincture", "topical", "capsule", "seed_clone", "accessory", "other",
];

/**
 * Distru product target (tech spec §3). Editing this file is the only change needed when Distru's
 * template changes. templateHeaders holds H fields only; M fields go through follow-up.
 */
export const productSchema = defineTarget({
  id: "distru.product",
  version: 1,
  uniqueKey: "sku",
  idField: "distru_id",
  nameField: "name",
  immutable: ["tracking_method"],
  sections: [
    { title: "Identity", fields: ["name", "sku", "upc", "distru_id", "external_name", "description"] },
    { title: "Classification", fields: ["product_type", "category", "subcategory", "group", "strain", "tags"] },
    { title: "Companies & people", fields: ["vendor", "brand", "owner"] },
    { title: "Pricing", fields: ["unit_price", "wholesale_price", "unit_cost", "msrp", "currency"] },
    { title: "Size", fields: ["net_weight", "net_weight_unit", "serving_size"] },
    { title: "Potency", fields: ["total_thc", "total_cbd", "cannabinoid_unit"] },
    { title: "Units & inventory", fields: ["unit_type", "tracking_method", "units_per_case", "threshold_min", "threshold_max"] },
    { title: "Status", fields: ["active", "featured"] },
  ],
  templateHeaders: [
    "Distru ID", "Name", "SKU", "UPC", "External Name", "Description",
    "Product Category", "Subcategory", "Group", "Strain", "Vendor", "Brand", "Owner",
    "Unit Type Name", "Tracking Method",
    "Unit Price", "Wholesale Price", "Unit Cost", "MSRP", "Units per Case",
    "Net Quantity per Unit", "Serving Size",
    "Min Threshold", "Max Threshold", "Featured", "Inactive",
  ],
  ignoredHeaders: [
    { header: "Image", reason: "Images are not imported in v1" },
    { header: "Image URL", reason: "Images are not imported in v1" },
    { header: "Initial Inventory", reason: "Initial inventory is not imported in v1" },
    { header: "Initial Inventory Location", reason: "Initial inventory is not imported in v1" },
    { header: "Location", reason: "Initial inventory is not imported in v1" },
    { header: "LeafLink Product", reason: "LeafLink product is not imported in v1" },
  ],
  fields: {
    distru_id: f.string().header("Distru ID").synonyms(["distru id", "product id"]),
    name: f.string().required().header("Name").synonyms(["item", "title", "product", "product name", "item name", "product title"]),
    sku: f.string().max(64).header("SKU").synonyms(["sku", "item number", "code", "part number", "item code", "sku number"]).warnIf(["whitespace", "sci_notation", "looks_like_barcode"]),
    upc: f.string().header("UPC").pattern("upc").synonyms(["upc", "barcode", "gtin", "ean", "upc code"]),
    external_name: f.string().header("External Name").synonyms(["display name", "menu name", "alt name"]),
    description: f.string().header("Description").synonyms(["description", "notes", "details", "desc"]),
    product_type: f.enum(PRODUCT_TYPES).src("importer").synonyms(["type", "product type", "form"]),
    category: f.ref("PRODUCT_CATEGORY", "auto_create").header("Product Category").synonyms(["category", "product category", "class"]),
    subcategory: f.ref("SUBCATEGORY", "auto_create").header("Subcategory").synonyms(["subcategory", "sub category"]),
    group: f.ref("PRODUCT_GROUP", "auto_create").header("Group").synonyms(["group", "product group", "line"]),
    strain: f.ref("STRAIN", "auto_create").header("Strain").synonyms(["strain", "genetics", "cultivar"]),
    vendor: f.ref("VENDOR", "must_exist").header("Vendor").synonyms(["vendor", "supplier", "cultivator", "grower", "producer", "farm"]),
    brand: f.ref("BRAND", "must_exist").header("Brand").synonyms(["brand", "manufacturer", "label"]),
    owner: f.ref("USER", "must_exist").header("Owner").synonyms(["owner", "rep", "account manager"]),
    unit_type: f.ref("UNIT_TYPE", "must_exist").header("Unit Type Name").synonyms(["uom", "unit", "sold by", "unit type", "unit of measure"]),
    tracking_method: f.enum(["product", "batch", "package"]).header("Tracking Method").default("batch").synonyms(["tracking", "inventory tracking"]),
    currency: f.currency().src("importer").default("USD").synonyms(["currency", "cur", "ccy"]),
    unit_price: f.money().header("Unit Price").synonyms(["price", "retail", "sale price", "retail price"]),
    wholesale_price: f.money().header("Wholesale Price").synonyms(["wholesale", "wholesale price", "b2b price"]),
    unit_cost: f.money().header("Unit Cost").synonyms(["cost", "unit cost", "cogs"]),
    msrp: f.money().header("MSRP").synonyms(["msrp", "list price", "srp"]),
    units_per_case: f.integer().header("Units per Case").synonyms(["case qty", "units case", "case pack", "case quantity"]),
    net_weight: f.number().header("Net Quantity per Unit").group("weight").pattern("quantity").unitField("net_weight_unit").servingField("serving_size").extractFrom("name")
      .synonyms(["weight", "size", "net wt", "net qty", "net weight", "net quantity"]),
    serving_size: f.number().header("Serving Size").group("weight").synonyms(["serving", "serving size", "per serving"]),
    net_weight_unit: f.ref("UNIT_TYPE", "must_exist").header("Net Quantity Unit").src("M").group("weight").synonyms(["weight unit", "size unit", "net quantity unit"]),
    total_thc: f.number().header("Total THC").src("M").group("potency").pattern("potency").unitField("cannabinoid_unit").synonyms(["thc", "total thc", "thca", "thc percent", "potency", "thc potency"]),
    total_cbd: f.number().header("Total CBD").src("M").group("potency").pattern("potency").unitField("cannabinoid_unit").synonyms(["cbd", "total cbd", "cbd percent"]),
    cannabinoid_unit: f.enum(["MG", "PERCENT"]).header("Cannabinoid Unit").src("M").group("potency").synonyms(["cannabinoid unit", "potency unit", "thc unit"]),
    threshold_min: f.number().header("Min Threshold").synonyms(["min", "reorder point", "par", "min stock"]),
    threshold_max: f.number().header("Max Threshold").synonyms(["max", "max stock"]),
    featured: f.bool().header("Featured").synonyms(["featured", "highlight"]),
    active: f.bool().header("Inactive").invert().default(true).synonyms(["active", "status", "enabled"]).invertedSynonyms(["inactive", "discontinued", "disabled", "archived"]),
    tags: f.refList("PRODUCT_TAG", "must_exist").header("Tags").src("M").synonyms(["tags", "labels"]),
  },
});
