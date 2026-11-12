import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ctx, setupEnv, waitFor, type Env } from "./harness.ts";

const csv = (s: string) => new TextEncoder().encode(s.trim() + "\n");
let env: Env;
beforeAll(async () => { env = await setupEnv({ sink: { followupRatePerSecond: 20, followupConcurrency: 5, followupRetries: 3 } }); });
afterAll(async () => { await env?.close(); });

async function run(body: string) {
  const { importId } = await env.importer.start(ctx, { input: { bytes: csv(body) }, filename: "f.csv", targetId: "distru.product" });
  const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
  await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
  const g2 = await waitFor(env.importer, importId, ["commit_review"]);
  return { importId, g2 };
}

describe("follow-up path (inactive until finished)", () => {
  test("M-only fields go via follow-up; weight group is never split; created inactive then activated in one mutation", async () => {
    const { importId, g2 } = await run("Name,SKU,Size,THC,Active\nFU One,FU-1,3.5g,22%,yes\nFU Two,FU-2,7g,18%,no");
    expect(g2.followupEstimate).toMatchObject({ rows: 2, creates: 2 });
    let snapshotAtUpload: boolean[] = [];
    env.mock.failMutation = () => { if (snapshotAtUpload.length) return undefined; snapshotAtUpload = env.mock.products.filter((p) => p.sku?.startsWith("FU-")).map((p) => p.inactive); return undefined; };
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    const done = await waitFor(env.importer, importId, ["completed"]);
    env.mock.failMutation = undefined;
    expect(done.progress.details).toMatchObject({ done: 2, total: 2 });

    const upload = env.mock.uploads.find((u) => u.importId === importId)!;
    expect(upload.headers).not.toContain("Total THC");
    expect(upload.headers).not.toContain("Net Quantity Unit");
    expect(upload.rows.every((r) => r.Inactive === "TRUE" && r["Net Quantity per Unit"] === "" && r["Serving Size"] === "")).toBe(true);
    expect(snapshotAtUpload.length).toBeGreaterThan(0);
    expect(snapshotAtUpload.every((x) => x === true)).toBe(true);

    const p1 = env.mock.products.find((p) => p.sku === "FU-1")!;
    const p2 = env.mock.products.find((p) => p.sku === "FU-2")!;
    expect(p1).toMatchObject({ inactive: false, netWeight: 3.5, netWeightUnit: { name: "Gram" }, totalThc: 22, cannabinoidUnit: "PERCENT" });
    expect(p2.inactive).toBe(true); // user said Active=no
    const m1 = env.mock.mutations.find((m) => m.id === p1.id)!;
    expect(m1.product).toMatchObject({ netWeight: 3.5, netWeightUnit: { name: "Gram" }, totalThc: 22, inactive: false });
  });

  test("429/5xx retry; 4xx is permanent: product stays inactive with needs_attention; Retry details finishes it", async () => {
    const { importId, g2 } = await run("Name,SKU,THC\nR One,RT-1,20%\nR Two,RT-2,21%\nR Three,RT-3,22%");
    const id = (sku: string) => env.mock.products.find((p) => p.sku === sku)?.id;
    env.mock.failMutation = (pid, attempt) => (pid === id("RT-1") && attempt <= 2 ? 429 : pid === id("RT-2") && attempt === 1 ? 503 : pid === id("RT-3") ? 400 : undefined);
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    const done = await waitFor(env.importer, importId, ["completed", "partially_completed"]);
    expect(done.status).toBe("partially_completed");
    expect(done.counts.needs_attention).toBe(1);
    expect(env.mock.products.find((p) => p.sku === "RT-1")!.inactive).toBe(false);
    expect(env.mock.products.find((p) => p.sku === "RT-3")!.inactive).toBe(true);
    const bad = (await env.importer.listRows(ctx, importId, { status: ["needs_attention"] })).rows[0];
    expect(bad.issues.find((i) => i.code === "followup_failed")?.message).toMatch(/400.*inactive/);

    env.mock.failMutation = undefined;
    await env.importer.retryFollowups(ctx, importId);
    const again = await waitFor(env.importer, importId, ["completed"]);
    expect(again.counts.needs_attention ?? 0).toBe(0);
    expect(env.mock.products.find((p) => p.sku === "RT-3")!.inactive).toBe(false);
  });

  test("rate limit is respected and committed rows are skipped on resume", async () => {
    const body = ["Name,SKU,THC", ...Array.from({ length: 40 }, (_, i) => `Rate ${i},RL-${i},20%`)].join("\n");
    const { importId, g2 } = await run(body);
    const start = env.mock.mutations.length;
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    await waitFor(env.importer, importId, ["completed"]);
    const times = env.mock.mutations.slice(start).map((m) => Date.parse(m.at));
    expect(times).toHaveLength(40);
    for (let i = 0; i < times.length; i++) expect(times.filter((t) => t >= times[i] && t < times[i] + 1000).length).toBeLessThanOrEqual(21);

    const rows = (await env.importer.listRows(ctx, importId, { limit: 100 })).rows.map((r) => r.rowIndex);
    await env.importer.store.tx(ctx.tenantId, (r) => r.updateImport(importId, { status: "committing" }));
    await env.importer.jobs.followup({ tenantId: ctx.tenantId, importId, rows });
    expect(env.mock.mutations.length - start).toBe(40);
  });
});

describe("catalog snapshot", () => {
  test("full load resumes from its cursor after a crash; a delta past the cap triggers a full reload", async () => {
    const e = await setupEnv({ snapshot: { pageSize: 10, maxDeltaPages: 2 } });
    try {
      let failed = false;
      e.mock.failSearch = (cursor) => { if (cursor === "20" && !failed) { failed = true; return true; } return false; };
      await e.importer.jobs.requestFullSnapshot(ctx, "distru.product");
      await expect(e.importer.jobs.snapshot({ tenantId: ctx.tenantId, actor: ctx.actor, targetId: "distru.product" })).rejects.toThrow();
      const calls = e.mock.searchCalls.length;
      await e.importer.jobs.snapshot({ tenantId: ctx.tenantId, actor: ctx.actor, targetId: "distru.product" });
      expect(e.mock.searchCalls.slice(calls)[0].cursor).toBe("20");
      expect(await e.importer.store.tx(ctx.tenantId, (r) => r.snapshotLookup({ skus: e.mock.products.map((p) => p.sku!).filter(Boolean) }))).toHaveLength(50);

      const now = new Date(Date.now() + 1000).toISOString();
      e.mock.products.forEach((p) => (p.updatedAt = now));
      const state = (await e.importer.store.tx(ctx.tenantId, (r) => r.getSnapshotState()))!;
      expect(await e.importer.jobs.deltaRefresh(ctx, "distru.product", state.refreshedAt!)).toBe(true);
    } finally {
      await e.close();
    }
  });
});
