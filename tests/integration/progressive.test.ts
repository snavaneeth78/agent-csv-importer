import { afterAll, beforeAll, expect, test } from "vitest";
import { MockLlm } from "@distru/csv-importer/scorers";
import { ctx, setupEnv, waitFor, type Env } from "./harness.ts";

/** An LLM that takes a while, so the review is open before its answers arrive. */
class SlowLlm extends MockLlm {
  calls = 0;
  override async mapColumns(input: Parameters<MockLlm["mapColumns"]>[0]) {
    this.calls++;
    await new Promise((r) => setTimeout(r, 1500));
    return super.mapColumns(input);
  }
}

let env: Env;
const llm = new SlowLlm();
// Jev unsure about everything, so the waiting columns are decided by the LLM.
const scorer = { modelId: "t", choose: async (items: { id: string }[]) => Object.fromEntries(items.map((it) => [it.id, { none: 0.5 }])) };
beforeAll(async () => { env = await setupEnv({}, { scorer, llm }); });
afterAll(async () => { await env?.close(); });

const csv = (s: string) => new TextEncoder().encode(s.trim() + "\n");

test("the review opens before the models answer; their answers merge around the user's edits", async () => {
  const body = ["Name,SKU,Price,Lineage,Maker", "Blue Dream,PR-1,35,Blue Dream,Kiva", "OG Kush,PR-2,60,OG Kush,Cookies"].join("\n");
  const t0 = Date.now();
  const { importId } = await env.importer.start(ctx, { input: { bytes: csv(body) }, filename: "progressive.csv", targetId: "distru.product" });

  const early = await waitFor(env.importer, importId, ["mapping_review"], 30_000, { whileMatching: true });
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(early.matching?.columns.sort()).toEqual(["Lineage", "Maker"]);
  expect(early.plan!.fields.map((m) => m.target)).toEqual(expect.arrayContaining(["name", "sku", "unit_price"]));
  // No question yet for a column a model is still reading.
  expect(early.openQuestions.some((q) => q.ref?.source === "Lineage" || q.ref?.source === "Maker")).toBe(false);
  await expect(env.importer.confirmMapping(ctx, importId, { planVersion: early.planVersion })).rejects.toThrow(/Still matching 2 column/);

  // The user decides one waiting column before the LLM answers; that choice survives the merge.
  const edit = await env.importer.revise(ctx, importId, { planVersion: early.planVersion, patch: { fields: [{ target: "description", sources: ["Maker"] }] } });
  expect((await env.importer.get(ctx, importId)).matching?.columns).toEqual(["Lineage"]);

  const done = await waitFor(env.importer, importId, ["mapping_review"]);
  expect(done.matching).toBeNull();
  expect(done.plan!.fields.find((m) => m.sources[0] === "Lineage")).toMatchObject({ target: "strain", method: "llm" });
  expect(done.plan!.fields.find((m) => m.sources[0] === "Maker")).toMatchObject({ target: "description", method: "user" });
  expect(done.planVersion).toBe(edit.planVersion + 1);
  expect(llm.calls).toBe(1);

  // An edit sent against the plan from just before the merge still applies, on the merged plan.
  const late = await env.importer.revise(ctx, importId, { planVersion: edit.planVersion, patch: { ignore: ["Price"] } });
  const after = await env.importer.get(ctx, importId);
  expect(late.planVersion).toBe(done.planVersion + 1);
  expect(after.plan!.fields.find((m) => m.sources[0] === "Lineage")?.target).toBe("strain");
  expect(after.plan!.fields.some((m) => m.sources[0] === "Price")).toBe(false);
  // Anything older than that is still a conflict.
  await expect(env.importer.revise(ctx, importId, { planVersion: early.planVersion, patch: { ignore: ["SKU"] } })).rejects.toThrow(/Plan changed/);

  // The agent hears about both milestones: review open, then review complete.
  const events = await env.importer.events(ctx, importId);
  const toReview = events.filter((e) => e.type === "status_changed" && e.payload.to === "mapping_review");
  expect(toReview.map((e) => e.payload.reason ?? null)).toEqual([null, "matching finished"]);

  await env.importer.confirmMapping(ctx, importId, { planVersion: after.planVersion });
  await waitFor(env.importer, importId, ["commit_review"]);
});

test("parse and match run in one job: no separate match job is queued", async () => {
  const { importId } = await env.importer.start(ctx, { input: { bytes: csv("Name,SKU\nOne Job,OJ-1") }, filename: "one-job.csv", targetId: "distru.product" });
  await waitFor(env.importer, importId, ["mapping_review"]);
  const { rows } = await env.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'csv.match'");
  expect(rows[0].n).toBe(0);
});
