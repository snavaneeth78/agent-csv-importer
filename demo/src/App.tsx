import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ImportCard, httpImportApi, type ExportData, type ImportApi, type ImportView } from "@distru/csv-importer/ui";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  importId?: string;
  createdAt: string;
}

const KEY_THREAD = "csvdemo.threadId";
const KEY_IMPORT = "csvdemo.importId";
const KEY_DEV = "csvdemo.devMode";
const POLL_MS = 1500;
/** Rows rendered in the export preview; the full set is in the CSV download. */
const PREVIEW_ROWS = 50;

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
  return value ?? null;
}

function threadIdFor(): string {
  const existing = store(KEY_THREAD);
  if (existing) return existing;
  const id = crypto.randomUUID();
  store(KEY_THREAD, id);
  return id;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function App() {
  const api = useMemo(() => httpImportApi("/api"), []);
  const [threadId] = useState(threadIdFor);
  const [importId, setImportIdState] = useState<string | null>(() => store(KEY_IMPORT));
  const [view, setView] = useState<ImportView | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  // Developer mode is the demo view (stages, scores, timings, payloads). Off is what a customer sees.
  const [dev, setDev] = useState(() => store(KEY_DEV) !== "off");
  const toggleDev = () => setDev((d) => { store(KEY_DEV, d ? "off" : "on"); return !d; });
  // An import the user reopened from its chat chip stays open even if it's cancelled.
  const pinned = useRef<string | null>(null);

  const selectImport = useCallback((id: string, explicit = false) => {
    if (explicit) pinned.current = id;
    setCleared(null);
    setImportIdState(id);
    store(KEY_IMPORT, id);
  }, []);

  const onView = useCallback((v: ImportView) => {
    setView(v);
    if (v.status === "cancelled" && pinned.current !== v.id) {
      setCleared(v.filename);
      setImportIdState(null);
      store(KEY_IMPORT, null);
    }
  }, []);

  return (
    <div className="app">
      <header className="app-head">
        <span className="app-logo"><span className="app-mark" aria-hidden="true" />distru</span>
        <span className="app-divider" />
        <span className="app-sub">Copilot</span>
        <span className="app-crumb">Product import</span>
        <button type="button" role="switch" aria-checked={dev} className={`app-dev${dev ? " app-dev-on" : ""}`} onClick={toggleDev} title={dev ? "Showing matching stages, scores and payloads" : "Showing what a customer sees"}>
          <span className="app-dev-label">Developer mode</span>
          <span className="app-dev-track" aria-hidden="true"><span className="app-dev-thumb" /></span>
        </button>
      </header>
      <main className="app-main">
        <Chat dev={dev} threadId={threadId} activeImportId={importId} status={importId && view?.id === importId ? view.status : undefined} onImport={selectImport} />
        <section className="app-side">
          {importId ? (
            <>
              <ImportCard
                key={importId}
                importId={importId}
                api={api}
                devMode={dev}
                onView={onView}
                onOpenImport={(id) => selectImport(id, true)}
                onDismiss={() => { setImportIdState(null); store(KEY_IMPORT, null); }}
              />
              {dev && view?.id === importId && (view.status === "completed" || view.status === "partially_completed") && (
                <ExportPanel api={api} view={view} />
              )}
            </>
          ) : (
            <div className="app-empty">
              {cleared ? (
                <>
                  <h2>Import cancelled</h2>
                  <p>{cleared} was cancelled. Nothing was changed in Distru. Drop another file in the chat to start again.</p>
                </>
              ) : (
                <>
                  <h2>No import yet</h2>
                  <p>The import card appears here once you drop a file in the chat.</p>
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

const SUGGESTIONS: Partial<Record<ImportView["status"], string[]>> = {
  mapping_review: ["what do you need?", "accept all", "show mapping", "yes", "llm off", "llm on", "rerun", "cancel"],
  commit_review: ["yes", "show problems", "update existing", "clear blanks on", "cancel"],
  committing: ["status"],
  partially_completed: ["status", "rerun"],
  completed: ["rerun", "llm off", "llm on"],
  cancelled: ["rerun"],
};

/** Chips that only make sense when demoing the engine. */
const DEV_SUGGESTIONS = new Set(["llm off", "llm on", "rerun", "show mapping", "status"]);

/** Customer view of an assistant message: the same content without model names and scores. */
function polish(text: string): string {
  return text
    .replace(/ \(confidence \d+%\)/g, "")
    .replace(/\(suggested, (?:Jev|LLM) \d+%[^)]*\)/g, "(suggested)")
    .replace(/ \((?:Jev|LLM) \d+%[^)]*\)/g, "")
    .replace(/will be created inactive, then finished over ~(\d+) min/g, "will be added, then go live in about $1 min");
}

function Chat({ dev, threadId, activeImportId, status, onImport }: { dev: boolean; threadId: string; activeImportId: string | null; status?: ImportView["status"]; onImport: (id: string, explicit?: boolean) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const lastId = useRef(0);
  const initial = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const onImportRef = useRef(onImport);
  onImportRef.current = onImport;

  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
    lastId.current = Math.max(lastId.current, ...incoming.map((m) => m.id));
    const latest = [...incoming].reverse().find((m) => m.importId && !/^Cancelled\b/.test(m.text));
    const keepStored = initial.current && store(KEY_IMPORT);
    if (latest?.importId && !keepStored) onImportRef.current(latest.importId);
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages?afterId=${lastId.current}`);
        // A fetch from a discarded effect (React dev double-run) must not end the "first load" window.
        if (res.ok && live) {
          merge((await res.json()) as ChatMessage[]);
          initial.current = false;
        }
      } catch {
        // server not reachable yet; keep polling
      }
      if (live) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [threadId, merge]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = async (body: { text?: string; file?: { name: string; base64: string } }) => {
    setSending(true);
    setError(null);
    initial.current = false;
    try {
      const res = await postJson<{ messages: ChatMessage[] }>("/api/chat", { threadId, ...body });
      merge(res.messages);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file: File | undefined) => {
    if (!file || sending) return;
    if (!/\.(csv|tsv|txt|xlsx|xls)$/i.test(file.name)) {
      setError("Use a CSV or XLSX file.");
      return;
    }
    try {
      await send({ file: { name: file.name, base64: await readBase64(file) } });
    } catch {
      setError(`Couldn't read ${file.name}.`);
    }
  };

  const suggestions = (status ? SUGGESTIONS[status] ?? [] : []).filter((t) => dev || !DEV_SUGGESTIONS.has(t));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setText("");
    // Put the message back if it didn't send, unless the user has typed something new since.
    send({ text: t }).then((ok) => { if (!ok) setText((cur) => cur || t); });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    sendFile(e.dataTransfer.files[0]);
  };

  return (
    <section
      className={`chat${dragging ? " chat-drag" : ""}`}
      onDragEnter={() => { dragDepth.current++; setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={onDrop}
    >
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <h2>Import your product catalog</h2>
            <p className="muted">Drop a CSV or XLSX here in any format. I'll map the columns, flag anything unclear, and ask before anything is written to Distru.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-text">{dev || m.role === "user" ? m.text : polish(m.text)}</div>
            {m.importId && (
              <button
                className={`msg-chip${m.importId === activeImportId ? " msg-chip-on" : ""}`}
                onClick={() => onImport(m.importId!, true)}
              >
                {dev ? "Import card" : "View import"}
              </button>
            )}
          </div>
        ))}
        {sending && <div className="msg msg-assistant msg-pending"><span className="dots"><i /><i /><i /></span></div>}
      </div>
      <div className="chat-composer">
        {error && <p className="chat-error">{error}</p>}
        {suggestions.length > 0 && (
          <div className="chat-suggest">
            {suggestions.map((t) => (
              <button key={t} type="button" className="chat-chip" disabled={sending} onClick={() => send({ text: t })}>{t}</button>
            ))}
          </div>
        )}
        <form className="chat-input" onSubmit={submit}>
          <button type="button" className="chat-attach" onClick={() => fileRef.current?.click()} disabled={sending} title="Attach a CSV or XLSX" aria-label="Attach a file">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 6.5 7.8 12.2a1.5 1.5 0 0 0 2.1 2.1l6-6a3 3 0 0 0-4.2-4.2l-6 6a4.5 4.5 0 0 0 6.4 6.4l5.3-5.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = ""; }} />
          <input className="chat-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={status ? "Ask or tell me what to change" : "Drop a file, or attach one"} />
          <button className="chat-send" disabled={sending || !text.trim()} aria-label="Send">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M10.5 5 15.5 10l-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </form>
      </div>
      {dragging && <div className="chat-drop">Drop a CSV or XLSX</div>}
    </section>
  );
}

function ExportPanel({ api, view }: { api: ImportApi; view: ImportView }) {
  const [data, setData] = useState<ExportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [showFollowups, setShowFollowups] = useState(false);
  useEffect(() => {
    let live = true;
    api.exportJson(view.id)
      .then((d) => live && setData(d))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [api, view.id, view.updatedAt]);

  return (
    <div className="export">
      <div className="export-head">
        <h3>Exported to Distru</h3>
        <div className="export-links">
          <a className="btn" href={api.exportCsvUrl(view.id)} download>Download CSV</a>
        </div>
      </div>
      {error && <p className="chat-error">{error}</p>}
      {!data && !error && <p className="muted">Loading export…</p>}
      {data && (
        <>
          <p className="muted small">
            {data.rows.length.toLocaleString()} rows in the upload template
            {data.rows.length > PREVIEW_ROWS ? `, showing the first ${PREVIEW_ROWS}. Download the CSV for all of them.` : ""}
          </p>
          <div className="export-table">
            <table>
              <thead>
                <tr>{data.headers.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                  <tr key={i}>{data.headers.map((h) => <td key={h}>{r[h]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <details onToggle={(e) => setShowRows(e.currentTarget.open)}>
            <summary>Rows as JSON{data.rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS})` : ""}</summary>
            {showRows && <pre>{JSON.stringify(data.rows.slice(0, PREVIEW_ROWS), null, 2)}</pre>}
          </details>
          <details onToggle={(e) => setShowFollowups(e.currentTarget.open)}>
            <summary>Follow-up updates ({data.followups.length.toLocaleString()})</summary>
            {showFollowups && <pre>{JSON.stringify(data.followups.slice(0, PREVIEW_ROWS), null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
