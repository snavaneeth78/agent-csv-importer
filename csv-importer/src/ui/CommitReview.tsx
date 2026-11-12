import { useState } from "react";
import type { ImportApi, ImportView, RowQuery } from "./api.ts";
import { Footer } from "./MappingReview.tsx";
import { RowList } from "./RowList.tsx";
import { fieldLabel, fmtNum, humanize, targetFields, useAction } from "./util.ts";
import { useDevMode } from "./mode.ts";

export interface CommitReviewProps {
  view: ImportView;
  api: ImportApi;
  refresh: () => Promise<unknown>;
}

type Tab = "invalid" | "changes" | "dups" | "new";

const TABS: { id: Tab; label: string; query: RowQuery; count: (c: Record<string, number>) => number }[] = [
  { id: "invalid", label: "To fix", query: { status: ["invalid"] }, count: (c) => c.invalid ?? 0 },
  { id: "changes", label: "Changes", query: { dupClass: ["exists_changed"] }, count: (c) => c.exists_changed ?? 0 },
  { id: "dups", label: "Duplicates", query: { dupClass: ["dup_in_file"] }, count: (c) => c.dup_in_file ?? 0 },
  // Rows that will actually be created; a new product with a problem is under "To fix" until it's fixed.
  { id: "new", label: "New", query: { action: ["create"] }, count: (c) => c.create ?? 0 },
];

export function CommitReview({ view, api, refresh }: CommitReviewProps) {
  const dev = useDevMode();
  const { busy, notice, error, run } = useAction(refresh);
  const c = view.counts;
  const plan = view.plan;
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.count(c) > 0)?.id ?? "new");
  const fields = targetFields(view);
  const existingAction = plan?.existingAction ?? "skip";
  const clearBlanks = plan?.clearBlanks ?? false;
  const toImport = (c.create ?? 0) + (c.update ?? 0);
  const est = view.followupEstimate;
  // Only lists that have rows get a tab; one list needs no tabs at all.
  const lists = TABS.filter((t) => t.count(c) > 0);
  const current = lists.find((t) => t.id === tab) ?? lists[0];
  const creates = c.create ?? 0, updates = c.update ?? 0;
  const existing = (c.exists_unchanged ?? 0) + (c.exists_changed ?? 0);
  const n = (k: number, one: string, many: string) => `${fmtNum(k)} ${k === 1 ? one : many}`;

  const headline = creates && updates ? `${n(creates, "product", "products")} will be created and ${fmtNum(updates)} updated`
    : creates ? `${n(creates, "product", "products")} will be created`
    : updates ? `${n(updates, "product", "products")} will be updated`
    : "Nothing to import yet";
  // What is left out, in plain words. Zero counts say nothing.
  const leftOut = [
    existing - updates > 0 && `${fmtNum(existing - updates)} already in Distru ${existing - updates === 1 ? "is" : "are"} skipped`,
    (c.dup_in_file ?? 0) > 0 && `${n(c.dup_in_file, "repeat", "repeats")} in your file ${c.dup_in_file === 1 ? "is" : "are"} skipped`,
    (c.invalid ?? 0) > 0 && `${n(c.invalid, "row has", "rows have")} problems and ${c.invalid === 1 ? "is" : "are"} left out`,
  ].filter(Boolean) as string[];

  // One line per kind of issue, not one per row.
  const notes = view.issueSummary.map((i) => {
    const label = i.field ? fieldLabel(fields, i.field) : null;
    const text = i.code === "unknown_value" && label ? `${label} isn't in Distru yet, so it's left blank` : i.example;
    // A problem on every row is a mapping problem: one fix there beats fixing each row here.
    const everyRow = i.severity === "error" && i.n > 1 && i.n >= (c.rows ?? 0);
    return { key: `${i.code}:${i.field ?? ""}`, code: i.code, tone: i.severity === "error" ? "bad" : "warn", label, text, rows: i.n, everyRow };
  });
  const newValues = Object.entries(view.willCreate);
  const backToMapping = () => run(() => api.revise(view.id, { planVersion: view.planVersion, patch: {} }));

  const tiles: [string, number, string?][] = [
    ["New", c.create ?? 0],
    ["Update", c.update ?? 0],
    ["Skip", c.skip ?? 0],
    ["Duplicates in file", c.dup_in_file ?? 0],
    ["Already in Distru", (c.exists_unchanged ?? 0) + (c.exists_changed ?? 0)],
    ["Invalid", c.invalid ?? 0, "bad"],
  ];

  return (
    <div className="ci-review">
      <div className="ci-lead">
        <h3 className="ci-lead-title">{headline}</h3>
        <p className="ci-lead-sub">{leftOut.length ? leftOut.join(" · ") : toImport > 0 ? "Every row in your file is ready." : "Fix the rows below, or go back and change the mapping."}</p>
      </div>

      {dev && (
        <div className="ci-tiles">
          {tiles.map(([label, k, tone]) => (
            <div key={label} className={`ci-tile${tone && k > 0 ? ` ci-tile-${tone}` : ""}`}>
              <div className="ci-tile-n">{fmtNum(k)}</div>
              <div className="ci-tile-label">{label}</div>
            </div>
          ))}
        </div>
      )}

      {(notes.length > 0 || newValues.length > 0) && (
        <ul className="ci-notes" aria-label="Worth knowing before you import">
          {newValues.map(([f, vals]) => (
            <li key={`new:${f}`} className="ci-note ci-note-new">
              <span className="ci-note-dot" aria-hidden="true" />
              <span>Adds {vals.length === 1 ? "a new" : `${vals.length} new`} {humanize(f)} to Distru: {vals.join(", ")}</span>
            </li>
          ))}
          {notes.map((x) => (
            <li key={x.key} className={`ci-note ci-note-${x.tone}`}>
              <span className="ci-note-dot" aria-hidden="true" />
              <span className="ci-note-text">
                {x.label && x.code !== "unknown_value" && !x.text.startsWith(x.label) && <strong>{x.label} </strong>}{x.text}
                {x.everyRow && (
                  <span className="ci-note-hint"> This is on every row, so fix it once in the mapping. <button type="button" className="ci-link" disabled={busy} onClick={backToMapping}>Back to mapping</button></span>
                )}
              </span>
              <span className="ci-note-n">{n(x.rows, "row", "rows")}</span>
            </li>
          ))}
        </ul>
      )}

      {existing > 0 && (
        <div className="ci-options">
          {(c.exists_changed ?? 0) > 0 && (
            <div className="ci-opt">
              <span>{n(c.exists_changed, "product", "products")} already in Distru {c.exists_changed === 1 ? "has" : "have"} changes</span>
              <div className="ci-seg" role="radiogroup" aria-label="Existing products with changes">
                {(["skip", "update"] as const).map((a) => (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={existingAction === a}
                    className={`ci-seg-btn${existingAction === a ? " ci-on" : ""}`}
                    disabled={busy}
                    onClick={() => a !== existingAction && run(() => api.rowActions(view.id, { planVersion: view.planVersion, existingAction: a }))}
                  >
                    {a === "skip" ? "Skip" : "Update"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="ci-opt ci-check">
            <input
              type="checkbox"
              checked={clearBlanks}
              disabled={busy}
              onChange={(e) => run(() => api.rowActions(view.id, { planVersion: view.planVersion, clearBlanks: e.target.checked }))}
            />
            Blank cells clear existing values
          </label>
        </div>
      )}

      {current && (
        <div className="ci-list">
          {lists.length > 1 ? (
            <div className="ci-tabs" role="tablist">
              {lists.map((t) => (
                <button key={t.id} role="tab" aria-selected={current.id === t.id} className={`ci-tab${current.id === t.id ? " ci-on" : ""}`} onClick={() => setTab(t.id)}>
                  {t.label} <span className="ci-count">{fmtNum(t.count(c))}</span>
                </button>
              ))}
            </div>
          ) : (
            <h4 className="ci-list-title">{LIST_TITLE[current.id]} <span className="ci-count">{fmtNum(current.count(c))}</span></h4>
          )}
          <RowList
            api={api}
            importId={view.id}
            query={current.query}
            version={view.planVersion}
            fields={fields}
            clearBlanks={clearBlanks}
            busy={busy}
            onEdit={current.id === "invalid" ? (rowIndex, field, value) =>
              run(() => api.editRows(view.id, { planVersion: view.planVersion, edits: [{ rowIndex, field, value }] })) : undefined}
          />
        </div>
      )}

      <Footer notice={notice} error={error}>
        <span className="ci-muted ci-footer-note">
          {est && toImport > 0
            ? dev
              ? est.creates > 0
                ? `${fmtNum(est.creates)} created inactive, then finished over ~${est.minutes} min`
                : `${fmtNum(est.rows)} updates applied over ~${est.minutes} min`
              : est.creates > 0
                ? `Products go live once their details are added, about ${est.minutes} min`
                : `Takes about ${est.minutes} min`
            : toImport > 0 ? "Nothing is written to Distru until you import" : "Fix a row above and it joins the import"}
        </span>
        <button type="button" className="ci-btn" disabled={busy} onClick={backToMapping}>Back to mapping</button>
        <button
          className="ci-btn ci-primary"
          disabled={busy || toImport === 0}
          onClick={() => run(() => api.confirmCommit(view.id, view.planVersion))}
        >
          {toImport === 0 ? "Nothing to import" : `${creates > 0 && updates === 0 ? "Create" : updates > 0 && creates === 0 ? "Update" : "Import"} ${fmtNum(toImport)} ${toImport === 1 ? "product" : "products"}`}
        </button>
      </Footer>
    </div>
  );
}

const LIST_TITLE: Record<Tab, string> = { invalid: "Rows with problems", changes: "Changes to existing products", dups: "Repeats in your file", new: "New products" };
