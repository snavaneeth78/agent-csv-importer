import { readFileSync } from "node:fs";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { inject } from "vitest";
import type { DeepPartial, ImportStatus, ImporterConfig } from "@distru/csv-importer/core";
import { MockDistru, createMockedProfile } from "@distru/csv-importer/distru";
import { MockJev, MockLlm } from "@distru/csv-importer/scorers";
import { createImporter, type Importer } from "@distru/csv-importer/workers";

export const ctx = { tenantId: "tenant_demo", actor: "user_1" };

export interface Env {
  importer: Importer;
  mock: MockDistru;
  pool: pg.Pool;
  boss: PgBoss;
  close(): Promise<void>;
}

/** A fresh database per call: migrations, pg-boss, workers and a mocked Distru. */
export async function setupEnv(config: DeepPartial<ImporterConfig> = {}): Promise<Env> {
  const base = inject("dbUrl");
  const name = `t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  const boss = new PgBoss({ connectionString: url.toString(), max: 5 });
  boss.on("error", () => {});
  await boss.start();
  const mock = new MockDistru(ctx.tenantId);
  const importer = createImporter({
    pool, boss, profiles: [await createMockedProfile(mock)], scorer: new MockJev(), llm: new MockLlm(),
    // Fast retries by default; a test's own `jobs` settings are merged in, not swapped for them.
    config: { ...config, jobs: { retryDelaySeconds: 1, retryBackoff: false, ...config.jobs } } as DeepPartial<ImporterConfig>,
  });
  await importer.migrate();
  await importer.work({ pollingIntervalSeconds: 0.5 });
  return { importer, mock, pool, boss, close: async () => { await boss.stop({ graceful: false, wait: true } as any).catch(() => {}); await pool.end(); } };
}

export const fixture = (name: string) => new Uint8Array(readFileSync(`fixtures/${name}`));

export async function waitFor(importer: Importer, importId: string, statuses: ImportStatus[], timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await importer.get(ctx, importId);
    if (statuses.includes(v.status)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${statuses.join("/")}; status=${v.status} error=${JSON.stringify(v.error)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Answer every open blocking question with its suggested option. */
export async function answerSuggested(importer: Importer, importId: string) {
  const v = await importer.get(ctx, importId);
  const answers = Object.fromEntries(v.openQuestions.filter((q) => q.blocking).map((q) => [q.id, q.suggested ?? q.options?.[0]?.id ?? ""]));
  if (!Object.keys(answers).length) return v.planVersion;
  return (await importer.revise(ctx, importId, { planVersion: v.planVersion, patch: { answers } })).planVersion;
}
