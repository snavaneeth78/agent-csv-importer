import { useEffect, useRef, useState } from "react";
import type { ImportEvent, ImportStatus } from "../core/index.ts";
import type { ImportApi, ImportView } from "./api.ts";
import { CommitReview } from "./CommitReview.tsx";
import { Footer, MappingReview } from "./MappingReview.tsx";
import { useImport } from "./useImport.ts";
import { RunLog, fmtMs } from "./RunLog.tsx";
import { DevModeContext, useDevMode } from "./mode.ts";
import { ImportedTable } from "./ImportedTable.tsx";
import { STATUS_LABEL, TERMINAL, confidenceTone, fieldLabel, fmtNum, humanize, targetFields, useAction } from "./util.ts";

export interface ImportCardProps {
  importId: string;
  api: ImportApi;
  onEvent?: (e: ImportEvent) => void;
  /** Called whenever a fresh view is loaded. */
  onView?: (view: ImportView) => void;
  /** Show another import in place of this one (continue an open import, or one this card just started). */
  onOpenImport?: (importId: string) => void;
  /** The import can't be loaded (for example it no longer exists) and the user dismissed the card. */
  onDismiss?: () => void;
  /** Show matching stages, scores, timings and spend. Off by default: customers see plain wording only. */
  devMode?: boolean;
}

const STEPS: { label: string; statuses: ImportStatus[] }[] = [
  { label: "Read file", statuses: ["queued", "parsing"] },
  { label: "Match columns", statuses: ["matching"] },
  { label: "Review mapping", statuses: ["mapping_review"] },
  { label: "Check rows", statuses: ["preparing"] },
  { label: "Review import", statuses: ["commit_review"] },
  { label: "Import", statuses: ["committing", "completed", "partially_completed"] },
];

const CANCELLABLE: ImportStatus[] = ["queued", "mapping_review", "commit_review"];

export function ImportCard({ devMode = false, ...props }: ImportCardProps) {
  return <DevModeContext.Provider value={devMode}><Card {...props} /></DevModeContext.Provider>;
}

function Card({ importId, api, onEvent, onView, onOpenImport, onDismiss }: Omit<ImportCardProps, "devMode">) {
  const dev = useDevMode();
  const { view, events, error, refresh } = useImport(importId, api, { onEvent });
  const action = useAction(refresh);
  const [showLog, setShowLog] = useState(false);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => { if (view) onViewRef.current?.(view); }, [view]);

  if (!view) {
    return (
      <div className="ci-card">
        <div className="ci-body ci-muted">
          {error ? `Can't load import: ${error}` : "Loading import…"}
          {error && onDismiss && <> <button type="button" className="ci-btn" onClick={onDismiss}>Dismiss</button></>}
        </div>
      </div>
    );
  }

  const rows = view.stats.totalRows ?? view.counts.rows ?? 0;
  const s = view.status;

  return (
    <div className="ci-card">
      <div className="ci-top">
      <header className="ci-head">
        <div className="ci-title">
          <span className="ci-file" title={view.filename}>{view.filename}</span>
          <span className={`ci-pill ci-pill-${s}`}>{STATUS_LABEL[s]}</span>
        </div>
        <div className="ci-meta">
          {rows > 0 && <span>{fmtNum(rows)} rows</span>}
          {dev && view.plan && (
            <span className="ci-conf">
              <span className={`ci-dot ci-dot-${confidenceTone(view.overallConfidence)}`} />
              {Math.round(view.overallConfidence * 100)}% confidence
            </span>
          )}
          {dev && view.plan && (
            <button className="ci-btn ci-ghost ci-howbtn" onClick={() => setShowLog(true)} title="Steps, timings and who decided each column">
              How it ran{view.stats.matchMs !== undefined ? ` · ${fmtMs(view.stats.matchMs)}` : ""}
            </button>
          )}
          {CANCELLABLE.includes(s) && (
            <button className="ci-btn ci-ghost" disabled={action.busy} onClick={() => action.run(() => api.cancel(view.id))}>
              Cancel
            </button>
          )}
        </div>
      </header>
      {s !== "failed" && s !== "cancelled" && <Steps status={s} />}
      </div>
      {error && <p className="ci-error ci-body">{error}</p>}
      {action.error && <p className="ci-error ci-body">{action.error}</p>}

      <div className="ci-body">
        {(s === "queued" || s === "parsing" || s === "matching" || s === "preparing") && <Working view={view} events={events} />}
        {s === "mapping_review" && <MappingReview view={view} api={api} refresh={refresh} />}
        {s === "commit_review" && <CommitReview view={view} api={api} refresh={refresh} />}
        {(s === "committing" || s === "completed" || s === "partially_completed") && <Result view={view} api={api} refresh={refresh} />}
        {s === "failed" && (duplicateOf(view)
          ? <DuplicateOpen view={view} openId={duplicateOf(view)!} api={api} onOpenImport={onOpenImport} />
          : <Failed view={view} api={api} refresh={refresh} onOpenImport={onOpenImport} />)}
        {s === "cancelled" && <p className="ci-muted">This import was cancelled. Nothing was changed in Distru.</p>}
      </div>
      {dev && showLog && <RunLog view={view} events={events} onClose={() => setShowLog(false)} />}
    </div>
  );
}

/** A failed import: what went wrong, what already reached Distru, and a way to run the file again. */
function Failed({ view, api, refresh, onOpenImport }: { view: ImportView; api: ImportApi; refresh: () => Promise<unknown>; onOpenImport?: (id: string) => void }) {
  const { busy, error, run } = useAction(refresh);
  const wrote = (view.counts.committed ?? 0) + (view.counts.uploaded ?? 0) > 0;
  return (
    <>
      <p className="ci-error">{view.error?.message ?? "The import failed."}</p>
      {wrote && <Result view={view} api={api} refresh={refresh} />}
      {error && <p className="ci-error ci-small">{error}</p>}
      {onOpenImport && (
        <div>
          <button type="button" className="ci-btn" disabled={busy} onClick={() => run(async () => onOpenImport((await api.retry(view.id)).importId))}>
            Try this file again
          </button>
        </div>
      )}
    </>
  );
}

/** The open import holding the same file. Older failures only carry the id in the message text. */
function duplicateOf(view: ImportView): string | null {
  if (view.error?.code !== "duplicate_open_import") return null;
  return view.error.openImportId ?? /import ([0-9a-f-]{36})/i.exec(view.error.message)?.[1] ?? null;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Same file dropped while another import of it is still open: continue that one, or cancel it and start here. */
function DuplicateOpen({ view, openId, api, onOpenImport }: { view: ImportView; openId: string; api: ImportApi; onOpenImport?: (id: string) => void }) {
  const [other, setOther] = useState<ImportView | "gone" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.get(openId).then((v) => live && setOther(v)).catch(() => live && setOther("gone"));
    return () => { live = false; };
  }, [api, openId]);

  const restart = async (cancelFirst: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      if (cancelFirst) await api.cancel(openId);
      const r = await api.retry(view.id);
      onOpenImport?.(r.importId);
    } catch (e) {
      setErr((e as Error).message);
      api.get(openId).then(setOther).catch(() => setOther("gone"));
    } finally {
      setBusy(false);
    }
  };

  if (other === null) return <p className="ci-muted">Looking up the open import…</p>;
  const still = other !== "gone" && !TERMINAL.includes(other.status);
  const cancellable = other !== "gone" && CANCELLABLE.includes(other.status);

  return (
    <div className="ci-dup">
      <div className="ci-dup-head">
        <span className="ci-dup-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20"><path d="M7 3h6l4 4v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M13 3v4h4 M8.5 11.5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div>
          <p className="ci-dup-title">{still ? "This file is already being imported" : "This file was being imported elsewhere"}</p>
          <p className="ci-muted ci-small">
            {still
              ? "Only one import per file can be open, so nothing is duplicated in Distru. Pick up where you left off, or start over here."
              : "That import has finished since, so you can start this file again."}
          </p>
        </div>
      </div>

      {other !== "gone" && (
        <button type="button" className="ci-dup-other" disabled={!onOpenImport} onClick={() => onOpenImport?.(other.id)} title="Open that import">
          <span className="ci-file">{other.filename}</span>
          <span className={`ci-pill ci-pill-${other.status}`}>{STATUS_LABEL[other.status]}</span>
          <span className="ci-muted ci-small">
            {other.stats.totalRows ? `${fmtNum(other.stats.totalRows)} rows · ` : ""}started {ago(other.createdAt)}
            {other.blockingQuestions > 0 ? ` · ${other.blockingQuestions} required ${other.blockingQuestions === 1 ? "answer" : "answers"} left` : ""}
          </span>
        </button>
      )}

      <div className="ci-dup-actions">
        {still && onOpenImport && (
          <button type="button" className="ci-btn ci-primary" disabled={busy} onClick={() => onOpenImport(openId)}>
            Continue that import
          </button>
        )}
        {still && cancellable && (
          <button type="button" className="ci-btn" disabled={busy} onClick={() => restart(true)}>
            Cancel it and start here
          </button>
        )}
        {!still && (
          <button type="button" className="ci-btn ci-primary" disabled={busy} onClick={() => restart(false)}>
            Start this file again
          </button>
        )}
      </div>
      {still && !cancellable && (
        <p className="ci-muted ci-small">That import is {STATUS_LABEL[other.status].toLowerCase()} right now, so it can't be cancelled. Continue there instead.</p>
      )}
      {err && <p className="ci-error ci-small">{err}</p>}
    </div>
  );
}

function Steps({ status }: { status: ImportStatus }) {
  const at = STEPS.findIndex((x) => x.statuses.includes(status));
  const done = status === "completed" || status === "partially_completed";
  return (
    <ol className="ci-steps">
      {STEPS.map((x, i) => (
        <li key={x.label} className={i < at || done ? "ci-step-done" : i === at ? "ci-step-now" : ""}>
          <span className="ci-step-n">{i < at || done ? "✓" : i + 1}</span>{x.label}
        </li>
      ))}
    </ol>
  );
}

function Working({ view, events }: { view: ImportView; events: ImportEvent[] }) {
  const dev = useDevMode();
  const fields = targetFields(view);
  const resolved = events.filter((e) => e.type === "column_resolved");
  return (
    <div className="ci-working">
      <p className="ci-muted"><span className="ci-spinner" />{STATUS_LABEL[view.status]}…</p>
      {resolved.length > 0 && view.status === "matching" && (
        <div className="ci-stream">
          {resolved.map((e) => {
            const p = e.payload as { source?: string; target?: string; method?: string; score?: number };
            return (
              <div key={e.id} className="ci-line">
                <span className={`ci-dot ci-dot-${dev ? confidenceTone(p.score ?? 0) : p.target ? "high" : "low"}`} />
                <span className="ci-raw">{p.source}</span>
                <span className="ci-arrow">→</span>
                <span className="ci-target">{p.target ? fieldLabel(fields, p.target) : dev ? "unmapped" : "not imported"}</span>
                {dev && p.method && <span className={`ci-badge ci-method-${p.method}`}>{p.method}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Bar({ label, done, failed, total }: { label: string; done: number; failed: number; total: number }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const bad = total ? Math.min(100 - pct, (failed / total) * 100) : 0;
  return (
    <div className="ci-bar">
      <div className="ci-bar-head">
        <span>{label}</span>
        <span className="ci-muted">
          {fmtNum(done)} / {fmtNum(total)}{failed > 0 && <span className="ci-bad"> · {fmtNum(failed)} failed</span>}
        </span>
      </div>
      <div className="ci-bar-track">
        <div className="ci-bar-fill" style={{ width: `${pct}%` }} />
        <div className="ci-bar-fail" style={{ width: `${bad}%` }} />
      </div>
    </div>
  );
}

const RESULT_KEYS: [string, string][] = [
  ["committed", "Done"],
  ["uploaded", "Waiting for details"],
  ["needs_attention", "Needs attention"],
  ["failed", "Failed"],
  ["skipped", "Skipped"],
  ["invalid", "Invalid"],
];

function Result({ view, api, refresh }: { view: ImportView; api: ImportApi; refresh: () => Promise<unknown> }) {
  const dev = useDevMode();
  const { busy, notice, error, run } = useAction(refresh);
  const c = view.counts;
  const p = view.progress;
  const problems = (c.invalid ?? 0) + (c.failed ?? 0) + (c.needs_attention ?? 0);
  const finished = view.status !== "committing";
  return (
    <div className="ci-result">
      <Bar label="Created" {...p.created} />
      {p.details.total > 0 && <Bar label="Details added" {...p.details} />}
      <div className="ci-counts">
        {RESULT_KEYS.filter(([k]) => (c[k] ?? 0) > 0).map(([k, label]) => (
          <span key={k} className={`ci-count-chip ci-cc-${k}`}>{fmtNum(c[k])} {label.toLowerCase()}</span>
        ))}
      </div>
      {Object.keys(view.willCreate).length > 0 && (
        <p className="ci-muted ci-small">
          New in Distru: {Object.entries(view.willCreate).map(([f, vals]) => `${humanize(f)} (${vals.join(", ")})`).join("; ")}
        </p>
      )}
      {/* Developer mode shows the raw upload payload beside the card instead. */}
      {!dev && finished && <ImportedTable view={view} api={api} />}
      {(problems > 0 || (finished && (c.needs_attention ?? 0) > 0)) && (
        <Footer notice={notice} error={error}>
          {problems > 0 && <a className="ci-btn" href={api.errorsCsvUrl(view.id)} download>Download error CSV</a>}
          {finished && (c.needs_attention ?? 0) > 0 && (
            <button className="ci-btn ci-primary" disabled={busy} onClick={() => run(() => api.retryFollowups(view.id))}>
              Retry details
            </button>
          )}
        </Footer>
      )}
    </div>
  );
}
