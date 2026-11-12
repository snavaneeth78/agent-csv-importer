import { createHash } from "node:crypto";
import type { ImporterConfig } from "./config.ts";
import type { ImportRecord, ImportStats, LlmMatcher, PlanPatch, Queue, Repos, RowRecord, Store, TargetProfile, ValueStage } from "./ports.ts";
import type { Ctx, DupClass, ImportEvent, ImportInput, ImportStatus, Json, MappingPlan, Question, RowAction, RowStatus } from "./types.ts";
import { TERMINAL } from "./types.ts";
import { applyPatch, finalizePlan, openBlocking, overallConfidence } from "./plan.ts";
import { ConflictError, StateError, assertTransition, chunkRanges, followupMinutes } from "./state.ts";
import { markFileDuplicates, prepareRows } from "./pipeline.ts";
import { needsFollowup } from "./template.ts";
import { followupFields } from "./target.ts";
import { addUsage, type ModelUsage } from "./usage.ts";
import { normalizeHeader } from "./normalize.ts";

export const Q = {
  parse: "csv.parse",
  match: "csv.match",
  prepare: "csv.prepare",
  commit: "csv.commit",
  followup: "csv.followup",
  snapshot: "csv.snapshot",
} as const;

export interface ServiceDeps {
  store: Store;
  queue: Queue;
  profiles: TargetProfile[];
  valueStages: ValueStage[];
  llm?: LlmMatcher;
  config: ImporterConfig;
}

export interface ImportView {
  id: string;
  status: ImportStatus;
  filename: string;
  threadId: string | null;
  planVersion: number;
  plan: MappingPlan | null;
  error: ImportRecord["error"];
  openQuestions: Question[];
  blockingQuestions: number;
  overallConfidence: number;
  stats: {
    disabledStages?: string[];
    totalRows?: number; skippedRows?: number; kind?: string; encoding?: string; sheets?: string[]; resolvedByStage?: Record<string, number>;
    matchMs?: number; timings?: Record<string, number>; matchStages?: ImportStats["matchStages"]; usage?: ImportStats["usage"];
  };
  counts: Record<string, number>;
  willCreate: Record<string, string[]>;
  progress: { created: { done: number; failed: number; total: number }; details: { done: number; failed: number; total: number } };
  followupEstimate: { rows: number; creates: number; minutes: number } | null;
  issueSummary: Awaited<ReturnType<Repos["issueCounts"]>>;
  targetFields: { name: string; label: string; section: string; synonyms: string[]; required: boolean; followup: boolean; options?: string[] }[];
  createdAt: string;
  updatedAt: string;
}

function targetFieldList(target: TargetProfile["target"], refs: Record<string, string[]> = {}): ImportView["targetFields"] {
  const fu = followupFields(target);
  const sectionOf = new Map((target.sections ?? []).flatMap((s) => s.fields.map((f) => [f, s.title] as const)));
  const order = new Map((target.sections ?? []).flatMap((s) => s.fields).map((f, i) => [f, i]));
  return Object.values(target.fields)
    .map((f) => ({ name: f.name, label: (f.invert ? null : f.header) ?? f.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), section: sectionOf.get(f.name) ?? "Other", synonyms: f.synonyms, required: !!f.required, followup: fu.has(f.name),
      options: f.enumValues ?? (f.ref?.mode === "must_exist" ? refs[f.name]?.slice(0, 300) : undefined) }))
    .sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
}

export class ImportService {
  /** Cascade stages switched off at runtime ("llm", "jev"). Per process; for demos and A/B comparisons. */
  private disabled = new Set<string>();

  constructor(private d: ServiceDeps) {}

  setStageEnabled(method: "llm" | "jev", enabled: boolean) {
    if (enabled) this.disabled.delete(method);
    else this.disabled.add(method);
  }

  stageEnabled(method: string): boolean {
    return !this.disabled.has(method);
  }

  disabledStages(): string[] {
    return [...this.disabled];
  }

  /** Value-matching stages that are switched on. */
  activeValueStages(): ValueStage[] {
    return this.d.valueStages.filter((s) => this.stageEnabled(s.method));
  }

  profile(targetId: string): TargetProfile {
    const p = this.d.profiles.find((x) => x.target.id === targetId);
    if (!p) throw new Error(`Unknown target "${targetId}"`);
    return p;
  }

  private async event(r: Repos, importId: string, type: ImportEvent["type"], actor: ImportEvent["actor"], payload: Record<string, Json>) {
    await r.appendEvent(importId, type, actor, payload);
  }

  async setStatus(r: Repos, imp: ImportRecord, to: ImportStatus, actor: ImportEvent["actor"] = "system", extra: Record<string, Json> = {}) {
    assertTransition(imp.status, to);
    await r.updateImport(imp.id, { status: to });
    await this.event(r, imp.id, "status_changed", actor, { from: imp.status, to, ...extra });
    imp.status = to;
  }

  private async load(r: Repos, importId: string, forUpdate = false): Promise<ImportRecord> {
    const imp = await r.getImport(importId, { forUpdate });
    if (!imp) throw new StateError(`Import ${importId} not found`);
    return imp;
  }

  private checkVersion(imp: ImportRecord, planVersion: number) {
    if (imp.planVersion !== planVersion) throw new ConflictError(`Plan changed (version ${imp.planVersion}, you sent ${planVersion}). Reload and try again.`);
  }

  // ---------------------------------------------------------------------------------------------

  async start(ctx: Ctx, args: { input: ImportInput; filename: string; targetId: string; threadId?: string }): Promise<{ importId: string; status: ImportStatus; reused: boolean }> {
    this.profile(args.targetId);
    let bytes: Uint8Array | undefined;
    let url: string | undefined;
    if ("bytes" in args.input) bytes = args.input.bytes;
    else if ("stream" in args.input) bytes = new Uint8Array(await new Response(args.input.stream).arrayBuffer());
    else url = args.input.url;
    if (bytes && bytes.byteLength > this.d.config.limits.maxFileBytes) throw new StateError(`File is larger than ${Math.round(this.d.config.limits.maxFileBytes / 1e6)} MB`);
    const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;

    const res = await this.d.store.tx(ctx.tenantId, async (r) => {
      if (sha256) {
        const open = await r.findOpenImportBySha(args.targetId, sha256);
        if (open) return { importId: open.id, status: open.status, reused: true };
      }
      const p = this.profile(args.targetId);
      const imp = await r.insertImport({
        createdBy: ctx.actor, threadId: args.threadId ?? null,
        source: { filename: args.filename, size: bytes?.byteLength, sha256, url },
        targetId: args.targetId, targetVersion: p.target.version, status: "queued", plan: null, planVersion: 0,
        stats: {}, error: null, refs: null,
      });
      if (bytes) await r.putFile(imp.id, bytes);
      await this.event(r, imp.id, "status_changed", "agent", { to: "queued", filename: args.filename });
      return { importId: imp.id, status: imp.status, reused: false };
    });
    if (!res.reused) await this.d.queue.send(Q.parse, { tenantId: ctx.tenantId, importId: res.importId }, { singletonKey: `${res.importId}:${Q.parse}:0` });
    return res;
  }

  async get(ctx: Ctx, importId: string): Promise<ImportView> {
    return this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId);
      const counts = await r.counts(importId);
      const issueSummary = ["mapping_review", "queued", "parsing", "matching"].includes(imp.status) ? [] : await r.issueCounts(importId);
      const c: Record<string, number> = { rows: 0 };
      const progress = { created: { done: 0, failed: 0, total: 0 }, details: { done: 0, failed: 0, total: 0 } };
      let followupRows = 0, followupCreates = 0;
      for (const g of counts) {
        c.rows += g.n;
        c[g.status] = (c[g.status] ?? 0) + g.n;
        if (g.action) c[g.action] = (c[g.action] ?? 0) + g.n;
        if (g.dupClass) c[g.dupClass] = (c[g.dupClass] ?? 0) + g.n;
        if (g.action === "create") {
          progress.created.total += g.n;
          if (["uploaded", "committed", "needs_attention"].includes(g.status)) progress.created.done += g.n;
          if (g.status === "failed") progress.created.failed += g.n;
        }
        if (g.followup && g.action !== "skip") {
          progress.details.total += g.n;
          followupRows += g.n;
          if (g.action === "create") followupCreates += g.n;
          if (g.status === "committed") progress.details.done += g.n;
          if (g.status === "needs_attention" || g.status === "failed") progress.details.failed += g.n;
        }
      }
      const plan = imp.plan;
      const willCreate: Record<string, string[]> = {};
      for (const [field, map] of Object.entries(plan?.valueMaps ?? {})) {
        const created = Object.values(map).filter((v): v is { create: string } => !!v && typeof v === "object").map((v) => v.create);
        if (created.length && plan!.fields.some((m) => m.target === field)) willCreate[field] = created;
      }
      return {
        id: imp.id,
        status: imp.status,
        filename: imp.source.filename,
        threadId: imp.threadId,
        planVersion: imp.planVersion,
        plan,
        error: imp.error,
        openQuestions: plan ? plan.questions.filter((q) => q.answer === undefined || q.waiting) : [],
        blockingQuestions: plan ? openBlocking(plan).length : 0,
        overallConfidence: plan ? overallConfidence(plan) : 0,
        stats: {
          totalRows: imp.stats.totalRows, skippedRows: imp.stats.skippedRows, kind: imp.stats.kind, sheets: imp.stats.sheets,
          resolvedByStage: imp.stats.resolvedByStage as Record<string, number>,
          disabledStages: imp.stats.disabledStages, encoding: imp.stats.encoding, matchMs: imp.stats.matchMs, timings: imp.stats.timings, matchStages: imp.stats.matchStages, usage: imp.stats.usage,
        },
        counts: c,
        willCreate,
        progress,
        followupEstimate: followupRows ? { rows: followupRows, creates: followupCreates, minutes: followupMinutes(followupRows, this.d.config.sink.followupRatePerSecond) } : null,
        issueSummary,
        targetFields: targetFieldList(this.profile(imp.targetId).target, imp.refs ?? {}),
        createdAt: imp.createdAt,
        updatedAt: imp.updatedAt,
      };
    });
  }

  async events(ctx: Ctx, importId: string, q: { afterId?: number; limit?: number } = {}): Promise<ImportEvent[]> {
    return this.d.store.tx(ctx.tenantId, (r) => r.listEvents(importId, q.afterId ?? 0, Math.min(q.limit ?? 200, 1000)));
  }

  async listRows(ctx: Ctx, importId: string, q: { status?: RowStatus[]; action?: RowAction[]; dupClass?: DupClass[]; cursor?: number; limit?: number } = {}): Promise<{ rows: RowRecord[]; nextCursor: number | null }> {
    const limit = Math.min(q.limit ?? 100, 1000);
    const rows = await this.d.store.tx(ctx.tenantId, (r) => r.listRows(importId, { ...q, afterRowIndex: q.cursor, limit }));
    return { rows, nextCursor: rows.length === limit ? rows[rows.length - 1].rowIndex : null };
  }

  async openImports(ctx: Ctx, threadId?: string): Promise<{ id: string; status: ImportStatus; filename: string }[]> {
    const list = await this.d.store.tx(ctx.tenantId, (r) => r.listOpenImports(threadId));
    return list.map((i) => ({ id: i.id, status: i.status, filename: i.source.filename }));
  }

  /** Structured patch or natural-language instruction. Gate-2-only options go through setRowActions. */
  async revise(ctx: Ctx, importId: string, args: { planVersion: number; patch?: PlanPatch; instruction?: string; actor?: "agent" | "user" }) {
    const actor = args.actor ?? "user";
    const snapshot = await this.d.store.tx(ctx.tenantId, (r) => this.load(r, importId));
    if (snapshot.status !== "mapping_review" && snapshot.status !== "commit_review") throw new StateError(`Can't revise while ${snapshot.status}`);
    this.checkVersion(snapshot, args.planVersion);
    const profile = this.profile(snapshot.targetId);

    let patch = args.patch ?? {};
    const spent: Record<string, ModelUsage> = {};
    const track = (key: string) => (u: ModelUsage) => { spent[key] = addUsage(spent[key], u); };
    if (args.instruction) {
      if (!this.d.llm || !this.stageEnabled("llm")) throw new StateError("The LLM step is off, so free-text edits aren't available. Answer by number, or use \"map <column> to <field>\".");
      const plan = snapshot.plan!;
      patch = await this.d.llm.planPatch({
        instruction: args.instruction,
        headers: plan.headers,
        fields: Object.values(profile.target.fields).map((f) => ({ name: f.name, label: f.header ?? f.name })),
        plan: { fields: plan.fields.map((m) => ({ target: m.target, sources: m.sources })), questions: plan.questions.filter((q) => !q.answer).map((q) => ({ id: q.id, prompt: q.prompt, options: (q.options ?? []).map((o) => o.id), suggested: q.suggested ?? null })) } as unknown as Json,
      }, { onUsage: track("llm:edits") });
    }

    const sheetAnswer = Object.entries(patch.answers ?? {}).find(([id]) => id === "choose_sheet" || id === "choose_header_row");
    if (patch.sheet || patch.headerRow !== undefined || sheetAnswer) {
      return this.d.store.tx(ctx.tenantId, async (r) => {
        const imp = await this.load(r, importId, true);
        this.checkVersion(imp, args.planVersion);
        if (imp.status !== "mapping_review") throw new StateError("Sheet and header row can only change at Gate 1");
        const plan = imp.plan!;
        if (sheetAnswer?.[0] === "choose_sheet") plan.sheet = sheetAnswer[1];
        if (sheetAnswer?.[0] === "choose_header_row") plan.headerRow = Number(sheetAnswer[1]);
        if (patch.sheet) plan.sheet = patch.sheet;
        if (patch.headerRow !== undefined) plan.headerRow = patch.headerRow;
        await r.updateImport(importId, { plan, planVersion: imp.planVersion + 1 });
        await this.event(r, importId, "plan_revised", actor, { changed: ["sheet/header row"], reparse: true });
        await this.setStatus(r, imp, "parsing", actor);
        await this.d.queue.send(Q.parse, { tenantId: ctx.tenantId, importId, reparse: true }, { singletonKey: `${importId}:${Q.parse}:${imp.planVersion + 1}` });
        return { planVersion: imp.planVersion + 1, changed: ["sheet/header row"], status: "parsing" as ImportStatus, openQuestions: 0, blockingQuestions: 0 };
      });
    }
    if (patch.answers?.not_a_catalog === "cancel") {
      await this.cancel(ctx, importId, actor);
      return { planVersion: snapshot.planVersion, changed: [], status: "cancelled" as ImportStatus, openQuestions: 0, blockingQuestions: 0 };
    }

    // Answering "I'll add them in Distru" (again) re-checks that list too, so chat answers work like the button.
    const adds = Object.entries(patch.answers ?? {}).filter(([id, a]) => id.startsWith("missing:") && a === "add").map(([id]) => id.slice(8));
    if (adds.length) patch = { ...patch, recheck: [...new Set([...(patch.recheck ?? []), ...adds])] };
    const { plan: patched, changed } = applyPatch(snapshot.plan!, patch, profile.target, snapshot.stats.columns ?? []);
    // "Re-check" fetches those Distru lists again, so names added in Distru since the upload now match.
    let refs = snapshot.refs ?? {};
    const recheck = (patch.recheck ?? []).map((f) => profile.target.fields[f]).filter((f) => f?.ref);
    if (recheck.length) {
      const fresh = await profile.refResolver.resolve(ctx, recheck, { snapshotDistinct: (f) => this.d.store.tx(ctx.tenantId, (r) => r.snapshotDistinct(f)) });
      refs = { ...refs, ...fresh };
    }
    const plan = await finalizePlan(patched, {
      profile, columns: snapshot.stats.columns ?? [], refs, valueStages: this.activeValueStages(),
      distinct: (src) => this.d.store.tx(ctx.tenantId, (r) => r.distinctRaw(importId, src, 1000)),
      onUsage: (method, u) => track(`${method}:values`)(u),
    });

    return this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      this.checkVersion(imp, args.planVersion);
      // The plan was rebuilt outside the lock (model calls). A gate confirmed or cancelled meanwhile wins.
      if (imp.status !== snapshot.status) throw new ConflictError(`Import moved to ${imp.status} while the mapping was being revised`);
      const usage = { ...(imp.stats.usage ?? {}) };
      for (const [k, u] of Object.entries(spent)) usage[k] = addUsage(usage[k], u);
      await r.updateImport(importId, { plan, planVersion: imp.planVersion + 1, ...(recheck.length ? { refs } : {}), ...(Object.keys(spent).length ? { stats: { ...imp.stats, usage } } : {}) });
      for (const [qid, answer] of Object.entries(patch.answers ?? {})) await this.event(r, importId, "question_answered", actor, { questionId: qid, answer });
      await this.event(r, importId, "plan_revised", actor, { changed, instruction: args.instruction ?? null });
      if (imp.status === "commit_review") {
        await r.deleteChunks(importId);
        await this.setStatus(r, imp, "mapping_review", actor, { reason: "mapping edited" });
      }
      return { planVersion: imp.planVersion + 1, changed, status: imp.status, openQuestions: plan.questions.filter((q) => !q.answer || q.waiting).length, blockingQuestions: openBlocking(plan).length };
    });
  }

  /**
   * An agent can pass a gate only by relaying a user message, and one message passes one gate: the "yes"
   * that confirmed the mapping can't also start the write. Enforced here, not left to the tool description.
   */
  private gateMessage(imp: ImportRecord, args: { confirmingMessageId?: string; actor?: "agent" | "user" }): string[] | null {
    if (args.actor !== "agent") return null;
    if (!args.confirmingMessageId) throw new StateError("A gate needs the id of the user message that confirmed it");
    const used = imp.stats.confirmingMessageIds ?? [];
    if (used.includes(args.confirmingMessageId)) throw new StateError("That message already confirmed an earlier step. Ask the user to confirm this step.");
    return [...used, args.confirmingMessageId];
  }

  /** Gate 1. Only a person confirms; the agent relays an explicit "yes" with its message id. */
  async confirmMapping(ctx: Ctx, importId: string, args: { planVersion: number; confirmingMessageId?: string; actor?: "agent" | "user" }) {
    const sends: { data: Record<string, Json>; key: string }[] = [];
    const res = await this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (imp.status !== "mapping_review") throw new StateError(`Gate 1 is not open (status ${imp.status})`);
      this.checkVersion(imp, args.planVersion);
      const messageIds = this.gateMessage(imp, args);
      const blocking = openBlocking(imp.plan!);
      if (blocking.length) throw new StateError(`${blocking.length} question(s) need an answer first: ${blocking.map((q) => q.prompt).join(" | ")}`);
      const cols = new Map((imp.stats.columns ?? []).map((c) => [c.source, c]));
      // Only a column's one primary mapping is remembered: not derived units, not sizes copied from names.
      const own = imp.plan!.fields.filter((m) => !m.rationale.startsWith("derived:") && !m.transforms.some((t) => t.op === "extract_quantity_from_name"));
      await r.putMemory(imp.targetId, own
        .filter((m) => m.sources.length === 1 && m.method !== "template" && !m.needsConfirm && own.filter((x) => x.sources.includes(m.sources[0])).length === 1)
        .map((m) => ({ headerNorm: normalizeHeader(m.sources[0]), targetField: m.target, transforms: m.transforms, typeSig: cols.get(m.sources[0])?.typeSig ?? "text" })));
      await r.deleteChunks(importId);
      await this.event(r, importId, "gate_confirmed", args.actor ?? "user", { gate: "mapping", planVersion: imp.planVersion, confirmingMessageId: args.confirmingMessageId ?? null });
      if (messageIds) await r.updateImport(importId, { stats: { ...imp.stats, confirmingMessageIds: messageIds } });
      await this.setStatus(r, imp, "preparing", args.actor ?? "user");
      for (const ch of chunkRanges(imp.stats.totalRows ?? 0, this.d.config.jobs.chunkSize)) {
        sends.push({ data: { tenantId: ctx.tenantId, importId, chunk: ch.index, planVersion: imp.planVersion }, key: `${importId}:${Q.prepare}:${ch.index}:${imp.planVersion}` });
      }
      return { status: "preparing" as ImportStatus, planVersion: imp.planVersion };
    });
    for (const s of sends) await this.d.queue.send(Q.prepare, s.data, { singletonKey: s.key });
    return res;
  }

  /** Gate 2 options: skip/update for existing products, per-row overrides, blank-clears. */
  async setRowActions(ctx: Ctx, importId: string, args: { planVersion: number; existingAction?: "skip" | "update"; rowOverrides?: Record<number, RowAction>; clearBlanks?: boolean; actor?: "agent" | "user" }) {
    return this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (imp.status !== "commit_review") throw new StateError(`Gate 2 is not open (status ${imp.status})`);
      this.checkVersion(imp, args.planVersion);
      const plan = imp.plan!;
      const profile = this.profile(imp.targetId);
      if (args.existingAction) plan.existingAction = args.existingAction;
      if (args.clearBlanks !== undefined) plan.clearBlanks = args.clearBlanks;
      const changedRows = await r.listRows(importId, { dupClass: ["exists_changed"], limit: 1_000_000 });
      const overrides = Object.entries(args.rowOverrides ?? {}).map(([k, v]) => [Number(k), v] as const);
      const extra = overrides.length ? await r.getRows(importId, overrides.map(([k]) => k)) : [];
      const byIdx = new Map([...changedRows, ...extra].map((x) => [x.rowIndex, x]));
      const ov = new Map(overrides);
      const patches = [];
      for (const row of byIdx.values()) {
        if (row.status !== "valid") continue;
        let action: RowAction = ov.get(row.rowIndex) ?? row.meta.userAction ?? (row.dupClass === "exists_changed" ? plan.existingAction : row.action ?? "skip");
        const allowed: RowAction[] = row.dupClass === "new" || row.dupClass === "no_sku" ? ["create", "skip"] : row.dupClass === "exists_changed" || row.dupClass === "exists_unchanged" ? ["update", "skip"] : ["skip"];
        if (!allowed.includes(action)) throw new StateError(`Row ${row.rowIndex} (${row.dupClass}) can't be set to ${action}`);
        patches.push({
          rowIndex: row.rowIndex, action,
          followup: needsFollowup(profile.target, row.output ?? {}, action, this.d.config.sink.uploadSupportsUpdate, (row.meta.diff ?? []).filter((d) => !d.blocked).map((d) => d.field)),
          ...(ov.has(row.rowIndex) ? { meta: { userAction: action } } : {}),
        });
      }
      await r.updateRows(importId, patches);
      await r.updateImport(importId, { plan, planVersion: imp.planVersion + 1 });
      await this.event(r, importId, "plan_revised", args.actor ?? "user", { gate: "commit", existingAction: plan.existingAction, clearBlanks: plan.clearBlanks, rows: patches.length });
      return { planVersion: imp.planVersion + 1 };
    });
  }

  /** Edit cells at Gate 2. Re-validates only those rows. */
  async editRows(ctx: Ctx, importId: string, args: { planVersion: number; edits: { rowIndex: number; field: string; value: Json }[]; actor?: "agent" | "user" }) {
    return this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (imp.status !== "commit_review") throw new StateError(`Rows can be edited at Gate 2 only (status ${imp.status})`);
      this.checkVersion(imp, args.planVersion);
      const profile = this.profile(imp.targetId);
      const edited = new Set(args.edits.map((e) => e.rowIndex));
      // Rows skipped as in-file duplicates of an edited row are re-checked too: once the first row's SKU
      // changes or it turns invalid, they are no longer duplicates and must not stay skipped.
      const shadowed = (await r.listRows(importId, { dupClass: ["dup_in_file"], limit: 1_000_000 }))
        .filter((x) => x.meta.firstRowIndex !== undefined && x.meta.firstRowIndex !== null && edited.has(x.meta.firstRowIndex) && !edited.has(x.rowIndex))
        .map((x) => x.rowIndex);
      const rows = await r.getRows(importId, [...edited, ...shadowed]);
      const missing = [...edited].filter((i) => !rows.some((x) => x.rowIndex === i));
      if (missing.length) throw new StateError(`No row ${missing.join(", ")} in this import`);
      for (const row of rows) {
        row.overrides = { ...(row.overrides ?? {}) };
        for (const e of args.edits.filter((x) => x.rowIndex === row.rowIndex)) {
          if (!profile.target.fields[e.field]) throw new StateError(`Unknown field "${e.field}"`);
          row.overrides[e.field] = e.value;
        }
      }
      const patches = await prepareRows(r, imp, profile, rows, this.d.config);
      await r.updateRows(importId, patches.map((p, i) => ({ ...p, overrides: rows[i].overrides })));
      await markFileDuplicates(r, importId);
      await r.updateImport(importId, { planVersion: imp.planVersion + 1 });
      await this.event(r, importId, "row_edited", args.actor ?? "user", { rows: [...edited] });
      return { planVersion: imp.planVersion + 1, rows: patches.filter((p) => edited.has(p.rowIndex)).map((p) => ({ rowIndex: p.rowIndex, status: p.status ?? null, issues: (p.issues ?? []) as unknown as Json })) };
    });
  }

  /** Gate 2. Queues csv.commit for every chunk. */
  async confirmCommit(ctx: Ctx, importId: string, args: { planVersion: number; confirmingMessageId?: string; actor?: "agent" | "user" }) {
    const sends: { data: Record<string, Json>; key: string }[] = [];
    const res = await this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (imp.status !== "commit_review") throw new StateError(`Gate 2 is not open (status ${imp.status})`);
      this.checkVersion(imp, args.planVersion);
      const messageIds = this.gateMessage(imp, args);
      if (messageIds) await r.updateImport(importId, { stats: { ...imp.stats, confirmingMessageIds: messageIds } });
      await r.deleteChunks(importId, "commit");
      await r.deleteFile(importId);
      await this.event(r, importId, "gate_confirmed", args.actor ?? "user", { gate: "commit", planVersion: imp.planVersion, confirmingMessageId: args.confirmingMessageId ?? null });
      await this.setStatus(r, imp, "committing", args.actor ?? "user");
      for (const ch of chunkRanges(imp.stats.totalRows ?? 0, this.d.config.jobs.chunkSize)) {
        sends.push({ data: { tenantId: ctx.tenantId, importId, chunk: ch.index }, key: `${importId}:${Q.commit}:${ch.index}` });
      }
      return { status: "committing" as ImportStatus };
    });
    for (const s of sends) await this.d.queue.send(Q.commit, s.data, { singletonKey: s.key });
    return res;
  }

  async cancel(ctx: Ctx, importId: string, actor: "agent" | "user" = "user") {
    return this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (!["queued", "mapping_review", "commit_review"].includes(imp.status)) throw new StateError(`Can't cancel while ${imp.status}`);
      await this.setStatus(r, imp, "cancelled", actor);
      await r.deleteFile(importId);
      return { status: "cancelled" as ImportStatus };
    });
  }

  /** Start a failed import's file again as a new import (the failed one stays as history). */
  async retry(ctx: Ctx, importId: string) {
    const { imp, bytes } = await this.d.store.tx(ctx.tenantId, async (r) => ({ imp: await this.load(r, importId), bytes: await r.getFile(importId) }));
    if (imp.status !== "failed") throw new StateError(`Only a failed import can be started again (status ${imp.status})`);
    const input: ImportInput | null = bytes ? { bytes } : imp.source.url ? { url: imp.source.url } : null;
    if (!input) throw new StateError("The file is no longer available. Drop it again to start over.");
    return this.start(ctx, { input, filename: imp.source.filename, targetId: imp.targetId, threadId: imp.threadId ?? undefined });
  }

  /** "Retry details": re-queue follow-ups that failed for good. Products stay inactive until they succeed. */
  async retryFollowups(ctx: Ctx, importId: string) {
    const batches: number[][] = [];
    await this.d.store.tx(ctx.tenantId, async (r) => {
      const imp = await this.load(r, importId, true);
      if (imp.status !== "completed" && imp.status !== "partially_completed") throw new StateError(`Nothing to retry (status ${imp.status})`);
      // A created row whose Distru ID was never found has nothing to send the details to.
      const rows = (await r.listRows(importId, { status: ["needs_attention"], followup: true, limit: 1_000_000 })).filter((x) => x.distruId);
      if (!rows.length) return;
      await r.updateRows(importId, rows.map((x) => ({ rowIndex: x.rowIndex, status: x.action === "create" ? "uploaded" : "valid", issues: x.issues.filter((i) => i.code !== "followup_failed") })));
      await this.setStatus(r, imp, "committing", "user", { reason: "retry details" });
      for (let i = 0; i < rows.length; i += this.d.config.sink.followupBatchSize) batches.push(rows.slice(i, i + this.d.config.sink.followupBatchSize).map((x) => x.rowIndex));
    });
    const stamp = Date.now();
    for (const [i, rows] of batches.entries()) await this.d.queue.send(Q.followup, { tenantId: ctx.tenantId, importId, rows }, { singletonKey: `${importId}:${Q.followup}:retry${stamp}:${i}` });
    return { requeued: batches.flat().length };
  }

  /** Rows that failed validation or commit, with the original columns plus Row and Errors. */
  errorCsv(ctx: Ctx, importId: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    // Users open this file in Excel: a cell starting with = + - @ would run as a formula, so it gets a leading quote.
    const esc = (raw: string) => {
      const s = /^[=+\-@\t\r]/.test(raw) && !/^[+-]?[\d.,]+$/.test(raw) ? `'${raw}` : raw;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    let cursor = 0;
    let headers: string[] | null = null;
    return new ReadableStream({
      pull: async (ctrl) => {
        const { rows, imp } = await this.d.store.tx(ctx.tenantId, async (r) => ({
          imp: await this.load(r, importId),
          rows: await r.listRows(importId, { status: ["invalid", "failed", "needs_attention"], afterRowIndex: cursor, limit: 1000 }),
        }));
        if (!headers) {
          headers = imp.plan?.headers ?? [];
          ctrl.enqueue(enc.encode([...headers, "Import Row", "Import Status", "Import Errors"].map(esc).join(",") + "\n"));
        }
        for (const row of rows) {
          const errs = row.issues.filter((i) => i.severity === "error" || i.code === "distru_id_not_found").map((i) => i.message).join("; ");
          ctrl.enqueue(enc.encode([...headers.map((h) => row.raw[h] ?? ""), String(row.rowIndex), row.status, errs].map(esc).join(",") + "\n"));
        }
        if (rows.length < 1000) ctrl.close();
        else cursor = rows[rows.length - 1].rowIndex;
      },
    });
  }

  isTerminal(s: ImportStatus) {
    return TERMINAL.includes(s);
  }
}
