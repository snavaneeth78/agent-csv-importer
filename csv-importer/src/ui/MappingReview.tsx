import { useState, type ReactNode } from "react";
import type { FieldMapping, Json, MappingPlan, PlanPatch, Question } from "../core/index.ts";
import type { ImportApi, ImportView } from "./api.ts";
import { confidenceTone, fieldLabel, fmtNum, targetFields, useAction, type TargetField } from "./util.ts";
import { FieldPicker, IGNORE } from "./FieldPicker.tsx";
import { useDevMode } from "./mode.ts";

export interface MappingReviewProps {
  view: ImportView;
  api: ImportApi;
  refresh: () => Promise<unknown>;
}

type ValueMapT = Record<string, string | { create: string } | null>;
type DefaultT = MappingPlan["defaultsApplied"][number];

/** One line of the mapping table: a file column, a Distru field filled without a column, or a file-level question. */
interface Row {
  key: string;
  order: number;
  sources: string[];
  mapping?: FieldMapping;
  ignored?: { reason: string };
  fill?: DefaultT;
  derived: FieldMapping[];
  valueMaps: [string, ValueMapT][];
  questions: Question[];
  /** A model is still reading this column. */
  matching?: boolean;
  /** Mapped, but its values are still being matched to Distru names. */
  checkingValues?: boolean;
}

type GroupId = "needs" | "matching" | "mapped" | "ignored" | "filled";

const GROUPS: { id: GroupId; title: string; hint: string }[] = [
  { id: "needs", title: "Needs you", hint: "Answer here, or pick a field on the row" },
  { id: "matching", title: "Still matching", hint: "Being read now; they fill in on their own, or pick a field yourself" },
  { id: "mapped", title: "Mapped", hint: "Change any field from its dropdown" },
  { id: "ignored", title: "Not imported", hint: "These columns are skipped" },
  { id: "filled", title: "Filled by Distru", hint: "No column in your file, so Distru sets these" },
];

export function MappingReview({ view, api, refresh }: MappingReviewProps) {
  const dev = useDevMode();
  const { busy, notice, error, run } = useAction(refresh);
  const [closed, setClosed] = useState<Partial<Record<GroupId, boolean>>>({ filled: true });
  const plan = view.plan;
  if (!plan) return <p className="ci-muted">Waiting for the mapping plan.</p>;
  const fields = targetFields(view);
  const revise = (patch: PlanPatch) => run(() => api.revise(view.id, { planVersion: view.planVersion, patch }));
  const remap = (sources: string[], target: string) =>
    revise(target === IGNORE ? { ignore: sources } : { fields: [{ target, sources }] });

  const own = plan.fields.filter((m) => !m.rationale.startsWith("derived:"));
  const usedBy = Object.fromEntries(own.map((m) => [m.target, m.sources.join(" + ")]));
  const rows = buildRows(plan, view.openQuestions);
  const groupOf = (r: Row): GroupId => (r.questions.length ? "needs" : r.matching ? "matching" : r.fill ? "filled" : r.mapping ? "mapped" : "ignored");
  const byGroup = Object.fromEntries(GROUPS.map((g) => [g.id, [] as Row[]])) as Record<GroupId, Row[]>;
  for (const r of rows) byGroup[groupOf(r)].push(r);
  // Required first inside Needs you, then file order.
  byGroup.needs.sort((a, b) => Number(isRequired(b)) - Number(isRequired(a)) || a.order - b.order);

  const stages = Object.entries(view.stats.resolvedByStage ?? {}).filter(([k, n]) => n > 0 && k !== "unresolved");
  const bulk = view.openQuestions.filter((q) => q.suggested && !(q.guess && q.guess.score < 0.4));
  const required = byGroup.needs.filter(isRequired).length;
  const matchingLeft = view.matching?.columns.length ?? 0;

  return (
    <div className="ci-review">
      <div className="ci-summary">
        <div className="ci-tally-counts">
          {GROUPS.map((g) => byGroup[g.id].length > 0 && (
            <span key={g.id} className={`ci-tally ci-tally-${g.id}`}>
              <span className="ci-tally-dot" />
              <b>{byGroup[g.id].length}</b> {g.title.toLowerCase()}
            </span>
          ))}
        </div>
        {dev && stages.length > 0 && (
          <div className="ci-stages">
            <span>Matched by</span>
            {stages.map(([k, n]) => <span key={k} className={`ci-badge ci-method-${k}`}>{k === "none" ? "not a field" : k} {fmtNum(n)}</span>)}
          </div>
        )}
      </div>

      <div className="ci-table" role="table" aria-label="Column mapping">
        <div className="ci-thead" role="row">
          <span role="columnheader">Your column</span>
          <span aria-hidden="true" />
          <span role="columnheader">Distru field</span>
          <span role="columnheader" className="ci-th-match">{dev ? "Match" : ""}</span>
        </div>

        {GROUPS.map((g) => {
          const list = byGroup[g.id];
          if (!list.length) return null;
          const isClosed = !!closed[g.id];
          return (
            <div key={g.id} className={`ci-group ci-group-${g.id}`} role="rowgroup">
              <div className="ci-group-head" role="row">
                <button
                  type="button"
                  className="ci-group-toggle"
                  aria-expanded={!isClosed}
                  onClick={() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))}
                >
                  <svg className="ci-group-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span className="ci-group-title">{g.title}</span>
                  <span className="ci-count">{list.length}</span>
                  {g.id === "needs" && required > 0 && <span className="ci-group-req">{required} required</span>}
                  <span className="ci-group-hint">{g.hint}</span>
                </button>
                {g.id === "needs" && bulk.length > 0 && (
                  <button
                    type="button"
                    className="ci-btn ci-accept"
                    disabled={busy}
                    title={dev ? "Answers every question with its highlighted choice. Low-confidence guesses (under 40%) are left for you." : "Uses the suggested answer for every question. Anything we're unsure about is left for you."}
                    onClick={() => revise({ answers: Object.fromEntries(bulk.map((q) => [q.id, q.suggested!])) })}
                  >
                    Accept {bulk.length} {bulk.length === 1 ? "suggestion" : "suggestions"}
                  </button>
                )}
              </div>
              {!isClosed && list.map((r) => g.id === "needs" ? (
                <NeedsRow
                  key={r.key}
                  row={r}
                  fields={fields}
                  usedBy={usedBy}
                  headers={plan.headers}
                  all={plan.questions}
                  busy={busy}
                  onRemap={(t) => remap(r.sources, t)}
                  onAnswers={(answers) => revise({ answers })}
                  onRecheck={(field) => revise({ recheck: [field] })}
                />
              ) : (
                <TableRow
                  key={r.key}
                  row={r}
                  group={g.id}
                  fields={fields}
                  usedBy={usedBy}
                  busy={busy}
                  onRemap={(t) => remap(r.sources, t)}
                />
              ))}
            </div>
          );
        })}
      </div>

      <Footer notice={notice} error={error}>
        {matchingLeft > 0 && <span className="ci-muted"><span className="ci-spinner" /> Matching {matchingLeft} more {matchingLeft === 1 ? "column" : "columns"}</span>}
        {matchingLeft === 0 && view.matching && <span className="ci-muted"><span className="ci-spinner" /> Checking names against Distru</span>}
        {view.blockingQuestions > 0 && (
          <span className="ci-muted">{view.blockingQuestions} required {view.blockingQuestions === 1 ? "answer" : "answers"} left</span>
        )}
        <button
          className="ci-btn ci-primary"
          disabled={busy || view.blockingQuestions > 0 || !!view.matching}
          title={view.matching ? "Available once matching finishes, in a few seconds" : undefined}
          onClick={() => run(() => api.confirmMapping(view.id, view.planVersion))}
        >
          Confirm mapping
        </button>
      </Footer>
    </div>
  );
}

const isRequired = (r: Row) => r.questions.some((q) => q.blocking);

/** Every file column once, in file order, then Distru-filled fields; open questions attach to the row they're about. */
function buildRows(plan: MappingPlan, open: Question[]): Row[] {
  const waiting = new Set(plan.pending?.columns ?? []);
  const checking = new Set(plan.pending?.fields ?? []);
  const own = plan.fields.filter((m) => !m.rationale.startsWith("derived:"));
  const derived = plan.fields.filter((m) => m.rationale.startsWith("derived:"));
  const valueMaps = Object.entries(plan.valueMaps).filter(([k, m]) => !k.startsWith("__slang:") && Object.keys(m).length);
  const rows: Row[] = [];
  const seen = new Set<string>();

  plan.headers.forEach((h, order) => {
    if (seen.has(h)) return;
    const m = own.find((x) => x.sources.includes(h));
    const sources = m ? m.sources : [h];
    sources.forEach((s) => seen.add(s));
    const kids = m ? derived.filter((d) => d.rationale === `derived:${m.target}`) : [];
    const targets = new Set([m?.target, ...kids.map((d) => d.target)].filter(Boolean) as string[]);
    rows.push({
      key: `col:${h}`,
      order,
      sources,
      mapping: m,
      ignored: m ? undefined : { reason: plan.ignoredColumns.find((i) => i.source === h)?.reason ?? "Not used" },
      derived: kids,
      valueMaps: valueMaps.filter(([f]) => targets.has(f)),
      questions: [],
      ...(!m && waiting.has(h) ? { matching: true } : {}),
      ...([...targets].some((t) => checking.has(t)) ? { checkingValues: true } : {}),
    });
  });

  plan.defaultsApplied.forEach((d, i) => {
    if (own.some((m) => m.target === d.target)) return;
    rows.push({ key: `fill:${d.target}`, order: plan.headers.length + i, sources: [], fill: d, derived: [], valueMaps: [], questions: [] });
  });

  const fileRows: Row[] = [];
  for (const q of open) {
    const src = q.ref?.source;
    const field = q.ref?.field;
    const row = (src && rows.find((r) => r.sources.includes(src)))
      || (field && rows.find((r) => r.mapping?.target === field || r.derived.some((d) => d.target === field) || r.fill?.target === field));
    if (row) { row.questions.push(q); continue; }
    fileRows.push({ key: `q:${q.id}`, order: -1, sources: [], derived: [], valueMaps: [], questions: [q] });
  }
  return [...fileRows, ...rows];
}

/** Mapped, Not imported and Filled by Distru rows (no open questions). */
function TableRow({ row, group, fields, usedBy, busy, onRemap }: {
  row: Row; group: GroupId; fields: TargetField[]; usedBy: Record<string, string>; busy: boolean; onRemap: (target: string) => void;
}) {
  const dev = useDevMode();
  const { mapping: m, fill } = row;
  const tone = group === "mapped" ? (dev ? confidenceTone(m!.score) : "high") : group;
  const src = row.sources.join(" + ");
  const vmaps = row.valueMaps;

  return (
    <div className={`ci-trow ci-trow-${group}`} role="row">
      <div className="ci-trow-main">
        <div className="ci-map-src" role="cell">
          <span className={`ci-dot ci-dot-${tone}`} />
          {row.sources.length > 0
            ? <span className={`ci-raw${group === "ignored" ? " ci-raw-off" : ""}`} title={src}>{src}</span>
            : <span className="ci-nocol" title={fill ? fillReason(fill) : undefined}>No column{fill ? ` · ${fillReason(fill)}` : ""}</span>}
        </div>
        <span className="ci-arrow" aria-hidden="true">→</span>
        <div role="cell" className="ci-trow-target">
          {fill ? <span className="ci-fixed">{fieldLabel(fields, fill.target)}</span>
            : (
              <FieldPicker
                fields={fields}
                usedBy={usedBy}
                value={m?.target ?? IGNORE}
                disabled={busy}
                placeholder={group === "ignored" ? "Not imported" : group === "matching" ? "Matching…" : "Choose a field"}
                onChange={onRemap}
              />
            )}
        </div>
        <div className="ci-map-meta" role="cell" title={dev ? m?.rationale ?? row.ignored?.reason ?? fill?.reason : undefined}>
          {dev && m && <span className={`ci-badge ci-method-${m.method}`}>{m.method}</span>}
          {dev && m && <span className={`ci-score ci-score-${confidenceTone(m.score)}`}>{Math.round(m.score * 100)}%</span>}
          {fill && <FillValue d={fill} />}
          {!m && !fill && group === "ignored" && <span className="ci-meta-note">{ignoredLabel(row.ignored!.reason, dev)}</span>}
          {group === "matching" && <span className="ci-meta-note"><span className="ci-spinner" /> matching</span>}
          {row.checkingValues && <span className="ci-meta-note" title="Matching its values to names in your Distru account"><span className="ci-spinner" /> checking names</span>}
        </div>
      </div>

      {(row.derived.length > 0 || vmaps.some(([, map]) => hasNotable(map))) && (
        <div className="ci-trow-sub">
          {row.derived.map((d) => (
            <span key={d.target} className="ci-derived" title={dev ? d.rationale : undefined}>also sets {fieldLabel(fields, d.target)}</span>
          ))}
          {vmaps.map(([f, map]) => <ValueMap key={f} label={fieldLabel(fields, f)} map={map} />)}
        </div>
      )}
    </div>
  );
}

// ---- Needs you: the proposed answer sits in the row's dropdown; Accept takes it, changing the dropdown answers it.

/** Questions about which field a column is. Their answer is a Distru field, so the row's dropdown answers them. */
const isMapQ = (q: Question) => /^(column|confirm|check):/.test(q.id);

/** The field a mapping question proposes (IGNORE for "ignore it"). */
function proposedTarget(q: Question, m?: FieldMapping): string | undefined {
  const s = q.suggested;
  if (q.id.startsWith("confirm:")) return !s || s === "yes" ? m?.target : s === "ignore" ? IGNORE : s;
  if (q.id.startsWith("check:")) return !s || s === "keep" ? m?.target : s === "ignore" ? IGNORE : s;
  return !s ? undefined : s === "ignore" ? IGNORE : s;
}

/** The answer that picks `target` for a mapping question. */
function answerFor(q: Question, target: string, m?: FieldMapping): string {
  if (target === IGNORE) return "ignore";
  if (q.id.startsWith("confirm:") && target === m?.target) return "yes";
  if (q.id.startsWith("check:") && target === m?.target) return "keep";
  return target;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const who = (g: NonNullable<Question["guess"]>) => (g.method === "jev" ? "Jev" : "LLM");

/** One short line saying why a mapping question is open. */
function mapWhy(q: Question, fields: TargetField[], proposal: string | undefined, dev: boolean, src = ""): string {
  const g = q.guess;
  if (!dev && !q.id.startsWith("check:")) {
    // Customer wording: what we think and what to do, never which model thought it or how sure it was.
    const unsure = g && g.score < 0.4;
    if (proposal === IGNORE) return "This doesn't look like product information, so it'll be skipped unless you pick a field.";
    if (proposal) return unsure ? "We're not sure about this one. Check it, or pick another field." : `This looks like ${fieldLabel(fields, proposal)}. Accept, or pick another field.`;
    return "We couldn't tell what this column is. Pick a field, or leave it out.";
  }
  const low = g && g.score < 0.4 ? " (low confidence)" : "";
  if (q.id.startsWith("check:")) {
    const label = fieldLabel(fields, q.ref?.field ?? "");
    const vals = q.values?.length ? ` (${q.values.slice(0, 3).join(", ")})` : "";
    const alt = proposal && proposal !== IGNORE && proposal !== q.ref?.field ? fieldLabel(fields, proposal) : undefined;
    const lead = sameName(src, label) ? "None of its values" : `We guessed ${label}, but none of its values`;
    return `${lead}${vals} are ${nounOf(label, 2)} in Distru. ${alt ? `They look more like ${alt}. Accept, or pick another field.` : `Accept to keep ${label}, or pick another field.`}`;
  }
  if (q.id.startsWith("confirm:")) return g ? `${who(g)} is ${pct(g.score)} sure${low}. Accept, or pick another field.` : "Check this match.";
  if (g && proposal === IGNORE) return `${who(g)} thinks this isn't a product field (${pct(g.score)})${low}.`;
  if (g && proposal) return `Best guess from ${who(g)} (${pct(g.score)})${low}.`;
  return proposal === IGNORE ? "No confident match, so it's skipped unless you pick a field." : "No confident match. Pick a field.";
}

/** Follow-ups (units, sizes, values) read as a sentence that ends in a small picker. */
function followText(q: Question): string {
  const k = q.id.split(":")[0];
  if (k === "unit" || k === "potunit") return "Numbers have no unit, read as";
  if (k === "slang") return q.prompt.replace(/^Read (".*?") as .*$/, "$1 reads as");
  if (k === "value") return q.prompt.replace(/ is not an? (.*) in Distru\. Map it to:$/, " isn't a $1 in your Distru account, use");
  return q.prompt;
}

function NeedsRow({ row, fields, usedBy, headers, all, busy, onRemap, onAnswers, onRecheck }: {
  row: Row; fields: TargetField[]; usedBy: Record<string, string>; headers: string[]; all: Question[]; busy: boolean;
  onRemap: (target: string) => void; onAnswers: (answers: Record<string, string>) => void; onRecheck: (field: string) => Promise<unknown>;
}) {
  const dev = useDevMode();
  const m = row.mapping;
  const req = isRequired(row);
  const mapQ = row.questions.find(isMapQ);
  const nameQ = row.questions.find((q) => q.kind === "not_a_catalog");
  // Names missing from a Distru list: one decision for the column, with the per-value picks inside it.
  const proposal = mapQ ? proposedTarget(mapQ, m) : undefined;
  // Shown with the "is this really Vendor?" question too, but only while the row still proposes this field.
  const missQ = m && (!mapQ || proposal === m.target) ? all.find((q) => q.id === `missing:${m.target}`) : undefined;
  const inMiss = (q: Question) => !!missQ && (q.id === missQ.id || q.id.startsWith(`value:${m!.target}:`));
  // Names questions for a field the row is about to drop are hidden, not listed one by one.
  const dropped = (q: Question) => !!m && !missQ && (q.id === `missing:${m.target}` || q.id.startsWith(`value:${m.target}:`));
  const follow = row.questions.filter((q) => !isMapQ(q) && q.kind !== "not_a_catalog" && !inMiss(q) && !dropped(q));
  const src = row.sources.join(" + ");
  const exact = !!m && sameName(src, fieldLabel(fields, m.target));

  // Accept takes every proposal on the row at once.
  const accept: Record<string, string> = {};
  if (mapQ && proposal) accept[mapQ.id] = answerFor(mapQ, proposal, m);
  for (const q of follow) if (q.suggested) accept[q.id] = q.suggested;
  if (missQ) {
    const choice = missQ.answer ?? missQ.suggested;
    if (missQ.answer === undefined && missQ.suggested) accept[missQ.id] = missQ.suggested;
    if (choice === "match") for (const q of row.questions) if (q.id.startsWith(`value:${m!.target}:`) && q.suggested) accept[q.id] = q.suggested;
  }
  const canAccept = Object.keys(accept).length > 0;
  const columns: TargetField[] = headers.map((h) => ({ name: `col:${h}`, label: h, section: "Columns in your file" }));

  return (
    <div className={`ci-trow ci-trow-needs${req ? " ci-trow-req" : ""}`} role="row">
      <div className="ci-trow-main">
        <div className="ci-map-src" role="cell">
          <span className={`ci-dot ci-dot-${req ? "req" : "opt"}`} />
          {nameQ ? (
            <FieldPicker fields={columns} value={IGNORE} disabled={busy} allowIgnore={false} placeholder="Pick a column" onChange={(c) => onAnswers({ [nameQ.id]: c })} />
          ) : row.sources.length > 0 ? <span className="ci-raw" title={src}>{src}</span> : <span className="ci-nocol">Whole file</span>}
        </div>
        <span className="ci-arrow" aria-hidden="true">→</span>
        <div role="cell" className="ci-trow-target">
          {nameQ ? <span className="ci-fixed">{fieldLabel(fields, "name")}</span>
            : mapQ ? (
              <FieldPicker
                fields={fields}
                usedBy={usedBy}
                value={proposal ?? IGNORE}
                pending={!!proposal}
                question
                disabled={busy}
                placeholder={proposal === IGNORE ? "Ignore column" : "Choose a field"}
                onChange={(t) => onAnswers({ [mapQ.id]: answerFor(mapQ, t, m) })}
              />
            ) : row.sources.length > 0 ? (
              <div className="ci-target-line">
                <FieldPicker fields={fields} usedBy={usedBy} value={m?.target ?? IGNORE} disabled={busy} placeholder="Choose a field" onChange={onRemap} />
                {missQ && exact && <span className="ci-tag ci-tag-exact" title="Your column has the same name as this Distru field">Exact header</span>}
              </div>
            ) : <span className="ci-fixed ci-fixed-muted">—</span>}
        </div>
        <div className="ci-map-meta" role="cell">
          {canAccept && (
            <button
              type="button"
              className="ci-btn ci-row-accept"
              disabled={busy}
              title="Use the highlighted answers on this row"
              onClick={() => onAnswers(accept)}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Accept
            </button>
          )}
        </div>
      </div>

      <div className="ci-trow-sub">
        {row.derived.map((d) => (
          <span key={d.target} className="ci-derived" title={dev ? d.rationale : undefined}>also sets {fieldLabel(fields, d.target)}</span>
        ))}
        {nameQ && <span className="ci-why"><StateTag required={nameQ.blocking} />This file has no product name column we could find. Pick the column with product names.</span>}
        {mapQ && (
          <span className="ci-why" title={dev ? mapQ.prompt : undefined}>
            <StateTag required={mapQ.blocking} />{mapWhy(mapQ, fields, proposal, dev, src)}
          </span>
        )}
        {missQ && (
          <Missing q={missQ} label={fieldLabel(fields, m!.target)} picks={all.filter((q) => q.id.startsWith(`value:${m!.target}:`))} busy={busy}
            onAnswers={onAnswers} onRecheck={() => onRecheck(m!.target)} />
        )}
        {follow.map((q) => (
          <span key={q.id} className="ci-why" title={q.prompt}>
            <StateTag required={q.blocking} />{followText(q)}
            <MiniPick q={q} busy={busy} onAnswer={(a) => onAnswers({ [q.id]: a })} />
          </span>
        ))}
      </div>
    </div>
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The file's column has the Distru field's own name ("Vendor" -> Vendor). */
const sameName = (src: string, label: string) => !!src && norm(src) === norm(label);
/** "Vendor" -> "vendor" / "vendors"; "Unit Type Name" -> "unit type(s)". */
const nounOf = (label: string, n: number) => {
  const one = label.replace(/ name$/i, "").toLowerCase().replace(/s$/, "");
  return n === 1 ? one : `${one}s`;
};
const SHOW_VALUES = 8;

/**
 * Names a must-exist Distru list doesn't have (new vendors, brands). The column match itself is settled; this asks
 * what to do with the missing names: add them in Distru and re-check, match each to an existing one, or leave blank.
 */
function Missing({ q, label, picks, busy, onAnswers, onRecheck }: {
  q: Question; label: string; picks: Question[]; busy: boolean;
  onAnswers: (answers: Record<string, string>) => void; onRecheck: () => Promise<unknown>;
}) {
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const vals = q.values ?? [];
  const choice = q.answer ?? q.suggested;
  const open = q.answer === undefined || !!q.waiting;
  const one = nounOf(label, 1);
  return (
    <div className="ci-miss">
      <span className="ci-why">
        <StateTag required={open} />
        {vals.length} {nounOf(label, vals.length)} {vals.length === 1 ? "isn't" : "aren't"} in your Distru account yet:
      </span>
      <div className="ci-miss-vals">
        {vals.slice(0, SHOW_VALUES).map((v) => <span key={v} className="ci-vchip">{v}</span>)}
        {vals.length > SHOW_VALUES && <span className="ci-muted">+{vals.length - SHOW_VALUES} more</span>}
      </div>
      <div className="ci-choices" role="radiogroup" aria-label={`What to do with the missing ${nounOf(label, 2)}`}>
        {(q.options ?? []).map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={choice === o.id}
            className={`ci-choice${choice === o.id ? " ci-choice-on" : ""}`}
            disabled={busy}
            onClick={() => q.answer !== o.id && onAnswers({ [q.id]: o.id })}
          >
            {o.label}
          </button>
        ))}
      </div>
      {choice === "match" && picks.length > 0 && (
        <div className="ci-miss-detail ci-miss-picks">
          {picks.map((p) => (
            <div key={p.id} className="ci-miss-pick">
              <span className="ci-raw">{p.values?.[0] ?? p.ref?.value}</span>
              <span className="ci-arrow" aria-hidden="true">→</span>
              <MiniPick q={{ ...p, suggested: p.answer ?? p.suggested }} busy={busy} onAnswer={(a) => onAnswers({ [p.id]: a })} />
            </div>
          ))}
        </div>
      )}
      {choice === "add" && (
        <div className="ci-miss-detail ci-miss-note">
          <span>Rows keep these names. Add the {nounOf(label, vals.length)} in Distru, then re-check. The import waits until they exist.</span>
          {q.answer === "add" && (
            <button type="button" className="ci-btn ci-recheck" disabled={busy}
              onClick={() => onRecheck().then(() => setCheckedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })))}>
              Re-check {nounOf(label, 2)}
            </button>
          )}
          {q.answer === "add" && checkedAt && <span className="ci-muted" role="status">Checked at {checkedAt}. The ones above still aren't in Distru.</span>}
        </div>
      )}
      {choice === "blank" && (
        <div className="ci-miss-detail ci-miss-note">These rows import with no {one}. You can set it later in Distru.</div>
      )}
    </div>
  );
}

/** Every open item on a row says the same way whether it blocks Confirm mapping. */
const StateTag = ({ required }: { required: boolean }) => (
  <span className={`ci-state ci-state-${required ? "req" : "opt"}`}>{required ? "Required" : "Optional"}</span>
);
const OTHER = "__other";

/** A compact picker for a follow-up answer; the proposed answer is pre-selected and picking another answers it. */
function MiniPick({ q, busy, onAnswer }: { q: Question; busy: boolean; onAnswer: (a: string) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const free = q.kind === "free_text" || q.id.startsWith("slang:");
  const options = q.options ?? [];
  return (
    <>
      <select
        className="ci-mini"
        value={other ? OTHER : q.suggested ?? ""}
        disabled={busy}
        aria-label={q.prompt}
        onChange={(e) => {
          if (e.target.value === OTHER) { setOther(true); return; }
          setOther(false);
          if (e.target.value) onAnswer(e.target.value);
        }}
      >
        {!q.suggested && <option value="" disabled>Choose…</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label.replace(/^Yes, /, "")}</option>)}
        {free && <option value={OTHER}>Other…</option>}
      </select>
      {other && (
        <form className="ci-mini-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
          <input autoFocus className="ci-input ci-mini-input" value={text} placeholder={q.id.startsWith("slang:") ? "4 g" : "Your answer"} onChange={(e) => setText(e.target.value)} />
          <button className="ci-btn ci-mini-use" disabled={busy || !text.trim()}>Use</button>
        </form>
      )}
    </>
  );
}

function FillValue({ d }: { d: DefaultT }) {
  if (isDerive(d.value)) return <span className="ci-default-auto">Auto</span>;
  return <span className="ci-default-chip">{d.value === null || d.value === "" ? "blank" : typeof d.value === "object" ? JSON.stringify(d.value) : String(d.value)}</span>;
}

const isDerive = (v: Json) => !!v && typeof v === "object" && !Array.isArray(v) && "derive" in v;
const fillReason = (d: DefaultT) => (d.reason === "Default" ? "Distru default" : d.reason);
const ignoredLabel = (reason: string, dev: boolean) =>
  reason.startsWith("Ignored by user") ? "Ignored by you"
    : reason.startsWith("Not matched") ? "No match"
    : dev || /^column is empty/i.test(reason) ? reason
    : "Not product info"; // model rationales ("Jev: not a product field", "LLM: ...") stay in developer mode

const same = (raw: string, v: unknown) => typeof v === "string" && v.toLowerCase() === raw.toLowerCase();
const hasNotable = (map: ValueMapT) => Object.entries(map).some(([raw, v]) => !same(raw, v));

/** Value maps collapse to a one-line summary; only values that change are listed when opened. */
function ValueMap({ label, map }: { label: string; map: ValueMapT }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const entries = Object.entries(map);
  const notable = entries.filter(([raw, v]) => !same(raw, v));
  const created = entries.filter(([, v]) => v && typeof v === "object").length;
  const blank = entries.filter(([, v]) => v === null).length;
  const exact = entries.length - notable.length;
  if (!notable.length) return null;
  const shown = all ? entries : notable;
  const parts = [
    notable.length - created - blank > 0 && `${notable.length - created - blank} renamed`,
    created > 0 && `${created} new`,
    blank > 0 && `${blank} left blank`,
    exact > 0 && `${exact} exact`,
  ].filter(Boolean);
  return (
    <div className="ci-vmap">
      <button type="button" className="ci-vmap-sum" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ci-vmap-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {label} values: {parts.join(" · ")}
      </button>
      {open && (
        <div className="ci-vmap-list">
          {shown.map(([raw, v]) => (
            <div key={raw} className="ci-vmap-line">
              <span className="ci-raw">{raw}</span>
              <span className="ci-arrow">→</span>
              {v === null ? <span className="ci-muted">left blank</span>
                : typeof v === "object" ? <span>{v.create} <span className="ci-tag">will be created</span></span>
                : <span>{v}</span>}
            </div>
          ))}
          {exact > 0 && (
            <button type="button" className="ci-link" onClick={() => setAll((a) => !a)}>
              {all ? "Hide exact matches" : `Show ${fmtNum(exact)} exact matches`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Section({ title, count, tone, children }: { title: string; count?: number; tone?: "attn"; children: ReactNode }) {
  return (
    <section className={`ci-section${tone ? ` ci-section-${tone}` : ""}`}>
      <h4 className="ci-section-title">
        {title}
        {count !== undefined && <span className="ci-count">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

export function Footer({ notice, error, children }: { notice: string | null; error: string | null; children: ReactNode }) {
  return (
    <div className="ci-footer">
      <div className="ci-footer-msg">
        {notice && <span className="ci-notice">{notice}</span>}
        {error && <span className="ci-error">{error}</span>}
      </div>
      <div className="ci-footer-actions">{children}</div>
    </div>
  );
}
