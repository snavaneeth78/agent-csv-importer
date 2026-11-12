/** A timeout, rate limit, server error or dropped connection may pass on a second try; a bad key or bad request won't. */
function retryable(e: unknown): boolean {
  const err = e as { status?: number; response?: { status?: number }; code?: string; message?: string };
  const status = err?.status ?? err?.response?.status ?? Number(/\b([45]\d\d)\b/.exec(String(err?.message ?? ""))?.[1]);
  if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  return /timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(`${err?.code ?? ""} ${err?.message ?? ""}`);
}

/** Model gateway: timeout, then one retry for transient failures only. The caller degrades the item to "needs you" on failure. */
export async function gateway<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const once = () =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      fn().then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  try {
    return await once();
  } catch (e) {
    if (!retryable(e)) throw e;
    return await once();
  }
}
