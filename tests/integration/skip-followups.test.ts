import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StateError } from "@distru/csv-importer/core";
import { ctx, setupEnv, waitFor, type Env } from "./harness.ts";

const csv = (s: string) => new TextEncoder().encode(s.trim() + "\n");
let env: Env;
// One follow-up per second, so details are still running when the test skips them.
beforeAll(async () => { env = await setupEnv({ sink: { followupRatePerSecond: 1, followupConcurrency: 1 } }); });
afterAll(async () => { await env?.close(); });

async function toGate2(body: string) {
  const { importId } = await env.importer.start(ctx, { input: { bytes: csv(body) }, filename: "skip.csv", targetId: "distru.product" });
  const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
  await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
  const g2 = await waitFor(env.importer, importId, ["commit_review"]);
  return { importId, g2 };
}

describe("skip details (stop follow-ups mid-import)", () => {
  test("ends the import with the waiting rows flagged; Retry details finishes them later", async () => {
    const body = ["Name,SKU,THC", ...Array.from({ length: 8 }, (_, i) => `Skip ${i},SK-${i},20%`)].join("\n");
    const { importId, g2 } = await toGate2(body);
    await expect(env.importer.skipFollowups(ctx, importId)).rejects.toBeInstanceOf(StateError);

    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    // Wait until every product is created and at least one is still waiting for its details.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const v = await env.importer.get(ctx, importId);
      if (v.progress.created.done === 8 && (v.counts.uploaded ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error(`never reached the follow-up phase: ${JSON.stringify(v.counts)}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const res = await env.importer.skipFollowups(ctx, importId);
    expect(res.skipped).toBeGreaterThan(0);
    const after = await env.importer.get(ctx, importId);
    expect(after.status).toBe("partially_completed");
    expect(after.counts.uploaded ?? 0).toBe(0);
    expect(after.counts.needs_attention).toBe(res.skipped);
    const flagged = (await env.importer.listRows(ctx, importId, { status: ["needs_attention"] })).rows;
    expect(flagged.every((r) => r.issues.some((i) => i.code === "followup_skipped" && /inactive/.test(i.message)))).toBe(true);
    const skippedSkus = new Set(flagged.map((r) => String((r.output as { sku?: string } | null)?.sku)));
    expect(env.mock.products.filter((p) => skippedSkus.has(String(p.sku))).every((p) => p.inactive)).toBe(true);

    await env.importer.retryFollowups(ctx, importId);
    const again = await waitFor(env.importer, importId, ["completed"], 30_000);
    expect(again.counts.needs_attention ?? 0).toBe(0);
    expect(env.mock.products.filter((p) => p.sku?.startsWith("SK-")).every((p) => !p.inactive)).toBe(true);
  }, 60_000);
});
