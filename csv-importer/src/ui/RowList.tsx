import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Json } from "../core/index.ts";
import type { ImportApi, RowQuery, RowRecord } from "./api.ts";
import { fieldLabel, fmtValue, type TargetField } from "./util.ts";

export interface RowListProps {
  api: ImportApi;
  importId: string;
  query: RowQuery;
  /** Changes when rows may have changed (plan version), triggering a reload. */
  version: number;
  fields: TargetField[];
  clearBlanks: boolean;
  busy: boolean;
  onEdit?: (rowIndex: number, field: string, value: Json) => void;
}

const PAGE = 100;

export function RowList({ api, importId, query, version, fields, clearBlanks, busy, onEdit }: RowListProps) {
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(query);

  // A different tab or filter must not show the previous list while it loads.
  useEffect(() => { setRows([]); setCursor(null); }, [importId, key]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.rows(importId, { ...query, limit: PAGE })
      .then((r) => { if (live) { setRows(r.rows); setCursor(r.nextCursor); setError(null); } })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, importId, key, version, attempt]);

  const more = async () => {
    if (cursor === null) return;
    setLoading(true);
    try {
      const r = await api.rows(importId, { ...query, cursor, limit: PAGE });
      setRows((prev) => [...prev, ...r.rows]);
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  const errorLine = error && (
    <p className="ci-error">
      {error} <button type="button" className="ci-btn" onClick={() => (rows.length ? more() : setAttempt((a) => a + 1))}>Retry</button>
    </p>
  );
  if (!rows.length && error) return errorLine;
  if (!rows.length) return <p className="ci-muted ci-empty">{loading ? "Loading rows…" : "No rows here."}</p>;

  return (
    <div className="ci-rows">
      <div ref={scrollRef} className="ci-rows-scroll">
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => (
            <div
              key={rows[v.index].rowIndex}
              data-index={v.index}
              ref={virt.measureElement}
              className="ci-row"
              style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}
            >
              <Row row={rows[v.index]} fields={fields} clearBlanks={clearBlanks} busy={busy} onEdit={onEdit} />
            </div>
          ))}
        </div>
      </div>
      {errorLine}
      {cursor !== null && !error && (
        <button className="ci-btn ci-more" disabled={loading} onClick={more}>{loading ? "Loading…" : "Load more"}</button>
      )}
    </div>
  );
}

function rowName(row: RowRecord): string {
  const n = row.output?.name;
  if (typeof n === "string" && n) return n;
  return row.raw.Name ?? row.raw.name ?? Object.values(row.raw).find((v) => v?.trim()) ?? "Untitled";
}

function Row({ row, fields, clearBlanks, busy, onEdit }: {
  row: RowRecord; fields: TargetField[]; clearBlanks: boolean; busy: boolean; onEdit?: RowListProps["onEdit"];
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const label = (f: string) => fieldLabel(fields, f);
  const options = (f: string) => fields.find((x) => x.name === f)?.options;
  const diff = row.meta.diff ?? [];
  const cleared = clearBlanks ? row.meta.blankWithValue ?? [] : [];

  const startEdit = (field: string) => {
    if (!onEdit || busy) return;
    const cur = row.overrides?.[field] ?? row.output?.[field];
    setDraft(cur === null || cur === undefined ? "" : typeof cur === "object" ? JSON.stringify(cur) : String(cur));
    setEditing(field);
  };
  const save = () => {
    if (!editing || !onEdit) return;
    onEdit(row.rowIndex, editing, draft.trim() === "" ? null : draft.trim());
    setEditing(null);
  };

  const named = typeof row.output?.name === "string" && !!row.output.name || !!(row.raw.Name ?? row.raw.name);

  return (
    <div className="ci-row-grid">
      <span className="ci-row-idx">Row {row.rowIndex}</span>
      <div className="ci-row-body">
      <div className="ci-row-head">
        {named ? <span className="ci-row-name">{rowName(row)}</span> : <span className="ci-row-name ci-row-noname">No name</span>}
        {row.sku && <span className="ci-row-sku">{row.sku}</span>}
        {row.meta.history && <span className="ci-tag">Imported {new Date(row.meta.history.date).toLocaleDateString()}</span>}
        {row.meta.possibleDuplicate && <span className="ci-tag ci-tag-warn">Possible duplicate</span>}
      </div>
      {row.issues.map((i, k) => {
        const editable = i.severity === "error" && !!i.field && !!onEdit;
        if (editable && editing === i.field) {
          return (
            <form key={k} className="ci-edit" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <label className="ci-edit-label" htmlFor={`ci-edit-${row.rowIndex}-${k}`}>{label(i.field!)}</label>
              {options(i.field!) ? (
                <select id={`ci-edit-${row.rowIndex}-${k}`} className="ci-input ci-edit-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)}>
                  <option value="">Choose…</option>
                  {options(i.field!)!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  id={`ci-edit-${row.rowIndex}-${k}`}
                  className="ci-input ci-edit-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                />
              )}
              <button className="ci-btn ci-save" disabled={busy}>Save</button>
              <button type="button" className="ci-btn ci-ghost ci-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          );
        }
        return (
          <div key={k} className={`ci-issue ci-issue-${i.severity}`}>
            <span className="ci-issue-text">{i.field && !i.message.startsWith(label(i.field)) && <strong>{label(i.field)} </strong>}{i.message}</span>
            {editable && <button type="button" className="ci-btn ci-fix" disabled={busy} onClick={() => startEdit(i.field!)}>Fix</button>}
          </div>
        );
      })}
      {diff.map((d) => (
        <div key={d.field} className={`ci-diff${d.blocked ? " ci-blocked" : ""}`}>
          <strong>{label(d.field)}:</strong> <span className="ci-from">{fmtValue(d.from)}</span> → <span className="ci-to">{fmtValue(d.to)}</span>
          {d.blocked && <span className="ci-tag">can't change</span>}
        </div>
      ))}
      {cleared.map((f) => (
        <div key={f} className="ci-diff">
          <strong>{label(f)}:</strong> <span className="ci-from">current value</span> → <span className="ci-to">cleared</span>
        </div>
      ))}
      </div>
    </div>
  );
}
