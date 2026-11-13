import { afterAll, beforeAll, expect, test } from "vitest";
import { createImporterTools } from "@distru/csv-importer/langgraph";
import { createImporter } from "@distru/csv-importer/workers";
import { MockLlm } from "@distru/csv-importer/scorers";
import { ctx, fixture, setupEnv, waitFor, type Env } from "./harness.ts";

let env: Env;
beforeAll(async () => { env = await setupEnv(); });
afterAll(async () => { await env?.close(); });

test("six tools; run context from config, never from arguments; gate tools record the confirming message", async () => {
  const tools = createImporterTools(env.importer, { resolveAttachment: async () => ({ input: { bytes: fixture("clean-100.csv") }, filename: "clean-100.csv" }) });
  expect(tools.map((t) => t.name)).toEqual(["import_csv_start", "import_csv_get", "import_csv_revise", "import_csv_confirm_mapping", "import_csv_confirm_commit", "import_csv_cancel"]);
  for (const t of tools) expect(JSON.stringify((t as any).schema?.shape ?? {})).not.toMatch(/tenant/i);

  const config = { configurable: { ...ctx, threadId: "th_1", userMessageId: "msg_42" } };
  await expect(tools[0].invoke({ attachmentId: "a1" })).rejects.toThrow(/run context/);
  const started = JSON.parse(String(await tools[0].invoke({ attachmentId: "a1" }, config)));
  await waitFor(env.importer, started.importId, ["mapping_review"]);

  const summary = String(await tools[1].invoke({ importId: started.importId }, config));
  expect(summary.length).toBeLessThan(4000); // ~1k tokens
  expect(summary).not.toContain("CL-1000"); // no row data
  const { planVersion } = JSON.parse(summary);
  await tools[3].invoke({ importId: started.importId, planVersion }, config);
  const gate = (await env.importer.events(ctx, started.importId)).find((e) => e.type === "gate_confirmed")!;
  expect(gate).toMatchObject({ actor: "agent", payload: { gate: "mapping", confirmingMessageId: "msg_42" } });
  const g2 = await waitFor(env.importer, started.importId, ["commit_review"]);
  // Gate 2 in chat: options and cell edits go through import_csv_revise without leaving Gate 2.
  const res = JSON.parse(String(await tools[2].invoke({ importId: started.importId, planVersion: g2.planVersion, gate2: { existingAction: "update", clearBlanks: true }, edits: [{ row: 1, field: "Name", value: "Renamed In Chat" }] }, config)));
  expect(res.status).toBe("commit_review");
  const after = await env.importer.get(ctx, started.importId);
  expect(after.plan).toMatchObject({ existingAction: "update", clearBlanks: true });
  expect((await env.importer.listRows(ctx, started.importId, { limit: 1 })).rows[0].output?.name).toBe("Renamed In Chat");
  await tools[5].invoke({ importId: started.importId }, config);
  expect((await env.importer.get(ctx, started.importId)).status).toBe("cancelled");
});

test("the LLM matching stage is off by default", () => {
  const importer = createImporter({ pool: {} as any, boss: {} as any, profiles: [], llm: new MockLlm() });
  expect(importer.stageEnabled("llm")).toBe(false);
  expect(importer.stageEnabled("jev")).toBe(true);
  expect(createImporter({ pool: {} as any, boss: {} as any, profiles: [], disabledStages: [] }).stageEnabled("llm")).toBe(true);
});

test("with the LLM stage off, the run records it and free-text edits still work", async () => {
  env.importer.setStageEnabled("llm", false);
  try {
    const { importId } = await env.importer.start(ctx, { input: { bytes: new TextEncoder().encode("Name,Maker\nA,Kiva\nB,Wyld\n") }, filename: "off.csv", targetId: "distru.product" });
    const v = await waitFor(env.importer, importId, ["mapping_review"]);
    expect(v.stats.disabledStages).toEqual(["llm"]);
    expect(v.stats.matchStages?.some((s) => s.method === "llm")).toBe(false);
    await expect(env.importer.revise(ctx, importId, { planVersion: v.planVersion, instruction: "map Maker to Brand" })).resolves.toBeDefined();
    await env.importer.cancel(ctx, importId);
  } finally {
    env.importer.setStageEnabled("llm", true);
  }
});
