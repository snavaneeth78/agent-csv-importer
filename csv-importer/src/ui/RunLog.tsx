import { useEffect, useState, type ReactNode } from "react";
import type { ImportEvent, Json } from "../core/index.ts";
import type { ImportView } from "./api.ts";
import { fieldLabel, fmtNum, targetFields } from "./util.ts";

const RULES = new Set(["template", "memory", "exact", "pattern", "fuzzy"]);
const STAGE_INFO: Record<string, { name: string; how: string }> = {
  template: { name: "Template fast path", how: "Used only when every header is a Distru template header" },
  memory: { name: "Column memory", how: "Decisions you confirmed on earlier imports" },
  exact: { name: "Exact names", how: "Header equals a field name or synonym" },
  pattern: { name: "Value patterns", how: "Barcodes, sizes, prices and potency in the values" },
  fuzzy: { name: "Fuzzy names", how: "Close spelling, with a type check" },
  jev: { name: "Jev", how: "Picks one field per column: 75%+ is accepted, 40-75% becomes a suggestion to confirm, the rest goes to the LLM" },
  llm: { name: "LLM", how: "Runs alongside Jev on the same columns (headers and samples); its answer is used where Jev had no real one" },
};

export function deciderOf(method: string): { label: string; tone: "rules" | "jev" | "llm" | "user" } {
  if (method === "jev") return { label: "Jev", tone: "jev" };
  if (method === "llm") return { label: "LLM", tone: "llm" };
  if (method === "user") return { label: "You", tone: "user" };
  return { label: "Rules", tone: "rules" };
}

type Usage = { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "price not set";
  if (n === 0) return "$0";
  if (n < 0.0001) return "< $0.0001";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

const fmtTok = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());

const USAGE_STEPS: [string, string][] = [
  ["jev:columns", "Jev, columns"], ["llm:columns", "LLM, columns"],
  ["jev:values", "Jev, values"], ["llm:values", "LLM, values"], ["llm:edits", "LLM, chat edits"],
];

function UsageSummary({ usage }: { usage: Record<string, Usage> | undefined }) {
  const [open, setOpen] = useState(false);
  const rows = USAGE_STEPS.filter(([k]) => usage?.[k]).map(([k, label]) => ({ k, label, u: usage![k] }));
  if (!rows.length) return <div className="ci-usage ci-usage-none">No paid model calls: rules and stubs only</div>;
  const total = rows.reduce((s, r) => ({ tok: s.tok + r.u.inputTokens + r.u.outputTokens, cost: r.u.costUsd === null ? s.cost : (s.cost ?? 0) + r.u.costUsd }), { tok: 0, cost: null as number | null });
  const unknownPrice = rows.some((r) => r.u.costUsd === null);
  return (
    <div className={`ci-usage${open ? " ci-usage-open" : ""}`}>
      <button className="ci-usage-total" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "Hide details" : "Tokens and cost per step"}>
        <svg className="ci-info" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        <span>Model usage</span>
        <b>{fmtTok(total.tok)} tokens</b>
        <b>{fmtUsd(total.cost)}{unknownPrice && total.cost !== null ? "+" : ""}</b>
        <svg className={`ci-chevron${open ? " ci-chevron-up" : ""}`} viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (<>
      <table className="ci-usage-table">
        <thead><tr><th>Step</th><th>Model</th><th>Calls</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
        <tbody>
          {rows.map(({ k, label, u }) => (
            <tr key={k}>
              <td><span className={`ci-who ci-who-${k.startsWith("jev") ? "jev" : "llm"}`}>{label}</span></td>
              <td className="ci-muted">{u.model}</td>
              <td>{u.calls}</td>
              <td>{fmtTok(u.inputTokens)}</td>
              <td>{fmtTok(u.outputTokens)}</td>
              <td>{fmtUsd(u.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ci-muted ci-small">List prices, USD per 1M tokens: gpt-4o $2.50 in / $10 out; Jev $0.042 in, output free.</p>
      </>)}
    </div>
  );
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** First time the import entered a status, from status_changed events. */
function entered(events: ImportEvent[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const e of events) {
    const to = e.type === "status_changed" ? String(e.payload.to) : null;
    if (to && !at.has(to)) at.set(to, Date.parse(e.createdAt));
  }
  return at;
}

const between = (at: Map<string, number>, a: string, b: string[]) => {
  const start = at.get(a);
  const end = b.map((x) => at.get(x)).find((x) => x !== undefined);
  return start !== undefined && end !== undefined ? end - start : undefined;
};

function whoConfirmed(e: ImportEvent | undefined): string {
  if (!e) return "";
  const msg = (e.payload as Record<string, Json>).confirmingMessageId;
  return e.actor === "agent" ? `You, in chat${msg ? ` (${msg})` : ""}` : "You, in the card";
}

export function RunLog({ view, events, onClose }: { view: ImportView; events: ImportEvent[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fields = targetFields(view);
  const at = entered(events);
  const t = view.stats.timings ?? {};
  const stages = view.stats.matchStages ?? [];
  const plan = view.plan;
  const own = plan?.fields.filter((m) => !m.rationale.startsWith("derived:")) ?? [];
  const tally = { rules: 0, jev: 0, llm: 0, user: 0 };
  for (const m of own) tally[deciderOf(m.method).tone]++;
  const toConfirm = own.filter((m) => m.needsConfirm).length;
  const gates = events.filter((e) => e.type === "gate_confirmed");
  const gate1 = gates.find((e) => e.payload.gate === "mapping");
  const gate2 = gates.find((e) => e.payload.gate === "commit");
  const answered = events.filter((e) => e.type === "question_answered");
  const chunks = (stage: string) => events.filter((e) => e.type === "chunk_progress" && e.payload.stage === stage);
  const prep = chunks("prepare");
  const commit = chunks("commit");
  const follow = chunks("followup");
  const sum = (es: ImportEvent[], k: string) => es.reduce((s, e) => s + Number(e.payload[k] ?? 0), 0);
  const c = view.counts;
  const leftForYou = (plan?.ignoredColumns ?? []).filter((i) => i.reason.startsWith("Not matched"));
  const needsYou = leftForYou.map((i) => i.source);
  const total = between(at, "queued", ["completed", "partially_completed", "failed", "cancelled"]);

  return (
    <div className="ci-drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="ci-drawer" role="dialog" aria-modal="true" aria-label="How this import ran">
        <header className="ci-drawer-head">
          <div>
            <h3>How it ran</h3>
            <p className="ci-muted ci-small">{view.filename}{total !== undefined ? ` · ${fmtMs(total)} end to end` : ""}</p>
          </div>
          <button className="ci-btn ci-ghost" onClick={onClose} aria-label="Close" autoFocus>Close</button>
        </header>

        <div className="ci-drawer-body">
          <div className="ci-sum">
            <div className="ci-sum-head">
              <span className="ci-sum-title">{fmtNum(own.length)} columns mapped</span>
              <span className="ci-sum-legend">
                {tally.rules > 0 && <span><i className="ci-key ci-key-rules" />Rules {tally.rules}</span>}
                {tally.jev > 0 && <span><i className="ci-key ci-key-jev" />Jev {tally.jev}</span>}
                {tally.llm > 0 && <span><i className="ci-key ci-key-llm" />LLM {tally.llm}</span>}
                {tally.user > 0 && <span><i className="ci-key ci-key-user" />You {tally.user}</span>}
              </span>
            </div>
            <div className="ci-sum-bar" aria-hidden="true">
              {(["rules", "jev", "llm", "user"] as const).map((k) => tally[k] > 0 && <i key={k} className={`ci-key-${k}`} style={{ flex: tally[k] }} />)}
            </div>
            {(toConfirm > 0 || needsYou.length > 0) && (
              <div className="ci-sum-attn">
                {toConfirm > 0 && <span>{toConfirm} to confirm</span>}
                {needsYou.length > 0 && <span>{needsYou.length} left for you</span>}
              </div>
            )}
            <UsageSummary usage={view.stats.usage as Record<string, Usage> | undefined} />
          </div>

          <ol className="ci-flow">
            <Step title="Read the file" ms={t.parse ?? between(at, "parsing", ["matching"])} done={at.has("matching")}>
              {fmtNum(view.stats.totalRows)} rows{view.stats.skippedRows ? `, ${fmtNum(view.stats.skippedRows)} blank or total rows dropped` : ""}
              {view.stats.kind ? ` · ${view.stats.kind.toUpperCase()}` : ""}{view.stats.encoding && view.stats.encoding !== "utf-8" ? ` · ${view.stats.encoding}` : ""}
              {view.stats.sheets && view.stats.sheets.length > 1 ? ` · sheet "${plan?.sheet}" of ${view.stats.sheets.length}` : ""}
            </Step>

            <Step title="Match columns" ms={view.stats.matchMs ?? between(at, "matching", ["mapping_review"])} done={at.has("mapping_review")}>
              <div className="ci-subtimes">
                {(["snapshot", "refs", "profile", "cascade", "plan", "review", "models"] as const).filter((k) => t[k] !== undefined).map((k) => (
                  <span key={k} title={k === "review" ? "The review opened here; model answers filled in after" : undefined}>
                    {{ snapshot: t.snapshotFull ? "Catalog load" : "Catalog", refs: "Lists", profile: "Profiles", cascade: "Rules", plan: "Values", review: "Review open at", models: "Models after that" }[k]} {fmtMs(t[k])}
                  </span>
                ))}
              </div>
              <div className="ci-cas">
                {(["rules", "models"] as const).map((group) => {
                  const rows = stages.filter((s) => (group === "rules") === RULES.has(s.method));
                  const off = group === "models" ? view.stats.disabledStages ?? [] : [];
                  if (!rows.length && !off.length) return null;
                  return (
                    <div key={group} className="ci-cas-group">
                      <div className="ci-cas-label">{group === "rules" ? "Rules" : "Models"}</div>
                      {rows.map((s) => {
                        const info = STAGE_INFO[s.method] ?? { name: s.method, how: "" };
                        const tone = deciderOf(s.method).tone;
                        const stub = s.model === "stub";
                        const skipped = s.method === "template" && s.resolved.length === 0;
                        const parts = [
                          s.resolved.length ? `${s.resolved.length} mapped` : "",
                          s.suggested?.length ? `${s.suggested.length} to confirm` : "",
                          s.ignored.length ? `${s.ignored.length} not a field` : "",
                          s.nearMisses?.length ? `${s.nearMisses.length} below bar` : "",
                          s.error ? "call failed" : "",
                        ].filter(Boolean);
                        const outcome = skipped ? "didn't apply" : parts.length ? parts.join(" · ") : "nothing";
                        return (
                          <CasRow
                            key={s.method}
                            tone={tone}
                            name={s.method === "jev" ? "Jev" : s.method === "llm" ? "LLM" : info.name}
                            meta={stub ? "stub" : !RULES.has(s.method) ? s.model : undefined}
                            outcome={outcome}
                            quiet={!parts.length}
                            bad={!!s.error}
                            right={<>{s.usage && <span className="ci-cas-cost">{fmtUsd(s.usage.costUsd)}</span>}{fmtMs(s.ms)}</>}
                            defaultOpen={parts.length > 0}
                          >
                            <p className="ci-cas-how">
                              {skipped ? "Not every header is a Distru template header, so the next stages decide." : stub ? `${info.how}. Stand-in, no model call.` : `${info.how}.`}
                              {` ${s.seen} ${s.seen === 1 ? "column" : "columns"} reached this stage.`}
                              {s.usage ? ` ${fmtTok(s.usage.inputTokens + s.usage.outputTokens)} tokens.` : ""}
                            </p>
                            {s.error && <div className="ci-stage-error">Call failed: {s.error}. Its columns moved on to the next stage.</div>}
                            <Chips label="Mapped" items={s.resolved.map((src) => { const m = own.find((x) => x.sources[0] === src); return { key: src, text: `${src} → ${m ? fieldLabel(fields, m.target) : "?"}`, title: m?.rationale }; })} />
                            <Chips label="To confirm" tone="suggest" items={(s.suggested ?? []).map((src) => { const m = own.find((x) => x.sources[0] === src); return { key: src, text: `${src} → ${m ? fieldLabel(fields, m.target) : "?"}`, score: m?.score }; })} />
                            <Chips label="Not a field" tone="ignored" items={s.ignored.map((src) => ({ key: src, text: src }))} />
                            <Chips label="Below bar" tone="near" items={(s.nearMisses ?? []).map((n) => ({ key: n.source, text: `${n.source} → ${n.target ? fieldLabel(fields, n.target) : "not a field"}`, score: n.score }))} />
                          </CasRow>
                        );
                      })}
                      {off.map((m) => (
                        <CasRow key={m} tone={m === "jev" ? "jev" : "llm"} name={m === "jev" ? "Jev" : "LLM"} meta="off" outcome="switched off for this run" quiet right={null} defaultOpen={false} />
                      ))}
                    </div>
                  );
                })}
              </div>
              {stages.length > 0 && stages[stages.length - 1].method === "template" && (
                <p className="ci-muted ci-small">Every header matched the template, so later stages didn't run.</p>
              )}
              {needsYou.length > 0 && (
                <div className="ci-left">
                  <div className="ci-left-title">Left for you <span className="ci-muted">· best guess is pre-selected in the card</span></div>
                  <Chips items={leftForYou.map((i) => ({ key: i.source, text: `${i.source}${i.guess ? ` → ${i.guess.target ? fieldLabel(fields, i.guess.target) : "not a field"}?` : ""}`, score: i.guess?.score }))} />
                </div>
              )}
              {own.some((m) => m.method === "user") && (
                <Chips label="Set by you" items={own.filter((m) => m.method === "user").map((m) => ({ key: m.target, text: `${m.sources.join(" + ")} → ${fieldLabel(fields, m.target)}` }))} />
              )}
            </Step>

            <Step title="Gate 1: mapping review" ms={between(at, "mapping_review", ["preparing", "cancelled"])} done={!!gate1} gate>
              {plan?.questions.length ? `${plan.questions.length} question(s), ${answered.length} answered` : "No questions"}
              {answered.length > 0 && ` (${answered.filter((e) => e.actor === "agent").length} in chat, ${answered.filter((e) => e.actor === "user").length} in the card)`}
              {gate1 && <div className="ci-muted ci-small">Confirmed by {whoConfirmed(gate1)} at {new Date(gate1.createdAt).toLocaleTimeString()}</div>}
            </Step>

            <Step title="Check rows" ms={between(at, "preparing", ["commit_review"])} done={at.has("commit_review")}>
              {prep.length > 0 && `${prep.length} chunk(s), ${fmtNum(sum(prep, "rows"))} rows validated and checked against your catalog`}
              {at.has("commit_review") && (
                <div className="ci-muted ci-small">
                  {fmtNum(c.create)} new · {fmtNum((c.exists_unchanged ?? 0) + (c.exists_changed ?? 0))} already in Distru · {fmtNum(c.dup_in_file)} duplicates in file · {fmtNum(c.invalid)} invalid
                </div>
              )}
            </Step>

            <Step title="Gate 2: import review" ms={between(at, "commit_review", ["committing", "cancelled", "mapping_review"])} done={!!gate2} gate>
              {gate2 ? <>Confirmed by {whoConfirmed(gate2)} at {new Date(gate2.createdAt).toLocaleTimeString()}</> : "Waiting for you"}
            </Step>

            <Step title="Write to Distru" ms={between(at, "committing", ["completed", "partially_completed", "failed"])} done={at.has("completed") || at.has("partially_completed")}>
              {commit.length > 0 && <div>Upload: {commit.length} chunk(s), {fmtMs(sum(commit, "ms"))} · POST /upload-products</div>}
              {follow.length > 0 && <div>Details (follow-up): {fmtNum(sum(follow, "done"))} done, {fmtNum(sum(follow, "failed"))} failed in {follow.length} batch(es) · MCP distru-mutate-product</div>}
              {commit.length === 0 && <span className="ci-muted">Not started</span>}
            </Step>
          </ol>
        </div>
      </aside>
    </div>
  );
}

/** One cascade stage as a row: outcome at a glance; details expand beneath. */
function CasRow({ tone, name, meta, outcome, quiet, bad, right, defaultOpen, children }: {
  tone: string; name: string; meta?: string; outcome: string; quiet?: boolean; bad?: boolean; right: ReactNode; defaultOpen: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;
  return (
    <div className={`ci-cas-row${quiet ? " ci-cas-quiet" : ""}${open ? " ci-cas-open" : ""}`}>
      <button type="button" className="ci-cas-line" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen((o) => !o)}>
        <i className={`ci-key ci-key-${tone}`} />
        <span className="ci-cas-name">{name}{meta && <span className={`ci-cas-meta${meta === "stub" || meta === "off" ? " ci-cas-meta-tag" : ""}`}>{meta}</span>}</span>
        <span className={`ci-cas-outcome${bad ? " ci-bad" : ""}`}>{outcome}</span>
        <span className="ci-cas-right">{right}</span>
        {expandable ? <svg className={`ci-chevron${open ? " ci-chevron-up" : ""}`} viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : <span className="ci-chevron" />}
      </button>
      {open && children && <div className="ci-cas-body">{children}</div>}
    </div>
  );
}

function Chips({ label, tone, items }: { label?: string; tone?: "suggest" | "ignored" | "near"; items: { key: string; text: string; title?: string; score?: number }[] }) {
  if (!items.length) return null;
  return (
    <div className="ci-chips">
      {label && <span className="ci-chips-label">{label}</span>}
      {items.map((i) => (
        <span key={i.key} className={`ci-chip${tone ? ` ci-chip-${tone}` : ""}`} title={i.title}>
          {i.text}{i.score !== undefined && <b>{Math.round(i.score * 100)}%</b>}
        </span>
      ))}
    </div>
  );
}

function Step({ title, ms, done, gate, children }: { title: string; ms?: number; done: boolean; gate?: boolean; children?: ReactNode }) {
  return (
    <li className={`ci-flow-step${done ? " ci-flow-done" : ""}${gate ? " ci-flow-gate" : ""}`}>
      <div className="ci-flow-head">
        <span className="ci-flow-title">{title}</span>
        {gate && <span className="ci-flow-tag">human</span>}
        {ms !== undefined && <span className="ci-flow-ms">{fmtMs(ms)}</span>}
      </div>
      <div className="ci-flow-body">{children}</div>
    </li>
  );
}
