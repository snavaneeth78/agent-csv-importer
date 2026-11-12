import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ctx, setupEnv, waitFor, type Env } from "./harness.ts";

const csv = (s: string) => new TextEncoder().encode(s.trim() + "\n");

async function toGate2(env: Env, bytes: Uint8Array) {
  const { importId } = await env.importer.start(ctx, { input: { bytes }, filename: "f.csv", targetId: "distru.product" });
  const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
  await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
  return { importId, g2: await waitFor(env.importer, importId, ["commit_review"], 120_000) };
}

describe("chunk checkpoints", () => {
  let env: Env;
  beforeAll(async () => { env = await setupEnv({ jobs: { chunkSize: 50 }, sink: { followupRatePerSecond: 500, followupConcurrency: 20 } }); });
  afterAll(async () => { await env?.close(); });

  test("120 rows at chunkSize 50 run as 3 prepare and 3 commit chunks; a replayed chunk is a no-op", async () => {
    const body = ["Name,SKU,Price", ...Array.from({ length: 120 }, (_, i) => `Chunk ${i},CH-${i},10`)].join("\n");
    const { importId, g2 } = await toGate2(env, csv(body));
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    await waitFor(env.importer, importId, ["completed"]);
    const chunks = await env.importer.store.tx(ctx.tenantId, async (r) => ({ prepare: await r.listChunks(importId, "prepare"), commit: await r.listChunks(importId, "commit") }));
    expect(chunks.prepare.map((c) => c.status)).toEqual(["done", "done", "done"]);
    expect(chunks.commit.map((c) => c.status)).toEqual(["done", "done", "done"]);
    const uploads = env.mock.uploads.filter((u) => u.importId === importId);
    expect(uploads.map((u) => u.rows.length).sort()).toEqual([20, 50, 50]);

    await env.importer.jobs.commit({ tenantId: ctx.tenantId, importId, chunk: 1 });
    expect(env.mock.uploads.filter((u) => u.importId === importId)).toHaveLength(3);
  });

  test("an upload that never succeeds ends the import as failed, not completed", async () => {
    const body = ["Name,SKU,Price", ...Array.from({ length: 5 }, (_, i) => `Down ${i},DN-${i},10`)].join("\n");
    const { importId, g2 } = await toGate2(env, csv(body));
    const before = env.mock.products.length;
    env.mock.rejectUpload = () => true;
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    const done = await waitFor(env.importer, importId, ["completed", "partially_completed", "failed"], 30_000).finally(() => { env.mock.rejectUpload = undefined; });
    expect(done.status).toBe("failed");
    expect(done.counts.failed).toBe(5);
    expect(env.mock.products.length).toBe(before);
    const rows = await env.importer.listRows(ctx, importId, { status: ["failed"], limit: 10 });
    expect(rows.rows[0].issues.map((i) => i.code)).toContain("job_failed");
  });

  test("resume after a crash mid-commit creates no duplicates", async () => {
    const body = ["Name,SKU,Price", ...Array.from({ length: 30 }, (_, i) => `Crash ${i},CR-${i},10`)].join("\n");
    const { importId, g2 } = await toGate2(env, csv(body));
    let crashes = 1;
    env.mock.crashAfterUpload = () => crashes-- > 0;
    const before = env.mock.products.length;
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    const done = await waitFor(env.importer, importId, ["completed", "partially_completed", "failed"], 60_000);
    env.mock.crashAfterUpload = undefined;
    expect(done.status).toBe("completed");
    expect(done.counts.committed).toBe(30);
    expect(env.mock.products.length - before).toBe(30);
    expect(env.mock.uploads.filter((u) => u.importId === importId)).toHaveLength(1);
    const chunk = await env.importer.store.tx(ctx.tenantId, (r) => r.getChunk(importId, "commit", 0));
    expect(chunk?.attempts).toBe(2);
  });

  test("blank cells clear: ## only where Distru has a value (upload update mode)", async () => {
    const env2 = await setupEnv({ sink: { uploadSupportsUpdate: true } });
    try {
      // BD-35 has a unit cost in Distru and no MSRP.
      const { importId, g2 } = await toGate2(env2, csv("Name,SKU,Unit Price,Unit Cost,MSRP\nBlue Dream 3.5g,BD-35,40,,\nOG Kush 3.5g,OK-35,35,16,50"));
      await env2.importer.setRowActions(ctx, importId, { planVersion: g2.planVersion, existingAction: "update", clearBlanks: true });
      const v = await env2.importer.get(ctx, importId);
      await env2.importer.confirmCommit(ctx, importId, { planVersion: v.planVersion });
      await waitFor(env2.importer, importId, ["completed"]);
      const row = env2.mock.uploads.find((u) => u.importId === importId && u.mode === "update")!.rows.find((r) => r["Distru ID"] === "prod_1000")!;
      expect(row).toMatchObject({ "Distru ID": "prod_1000", "Unit Price": "40", "Unit Cost": "##", MSRP: "" });
    } finally {
      await env2.close();
    }
  });
});

describe("large file", () => {
  let env: Env;
  beforeAll(async () => { env = await setupEnv(); });
  afterAll(async () => { await env?.close(); });

  test("a 25k-row file runs as 3 chunks", async () => {
    const body = ["Name,SKU,Price", ...Array.from({ length: 25_000 }, (_, i) => `Bulk ${i},BK-${i},${(i % 50) + 1}`)].join("\n");
    const { importId, g2 } = await toGate2(env, csv(body));
    expect(g2.counts.create).toBe(25_000);
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    await waitFor(env.importer, importId, ["completed"], 180_000);
    expect(env.mock.uploads.filter((u) => u.importId === importId).map((u) => u.rows.length).sort()).toEqual([10_000, 10_000, 5_000].sort());
  }, 240_000);
});
