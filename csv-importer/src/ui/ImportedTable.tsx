import { useEffect, useMemo, useState } from "react";
import type { Json } from "../core/index.ts";
import type { ImportApi, ImportView, RowRecord } from "./api.ts";
import { fmtNum, targetFields } from "./util.ts";

const PAGE = 100;
const QUERY = { status: ["committed", "uploaded", "needs_attention"] as RowRecord["status"][] };
/** Shown first, in this order, when the file has them. */
const LEAD = ["name", "sku"];

function cell(v: Json | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => cell(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The products this import put in Distru, with the values Distru now holds. Only columns that have a value are shown. */
export function ImportedTable({ view, api }: { view: ImportView; api: ImportApi }) {
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const total = (view.counts.committed ?? 0) + (view.counts.uploaded ?? 0) + (view.counts.needs_attention ?? 0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.rows(view.id, { ...QUERY, limit: PAGE })
      .then((r) => { if (live) { setRows(r.rows); setCursor(r.nextCursor); setError(null); } })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [api, view.id, total, attempt]);

  const more = async () => {
    if (cursor === null) return;
    setLoading(true);
    try {
      const r = await api.rows(view.id, { ...QUERY, cursor, limit: PAGE });
      setRows((prev) => [...prev, ...r.rows]);
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const columns = useMemo(() => {
    const fields = targetFields(view).filter((f) => f.name !== "distru_id");
    const filled = new Set<string>();
    for (const r of rows) for (const [k, v] of Object.entries(r.output ?? {})) if (cell(v)) filled.add(k);
    const order = [...LEAD, ...fields.map((f) => f.name).filter((n) => !LEAD.includes(n))];
    return order.filter((n) => filled.has(n)).map((n) => ({ name: n, label: fields.find((f) => f.name === n)?.label ?? n }));
  }, [rows, view]);

  if (total === 0) return null;
  const attention = rows.some((r) => r.status !== "committed");

  return (
    <section className="ci-imported" aria-label="Imported products">
      <div className="ci-imported-head">
        <h4 className="ci-list-title ci-imported-title">Now in Distru <span className="ci-count">{fmtNum(total)}</span></h4>
        {rows.length < total && rows.length > 0 && <span className="ci-muted ci-small">Showing {fmtNum(rows.length)} of {fmtNum(total)}</span>}
      </div>
      {error && (
        <p className="ci-error">
          {error} <button type="button" className="ci-btn" onClick={() => (rows.length ? more() : setAttempt((a) => a + 1))}>Retry</button>
        </p>
      )}
      {!rows.length && !error && <p className="ci-muted ci-empty">{loading ? "Loading products…" : "No products to show."}</p>}
      {rows.length > 0 && (
        <div className="ci-imported-scroll" tabIndex={0} role="region" aria-label="Imported products table">
          <table className="ci-imported-table">
            <thead>
              <tr>
                {columns.map((c) => <th key={c.name} scope="col">{c.label}</th>)}
                {attention && <th scope="col">Status</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowIndex}>
                  {columns.map((c, i) => {
                    const text = cell(r.output?.[c.name]);
                    return i === 0 ? <th key={c.name} scope="row" title={text}>{text}</th> : <td key={c.name} title={text}>{text}</td>;
                  })}
                  {attention && (
                    <td>
                      {r.status === "committed" ? <span className="ci-cc-committed ci-count-chip">Done</span>
                        : r.status === "uploaded" ? <span className="ci-count-chip">Adding details</span>
                        : <span className="ci-count-chip ci-cc-needs_attention">Needs attention</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor !== null && !error && rows.length > 0 && (
        <button type="button" className="ci-btn ci-more" disabled={loading} onClick={more}>{loading ? "Loading…" : "Show more"}</button>
      )}
    </section>
  );
}
