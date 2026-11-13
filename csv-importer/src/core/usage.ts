/** Tokens and spend for model calls. costUsd is null when the model's price is unknown. */
export interface ModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type UsageSink = (u: ModelUsage) => void;

/** Optional per-call options for model ports. */
export interface CallOpts {
  onUsage?: UsageSink;
  /** Aborted when the gateway's time budget runs out, so a slow request stops instead of finishing unseen. */
  signal?: AbortSignal;
}

export function addUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  if (!a) return { ...b };
  return {
    model: a.model === b.model ? a.model : `${a.model}, ${b.model}`,
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
}

export function costOf(price: Price | undefined, inputTokens: number, outputTokens: number): number | null {
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : null;
}
