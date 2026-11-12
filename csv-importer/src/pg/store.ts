import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import type {
  CatalogProduct, ChunkRecord, ImportEvent, ImportRecord, MemoryEntry, Repos, RowPatch, RowRecord, Store,
} from "../core/index.ts";
import { normValue } from "../core/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface DB {
  imports: Row;
  import_rows: Row;
  import_events: Row;
  import_chunks: Row;
  import_files: Row;
  catalog_snapshot: Row;
  catalog_snapshot_state: Row;
  column_memory: Row;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const j = (v: unknown) => JSON.stringify(v ?? null);
const iso = (d: any) => (d instanceof Date ? d.toISOString() : d ?? null);

function toImport(r: Row): ImportRecord {
  return {
    id: r.id, tenantId: r.tenant_id, createdBy: r.created_by, threadId: r.thread_id, source: r.source, targetId: r.target_id,
    targetVersion: r.target_version, status: r.status, plan: r.plan, planVersion: r.plan_version, stats: r.stats ?? {},
    error: r.error, refs: r.refs, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

function toRow(r: Row): RowRecord {
  return {
    rowIndex: r.row_index, raw: r.raw, output: r.output, overrides: r.overrides, issues: r.issues ?? [], sku: r.sku,
    distruId: r.distru_id, dupClass: r.dup_class, action: r.action, status: r.status, followup: r.followup, meta: r.meta ?? {},
  };
}

function toProduct(r: Row): CatalogProduct {
  return { distruId: r.distru_id, sku: r.sku, upc: r.upc, name: r.name, values: r.values, updatedAt: iso(r.distru_updated_at) };
}

function repos(db: Transaction<DB>, tenantId: string): Repos {
  const t = db.withSchema("csv_import");
  return {
    async insertImport(rec) {
      const r = await t.insertInto("imports").values({
        tenant_id: tenantId, created_by: rec.createdBy, thread_id: rec.threadId, source: j(rec.source), target_id: rec.targetId,
        target_version: rec.targetVersion, status: rec.status, plan: j(rec.plan), plan_version: rec.planVersion, stats: j(rec.stats),
        error: j(rec.error), refs: j(rec.refs),
      }).returningAll().executeTakeFirstOrThrow();
      return toImport(r);
    },
    async getImport(id, opts) {
      let q = t.selectFrom("imports").selectAll().where("id", "=", id).where("tenant_id", "=", tenantId);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toImport(r) : null;
    },
    async findOpenImportBySha(targetId, sha256) {
      const r = await t.selectFrom("imports").selectAll().where("tenant_id", "=", tenantId).where("target_id", "=", targetId)
        .where(sql`source->>'sha256'`, "=", sha256)
        .where("status", "not in", ["completed", "partially_completed", "failed", "cancelled"]).executeTakeFirst();
      return r ? toImport(r) : null;
    },
    async updateImport(id, patch) {
      const set: Row = { updated_at: sql`now()` };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.plan !== undefined) set.plan = j(patch.plan);
      if (patch.planVersion !== undefined) set.plan_version = patch.planVersion;
      if (patch.stats !== undefined) set.stats = j(patch.stats);
      if (patch.error !== undefined) set.error = j(patch.error);
      if (patch.refs !== undefined) set.refs = j(patch.refs);
      if (patch.source !== undefined) set.source = j(patch.source);
      await t.updateTable("imports").set(set).where("id", "=", id).where("tenant_id", "=", tenantId).execute();
    },
    async listOpenImports(threadId) {
      let q = t.selectFrom("imports").selectAll().where("tenant_id", "=", tenantId)
        .where("status", "not in", ["completed", "partially_completed", "failed", "cancelled"]).orderBy("created_at", "desc");
      if (threadId) q = q.where("thread_id", "=", threadId);
      return (await q.execute()).map(toImport);
    },

    async appendEvent(importId, type, actor, payload) {
      const r = await t.insertInto("import_events").values({ import_id: importId, tenant_id: tenantId, type, actor, payload: j(payload) })
        .returning("id").executeTakeFirstOrThrow();
      return Number(r.id);
    },
    async listEvents(importId, afterId, limit) {
      const rows = await t.selectFrom("import_events").selectAll().where("import_id", "=", importId).where("tenant_id", "=", tenantId)
        .where("id", ">", afterId).orderBy("id").limit(limit).execute();
      return rows.map((r): ImportEvent => ({ id: Number(r.id), importId: r.import_id, type: r.type, actor: r.actor, payload: r.payload, createdAt: iso(r.created_at) }));
    },

    async insertRows(importId, rows) {
      for (let i = 0; i < rows.length; i += 2000) {
        const batch = rows.slice(i, i + 2000).map((r) => ({ i: r.rowIndex, r: r.raw, m: r.meta }));
        await sql`INSERT INTO csv_import.import_rows (import_id, row_index, tenant_id, raw, meta)
          SELECT ${importId}::uuid, (x->>'i')::int, ${tenantId}, x->'r', x->'m' FROM jsonb_array_elements(${j(batch)}::jsonb) x`.execute(db);
      }
    },
    async deleteRows(importId) {
      await t.deleteFrom("import_rows").where("import_id", "=", importId).where("tenant_id", "=", tenantId).execute();
    },
    async sampleRaw(importId, limit) {
      const rows = await t.selectFrom("import_rows").select("raw").where("import_id", "=", importId).orderBy("row_index").limit(limit).execute();
      return rows.map((r) => r.raw);
    },
    async distinctRaw(importId, column, limit) {
      const rows = await sql<{ v: string }>`SELECT DISTINCT raw->>${column} AS v FROM csv_import.import_rows
        WHERE import_id = ${importId}::uuid AND tenant_id = ${tenantId} AND coalesce(raw->>${column}, '') <> '' LIMIT ${limit}`.execute(db);
      return rows.rows.map((r) => r.v);
    },
    async rowsInRange(importId, from, to) {
      const rows = await t.selectFrom("import_rows").selectAll().where("import_id", "=", importId).where("tenant_id", "=", tenantId)
        .where("row_index", ">=", from).where("row_index", "<=", to).orderBy("row_index").execute();
      return rows.map(toRow);
    },
    async getRows(importId, idx) {
      if (!idx.length) return [];
      const rows = await t.selectFrom("import_rows").selectAll().where("import_id", "=", importId).where("tenant_id", "=", tenantId)
        .where("row_index", "in", idx).orderBy("row_index").execute();
      return rows.map(toRow);
    },
    async listRows(importId, q) {
      let s = t.selectFrom("import_rows").selectAll().where("import_id", "=", importId).where("tenant_id", "=", tenantId);
      if (q.status?.length) s = s.where("status", "in", q.status);
      if (q.action?.length) s = s.where("action", "in", q.action);
      if (q.dupClass?.length) s = s.where("dup_class", "in", q.dupClass);
      if (q.followup !== undefined) s = s.where("followup", "=", q.followup);
      if (q.afterRowIndex !== undefined) s = s.where("row_index", ">", q.afterRowIndex);
      return (await s.orderBy("row_index").limit(q.limit).execute()).map(toRow);
    },
    async updateRows(importId, patches: RowPatch[]) {
      for (let i = 0; i < patches.length; i += 2000) {
        const batch = patches.slice(i, i + 2000);
        await sql`UPDATE csv_import.import_rows r SET
            output    = CASE WHEN x.p ? 'output' THEN x.p->'output' ELSE r.output END,
            overrides = CASE WHEN x.p ? 'overrides' THEN x.p->'overrides' ELSE r.overrides END,
            issues    = CASE WHEN x.p ? 'issues' THEN x.p->'issues' ELSE r.issues END,
            sku       = CASE WHEN x.p ? 'sku' THEN x.p->>'sku' ELSE r.sku END,
            distru_id = CASE WHEN x.p ? 'distruId' THEN x.p->>'distruId' ELSE r.distru_id END,
            dup_class = CASE WHEN x.p ? 'dupClass' THEN x.p->>'dupClass' ELSE r.dup_class END,
            action    = CASE WHEN x.p ? 'action' THEN x.p->>'action' ELSE r.action END,
            status    = CASE WHEN x.p ? 'status' THEN x.p->>'status' ELSE r.status END,
            followup  = CASE WHEN x.p ? 'followup' THEN (x.p->>'followup')::boolean ELSE r.followup END,
            meta      = CASE WHEN x.p ? 'meta' THEN jsonb_strip_nulls(r.meta || (x.p->'meta')) ELSE r.meta END
          FROM (SELECT (e->>'rowIndex')::int AS row_index, e AS p FROM jsonb_array_elements(${j(batch)}::jsonb) e) x
          WHERE r.import_id = ${importId}::uuid AND r.tenant_id = ${tenantId} AND r.row_index = x.row_index`.execute(db);
      }
    },
    async rowKeys(importId) {
      const rows = await t.selectFrom("import_rows").select(["row_index", "sku", "distru_id", "status"]).where("import_id", "=", importId)
        .where("tenant_id", "=", tenantId).execute();
      return rows.map((r) => ({ rowIndex: r.row_index, sku: r.sku, distruId: r.distru_id, status: r.status }));
    },
    async counts(importId) {
      const rows = await t.selectFrom("import_rows").select(["status", "action", "dup_class", "followup", sql<string>`count(*)`.as("n")])
        .where("import_id", "=", importId).where("tenant_id", "=", tenantId).groupBy(["status", "action", "dup_class", "followup"]).execute();
      return rows.map((r) => ({ status: r.status, action: r.action, dupClass: r.dup_class, followup: r.followup, n: Number(r.n) }));
    },
    async historyForSkus(importId, skus) {
      const out = new Map<string, { importId: string; date: string }>();
      if (!skus.length) return out;
      const rows = await sql<Row>`SELECT r.sku, r.import_id, i.updated_at FROM csv_import.import_rows r
        JOIN csv_import.imports i ON i.id = r.import_id
        WHERE r.tenant_id = ${tenantId} AND r.status = 'committed' AND r.sku = ANY(${skus}) AND r.import_id <> ${importId}::uuid
        ORDER BY i.updated_at DESC`.execute(db);
      for (const r of rows.rows) if (!out.has(r.sku)) out.set(r.sku, { importId: r.import_id, date: iso(r.updated_at) });
      return out;
    },

    async issueCounts(importId) {
      const rows = await sql<Row>`SELECT i->>'code' AS code, i->>'field' AS field, i->>'severity' AS severity, count(*)::int AS n,
          min(i->>'message') AS example, min(r.row_index) AS first_row
        FROM csv_import.import_rows r, jsonb_array_elements(r.issues) i
        WHERE r.import_id = ${importId}::uuid AND r.tenant_id = ${tenantId} AND r.status IN ('invalid', 'failed', 'needs_attention', 'valid')
        GROUP BY 1, 2, 3 ORDER BY (i->>'severity') = 'error' DESC, count(*) DESC LIMIT 12`.execute(db);
      return rows.rows.map((r) => ({ code: r.code, field: r.field || null, severity: r.severity, n: r.n, example: r.example, firstRow: r.first_row }));
    },
    async getChunk(importId, stage, chunkIndex) {
      const r = await t.selectFrom("import_chunks").selectAll().where("import_id", "=", importId).where("stage", "=", stage)
        .where("chunk_index", "=", chunkIndex).executeTakeFirst();
      return r ? { stage: r.stage, chunkIndex: r.chunk_index, planVersion: r.plan_version, status: r.status, attempts: r.attempts, response: r.response } : null;
    },
    async upsertChunk(importId, c) {
      await t.insertInto("import_chunks").values({
        import_id: importId, tenant_id: tenantId, stage: c.stage, chunk_index: c.chunkIndex, plan_version: c.planVersion,
        status: c.status, attempts: c.attempts, response: j(c.response),
      }).onConflict((oc) => oc.columns(["import_id", "stage", "chunk_index"]).doUpdateSet({
        plan_version: c.planVersion, status: c.status, attempts: c.attempts, response: j(c.response),
      })).execute();
    },
    async listChunks(importId, stage) {
      const rows = await t.selectFrom("import_chunks").selectAll().where("import_id", "=", importId).where("stage", "=", stage).orderBy("chunk_index").execute();
      return rows.map((r): ChunkRecord => ({ stage: r.stage, chunkIndex: r.chunk_index, planVersion: r.plan_version, status: r.status, attempts: r.attempts, response: r.response }));
    },
    async deleteChunks(importId, stage) {
      let q = t.deleteFrom("import_chunks").where("import_id", "=", importId).where("tenant_id", "=", tenantId);
      if (stage) q = q.where("stage", "=", stage);
      await q.execute();
    },

    async getMemory(targetId, headerNorms) {
      if (!headerNorms.length) return [];
      const rows = await t.selectFrom("column_memory").selectAll().where("tenant_id", "=", tenantId).where("target_id", "=", targetId)
        .where("header_norm", "in", headerNorms).execute();
      return rows.map((r): MemoryEntry => ({ headerNorm: r.header_norm, targetField: r.target_field, transforms: r.transforms, typeSig: r.type_sig, hits: r.hits }));
    },
    async putMemory(targetId, entries) {
      for (const e of entries) {
        await t.insertInto("column_memory").values({
          tenant_id: tenantId, target_id: targetId, header_norm: e.headerNorm, target_field: e.targetField, transforms: j(e.transforms), type_sig: e.typeSig,
        }).onConflict((oc) => oc.columns(["tenant_id", "target_id", "header_norm"]).doUpdateSet({
          target_field: e.targetField, transforms: j(e.transforms), type_sig: e.typeSig, hits: sql`csv_import.column_memory.hits + 1`, last_used_at: sql`now()`,
        })).execute();
      }
    },

    async getSnapshotState() {
      const r = await t.selectFrom("catalog_snapshot_state").selectAll().where("tenant_id", "=", tenantId).executeTakeFirst();
      return r ? { status: r.status, cursor: r.cursor, refreshedAt: iso(r.refreshed_at) } : null;
    },
    async setSnapshotState(s) {
      const v: Row = { tenant_id: tenantId, status: s.status, cursor: s.cursor };
      if (s.refreshedAt !== undefined) v.refreshed_at = s.refreshedAt;
      const { tenant_id, ...upd } = v;
      void tenant_id;
      await t.insertInto("catalog_snapshot_state").values(v).onConflict((oc) => oc.column("tenant_id").doUpdateSet(upd)).execute();
    },
    async upsertSnapshot(products) {
      if (!products.length) return;
      const batch = products.map((p) => ({ id: p.distruId, sku: p.sku, upc: p.upc, name: p.name, nn: normValue(p.name), v: p.values, u: p.updatedAt }));
      await sql`INSERT INTO csv_import.catalog_snapshot (tenant_id, distru_id, sku, upc, name, name_norm, values, distru_updated_at)
        SELECT ${tenantId}, x->>'id', x->>'sku', x->>'upc', x->>'name', x->>'nn', x->'v', (x->>'u')::timestamptz FROM jsonb_array_elements(${j(batch)}::jsonb) x
        ON CONFLICT (tenant_id, distru_id) DO UPDATE SET sku = EXCLUDED.sku, upc = EXCLUDED.upc, name = EXCLUDED.name,
          name_norm = EXCLUDED.name_norm, values = EXCLUDED.values, distru_updated_at = EXCLUDED.distru_updated_at`.execute(db);
    },
    async clearSnapshot() {
      await t.deleteFrom("catalog_snapshot").where("tenant_id", "=", tenantId).execute();
    },
    async snapshotLookup(q) {
      const ids = q.ids ?? [], skus = (q.skus ?? []).map((s) => s.toUpperCase()), names = q.names ?? [];
      if (!ids.length && !skus.length && !names.length) return [];
      const rows = await sql<Row>`SELECT * FROM csv_import.catalog_snapshot WHERE tenant_id = ${tenantId}
        AND (distru_id = ANY(${ids}) OR upper(sku) = ANY(${skus}) OR name_norm = ANY(${names}))`.execute(db);
      return rows.rows.map(toProduct);
    },
    async snapshotDistinct(field) {
      const rows = await sql<{ v: string }>`SELECT DISTINCT values->>${field} AS v FROM csv_import.catalog_snapshot
        WHERE tenant_id = ${tenantId} AND coalesce(values->>${field}, '') <> '' LIMIT 5000`.execute(db);
      return rows.rows.map((r) => r.v);
    },

    async putFile(importId, bytes) {
      await t.insertInto("import_files").values({ import_id: importId, tenant_id: tenantId, bytes: Buffer.from(bytes) })
        .onConflict((oc) => oc.column("import_id").doUpdateSet({ bytes: Buffer.from(bytes) })).execute();
    },
    async getFile(importId) {
      const r = await t.selectFrom("import_files").select("bytes").where("import_id", "=", importId).executeTakeFirst();
      return r ? new Uint8Array(r.bytes) : null;
    },
    async deleteFile(importId) {
      await t.deleteFrom("import_files").where("import_id", "=", importId).execute();
    },
  };
}

export class PgStore implements Store {
  db: Kysely<DB>;
  constructor(public pool: pg.Pool) {
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }

  /** withTenant(tenantId, fn): one transaction, `SET LOCAL ROLE csv_import_app` + `app.tenant_id`, so RLS applies. */
  tx<T>(tenantId: string, fn: (r: Repos) => Promise<T>): Promise<T> {
    if (!tenantId) throw new Error("tenantId is required");
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      await sql`SET LOCAL ROLE csv_import_app`.execute(trx);
      return fn(repos(trx, tenantId));
    });
  }

  async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext('csv_import_migrate'))");
      await c.query("CREATE SCHEMA IF NOT EXISTS csv_import; CREATE TABLE IF NOT EXISTS csv_import._migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())");
      const done = new Set((await c.query("SELECT name FROM csv_import._migrations")).rows.map((r) => r.name));
      for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
        if (done.has(f)) continue;
        await c.query("BEGIN");
        await c.query(readFileSync(join(MIGRATIONS, f), "utf8"));
        await c.query("INSERT INTO csv_import._migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      }
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('csv_import_migrate'))").catch(() => {});
      c.release();
    }
  }

  /** Highest event id, where the harness event tail starts. */
  async lastEventId(): Promise<number> {
    const r = await this.pool.query("SELECT COALESCE(max(id), 0) AS id FROM csv_import.import_events");
    return Number(r.rows[0].id);
  }

  /** System role (owner, no RLS): ids only, for the harness event tail. `status` is the status the event moved to. */
  async eventsAfter(afterId: number, limit: number) {
    const r = await this.pool.query(
      `SELECT e.id, e.type, e.import_id, i.tenant_id, i.thread_id, COALESCE(e.payload->>'to', i.status) AS status FROM csv_import.import_events e
       JOIN csv_import.imports i ON i.id = e.import_id WHERE e.id > $1 ORDER BY e.id LIMIT $2`, [afterId, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), type: x.type, importId: x.import_id, tenantId: x.tenant_id, threadId: x.thread_id, status: x.status }));
  }
}
