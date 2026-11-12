import { expect, test } from "vitest";
import { JevClient, LangChainLlm, LlmJev, MockJev, MockLlm, modelsFromEnv, openRouterJev, typesafeJev } from "@distru/csv-importer/scorers";

test("stubs unless USE_REAL_MODELS=1 and a key is present", async () => {
  expect((await modelsFromEnv({})).llm).toBeInstanceOf(MockLlm);
  const noKey = await modelsFromEnv({ USE_REAL_MODELS: "1" });
  expect(noKey.llm).toBeInstanceOf(MockLlm);
  expect(noKey.jev).toBeInstanceOf(MockJev);
});

test("default: LLM direct via OpenAI (gpt-4o), Jev direct via TypeSafe", async () => {
  const m = await modelsFromEnv({ USE_REAL_MODELS: "1", OPENAI_API_KEY: "sk-test", TYPESAFE_API_KEY: "ts" });
  expect(m.llm).toBeInstanceOf(LangChainLlm);
  expect(m.jev).toBeInstanceOf(JevClient);
  expect(m.real).toEqual({ llm: "openai:gpt-4o", jev: "typesafe:jev-latest" });
});

test("openrouter: LLM via chat completions, Jev via the Decisions API", async () => {
  const m = await modelsFromEnv({ USE_REAL_MODELS: "1", OPENROUTER_API_KEY: "test", LLM_PROVIDER: "openrouter", JEV_PROVIDER: "openrouter", LLM_MODEL: "anthropic/claude-sonnet-4.5" });
  expect(m.llm).toBeInstanceOf(LangChainLlm);
  expect(m.jev).toBeInstanceOf(JevClient);
  expect(m.real).toEqual({ llm: "openrouter:anthropic/claude-sonnet-4.5", jev: "openrouter:typesafe/jev-1.14" });
  expect(m.timeoutMs).toEqual({ llm: 30_000, jev: 5_000 });
});

test("a non-Jev JEV_MODEL falls back to the LLM stand-in", async () => {
  const m = await modelsFromEnv({ USE_REAL_MODELS: "1", OPENROUTER_API_KEY: "test", JEV_PROVIDER: "openrouter", JEV_MODEL: "openai/gpt-4o-mini" });
  expect(m.jev).toBeInstanceOf(LlmJev);
});

test("Jev client: same choice body to the direct and OpenRouter endpoints; reads probabilities", async () => {
  const calls: any[] = [];
  const urls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ answers: { pick: { type: "choice", choice: "brand", probabilities: { brand: 0.9, none: 0.1 } } } }));
  }) as any;
  try {
    const items = [{ id: "Mfr", state: { header: "Mfr" }, options: [{ id: "brand", label: "Brand" }, { id: "none", label: "Not a product field" }] }];
    expect(await typesafeJev("k").choose(items)).toEqual({ Mfr: { brand: 0.9, none: 0.1 } });
    expect(await openRouterJev("k").choose(items)).toEqual({ Mfr: { brand: 0.9, none: 0.1 } });
    expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone", "https://openrouter.ai/api/alpha/decisions"]);
    expect(calls[0]).toMatchObject({ model: "jev-latest", questions: { pick: { type: "choice", criteria: { brand: "Brand", none: "Not a product field" } } } });
    expect(calls[1].model).toBe("typesafe/jev-1.14");
  } finally {
    globalThis.fetch = orig;
  }
});

test("usage and cost: Jev sums usage across requests and prices input tokens; known LLM prices", async () => {
  const { costOf, addUsage } = await import("@distru/csv-importer/core");
  const { priceFor, typesafeJev } = await import("@distru/csv-importer/scorers");
  expect(priceFor("gpt-4o")).toEqual({ input: 2.5, output: 10 });
  expect(priceFor("openai/gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
  expect(priceFor("jev-latest")).toEqual({ input: 0.042, output: 0 });
  expect(priceFor("gpt-4o", "3,12")).toEqual({ input: 3, output: 12 });
  expect(priceFor("some-new-model")).toBeUndefined();
  expect(costOf({ input: 2.5, output: 10 }, 1000, 100)).toBeCloseTo(0.0035, 10);
  expect(addUsage(undefined, { model: "m", calls: 1, inputTokens: 1, outputTokens: 2, costUsd: null }).costUsd).toBeNull();

  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { pick: { type: "choice", probabilities: { a: 1 } } }, usage: { input_tokens: 500_000, output_tokens: 3 } }))) as any;
  try {
    const seen: any[] = [];
    await typesafeJev("k").choose([{ id: "x", state: {}, options: [{ id: "a", label: "A" }] }, { id: "y", state: {}, options: [{ id: "a", label: "A" }] }], { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ model: "jev-latest", calls: 2, inputTokens: 1_000_000, outputTokens: 6, costUsd: 0.042 }]);
  } finally {
    globalThis.fetch = orig;
  }
});
