import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TargetField } from "./util.ts";

export const IGNORE = "__ignore";

export interface FieldPickerProps {
  fields: TargetField[];
  value: string;
  /** target -> source column(s) already mapped to it, shown as "from X". */
  usedBy?: Record<string, string>;
  disabled?: boolean;
  placeholder?: string;
  /** `value` is a proposal, not yet confirmed: picking it (even unchanged) calls onChange. */
  pending?: boolean;
  /** The picker answers an open question: any pick, including Ignore or the current value, calls onChange. */
  question?: boolean;
  /** Offer "Ignore this column" (default true). */
  allowIgnore?: boolean;
  onChange: (v: string) => void;
}

type Item = { id: string; label: string; section: string; hint?: string; tag?: string };

/** Searchable, grouped field picker. Popover is position: fixed so scroll containers never clip it. */
export function FieldPicker({ fields, value, usedBy = {}, disabled, placeholder = "Map to a field", pending, question, allowIgnore = true, onChange }: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = fields.find((f) => f.name === value);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (f: TargetField) =>
      !needle || [f.label, f.name.replace(/_/g, " "), ...(f.synonyms ?? [])].some((s) => s.toLowerCase().includes(needle));
    const out: Item[] = fields.filter(match).map((f) => ({
      id: f.name,
      label: f.label,
      section: f.section ?? "Fields",
      hint: usedBy[f.name] && f.name !== value ? `from ${usedBy[f.name]}` : undefined,
      tag: f.followup ? "after upload" : f.required ? "required" : undefined,
    }));
    if (allowIgnore && (value !== IGNORE || pending || question) && (!needle || "ignore column".includes(needle))) out.push({ id: IGNORE, label: "Ignore this column", section: "" });
    return out;
  }, [fields, q, usedBy, value, pending, question, allowIgnore]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const up = window.innerHeight - r.bottom < 340 && r.top > 340;
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left: Math.min(r.right - 280, window.innerWidth - 292), width: 280, up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (pop.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", onScroll, true);
    const onResize = () => setOpen(false);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (id: string) => {
    setOpen(false);
    setQ("");
    if (id !== value || pending || question) onChange(id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].id); }
    else if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
  };

  let lastSection: string | null = null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`ci-picker${!pending && value === IGNORE ? " ci-picker-empty" : ""}${open ? " ci-picker-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ci-picker-label">{value === IGNORE ? placeholder : current?.label ?? value}</span>
        <svg className="ci-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && (
        <div
          ref={pop}
          className="ci-pop"
          style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
        >
          <input autoFocus className="ci-pop-search" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <div ref={list} className="ci-pop-list" role="listbox">
            {items.length === 0 && <div className="ci-pop-empty">No field matches "{q}"</div>}
            {items.map((it, i) => {
              const head = it.section !== lastSection ? it.section : null;
              lastSection = it.section;
              return (
                <div key={it.id}>
                  {head !== null && (head ? <div className="ci-pop-group">{head}</div> : <div className="ci-pop-sep" />)}
                  <div
                    data-i={i}
                    role="option"
                    aria-selected={it.id === value}
                    className={`ci-pop-item${i === active ? " ci-pop-active" : ""}${it.id === value ? " ci-pop-current" : ""}${it.id === IGNORE ? " ci-pop-ignore" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); pick(it.id); }}
                  >
                    <span className="ci-pop-label">{it.label}</span>
                    {it.hint && <span className="ci-pop-hint">{it.hint}</span>}
                    {it.tag && <span className="ci-pop-tag">{it.tag}</span>}
                    {it.id === value && <span className="ci-pop-check" aria-hidden="true">✓</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
