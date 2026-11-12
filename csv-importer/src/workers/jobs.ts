import { createHash } from "node:crypto";
import {
  addUsage, type ModelUsage,
  FileRejected, FollowupError, ImportService, Q, buildTable, chunkRanges, emptyPlan, finalizePlan, followupValues, indexCatalog,
  markFileDuplicates, normSku, normValue, normalizeHeader, parseFile, prepareRows, profileColumns, runCascade, toTemplateRow,
  type Ctx, type ImportRecord, type ImporterConfig, type Json, type MatchStage, type Question, type Queue, type RowPatch,
  type RowRecord, type Repos, type Store, type Candidate, type TargetProfile, type ValueStage,
} from "../core/index.ts";
import { RateLimiter } from "./limiter.ts";

export interface JobDeps {
  store: Store;
  queue: Queue;
  service: ImportService;
  config: ImporterConfig;
  stages: MatchStage[];
  valueStages: ValueStage[];
  fetch?: typeof fetch;
}

type Payload = { tenantId: string; importId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Jobs {
  private limiter: RateLimiter;
  constructor(private d: JobDeps) {
    this.limiter = new RateLimiter(d.config.sink.followupRatePerSecond, d.config.sink.followupConcurrency);
  }

  private tx<T>(tenantId: string, fn: (r: Repos) => Promise<T>): Promise<T> {
    return this.d.store.tx(tenantId, fn);
  }

  private async load(tenantId: string, importId: string): Promise<ImportRecord> {
    const imp = await this.tx(tenantId, (r) => r.getImport(importId));
    if (!imp) throw new Error(`Import ${importId} not found for tenant`);
    if (imp.tenantId !== tenantId) throw new Error("Tenant mismatch");
    return imp;
  }

  private ctx(imp: ImportRecord): Ctx {
    return { tenantId: imp.tenantId, actor: imp.createdBy };
  }

  private async fail(imp: ImportRecord, code: string, message: string, extra: { openImportId?: string } = {}) {
    await this.tx(imp.tenantId, async (r) => {
      const cur = (await r.getImport(imp.id, { forUpdate: true }))!;
      await r.updateImport(imp.id, { error: { code, message, ...extra } });
      await r.appendEvent(imp.id, "error", "system", { code, message });
      if (!this.d.service.isTerminal(cur.status)) await this.d.service.setStatus(r, cur, "failed");
    });
  }

  /** Last retry failed: the import moves to `failed` with the error (§5). */
  async onFinalFailure(name: string, data: Payload, err: unknown) {
    const imp = await this.load(data.tenantId, data.importId).catch(() => null);
    if (!imp || this.d.service.isTerminal(imp.status)) return;
    if (name === Q.commit || name === Q.followup) {
      // Rows already written stay written. The rows this job never finished are marked, so the import
      // can't end as "completed" with products missing or left inactive.
      const message = String((err as Error)?.message ?? err);
      await this.tx(imp.tenantId, async (r) => {
        await r.appendEvent(imp.id, "error", "system", { queue: name, message });
        if (name === Q.commit) {
          const chunk = Number((data as Payload & { chunk: number }).chunk);
          const ch = chunkRanges(imp.stats.totalRows ?? 0, this.d.config.jobs.chunkSize)[chunk];
          const rows = (await r.rowsInRange(imp.id, ch.from, ch.to)).filter((x) => x.status === "valid" && (x.action === "create" || x.action === "update"));
          await r.updateRows(imp.id, rows.map((x) => ({
            rowIndex: x.rowIndex, status: "failed" as const,
            issues: [...x.issues, { code: "job_failed", message: `Not confirmed in Distru (${message}). Check Distru before importing this row again.`, severity: "error" as const }],
          })));
          const prev = await r.getChunk(imp.id, "commit", chunk);
          await r.upsertChunk(imp.id, { stage: "commit", chunkIndex: chunk, planVersion: imp.planVersion, status: "done", attempts: prev?.attempts ?? 1, response: { ...((prev?.response as Record<string, Json>) ?? {}), failed: rows.length, error: message } });
        } else {
          const rows = (await r.getRows(imp.id, (data as Payload & { rows: number[] }).rows))
            .filter((x) => x.followup && (x.status === "uploaded" || (x.status === "valid" && x.action === "update")));
          await r.updateRows(imp.id, rows.map((x) => ({
            rowIndex: x.rowIndex, status: "needs_attention" as const,
            issues: [...x.issues, { code: "followup_failed", message: `Details not added: ${message}${x.action === "create" ? " (product left inactive)" : ""}`, severity: "error" as const }],
          })));
        }
      });
      return this.checkComplete(imp.tenantId, imp.id);
    }
    await this.fail(imp, "job_failed", `${name}: ${String((err as Error)?.message ?? err)}`);
  }

  // ------------------------------------------------------------------ csv.parse

  async parse(data: Payload & { reparse?: boolean }) {
    let imp = await this.load(data.tenantId, data.importId);
    if (imp.status === "queued") {
      await this.tx(imp.tenantId, async (r) => this.d.service.setStatus(r, (await r.getImport(imp.id, { forUpdate: true }))!, "parsing"));
      imp.status = "parsing";
    }
    if (imp.status !== "parsing") return;
    const profile = this.d.service.profile(imp.targetId);

    let bytes = await this.tx(imp.tenantId, (r) => r.getFile(imp.id));
    if (!bytes && imp.source.url) {
      const res = await (this.d.fetch ?? fetch)(imp.source.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Fetching the file failed: ${res.status}`);
      // Refuse an oversized download before buffering it.
      if (Number(res.headers.get("content-length") ?? 0) > this.d.config.limits.maxFileBytes) {
        return this.fail(imp, "too_large", `File is larger than ${Math.round(this.d.config.limits.maxFileBytes / 1e6)} MB`);
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (!bytes) return this.fail(imp, "no_file", "The uploaded file is no longer available");
    if (bytes.byteLength > this.d.config.limits.maxFileBytes) return this.fail(imp, "too_large", `File is larger than ${Math.round(this.d.config.limits.maxFileBytes / 1e6)} MB`);

    if (!imp.source.sha256) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        await this.tx(imp.tenantId, (r) => r.updateImport(imp.id, { source: { ...imp.source, sha256 } }));
        imp.source.sha256 = sha256;
      } catch (e) {
        // Only the unique index on open imports means "duplicate"; a dropped connection must retry, not fail the import.
        if ((e as { code?: string }).code !== "23505") throw e;
        const open = await this.tx(imp.tenantId, (r) => r.findOpenImportBySha(imp.targetId, sha256));
        // Keep the bytes so "cancel the other one and start this file" can restart from them.
        await this.tx(imp.tenantId, (r) => r.putFile(imp.id, bytes!));
        return this.fail(imp, "duplicate_open_import", "This file is already open in another import. Continue there, or cancel it and start this one.", { openImportId: open?.id });
      }
    }

    const tParse = Date.now();
    const vocabulary = new Set(Object.values(profile.target.fields).flatMap((f) => [f.name.replace(/_/g, " "), f.header ?? "", ...f.synonyms].map(normalizeHeader)));
    let table;
    try {
      const file = parseFile(bytes);
      table = buildTable(file, { sheet: imp.plan?.sheet, headerRow: imp.plan?.headerRow, vocabulary, maxRows: this.d.config.limits.maxRows });
      imp.stats = { ...imp.stats, kind: file.kind, encoding: file.encoding, sheets: file.sheets.map((s) => s.name) };
    } catch (e) {
      if (e instanceof FileRejected) return this.fail(imp, e.code, e.message);
      throw e;
    }

    const plan = emptyPlan(table.headers, table.headerRow, table.sheet);
    const questions: Question[] = [];
    if (table.unsure?.sheets && !imp.plan?.sheet) {
      questions.push({ id: "choose_sheet", kind: "choose_sheet", blocking: true, prompt: `This workbook has ${table.unsure.sheets.length} sheets with data. Which one has the products?`, options: table.unsure.sheets.map((s) => ({ id: s, label: s })), suggested: table.sheet, answer: undefined });
    }
    if (table.unsure?.headerRow && imp.plan?.headerRow === undefined) {
      questions.push({ id: "choose_header_row", kind: "choose_header_row", blocking: true, prompt: "Which row has the column names?", options: table.unsure.headerRow.map((n) => ({ id: String(n), label: `Row ${n + 1}` })), suggested: String(table.headerRow) });
    }
    plan.questions = questions;

    await this.tx(imp.tenantId, async (r) => {
      const cur = (await r.getImport(imp.id, { forUpdate: true }))!;
      if (cur.status !== "parsing") return;
      await r.deleteRows(imp.id);
      await r.insertRows(imp.id, table.rows.map((x) => ({ rowIndex: x.rowIndex, raw: x.cells, meta: x.ragged ? { ragged: x.ragged } : {} })));
      await r.updateImport(imp.id, { plan, stats: { ...imp.stats, totalRows: table.rows.length, skippedRows: table.skippedRows, timings: { parse: Date.now() - tParse } }, source: imp.source });
      await r.appendEvent(imp.id, "chunk_progress", "system", { stage: "parse", rows: table.rows.length, columns: table.headers.length, skippedRows: table.skippedRows });
      await this.d.service.setStatus(r, cur, "matching");
    });
    await this.d.queue.send(Q.match, { tenantId: imp.tenantId, importId: imp.id }, { singletonKey: `${imp.id}:${Q.match}:${imp.planVersion}` });
  }

  // ------------------------------------------------------------------ csv.match

  async match(data: Payload) {
    const imp = await this.load(data.tenantId, data.importId);
    if (imp.status !== "matching") return;
    const profile = this.d.service.profile(imp.targetId);
    const ctx = this.ctx(imp);
    const t0 = Date.now();
    const timings: Record<string, number> = { ...(imp.stats.timings ?? {}) };
    const lap = (k: string, from: number) => (timings[k] = Date.now() - from);
    let t = Date.now();
    if ((await this.ensureSnapshot(ctx, imp.targetId)) === "full") timings.snapshotFull = 1;
    lap("snapshot", t);
    t = Date.now();

    const sample = await this.tx(imp.tenantId, (r) => r.sampleRaw(imp.id, 2000));
    const plan = imp.plan!;
    const columns = profileColumns(plan.headers, sample);
    lap("profile", t);
    const memory = await this.tx(imp.tenantId, (r) => r.getMemory(imp.targetId, columns.map((c) => c.headerNorm)));
    const refFields = Object.values(profile.target.fields).filter((f) => f.ref);
    t = Date.now();
    const refs = await profile.refResolver.resolve(ctx, refFields, { snapshotDistinct: (f) => this.tx(imp.tenantId, (r) => r.snapshotDistinct(f)) });
    lap("refs", t);

    // Time each stage and record what it decided, for the "How it ran" view.
    const matchStages: NonNullable<ImportRecord["stats"]["matchStages"]> = [];
    const disabledStages = this.d.service.disabledStages();
    const stages: MatchStage[] = this.d.stages.filter((s) => this.d.service.stageEnabled(s.method)).map((s) => ({
      ...s,
      run: async (input) => {
        const st = Date.now();
        const res = await s.run(input);
        const ok = res.candidates.filter((c) => c.score >= s.threshold || (c.suggest && c.target));
        const best = new Map<string, Candidate>();
        for (const c of res.candidates) if (c.score < s.threshold && c.score > 0 && (!best.has(c.source) || best.get(c.source)!.score < c.score)) best.set(c.source, c);
        matchStages.push({
          method: s.method, model: s.model, ms: Date.now() - st, seen: input.columns.length, resolved: [],
          ignored: ok.filter((c) => c.target === null).map((c) => c.source),
          ...(res.error ? { error: res.error } : {}),
          ...(res.usage ? { usage: res.usage } : {}),
          nearMisses: [...best.values()].filter((c) => !ok.some((o) => o.source === c.source)).map((c) => ({ source: c.source, target: c.target, score: Math.round(c.score * 100) / 100 })),
        });
        return res;
      },
    }));
    t = Date.now();

    const result = await runCascade({
      ctx, target: profile.target, columns, memory, config: this.d.config, stages,
      onResolved: (m) => this.tx(imp.tenantId, (r) => r.appendEvent(imp.id, "column_resolved", "system", { source: m.sources[0], target: m.target, method: m.method, score: m.score })).then(() => undefined),
    });
    lap("cascade", t);
    for (const m of result.fields) {
      const st = matchStages.find((s) => s.method === m.method);
      if (m.needsConfirm) (st!.suggested ??= []).push(m.sources[0]);
      else st?.resolved.push(m.sources[0]);
    }
    t = Date.now();
    plan.fields = result.fields;
    // Best model guess per unresolved column (Jev first, then LLM), offered as the pre-selected answer.
    const guessFor = (source: string) => {
      for (const st of matchStages) {
        const n = st.nearMisses?.find((x) => x.source === source);
        if (n) return { target: n.target, score: n.score, method: st.method };
      }
      return undefined;
    };
    plan.ignoredColumns = [
      ...result.ignored,
      ...result.unresolved.map((c) => ({ source: c.source, reason: "Not matched (needs you)", ...(guessFor(c.source) ? { guess: guessFor(c.source) } : {}) })),
    ];
    const usage: Record<string, ModelUsage> = {};
    for (const s of matchStages) if (s.usage) usage[`${s.method}:columns`] = addUsage(usage[`${s.method}:columns`], s.usage);
    const finalized = await finalizePlan(plan, {
      profile, columns, refs, valueStages: this.d.service.activeValueStages(),
      onUsage: (method, u) => { usage[`${method}:values`] = addUsage(usage[`${method}:values`], u); },
      distinct: (src) => this.tx(imp.tenantId, (r) => r.distinctRaw(imp.id, src, 1000)),
    });

    lap("plan", t);
    await this.tx(imp.tenantId, async (r) => {
      const cur = (await r.getImport(imp.id, { forUpdate: true }))!;
      if (cur.status !== "matching") return;
      await r.updateImport(imp.id, {
        plan: finalized, planVersion: cur.planVersion + 1, refs,
        stats: { ...cur.stats, columns, resolvedByStage: { ...result.byStage, unresolved: result.unresolved.length } as any, matchMs: Date.now() - t0, timings, matchStages, usage, disabledStages },
      });
      for (const q of finalized.questions) await r.appendEvent(imp.id, "question_added", "system", { id: q.id, kind: q.kind, blocking: q.blocking });
      await this.d.service.setStatus(r, cur, "mapping_review");
    });
  }

  // ------------------------------------------------------------------ catalog snapshot

  /** Full reload if missing or stale; otherwise a bounded delta refresh. Waits for a running full load. */
  async ensureSnapshot(ctx: Ctx, targetId: string): Promise<"full" | "delta"> {
    const state = await this.tx(ctx.tenantId, (r) => r.getSnapshotState());
    const stale = !state?.refreshedAt || Date.now() - Date.parse(state.refreshedAt) > this.d.config.snapshot.maxAgeHours * 3600_000;
    if (!state || state.status === "loading" || stale) {
      // Always (re)send: the queue dedupes per tenant while a load runs, and a load whose job died for good
      // is picked up again from its cursor. Otherwise a dead load would block the tenant's imports forever.
      await this.requestFullSnapshot(ctx, targetId);
      await this.waitForSnapshot(ctx.tenantId);
      return "full";
    }
    const overflow = await this.deltaRefresh(ctx, targetId, state.refreshedAt!);
    if (overflow) {
      await this.requestFullSnapshot(ctx, targetId);
      await this.waitForSnapshot(ctx.tenantId);
      return "full";
    }
    return "delta";
  }

  async requestFullSnapshot(ctx: Ctx, targetId: string) {
    await this.tx(ctx.tenantId, async (r) => {
      const s = await r.getSnapshotState();
      if (s?.status !== "loading") await r.setSnapshotState({ status: "loading", cursor: null, refreshedAt: new Date().toISOString() });
    });
    await this.d.queue.send(Q.snapshot, { tenantId: ctx.tenantId, actor: ctx.actor, targetId }, { singletonKey: ctx.tenantId });
  }

  private async waitForSnapshot(tenantId: string) {
    const deadline = Date.now() + this.d.config.jobs.expireInSeconds * 800;
    while (Date.now() < deadline) {
      const s = await this.tx(tenantId, (r) => r.getSnapshotState());
      if (s?.status === "ready") return;
      await sleep(100);
    }
    throw new Error("Catalog snapshot is still loading");
  }

  /** Returns true when the delta overflowed `snapshot.maxDeltaPages`. */
  async deltaRefresh(ctx: Ctx, targetId: string, since: string): Promise<boolean> {
    const profile = this.d.service.profile(targetId);
    const started = new Date().toISOString();
    let cursor: string | null = null;
    for (let page = 0; page < this.d.config.snapshot.maxDeltaPages; page++) {
      const res = await profile.catalog.page(ctx, { cursor, limit: this.d.config.snapshot.pageSize, sort: "updated_desc" });
      const fresh = res.items.filter((p) => p.updatedAt >= since);
      await this.tx(ctx.tenantId, (r) => r.upsertSnapshot(fresh));
      if (fresh.length < res.items.length || !res.nextCursor) {
        await this.tx(ctx.tenantId, (r) => r.setSnapshotState({ status: "ready", cursor: null, refreshedAt: started }));
        return false;
      }
      cursor = res.nextCursor;
    }
    return true;
  }

  /** csv.snapshot: full, cursor-resumable load. One per tenant. */
  async snapshot(data: { tenantId: string; actor: string; targetId: string }) {
    const ctx = { tenantId: data.tenantId, actor: data.actor };
    const profile = this.d.service.profile(data.targetId);
    let state = await this.tx(ctx.tenantId, (r) => r.getSnapshotState());
    if (state?.status === "ready") return;
    if (!state) {
      await this.tx(ctx.tenantId, (r) => r.setSnapshotState({ status: "loading", cursor: null, refreshedAt: new Date().toISOString() }));
      state = { status: "loading", cursor: null, refreshedAt: new Date().toISOString() };
    }
    if (!state.cursor) await this.tx(ctx.tenantId, (r) => r.clearSnapshot());
    let cursor = state.cursor;
    for (;;) {
      const res = await profile.catalog.page(ctx, { cursor, limit: this.d.config.snapshot.pageSize, sort: "default" });
      cursor = res.nextCursor;
      await this.tx(ctx.tenantId, async (r) => {
        await r.upsertSnapshot(res.items);
        await r.setSnapshotState({ status: cursor ? "loading" : "ready", cursor });
      });
      if (!cursor) return;
    }
  }

  // ------------------------------------------------------------------ csv.prepare

  async prepare(data: Payload & { chunk: number; planVersion: number }) {
    const imp = await this.load(data.tenantId, data.importId);
    if (imp.status !== "preparing" || imp.planVersion !== data.planVersion) return;
    const profile = this.d.service.profile(imp.targetId);
    const ch = chunkRanges(imp.stats.totalRows ?? 0, this.d.config.jobs.chunkSize)[data.chunk];
    const done = await this.tx(imp.tenantId, (r) => r.getChunk(imp.id, "prepare", data.chunk));
    if (!(done?.status === "done" && done.planVersion === data.planVersion)) {
      const st = Date.now();
      await this.ensureSnapshot(this.ctx(imp), imp.targetId);
      await this.tx(imp.tenantId, async (r) => {
        const rows = await r.rowsInRange(imp.id, ch.from, ch.to);
        const patches = await prepareRows(r, imp, profile, rows, this.d.config);
        await r.updateRows(imp.id, patches);
        await r.upsertChunk(imp.id, { stage: "prepare", chunkIndex: data.chunk, planVersion: data.planVersion, status: "done", attempts: (done?.attempts ?? 0) + 1, response: { rows: rows.length, ms: Date.now() - st } });
        await r.appendEvent(imp.id, "chunk_progress", "system", { stage: "prepare", chunk: data.chunk, rows: rows.length, ms: Date.now() - st });
      });
    }
    await this.tx(imp.tenantId, async (r) => {
      const cur = (await r.getImport(imp.id, { forUpdate: true }))!;
      if (cur.status !== "preparing" || cur.planVersion !== data.planVersion) return;
      const total = chunkRanges(cur.stats.totalRows ?? 0, this.d.config.jobs.chunkSize).length;
      const chunks = (await r.listChunks(imp.id, "prepare")).filter((c) => c.status === "done" && c.planVersion === data.planVersion);
      if (chunks.length < total) return;
      await markFileDuplicates(r, imp.id);
      await this.d.service.setStatus(r, cur, "commit_review");
    });
  }

  // ------------------------------------------------------------------ csv.commit

  async commit(data: Payload & { chunk: number }) {
    const imp = await this.load(data.tenantId, data.importId);
    if (imp.status !== "committing") return;
    const profile = this.d.service.profile(imp.targetId);
    const target = profile.target;
    const ctx = this.ctx(imp);
    const plan = imp.plan!;
    const ch = chunkRanges(imp.stats.totalRows ?? 0, this.d.config.jobs.chunkSize)[data.chunk];

    const prev = await this.tx(imp.tenantId, (r) => r.getChunk(imp.id, "commit", data.chunk));
    if (prev?.status === "done") {
      // A crash between the checkpoint and the follow-up sends would leave rows waiting forever: send again
      // (the queue dedupes by key, and the follow-up job skips rows that are already finished).
      const pending = (await this.tx(imp.tenantId, (r) => r.rowsInRange(imp.id, ch.from, ch.to)))
        .filter((r) => r.followup && (r.status === "uploaded" || (r.status === "valid" && r.action === "update"))).map((r) => r.rowIndex);
      await this.sendFollowups(imp, data.chunk, pending);
      return this.checkComplete(imp.tenantId, imp.id);
    }
    const attempts = (prev?.attempts ?? 0) + 1;
    const startedAt = (prev?.response as any)?.startedAt ?? new Date().toISOString();
    const st = Date.now();
    await this.tx(imp.tenantId, (r) => r.upsertChunk(imp.id, { stage: "commit", chunkIndex: data.chunk, planVersion: imp.planVersion, status: "running", attempts, response: { startedAt } }));

    // Check before write: refresh the snapshot, then re-check every create against Distru.
    await this.ensureSnapshot(ctx, imp.targetId);
    const rows = await this.tx(imp.tenantId, (r) => r.rowsInRange(imp.id, ch.from, ch.to));
    const patches = new Map<number, RowPatch>();
    const patch = (row: RowRecord, p: Omit<RowPatch, "rowIndex">) => patches.set(row.rowIndex, { ...(patches.get(row.rowIndex) ?? {}), rowIndex: row.rowIndex, ...p });

    for (const row of rows) if (row.status === "valid" && row.action === "skip") patch(row, { status: "skipped" });
    let creates = rows.filter((r) => r.status === "valid" && r.action === "create");
    const updates = rows.filter((r) => r.status === "valid" && r.action === "update");

    const existing = indexCatalog(await this.tx(imp.tenantId, (r) => r.snapshotLookup({
      skus: creates.map((c) => c.sku).filter(Boolean) as string[],
      names: creates.filter((c) => !c.sku).map((c) => normValue(String(c.output?.[target.nameField] ?? ""))),
    })));
    const nameOf = (row: RowRecord) => normValue(String(row.output?.[target.nameField] ?? ""));
    // Rows without a SKU can only be recognised by name, and only when the name is unambiguous: one such row
    // in this upload, and a product that was not already in Distru under that name. Anything else is left
    // without an ID (flagged below) so a follow-up never lands on someone else's product.
    const nameUses = new Map<string, number>();
    for (const c of creates) if (!c.sku) nameUses.set(nameOf(c), (nameUses.get(nameOf(c)) ?? 0) + 1);
    const unique = (row: RowRecord) => nameUses.get(nameOf(row)) === 1;
    const found = (row: RowRecord) => {
      if (row.sku) return existing.bySku.get(normSku(row.sku)!);
      const p = attempts > 1 && unique(row) ? existing.byName.get(nameOf(row)) : undefined;
      return p && p.updatedAt >= startedAt ? p : undefined; // an older same-named product is not ours: still create
    };
    const createdByName = (row: RowRecord, after: ReturnType<typeof indexCatalog>) => {
      const p = after.byName.get(nameOf(row));
      return p && unique(row) && p.distruId !== existing.byName.get(nameOf(row))?.distruId ? p : undefined;
    };
    creates = creates.filter((row) => {
      const p = found(row);
      if (!p) return true;
      if (attempts > 1 && p.updatedAt >= startedAt) {
        // Our own earlier attempt created it before crashing: resume, don't create twice.
        patch(row, { distruId: p.distruId, status: row.followup ? "uploaded" : "committed" });
      } else {
        patch(row, { status: "skipped", dupClass: "exists_unchanged", issues: [...row.issues, { code: "became_duplicate", message: "Created in Distru after review; skipped", severity: "warning" }] });
      }
      return false;
    });

    if (creates.length) {
      const tplRows = creates.map((row) => toTemplateRow(target, row.output ?? {}, { forceInactive: row.followup }));
      const res = await profile.sink.upload(ctx, { importId: imp.id, mode: "create", headers: target.templateHeaders, rows: tplRows });
      const failed = new Map(res.errors.map((e) => [e.index, e.message]));
      await this.ensureSnapshot(ctx, imp.targetId);
      const after = indexCatalog(await this.tx(imp.tenantId, (r) => r.snapshotLookup({
        skus: creates.map((c) => c.sku).filter(Boolean) as string[],
        names: creates.map((c) => normValue(String(c.output?.[target.nameField] ?? ""))),
      })));
      creates.forEach((row, i) => {
        if (failed.has(i)) return patch(row, { status: "failed", issues: [...row.issues, { code: "sink_error", message: failed.get(i)!, severity: "error" }] });
        const p = row.sku ? after.bySku.get(normSku(row.sku)!) : createdByName(row, after);
        if (row.followup && !p) return patch(row, { status: "needs_attention", issues: [...row.issues, { code: "followup_failed", message: "Created inactive, but its Distru ID wasn't found for the follow-up", severity: "error" }] });
        patch(row, { distruId: p?.distruId ?? null, status: row.followup ? "uploaded" : "committed" });
      });
    }

    if (updates.length && this.d.config.sink.uploadSupportsUpdate) {
      const tplRows = updates.map((row) => toTemplateRow(target, row.output ?? {}, {
        distruId: row.distruId,
        onlyFields: new Set((row.meta.diff ?? []).filter((d) => !d.blocked).map((d) => d.field)),
        clear: plan.clearBlanks ? new Set(row.meta.blankWithValue ?? []) : undefined,
      }));
      const res = await profile.sink.upload(ctx, { importId: imp.id, mode: "update", headers: target.templateHeaders, rows: tplRows });
      const failed = new Map(res.errors.map((e) => [e.index, e.message]));
      updates.forEach((row, i) => {
        if (failed.has(i)) patch(row, { status: "failed", issues: [...row.issues, { code: "sink_error", message: failed.get(i)!, severity: "error" }] });
        else if (!row.followup) patch(row, { status: "committed" });
      });
    }

    const final = rows.map((row) => ({ ...row, ...(patches.get(row.rowIndex) ?? {}) }));
    const followupRows = final.filter((r) => r.followup && (r.status === "uploaded" || (r.status === "valid" && r.action === "update"))).map((r) => r.rowIndex);
    await this.tx(imp.tenantId, async (r) => {
      await r.updateRows(imp.id, [...patches.values()]);
      await r.upsertChunk(imp.id, {
        stage: "commit", chunkIndex: data.chunk, planVersion: imp.planVersion, status: "done", attempts,
        response: { startedAt, created: final.filter((x) => x.action === "create" && ["uploaded", "committed"].includes(x.status)).length, failed: final.filter((x) => x.status === "failed").length, followups: followupRows.length },
      });
      await r.appendEvent(imp.id, "chunk_progress", "system", { stage: "commit", chunk: data.chunk, rows: rows.length, followups: followupRows.length, ms: Date.now() - st });
    });
    await this.sendFollowups(imp, data.chunk, followupRows);
    await this.checkComplete(imp.tenantId, imp.id);
  }

  private async sendFollowups(imp: ImportRecord, chunk: number, rowIndexes: number[]) {
    const size = this.d.config.sink.followupBatchSize;
    for (let i = 0; i * size < rowIndexes.length; i++) {
      await this.d.queue.send(Q.followup, { tenantId: imp.tenantId, importId: imp.id, rows: rowIndexes.slice(i * size, (i + 1) * size) }, { singletonKey: `${imp.id}:${Q.followup}:${chunk}:${i}` });
    }
  }

  // ------------------------------------------------------------------ csv.followup

  async followup(data: Payload & { rows: number[] }) {
    const imp = await this.load(data.tenantId, data.importId);
    if (imp.status !== "committing") return;
    const profile = this.d.service.profile(imp.targetId);
    const target = profile.target;
    const plan = imp.plan!;
    const ctx = this.ctx(imp);
    const waiting = (await this.tx(imp.tenantId, (r) => r.getRows(imp.id, data.rows)))
      .filter((r) => r.followup && (r.status === "uploaded" || (r.status === "valid" && r.action === "update")));
    const rows = waiting.filter((r) => r.distruId);
    // No Distru ID means nothing to update. Flag the row; left as "uploaded" it would hold the import open forever.
    const lost = waiting.filter((r) => !r.distruId);
    if (lost.length) {
      await this.tx(imp.tenantId, (r) => r.updateRows(imp.id, lost.map((row) => ({
        rowIndex: row.rowIndex, status: "needs_attention" as const,
        issues: [...row.issues, { code: "followup_failed", message: "Details not added: the product's Distru ID wasn't found", severity: "error" as const }],
      }))));
    }

    let ok = 0, bad = 0;
    const st = Date.now();
    await Promise.all(rows.map(async (row) => {
      const out = row.output ?? {};
      let values: Record<string, Json>;
      if (row.action === "create") {
        // Pending groups and the real active value, in one mutation.
        values = { ...followupValues(target, out), active: out.active ?? true };
      } else {
        const changed = new Set((row.meta.diff ?? []).filter((d) => !d.blocked).map((d) => d.field));
        const clear = plan.clearBlanks ? new Set(row.meta.blankWithValue ?? []) : undefined;
        values = followupValues(target, out, { onlyFields: new Set([...changed, ...(clear ?? [])]), clear, includeTemplateFields: !this.d.config.sink.uploadSupportsUpdate });
      }
      const err = await this.callWithRetry(imp.tenantId, () => profile.followup.update(ctx, { distruId: row.distruId!, values }));
      // Checkpoint per row: a resumed job skips committed rows.
      if (!err) {
        ok++;
        await this.tx(imp.tenantId, (r) => r.updateRows(imp.id, [{ rowIndex: row.rowIndex, status: "committed" }]));
      } else {
        bad++;
        await this.tx(imp.tenantId, (r) => r.updateRows(imp.id, [{
          rowIndex: row.rowIndex, status: "needs_attention",
          issues: [...row.issues, { code: "followup_failed", message: `Details not added: ${err}${row.action === "create" ? " (product left inactive)" : ""}`, severity: "error" }],
        }]));
      }
    }));
    await this.tx(imp.tenantId, (r) => r.appendEvent(imp.id, "chunk_progress", "system", { stage: "followup", done: ok, failed: bad, ms: Date.now() - st }));
    await this.checkComplete(imp.tenantId, imp.id);
  }

  /** 429 / 5xx retry with exponential backoff and jitter; 4xx is a row error. Returns the error message or null. */
  private async callWithRetry(tenantId: string, fn: () => Promise<void>): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.limiter.run(tenantId, fn);
        return null;
      } catch (e) {
        const status = e instanceof FollowupError ? e.status : 500;
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt >= this.d.config.sink.followupRetries) return `${status} ${(e as Error).message}`;
        await sleep(Math.min(10_000, 200 * 2 ** attempt) * (0.5 + Math.random()));
      }
    }
  }

  // ------------------------------------------------------------------ completion

  async checkComplete(tenantId: string, importId: string, force = false) {
    await this.tx(tenantId, async (r) => {
      const cur = (await r.getImport(importId, { forUpdate: true }))!;
      if (cur.status !== "committing") return;
      const total = chunkRanges(cur.stats.totalRows ?? 0, this.d.config.jobs.chunkSize).length;
      const done = (await r.listChunks(importId, "commit")).filter((c) => c.status === "done").length;
      const counts = await r.counts(importId);
      const pending = counts.filter((c) => c.followup && (c.status === "uploaded" || (c.status === "valid" && c.action === "update"))).reduce((s, c) => s + c.n, 0);
      if (!force && (done < total || pending > 0)) return;
      const n = (s: string[]) => counts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
      const committed = n(["committed", "uploaded"]);
      const failed = n(["failed", "needs_attention"]);
      const to = committed > 0 && failed > 0 ? "partially_completed" : committed === 0 && failed > 0 ? "failed" : "completed";
      await this.d.service.setStatus(r, cur, to, "system", { committed, failed });
    });
  }
}
