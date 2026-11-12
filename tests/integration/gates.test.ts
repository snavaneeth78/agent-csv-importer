import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { answerSuggested, ctx, fixture, setupEnv, waitFor, type Env } from "./harness.ts";

let env: Env;
beforeAll(async () => { env = await setupEnv({ sink: { followupRatePerSecond: 500, followupConcurrency: 20 } }); });
afterAll(async () => { await env?.close(); });

const csv = (s: string) => new TextEncoder().encode(s.trim() + "\n");
const start = (bytes: Uint8Array, filename = "f.csv", c = ctx) => env.importer.start(c, { input: { bytes }, filename, targetId: "distru.product", threadId: "thread_1" });

describe("gates", () => {
  test("an agent passes a gate only with a user message id, and one message passes one gate", async () => {
    const body = ["Name,SKU,Price", "Gate A,GA-1,10", "Gate B,GA-2,12"].join("\n");
    const { importId } = await start(csv(body), "agent-gates.csv");
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    await expect(env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion, actor: "agent" })).rejects.toThrow(/user message/);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion, confirmingMessageId: "msg_7", actor: "agent" });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    await expect(env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion, confirmingMessageId: "msg_7", actor: "agent" })).rejects.toThrow(/already confirmed/);
    expect((await env.importer.get(ctx, importId)).status).toBe("commit_review");
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion, confirmingMessageId: "msg_8", actor: "agent" });
    await waitFor(env.importer, importId, ["completed"]);
  });

  test("full lifecycle through both gates; neither gate can be skipped", async () => {
    const { importId } = await start(fixture("clean-100.csv"), "clean-100.csv");
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    expect(g1.overallConfidence).toBeGreaterThan(0.9);

    await expect(env.importer.confirmCommit(ctx, importId, { planVersion: g1.planVersion })).rejects.toThrow(/Gate 2 is not open/);
    await expect(env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion - 1 })).rejects.toThrow(/Plan changed/);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion, confirmingMessageId: "msg_1", actor: "agent" });

    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    expect(g2.counts.create).toBe(100);
    expect(g2.followupEstimate?.creates).toBe(100);
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });

    const done = await waitFor(env.importer, importId, ["completed"]);
    expect(done.progress.created).toEqual({ done: 100, failed: 0, total: 100 });
    expect(done.progress.details.done).toBe(100);

    const events = await env.importer.events(ctx, importId);
    const gates = events.filter((e) => e.type === "gate_confirmed").map((e) => e.payload);
    expect(gates).toEqual([
      expect.objectContaining({ gate: "mapping", confirmingMessageId: "msg_1" }),
      expect.objectContaining({ gate: "commit" }),
    ]);
    const after = await env.importer.events(ctx, importId, { afterId: events[3].id });
    expect(after[0].id).toBe(events[4].id);
  });

  test("blocking questions hold Gate 1", async () => {
    const { importId } = await start(fixture("slang-units.csv"), "slang.csv");
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    expect(g1.blockingQuestions).toBeGreaterThan(0);
    await expect(env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion })).rejects.toThrow(/need an answer/);
    const pv = await answerSuggested(env.importer, importId);
    await env.importer.confirmMapping(ctx, importId, { planVersion: pv });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    const rows = await env.importer.listRows(ctx, importId, { limit: 100 });
    const eighth = rows.rows.find((r) => r.raw.Size === "eighth")!;
    expect(eighth.output).toMatchObject({ net_weight: 3.5, net_weight_unit: "Gram" });
    const lb = rows.rows.find((r) => r.raw.Size === "1/4 lb")!;
    expect(lb.output).toMatchObject({ net_weight: 0.25, net_weight_unit: "Pound" });
    await env.importer.cancel(ctx, importId);
    expect((await env.importer.get(ctx, importId)).status).toBe("cancelled");
    void g2;
  });

  test("re-uploading the same open file returns the open import; other tenants can't see it", async () => {
    const bytes = csv("Name,SKU\nA,RE-1\nB,RE-2");
    const a = await start(bytes);
    const b = await start(bytes);
    expect(b).toEqual({ importId: a.importId, status: expect.any(String), reused: true });
    await expect(env.importer.get({ tenantId: "tenant_other", actor: "x" }, a.importId)).rejects.toThrow(/not found/);
    await waitFor(env.importer, a.importId, ["mapping_review"]);
    await env.importer.cancel(ctx, a.importId);
  });

  test("a Distru ID from another tenant is rejected and never sent", async () => {
    env.mock.products.push({ id: "prod_foreign", name: "Foreign", sku: "FX-1", upc: null, inactive: false, tenantId: "tenant_other", updatedAt: new Date().toISOString() });
    const { importId } = await start(csv("Distru ID,Name,SKU,Unit Price\nprod_foreign,Hijack,FX-NEW,10\nprod_1000,Blue Dream 3.5g,BD-35,99"));
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    const rows = (await env.importer.listRows(ctx, importId)).rows;
    expect(rows[0].issues.map((i) => i.code)).toContain("distru_id_not_found");
    expect(rows[0].distruId).toBeNull();
    expect(rows[1]).toMatchObject({ distruId: "prod_1000", dupClass: "exists_changed", action: "skip" });
    await env.importer.setRowActions(ctx, importId, { planVersion: g2.planVersion, existingAction: "update" });
    const g2b = await env.importer.get(ctx, importId);
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2b.planVersion });
    await waitFor(env.importer, importId, ["completed"]);
    const sent = env.mock.uploads.filter((u) => u.importId === importId).flatMap((u) => u.rows);
    expect(sent.map((r) => r["Distru ID"])).not.toContain("prod_foreign");
    expect(env.mock.mutations.find((m) => m.id === "prod_1000")?.product).toMatchObject({ unitPrice: 99 });
  });

  test("delta refresh before commit: a product created after Gate 2 is skipped, not duplicated", async () => {
    const { importId } = await start(csv("Name,SKU,Unit Price\nLate One,LATE-1,10\nLate Two,LATE-2,10"));
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    env.mock.products.push({ id: "prod_late", name: "Late One", sku: "LATE-1", upc: null, inactive: false, tenantId: ctx.tenantId, updatedAt: new Date().toISOString() });
    await env.importer.confirmCommit(ctx, importId, { planVersion: g2.planVersion });
    const done = await waitFor(env.importer, importId, ["completed"]);
    expect(done.counts.skipped).toBe(1);
    expect(env.mock.products.filter((p) => p.sku === "LATE-1")).toHaveLength(1);
  });

  test("column memory is reused on a reordered file", async () => {
    const first = await start(csv("Thingamajig,Name\nalpha note,Mem A"));
    const g1 = await waitFor(env.importer, first.importId, ["mapping_review"]);
    const r = await env.importer.revise(ctx, first.importId, { planVersion: g1.planVersion, instruction: "map Thingamajig to Description" });
    await env.importer.confirmMapping(ctx, first.importId, { planVersion: r.planVersion });
    await waitFor(env.importer, first.importId, ["commit_review"]);
    await env.importer.cancel(ctx, first.importId);

    const second = await start(csv("Name,SKU,Thingamajig\nMem B,M-2,beta note"));
    const g = await waitFor(env.importer, second.importId, ["mapping_review"]);
    expect(g.plan!.fields.find((f) => f.sources[0] === "Thingamajig")).toMatchObject({ target: "description", method: "memory" });
    await env.importer.cancel(ctx, second.importId);
  });

  test("editing the mapping at Gate 2 goes back to Gate 1", async () => {
    const { importId } = await start(csv("Name,SKU,Notes\nE1,ED-1,hello"));
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    const r = await env.importer.revise(ctx, importId, { planVersion: g2.planVersion, patch: { ignore: ["Notes"] } });
    expect((await env.importer.get(ctx, importId)).status).toBe("mapping_review");
    await expect(env.importer.revise(ctx, importId, { planVersion: g2.planVersion, patch: { ignore: ["SKU"] } })).rejects.toThrow(/Plan changed/);
    void r;
    await env.importer.cancel(ctx, importId);
  });

  test("Gate 2 row edits re-validate only those rows", async () => {
    const { importId } = await start(csv("Name,SKU,Price\n,NN-1,10\nOK,NN-2,10"));
    const g1 = await waitFor(env.importer, importId, ["mapping_review"]);
    await env.importer.confirmMapping(ctx, importId, { planVersion: g1.planVersion });
    const g2 = await waitFor(env.importer, importId, ["commit_review"]);
    expect(g2.counts.invalid).toBe(1);
    const res = await env.importer.editRows(ctx, importId, { planVersion: g2.planVersion, edits: [{ rowIndex: 1, field: "name", value: "Fixed" }] });
    expect(res.rows[0].status).toBe("valid");
    const after = await env.importer.get(ctx, importId);
    expect(after.counts.invalid ?? 0).toBe(0);
    expect(after.counts.create).toBe(2);
    await env.importer.cancel(ctx, importId);
  });

  test("errorCsv lists invalid rows with their errors", async () => {
    const { importId } = await start(fixture("messy-200.csv"), "messy.csv");
    await waitFor(env.importer, importId, ["mapping_review"]);
    const pv = await answerSuggested(env.importer, importId);
    await env.importer.confirmMapping(ctx, importId, { planVersion: pv });
    await waitFor(env.importer, importId, ["commit_review"]);
    const text = await new Response(env.importer.errorCsv(ctx, importId)).text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("Import Row,Import Status,Import Errors");
    expect(text).toMatch(/Name is required/);
    expect(text).toMatch(/EUR/);
    await env.importer.cancel(ctx, importId);
  });
});
