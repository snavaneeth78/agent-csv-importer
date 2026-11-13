import type pg from "pg";
import type { PgBoss } from "pg-boss";
import {
  ImportService, Q, resolveConfig, type ChoiceScorer, type DeepPartial, type ImporterConfig, type Json, type LlmMatcher,
  type Queue, type TargetProfile,
} from "../core/index.ts";
import { PgStore } from "../pg/index.ts";
import { defaultStages, defaultValueStages } from "../scorers/index.ts";
import { Jobs } from "./jobs.ts";

export { Jobs } from "./jobs.ts";
export { RateLimiter } from "./limiter.ts";

export const HARNESS = { run: "harness.run", tail: "harness.tail" } as const;

class BossQueue implements Queue {
  constructor(private boss: PgBoss) {}
  async send(queue: string, data: Record<string, Json>, opts: { singletonKey?: string; startAfterSeconds?: number } = {}) {
    await this.boss.send(queue, data, { singletonKey: opts.singletonKey, ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
  }
}

export interface CreateImporterOptions {
  pool: pg.Pool;
  /** Started PgBoss instance. Distru owns its lifecycle. */
  boss: PgBoss;
  profiles: TargetProfile[];
  /** Jev (stage 5). Omit to skip the stage. */
  scorer?: ChoiceScorer;
  /** BYO LLM: stage 6 and value matching when switched on, and natural-language revise. */
  llm?: LlmMatcher;
  config?: DeepPartial<ImporterConfig>;
  fetch?: typeof fetch;
  /**
   * Stages to start switched off. Default ["llm"]: the LLM matching pass gave no gain in the eval and adds
   * seconds, so matching ends at Jev. Pass [] to switch it on. Toggle later with importer.setStageEnabled().
   * Natural-language revise works whenever `llm` is set, whatever this says.
   */
  disabledStages?: ("llm" | "jev")[];
}

export class Importer extends ImportService {
  readonly config: ImporterConfig;
  readonly store: PgStore;
  readonly jobs: Jobs;
  private boss: PgBoss;

  constructor(opts: CreateImporterOptions) {
    const config = resolveConfig(opts.config);
    const store = new PgStore(opts.pool);
    const queue = new BossQueue(opts.boss);
    const valueStages = defaultValueStages({ config, jev: opts.scorer, llm: opts.llm });
    super({ store, queue, profiles: opts.profiles, valueStages, llm: opts.llm, config });
    this.config = config;
    this.store = store;
    this.boss = opts.boss;
    for (const s of opts.disabledStages ?? ["llm"]) this.setStageEnabled(s, false);
    this.jobs = new Jobs({ store, queue, service: this, config, valueStages, stages: defaultStages({ config, jev: opts.scorer, llm: opts.llm }), fetch: opts.fetch });
  }

  /** Runs migrations/*.sql and creates the pg-boss queues. */
  async migrate() {
    await this.store.migrate();
    const { jobs } = this.config;
    const opts = { retryLimit: jobs.retryLimit, retryDelay: jobs.retryDelaySeconds, retryBackoff: jobs.retryBackoff, expireInSeconds: jobs.expireInSeconds };
    for (const name of Object.values(Q)) {
      if (!(await this.boss.getQueue(name))) await this.boss.createQueue(name, { ...opts, policy: "exclusive" });
    }
  }

  /** Register pg-boss handlers. Same code in the harness process or a separate worker process. */
  async work(opts: { pollingIntervalSeconds?: number; concurrency?: number } = {}) {
    const poll = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 0.5, localConcurrency: opts.concurrency ?? 4 };
    const bind = (name: string, fn: (data: any) => Promise<unknown>) =>
      this.boss.work(name, poll, async ([job]) => {
        try {
          await fn(job.data);
        } catch (e) {
          const meta = await this.boss.getJobById(name, job.id).catch(() => null);
          if (meta && meta.retryCount >= meta.retryLimit) await this.jobs.onFinalFailure(name, job.data as any, e);
          throw e;
        }
      });
    await bind(Q.parse, (d) => this.jobs.parse(d));
    await bind(Q.match, (d) => this.jobs.match(d));
    await bind(Q.prepare, (d) => this.jobs.prepare(d));
    await bind(Q.commit, (d) => this.jobs.commit(d));
    await bind(Q.followup, (d) => this.jobs.followup(d));
    await bind(Q.snapshot, (d) => this.jobs.snapshot(d));
  }
}

export function createImporter(opts: CreateImporterOptions): Importer {
  return new Importer(opts);
}

/**
 * harness.run + the gate-service event tail (system design §4). The tail reads (event id, type, import id)
 * across tenants every 2 s and enqueues `harness.run { tenantId, runId, resume }` when a gate is reached,
 * confirmed, or the import finishes. `runGraph` is the harness's graph runner (LangGraph in production).
 */
export async function registerHarness(boss: PgBoss, store: PgStore, runGraph: (job: { tenantId: string; runId: string; resume: { event: { type: string; importId: string; status: string } } }) => Promise<void>) {
  for (const [name, policy] of [[HARNESS.run, "singleton"], [HARNESS.tail, "stately"]] as const) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { policy, retryLimit: 3, retryDelay: 2 });
  }
  await boss.work(HARNESS.run, { pollingIntervalSeconds: 0.5 }, async ([job]) => runGraph(job.data as any));
  await boss.work(HARNESS.tail, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
    let afterId = Number((job.data as { afterId: number }).afterId);
    for (const e of await store.eventsAfter(afterId, 500)) {
      afterId = e.id;
      const interesting = e.type === "gate_confirmed" || (e.type === "status_changed" && ["mapping_review", "commit_review", "completed", "partially_completed", "failed", "cancelled"].includes(e.status));
      if (!interesting || !e.threadId) continue;
      await boss.send(HARNESS.run, { tenantId: e.tenantId, runId: e.threadId, resume: { event: { type: e.type, importId: e.importId, status: e.status } } }, { singletonKey: `${e.threadId}:${e.id}` });
    }
    await boss.sendAfter(HARNESS.tail, { afterId }, { singletonKey: "tail" }, 2);
  });
  const latest = await store.lastEventId();
  await boss.send(HARNESS.tail, { afterId: latest }, { singletonKey: "tail" });
}
