/**
 * Matching eval: per-fixture field precision/recall, share of columns resolved per stage, per-stage precision,
 * and latency against the §4.1 targets. Mock Jev/LLM by default; USE_REAL_MODELS=1 with keys uses real ones.
 * Run: npm run eval
 */
import { readFileSync, readdirSync } from "node:fs";
import { buildTable, normalizeHeader, parseFile, profileColumns, resolveConfig, runCascade, type MatchStage, type Method } from "@distru/csv-importer/core";
import { productSchema } from "@distru/csv-importer/distru";
import { defaultStages, modelsFromEnv } from "@distru/csv-importer/scorers";

try { process.loadEnvFile(".env"); } catch { /* optional */ }
const models = await modelsFromEnv();
const config = resolveConfig({ scorers: { timeoutMs: models.timeoutMs } } as any);
const vocabulary = new Set(Object.values(productSchema.fields).flatMap((f) => [f.name.replace(/_/g, " "), f.header ?? "", ...f.synonyms].map(normalizeHeader)));

const timed = (stages: MatchStage[], ms: Record<string, number>) =>
  stages.map((s) => ({ ...s, run: async (i: Parameters<MatchStage["run"]>[0]) => { const t = performance.now(); const r = await s.run(i); ms[s.method] = (ms[s.method] ?? 0) + performance.now() - t; return r; } }));

const stageTotals: Record<string, { n: number; correct: number }> = {};
let suggested = 0, suggestedRight = 0;
let tp = 0, fp = 0, fn = 0, cols = 0, llmCols = 0;
const rows: string[][] = [];
const latency = { deterministic: [] as number[], jev: [] as number[], llm: [] as number[] };

for (const f of readdirSync("fixtures/expected").filter((x) => x.endsWith(".json")).sort()) {
  const name = f.replace(/\.json$/, "");
  const expected: Record<string, string | null> = JSON.parse(readFileSync(`fixtures/expected/${f}`, "utf8"));
  const file = readdirSync("fixtures").find((x) => x.startsWith(name + "."))!;
  const table = buildTable(parseFile(new Uint8Array(readFileSync(`fixtures/${file}`))), { vocabulary, maxRows: config.limits.maxRows });
  const columns = profileColumns(table.headers, table.rows.map((r) => r.cells));
  const ms: Record<string, number> = {};
  const res = await runCascade({ ctx: { tenantId: "eval", actor: "eval" }, target: productSchema, columns, memory: [], config, stages: timed(defaultStages({ config, jev: models.jev, llm: process.env.EVAL_NO_LLM === "1" ? undefined : models.llm }), ms) });
  latency.deterministic.push(["template", "memory", "exact", "pattern", "fuzzy"].reduce((s, k) => s + (ms[k] ?? 0), 0));
  if (ms.jev !== undefined) latency.jev.push(ms.jev);
  if (ms.llm !== undefined) latency.llm.push(ms.llm);

  const got = new Map(res.fields.map((m) => [m.sources[0], m]));
  let ftp = 0, ffp = 0, ffn = 0;
  for (const [header, want] of Object.entries(expected)) {
    cols++;
    const m = got.get(header);
    const method: Method | "none" | "jev suggest" = m?.needsConfirm ? "jev suggest" : m?.method ?? "none";
    if (m?.method === "llm" || res.ignored.find((i) => i.source === header)?.reason.startsWith("LLM")) llmCols++;
    const ok = (m?.target ?? null) === want;
    stageTotals[method] ??= { n: 0, correct: 0 };
    stageTotals[method].n++;
    if (ok) stageTotals[method].correct++;
    if (m && ok) ftp++;
    if (m && !ok) ffp++;
    if (want && !ok) ffn++;
    if (m?.needsConfirm) { suggested++; if (ok) suggestedRight++; }
    if (!ok) console.log(`  miss ${name}: "${header}" -> ${m?.target ?? "none"} (want ${want ?? "none"}, ${method}${m?.needsConfirm ? ", shown to the user to confirm" : ""})`);
  }
  tp += ftp; fp += ffp; fn += ffn;
  rows.push([name, String(Object.keys(expected).length), pct(ftp / (ftp + ffp)), pct(ftp / (ftp + ffn))]);
}

function pct(x: number) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a"; }
const p95 = (a: number[]) => (a.length ? `${[...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]?.toFixed(1) ?? a.at(-1)!.toFixed(1)} ms` : "n/a");
const table = (head: string[], body: string[][]) => [head, ...body].map((r) => r.map((c, i) => c.padEnd(Math.max(...[head, ...body].map((x) => x[i].length)))).join("  ")).join("\n");

console.log(`\nModels: jev=${models.real.jev || "mock"}, llm=${process.env.EVAL_NO_LLM === "1" ? "off" : models.real.llm || "mock"}\n`);
console.log(table(["fixture", "columns", "precision", "recall"], [...rows, ["ALL", String(cols), pct(tp / (tp + fp)), pct(tp / (tp + fn))]]));
console.log("\n" + table(["stage", "columns", "share", "precision"], Object.entries(stageTotals).map(([k, v]) => [k, String(v.n), pct(v.n / cols), pct(v.correct / v.n)])));
console.log("\n" + table(["target", "goal", "measured"], [
  ["stages 0-4 latency (p95)", "< 300 ms", p95(latency.deterministic)],
  ["Jev latency (p95)", "< 1 s", p95(latency.jev)],
  ["LLM latency (p95)", "< 5 s", p95(latency.llm)],
  ["columns reaching the LLM", "< 20%", pct(llmCols / cols)],
]));
console.log(`\nJev suggestions (40-75%, user confirms): ${suggested}, right ${suggestedRight} (${pct(suggestedRight / suggested)}). Excluding them, auto-accepted precision is ${pct((tp - suggestedRight) / (tp - suggestedRight + fp - (suggested - suggestedRight)))}.`);
