/** A timeout, rate limit, server error or dropped connection may pass on a second try; a bad key or bad request won't. */
function retryable(e: unknown): boolean {
  const err = e as { status?: number; response?: { status?: number }; code?: string; message?: string };
  const status = err?.status ?? err?.response?.status ?? Number(/\b([45]\d\d)\b/.exec(String(err?.message ?? ""))?.[1]);
  if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  return /timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(`${err?.code ?? ""} ${err?.message ?? ""}`);
}

/** A retry needs at least this much of the budget left to be worth sending. */
const MIN_RETRY_MS = 250;

/**
 * Model gateway. `budgetMs` is the whole time the caller waits, the one retry included: a slow call can't cost
 * twice the timeout. A transient failure that comes back fast (429, 503, dropped connection) is retried with what
 * is left of the budget; a timeout uses it all, so it is not retried. When the budget runs out the request is
 * aborted through `signal`. The caller degrades the item to "needs you" on failure.
 */
export async function gateway<T>(name: string, budgetMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = Date.now() + budgetMs;
  const once = (ms: number) =>
    new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => {
        const err = new Error(`${name} timed out after ${budgetMs}ms`);
        ctrl.abort(err);
        reject(err);
      }, ms);
      fn(ctrl.signal).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  try {
    return await once(budgetMs);
  } catch (e) {
    const left = deadline - Date.now();
    if (!retryable(e) || left < MIN_RETRY_MS) throw e;
    return await once(left);
  }
}
