/**
 * Per-tenant rate limit (calls/second) plus max in-flight calls. In-process: with several worker processes,
 * divide the configured rate by the process count (or move this to Postgres; see README).
 */
export class RateLimiter {
  private state = new Map<string, { inFlight: number; next: number; waiters: (() => void)[] }>();
  constructor(private perSecond: number, private concurrency: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const s = this.state.get(key) ?? { inFlight: 0, next: 0, waiters: [] };
    this.state.set(key, s);
    while (s.inFlight >= this.concurrency) await new Promise<void>((r) => s.waiters.push(r));
    s.inFlight++;
    const now = Date.now();
    const at = Math.max(now, s.next);
    s.next = at + 1000 / this.perSecond;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    try {
      return await fn();
    } finally {
      s.inFlight--;
      s.waiters.shift()?.();
    }
  }
}
