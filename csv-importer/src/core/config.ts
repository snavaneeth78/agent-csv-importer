export interface ImporterConfig {
  jobs: {
    retryLimit: number;
    retryDelaySeconds: number;
    retryBackoff: boolean;
    expireInSeconds: number;
    chunkSize: number;
  };
  limits: { maxFileBytes: number; maxRows: number };
  snapshot: { maxAgeHours: number; maxDeltaPages: number; pageSize: number };
  sink: {
    uploadSupportsUpdate: boolean;
    followupBatchSize: number;
    followupConcurrency: number;
    followupRatePerSecond: number;
    followupRetries: number;
  };
  matching: {
    /**
     * jevSuggest: Jev answers between this and `jev` become suggestions to confirm and skip the LLM.
     * llm: an LLM answer under this is a suggestion to confirm, and never ignores a column on its own.
     */
    thresholds: { memory: number; pattern: number; fuzzy: number; jev: number; jevSuggest: number; llm: number };
    fuzzyMin: number;
  };
  scorers: { timeoutMs: { jev: number; llm: number } };
  retention: { rowsDays: number; abandonedDays: number };
}

export const defaultConfig: ImporterConfig = {
  jobs: { retryLimit: 3, retryDelaySeconds: 10, retryBackoff: true, expireInSeconds: 900, chunkSize: 10_000 },
  limits: { maxFileBytes: 50 * 1024 * 1024, maxRows: 100_000 },
  snapshot: { maxAgeHours: 24, maxDeltaPages: 20, pageSize: 500 },
  sink: {
    uploadSupportsUpdate: false,
    followupBatchSize: 500,
    followupConcurrency: 5,
    followupRatePerSecond: 10,
    followupRetries: 3,
  },
  matching: { thresholds: { memory: 0.9, pattern: 0.85, fuzzy: 0.85, jev: 0.75, jevSuggest: 0.4, llm: 0.6 }, fuzzyMin: 0.88 },
  scorers: { timeoutMs: { jev: 2000, llm: 20000 } },
  retention: { rowsDays: 90, abandonedDays: 7 },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function resolveConfig(partial: DeepPartial<ImporterConfig> = {}): ImporterConfig {
  return merge(structuredClone(defaultConfig), partial) as ImporterConfig;
}

function merge(base: any, over: any): any {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") base[k] = merge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}
