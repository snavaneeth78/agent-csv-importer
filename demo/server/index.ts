/**
 * Demo server: the real library on local Postgres + pg-boss, a mock Distru (POST /upload-products + MCP),
 * a rule-based chat agent that calls the real import_csv_* tools, and a REST stand-in for Distru's API.
 * Not the harness: no LangGraph agent loop, no auth, single tenant.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { ConflictError, StateError, toCsv, type Ctx } from "@distru/csv-importer/core";
import { MockDistru, createDistruProductProfile, productSchema } from "@distru/csv-importer/distru";
import { modelsFromEnv } from "@distru/csv-importer/scorers";
import { createImporter, registerHarness } from "@distru/csv-importer/workers";
import { createImporterTools, summarize } from "@distru/csv-importer/langgraph";
import { createAgent, type ChatMessage } from "./agent.ts";

try { process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url))); } catch { /* optional */ }

const PORT = Number(process.env.DEMO_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://distru:distru@localhost:54329/csv_import";
const ctx: Ctx = { tenantId: "tenant_demo", actor: "demo_user" };

const mock = new MockDistru(ctx.tenantId);
// Uploads and chat are kept on disk under demo/.data so a server restart doesn't orphan open imports.
const DATA_DIR = fileURLToPath(new URL("../.data/", import.meta.url));
mkdirSync(`${DATA_DIR}attachments`, { recursive: true });
const attachments = {
  set(id: string, a: { name: string; bytes: Buffer }) {
    writeFileSync(`${DATA_DIR}attachments/${id}`, a.bytes);
    writeFileSync(`${DATA_DIR}attachments/${id}.name`, a.name);
  },
  get(id: string): { name: string; bytes: Buffer } | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    try { return { name: readFileSync(`${DATA_DIR}attachments/${id}.name`, "utf8"), bytes: readFileSync(`${DATA_DIR}attachments/${id}`) }; } catch { return undefined; }
  },
};
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 20 });
const boss = new PgBoss({ connectionString: DATABASE_URL });
boss.on("error", (e) => console.error("[pg-boss]", e.message));
await boss.start();

const models = await modelsFromEnv();
const profile = createDistruProductProfile({
  uploadUrl: `${BASE}/upload-products`,
  mcp: mock.mcp,
  uploadHeaders: (c) => ({ "x-tenant-id": c.tenantId }),
});
const importer = createImporter({
  pool, boss, profiles: [profile], scorer: models.jev, llm: models.llm, config: { scorers: { timeoutMs: models.timeoutMs } } as any,
  disabledStages: process.env.LLM_STAGE === "off" ? ["llm"] : [],
});
await importer.migrate();
// The mock catalog lives in memory, so a restart must also drop the persisted snapshot of it.
await pool.query("DELETE FROM csv_import.catalog_snapshot WHERE tenant_id = $1", [ctx.tenantId]);
await pool.query("DELETE FROM csv_import.catalog_snapshot_state WHERE tenant_id = $1", [ctx.tenantId]);
await importer.work();

const tools = createImporterTools(importer, {
  // Distru owns storage: the attachment resolves to a URL the worker fetches.
  resolveAttachment: async (_c, id) => ({ input: { url: `${BASE}/attachments/${id}` }, filename: attachments.get(id)?.name ?? "upload.csv" }),
});
const agent = createAgent({ importer, tools, ctx, persistPath: `${DATA_DIR}chat.json` });

// harness.run: system-started turns post summaries into the thread when a gate is reached or the import ends.
await registerHarness(boss, importer.store, async ({ tenantId, runId, resume }) => {
  const v = await importer.get({ tenantId, actor: "system" }, resume.event.importId);
  agent.systemTurn(runId, v);
});

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use("/upload-products", express.text({ type: "*/*", limit: "60mb" }));

// ---- mock Distru
app.post("/upload-products", (req, res) => {
  const mode = req.query.mode === "update" ? "update" : "create";
  const rows = String(req.body).trim().split("\n").length - 1;
  console.log(`[distru] POST /upload-products mode=${mode} rows=${rows} import=${req.header("x-import-id")}`);
  const errors = mock.upload(req.header("x-tenant-id") ?? ctx.tenantId, req.header("x-import-id") ?? "", mode, String(req.body));
  res.type("text/csv").send(errors);
});
app.get("/attachments/:id", (req, res) => {
  const a = attachments.get(req.params.id);
  if (!a) return res.status(404).end();
  res.type("application/octet-stream").send(a.bytes);
});

// ---- chat
app.post("/api/chat", async (req, res, next) => {
  try {
    const { threadId, text, file } = (req.body ?? {}) as { threadId?: unknown; text?: unknown; file?: { name?: unknown; base64?: unknown } };
    if (typeof threadId !== "string" || !threadId || threadId.length > 128) return res.status(400).json({ error: "threadId is required" });
    if (text !== undefined && (typeof text !== "string" || text.length > 4000)) return res.status(400).json({ error: "text must be a string of at most 4000 characters" });
    if (file && (typeof file.name !== "string" || typeof file.base64 !== "string")) return res.status(400).json({ error: "file needs a name and base64 content" });
    let attachmentId: string | undefined;
    const fileName = file ? String(file.name).split(/[\\/]/).pop()!.slice(0, 255) : "";
    if (file) {
      attachmentId = randomUUID();
      attachments.set(attachmentId, { name: fileName, bytes: Buffer.from(String(file.base64), "base64") });
    }
    res.json({ messages: await agent.userTurn(threadId, text ?? "", attachmentId ? { id: attachmentId, name: fileName } : undefined) });
  } catch (e) { next(e); }
});
app.get("/api/threads/:threadId/messages", (req, res) => {
  const after = int(req.query.afterId) ?? 0;
  res.json(agent.messages(req.params.threadId).filter((m: ChatMessage) => m.id > after));
});

// ---- REST stand-in for Distru's API (see docs/api-integration.md)
const id = (req: Request) => String(req.params.id);
const route = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req)); } catch (e) { next(e); }
};
/** A non-negative integer query value, or undefined. */
const int = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : undefined);
const list = (v: unknown) => (v ? String(v).split(",") : undefined) as any;
app.get("/api/imports/:id", route((req) => importer.get(ctx, id(req))));
app.get("/api/imports/:id/summary", route(async (req) => summarize(await importer.get(ctx, id(req)))));
app.get("/api/imports/:id/events", route((req) => importer.events(ctx, id(req), { afterId: int(req.query.afterId) ?? 0 })));
app.get("/api/imports/:id/rows", route((req) => importer.listRows(ctx, id(req), {
  status: list(req.query.status), dupClass: list(req.query.dupClass), action: list(req.query.action),
  cursor: int(req.query.cursor), limit: int(req.query.limit),
})));
app.post("/api/imports/:id/revise", route((req) => importer.revise(ctx, id(req), { ...req.body, actor: "user" })));
app.post("/api/imports/:id/confirm-mapping", route((req) => importer.confirmMapping(ctx, id(req), { planVersion: req.body?.planVersion, actor: "user" })));
app.post("/api/imports/:id/row-actions", route((req) => importer.setRowActions(ctx, id(req), { ...req.body, actor: "user" })));
app.post("/api/imports/:id/edit-rows", route((req) => importer.editRows(ctx, id(req), { ...req.body, actor: "user" })));
app.post("/api/imports/:id/confirm-commit", route((req) => importer.confirmCommit(ctx, id(req), { planVersion: req.body?.planVersion, actor: "user" })));
app.post("/api/imports/:id/cancel", route((req) => importer.cancel(ctx, id(req), "user")));
app.post("/api/imports/:id/retry", route((req) => importer.retry(ctx, id(req))));
app.post("/api/imports/:id/retry-followups", route((req) => importer.retryFollowups(ctx, id(req))));
app.post("/api/imports/:id/skip-followups", route((req) => importer.skipFollowups(ctx, id(req))));
app.get("/api/imports/:id/errors.csv", async (req, res, next) => {
  try {
    res.attachment(`import-${id(req).slice(0, 8)}-errors.csv`).type("text/csv");
    res.send(await new Response(importer.errorCsv(ctx, id(req))).text());
  } catch (e) { next(e); }
});

/** What Distru received: template rows in templateHeaders order, plus the follow-up mutations. */
async function exported(importId: string) {
  const uploads = mock.uploads.filter((u) => u.importId === importId);
  const rows = uploads.flatMap((u) => u.rows.map((r) => Object.fromEntries(productSchema.templateHeaders.map((h) => [h, r[h] ?? ""]))));
  const ids = new Set<string>();
  for (let cursor: number | null | undefined = undefined; ;) {
    const page = await importer.listRows(ctx, importId, { status: ["committed", "needs_attention", "uploaded"], cursor, limit: 1000 });
    page.rows.forEach((r) => r.distruId && ids.add(r.distruId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const followups = mock.mutations.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, product: m.product }));
  return { headers: productSchema.templateHeaders, uploads: uploads.map((u) => ({ mode: u.mode, rows: u.rows.length, at: u.at })), rows, followups };
}
app.get("/api/imports/:id/export.json", route((req) => exported(id(req))));
app.get("/api/imports/:id/export.csv", async (req, res, next) => {
  try {
    const x = await exported(id(req));
    res.attachment(`import-${id(req).slice(0, 8)}-distru-template.csv`).type("text/csv").send(toCsv(x.headers, x.rows));
  } catch (e) { next(e); }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  // body-parser errors carry their own 4xx; a malformed import id is a pg "invalid uuid" (22P02).
  const own = Number(err?.status ?? err?.statusCode);
  const status = err instanceof ConflictError ? 409
    : err instanceof StateError ? (/not found/.test(err.message) ? 404 : 400)
    : err?.code === "22P02" ? 404
    : own >= 400 && own < 500 ? own : 500;
  if (status === 500) console.error(err);
  // Internal errors (SQL, stack details) stay in the server log.
  res.status(status).json({ error: status === 500 ? "Something went wrong on the server. Try again." : err?.code === "22P02" ? "Import not found" : err?.message ?? String(err) });
});

// Local demo with no auth: listen on loopback only, never the LAN.
// If the port is taken, another demo is running: exit instead of staying up as a second set of job workers on the same
// queue. Two servers each have their own in-memory MockDistru, so jobs picked up by the other one fail with 404s.
app.listen(PORT, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`demo server: can't listen on ${BASE} (${err.message}). Is another demo already running? Stop it first.`);
    process.exit(1);
  }
  console.log(`demo server on ${BASE}  (models: jev=${models.real.jev || "mock"}, llm=${models.real.llm || "mock"}, llm step ${importer.stageEnabled("llm") ? "on" : "off"}; mock catalog: ${mock.products.length} products)`);
});
