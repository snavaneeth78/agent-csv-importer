import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportEvent, ImportStatus } from "../core/index.ts";
import type { ImportApi, ImportView } from "./api.ts";
import { ACTIVE, TERMINAL } from "./util.ts";

const FAST_MS = 1000;
const IDLE_MS = 2500;
const EVENT_PAGE = 200;

export interface UseImport {
  view: ImportView | null;
  events: ImportEvent[];
  error: string | null;
  refresh: () => Promise<ImportView | null>;
}

export function useImport(importId: string | null, api: ImportApi, opts: { onEvent?: (e: ImportEvent) => void } = {}): UseImport {
  const [view, setView] = useState<ImportView | null>(null);
  const [events, setEvents] = useState<ImportEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const lastId = useRef(0);
  const status = useRef<ImportStatus | null>(null);
  const matching = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;

  const load = useCallback(async (g: number): Promise<ImportView | null> => {
    if (!importId) return null;
    const v = await api.get(importId);
    if (g !== gen.current) return null;
    status.current = v.status;
    matching.current = !!v.matching;
    setView(v);
    setError(null);
    return v;
  }, [api, importId]);

  const pullEvents = useCallback(async (g: number): Promise<number> => {
    if (!importId) return 0;
    let total = 0;
    for (;;) {
      const page = await api.events(importId, lastId.current);
      if (g !== gen.current || !page.length) return total;
      lastId.current = page[page.length - 1].id;
      total += page.length;
      setEvents((prev) => [...prev, ...page].slice(-500));
      for (const e of page) onEvent.current?.(e);
      if (page.length < EVENT_PAGE) return total;
    }
  }, [api, importId]);

  const schedule = useCallback((g: number) => {
    clearTimeout(timer.current);
    const s = status.current;
    if (g !== gen.current || (s && TERMINAL.includes(s))) return;
    // The review opens before the model answers arrive: poll fast until they're merged.
    const delay = (s && ACTIVE.includes(s)) || matching.current ? FAST_MS : IDLE_MS;
    timer.current = setTimeout(async () => {
      try {
        if (!status.current) await load(g);
        // Follow-ups checkpoint per row without an event per row, so progress is re-read every tick while committing.
        else if ((await pullEvents(g)) || status.current === "committing") await load(g);
        if (g === gen.current) setError(null);
      } catch (e) {
        if (g === gen.current) setError((e as Error).message);
      }
      schedule(g);
    }, delay);
  }, [load, pullEvents]);

  const refresh = useCallback(async () => {
    const g = gen.current;
    const v = await load(g);
    schedule(g);
    return v;
  }, [load, schedule]);

  useEffect(() => {
    const g = ++gen.current;
    lastId.current = 0;
    status.current = null;
    setView(null);
    setEvents([]);
    setError(null);
    if (!importId) return;
    (async () => {
      try {
        await pullEvents(g);
        await load(g);
      } catch (e) {
        if (g === gen.current) setError((e as Error).message);
      }
      schedule(g);
    })();
    return () => {
      gen.current++;
      clearTimeout(timer.current);
    };
  }, [importId, load, pullEvents, schedule]);

  return { view, events, error, refresh };
}
