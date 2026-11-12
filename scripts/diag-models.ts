/** Calls Jev and the LLM directly on a few columns and prints raw results or errors. Run: npx tsx scripts/diag-models.ts */
import { profileColumns } from "@distru/csv-importer/core";
import { productSchema } from "@distru/csv-importer/distru";
import { describeField, modelsFromEnv, redact } from "@distru/csv-importer/scorers";

try { process.loadEnvFile(".env"); } catch { /* optional */ }
const m = await modelsFromEnv();
console.log("models", m.real);
const rows = [
  { Value: "45", Origin: "Green Leaf", Strength: "22%", Count: "12" },
  { Value: "80", Origin: "Sunrise", Strength: "24%", Count: "6" },
  { Value: "15", Origin: "Green Leaf", Strength: "20%", Count: "24" },
  { Value: "220", Origin: "Coastal", Strength: "20%", Count: "2" },
];
const cols = profileColumns(["Value", "Origin", "Strength", "Count"], rows);
const fields = Object.values(productSchema.fields);
const t0 = Date.now();
try {
  const r = await m.jev.choose(cols.map((c) => ({
    id: c.source, state: { header: c.source, samples: c.samples, valueType: c.typeSig },
    options: [...fields.map((f) => ({ id: f.name, label: f.header ?? f.name.replace(/_/g, " "), hint: describeField(f) })), { id: "none", label: "Not a product field" }],
  })));
  for (const [k, p] of Object.entries(r)) console.log("JEV", k, Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, v]) => `${o}=${v.toFixed(2)}`).join(" "));
  console.log("JEV ms", Date.now() - t0, "answered", Object.keys(r).length, "of", cols.length);
} catch (e) { console.log("JEV ERROR", redact(e)); }
const t1 = Date.now();
try {
  const r = await m.llm.mapColumns({ columns: cols.map((c) => ({ source: c.source, samples: c.samples, typeSig: c.typeSig })), fields: fields.map((f) => ({ name: f.name, label: f.header ?? f.name, type: describeField(f), synonyms: f.synonyms })) });
  console.log("LLM ms", Date.now() - t1, JSON.stringify(r));
} catch (e) { console.log("LLM ERROR", redact(e)); }
