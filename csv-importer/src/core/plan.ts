import { jaroWinkler, levenshtein } from "./similarity.ts";
import type { ColumnProfile } from "./profile.ts";
import type { PlanPatch, TargetProfile, ValueStage } from "./ports.ts";
import type { ModelUsage } from "./usage.ts";
import type { FieldDef, FieldMapping, Json, MappingPlan, Question, TargetSchema, Transform, ValueMapEntry } from "./types.ts";
import { defaultTransforms } from "./cascade.ts";
import { parsePotency, parseQuantity } from "./units.ts";
import { runTransforms, valueKey } from "./transforms.ts";
import { normalizeHeader, normValue } from "./normalize.ts";

export const BLANK = "__blank";
const UNITS = ["g", "mg", "oz", "lb", "ml"];

export interface FinalizeDeps {
  profile: TargetProfile;
  columns: ColumnProfile[];
  /** Distinct raw values of a source column (all rows, capped). */
  distinct(source: string): Promise<string[]>;
  refs: Record<string, string[]>;
  valueStages: ValueStage[];
  /** Model spend from value matching, by stage method ("jev" | "llm"). */
  onUsage?: (method: string, u: ModelUsage) => void;
  /**
   * Skip the model value stages. Fields whose values still need them are listed in `plan.pending.fields` and get
   * no value questions yet, so the early review never asks about a vendor a model would have matched.
   */
  deferModels?: boolean;
}

const isModelStage = (s: { method: string }) => s.method === "jev" || s.method === "llm";

/**
 * Value stages whose answers are kept per field and set of values, so the same model call isn't paid twice: value
 * matching started early (while column models run) is reused by the final pass over the merged plan.
 */
export function memoValueStages(stages: ValueStage[]): ValueStage[] {
  return stages.map((s) => {
    const cache = new Map<string, ReturnType<ValueStage["run"]>>();
    return {
      method: s.method,
      run(input, opts) {
        const key = `${input.field.name}\u0000${JSON.stringify([...input.values].sort())}`;
        let p = cache.get(key);
        if (!p) {
          p = s.run(input, opts);
          cache.set(key, p);
          p.catch(() => cache.delete(key));
        }
        return p;
      },
    };
  });
}

export function emptyPlan(headers: string[], headerRow: number, sheet?: string): MappingPlan {
  return {
    sheet, headerRow, headers, fields: [], ignoredColumns: [], valueMaps: {}, defaultsApplied: [], questions: [],
    clearBlanks: false, existingAction: "skip",
  };
}

const mappingFor = (plan: MappingPlan, target: string) => plan.fields.find((m) => m.target === target);

/**
 * Idempotent: derives dependent mappings (units, servings, sizes from names), defaults, questions and value
 * maps for the current mappings. Runs after the cascade and after every revise. Keeps user answers.
 */
export async function finalizePlan(plan: MappingPlan, deps: FinalizeDeps): Promise<MappingPlan> {
  const { profile } = deps;
  const target = profile.target;
  const colBy = new Map(deps.columns.map((c) => [c.source, c]));
  const questions: Question[] = [];
  const mapped = new Set(plan.fields.map((m) => m.target));
  const derivedFrom = (m: FieldMapping) => m.rationale.startsWith("derived:");

  // Drop derived mappings whose parent is gone; they are re-derived below.
  plan.fields = plan.fields.filter((m) => !derivedFrom(m) || plan.fields.some((p) => p.target === m.rationale.slice(8)));

  // 1. Sizes from names when no size column exists (names are never changed).
  for (const fd of Object.values(target.fields)) {
    if (fd.pattern !== "quantity" || !fd.extractFrom || mappingFor(plan, fd.name)) continue;
    const src = mappingFor(plan, fd.extractFrom);
    if (!src) continue;
    const names = await deps.distinct(src.sources[0]);
    const hits = names.filter((n) => {
      const q = parseQuantity(n, { inName: true });
      return (q?.kind === "explicit" && q.unit !== "mg") || q?.kind === "slang";
    }).length;
    if (names.length && hits / names.length >= 0.2) {
      plan.fields.push({
        target: fd.name, sources: [...src.sources], transforms: [{ op: "extract_quantity_from_name", part: "value" }],
        score: 0.9, method: "pattern", rationale: `Size copied from ${src.sources[0]} (names unchanged)`,
      });
    }
  }

  // 2. Unit and serving fields derived from quantity/potency columns.
  for (const m of [...plan.fields]) {
    const fd = target.fields[m.target];
    if (!fd || derivedFrom(m)) continue;
    const head = m.transforms[0];
    if (fd.unitField && !plan.fields.some((x) => x.target === fd.unitField && !derivedFrom(x))) {
      const t: Transform[] = head?.op === "parse_quantity" ? [{ ...head, part: "unit", slangField: m.target }]
        : head?.op === "extract_quantity_from_name" ? [{ op: "extract_quantity_from_name", part: "unit", slangField: m.target }]
        : [{ op: "parse_potency", part: "unit", ...(head?.op === "parse_percent" ? { assumeUnit: "PERCENT" as const } : head?.op === "parse_potency" && head.assumeUnit ? { assumeUnit: head.assumeUnit } : {}) }];
      const unitDef = target.fields[fd.unitField];
      if (unitDef.ref || unitDef.type === "enum" && fd.pattern === "quantity") t.push({ op: "map_values", key: fd.unitField });
      upsertDerived(plan, { target: fd.unitField, sources: [...m.sources], transforms: t, score: m.score, method: m.method, rationale: `derived:${m.target}` });
    }
    if (fd.servingField && !plan.fields.some((x) => x.target === fd.servingField && !derivedFrom(x))) {
      const vals = await deps.distinct(m.sources[0]);
      const inName = head?.op === "extract_quantity_from_name";
      if (vals.some((v) => { const q = parseQuantity(v, { inName }); return q?.kind === "explicit" && !!q.serving; })) {
        const t: Transform[] = inName ? [{ op: "extract_quantity_from_name", part: "serving", slangField: m.target }] : [{ ...(head as any), part: "serving", slangField: m.target }];
        upsertDerived(plan, { target: fd.servingField, sources: [...m.sources], transforms: t, score: m.score, method: m.method, rationale: `derived:${m.target}` });
      }
    }
  }

  // 3. Slang and bare-number questions for quantity columns. Slang is proposed, never assumed.
  for (const m of plan.fields) {
    const fd = target.fields[m.target];
    if (fd?.pattern !== "quantity" || derivedFrom(m)) continue;
    const head = m.transforms[0];
    const inName = head?.op === "extract_quantity_from_name";
    const slangMap = (plan.valueMaps[`__slang:${fd.name}`] ??= {});
    let bare = 0;
    for (const raw of await deps.distinct(m.sources[0])) {
      const q = parseQuantity(raw, { inName });
      if (q?.kind === "bare") bare++;
      if (q?.kind !== "slang") continue;
      const key = inName ? q.slang : valueKey(raw);
      const proposed = `${q.proposed.value} ${q.proposed.unit}`;
      const id = `slang:${fd.name}:${key}`;
      questions.push({
        id, kind: "confirm_default", blocking: true, ref: { field: fd.name, value: key },
        prompt: `Read "${inName ? q.slang : raw}" as ${proposed}?`,
        options: [{ id: proposed, label: `Yes, ${proposed}` }, { id: BLANK, label: "Leave size blank" }],
        suggested: proposed,
        answer: key in slangMap ? (slangMap[key] === null ? BLANK : String(slangMap[key])) : undefined,
      });
    }
    if (!inName && head?.op === "parse_quantity" && bare > 0) {
      const src = m.sources[0];
      const hint = colBy.get(src)?.unitHint;
      if (hint && !head.assumeUnit) setAssumeUnit(plan, src, hint);
      const id = `unit:${src}`;
      if (hint) {
        upsertDefault(plan, fd.unitField ?? fd.name, hint, `Bare numbers in "${src}" read as ${hint} (from the header)`);
      } else {
        questions.push({
          id, kind: "confirm_default", blocking: true, ref: { source: src, field: fd.name },
          prompt: `"${src}" has numbers with no unit. What unit are they in?`,
          options: UNITS.map((u) => ({ id: u, label: u })), suggested: "g",
          answer: head.assumeUnit,
        });
      }
    }
  }

  // 3b. Potency columns of bare numbers ("22"): ask % or mg, never assume.
  for (const m of plan.fields) {
    const fd = target.fields[m.target];
    const head = m.transforms[0];
    if (fd?.pattern !== "potency" || m.rationale.startsWith("derived:") || head?.op !== "parse_potency") continue;
    const nums = (await deps.distinct(m.sources[0])).map((v) => parsePotency(v)).filter((p) => p && !p.unit) as { value: number }[];
    if (!nums.length) continue;
    const src = m.sources[0];
    const max = Math.max(...nums.map((n) => n.value));
    questions.push({
      id: `potunit:${src}`, kind: "confirm_default", blocking: true, ref: { source: src, field: fd.name },
      prompt: `"${src}" has numbers with no unit (e.g. ${nums[0].value}). Are they % or mg?`,
      options: [{ id: "PERCENT", label: "% (percent)" }, { id: "MG", label: "mg" }],
      suggested: max <= 100 ? "PERCENT" : "MG",
      answer: head.assumeUnit,
    });
  }

  // 4. Defaults (never silent: listed under Defaults applied).
  for (const fd of Object.values(target.fields)) {
    if (fd.default !== undefined && !mapped.has(fd.name) && !mappingFor(plan, fd.name)) upsertDefault(plan, fd.name, fd.default, "Default", true);
  }
  plan.defaultsApplied = plan.defaultsApplied.filter((d) => !plan.fields.some((m) => m.target === d.target && !m.rationale.startsWith("derived:")) || d.reason.startsWith("Bare numbers"));
  profile.hooks?.afterMatch?.(plan, deps.columns);

  // 5. Value maps for every map_values transform. Three passes: collect values per field, run each stage
  // across all fields in parallel (one round of model calls instead of one per field), then decide.
  type Entry = { m: FieldMapping; key: string; fd: FieldDef; allowed: string[]; values: Set<string>; map: Record<string, ValueMapEntry>; todo: string[]; modelsAllowed: boolean };
  const entries: Entry[] = [];
  for (const m of plan.fields) {
    const mv = m.transforms.findIndex((t) => t.op === "map_values");
    if (mv < 0) continue;
    const key = (m.transforms[mv] as { key: string }).key;
    const fd = target.fields[key];
    const pre = m.transforms.slice(0, mv);
    const values = new Set<string>();
    for (const raw of await deps.distinct(m.sources[0])) {
      const out = pre.length ? runTransforms([raw], pre, { valueMaps: plan.valueMaps, currency: profile.currency, field: key }).value : raw;
      for (const v of Array.isArray(out) ? out : [out]) if (v !== null && String(v).trim()) values.add(String(v).trim());
    }
    const map = (plan.valueMaps[key] ??= {});
    // Fields Distru creates when new keep the file's value unless it's the same name or a typo: a model must
    // not turn "Top Shelf" into an existing "Premium". Models only help where a match is required.
    entries.push({ m, key, fd, allowed: fd.enumValues ?? deps.refs[key] ?? [], values, map, todo: [...values].filter((v) => !(valueKey(v) in map)), modelsAllowed: fd.ref?.mode !== "auto_create" });
  }
  const modelStages = deps.valueStages.some(isModelStage);
  for (const stage of deps.valueStages) {
    const isModel = isModelStage(stage);
    if (isModel && deps.deferModels) continue;
    const due = entries.filter((e) => e.todo.length && (!isModel || e.modelsAllowed));
    const results = await Promise.all(due.map((e) => stage.run({ field: e.fd, values: e.todo, allowed: e.allowed, aliases: profile.valueAliases?.[e.key] ?? {} }, { onUsage: (u) => deps.onUsage?.(stage.method, u) })));
    due.forEach((e, i) => {
      for (const r of results[i]) e.map[valueKey(r.value)] = r.match;
      const hit = new Set(results[i].map((r) => r.value));
      e.todo = e.todo.filter((v) => !hit.has(v));
    });
  }
  const pendingFields = new Set<string>();
  for (const { m, key, fd, allowed, values, map, todo, modelsAllowed } of entries) {
    // Values only a model can still place: decided (and asked about) once the model answers are in.
    if (deps.deferModels && modelStages && modelsAllowed && todo.length) {
      pendingFields.add(key);
      continue;
    }
    for (const v of todo) map[valueKey(v)] = fd.ref?.mode === "auto_create" ? { create: v } : null;

    // A must-exist column where no value exists in Distru is probably the wrong field ("Label" holding
    // "Top Shelf, House" is a group, not a brand). Ask once about the column instead of once per value.
    const own = !m.rationale.startsWith("derived:");
    const hits = [...values].filter((v) => typeof map[valueKey(v)] === "string").length;
    const checkId = `check:${key}`;
    const check = plan.questions.find((q) => q.id === checkId);
    const closedList = fd.ref?.mode === "must_exist" || fd.type === "enum";
    const label = fd.header ?? fd.name.replace(/_/g, " ");
    const free = (f: (typeof fd)) => f.name !== key && !plan.fields.some((x) => x.target === f.name);
    // Other Distru lists the values actually match come first (e.g. "Producer" holding brand names).
    const matching = Object.values(target.fields)
      .filter((f) => f.ref?.mode === "must_exist" && free(f))
      .map((f) => {
        const known = new Set((deps.refs[f.name] ?? []).map((x) => x.toLowerCase()));
        return { f, n: [...values].filter((v) => known.has(v.toLowerCase())).length };
      })
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((x) => x.f);
    // A column named exactly like the Distru field (or one the user picked) is that field. When its values fit
    // no other Distru list, they're names Distru doesn't have yet, not a sign of the wrong field.
    const sure = m.method === "user" || normalizeHeader(m.sources[0]) === normalizeHeader(label);
    const newNames = fd.ref?.mode === "must_exist" && sure && matching.length === 0;
    // A "keep" answer only lives on the question; carry it forward or the next rebuild asks again.
    if (own && check?.answer === "keep") questions.push(check);
    if (own && closedList && allowed.length && values.size >= 2 && hits === 0 && check?.answer !== "keep" && !newNames) {
      // Free text a closed list rejected is often a name or description ("Prod Title" mapped to product type).
      const textual = fd.type === "enum" ? Object.values(target.fields).filter((f) => f.type === "string" && free(f) && f.name !== target.idField && f.pattern !== "upc" && f.name !== target.uniqueKey) : [];
      const alternatives = [...matching, ...textual, ...Object.values(target.fields).filter((f) => f.ref?.mode === "auto_create" && free(f))];
      if (!m.rationale.includes("none of its values")) m.rationale += `; none of its values are a ${label} in Distru`;
      m.score = Math.min(m.score, 0.4);
      questions.push({
        id: checkId, kind: "map_column", blocking: true, ref: { field: key, source: m.sources[0] },
        prompt: `None of the values in "${m.sources[0]}" (${[...values].slice(0, 3).join(", ")}) are a ${label} in Distru. Is "${m.sources[0]}" really ${label}?`,
        options: [{ id: "keep", label: `Yes, keep ${label}` }, ...alternatives.map((f) => ({ id: f.name, label: f.header ?? f.name })), { id: "ignore", label: "Ignore column" }],
        suggested: matching[0]?.name,
        answer: check?.answer,
        values: [...values].slice(0, 5),
      });
      // A Distru list (vendors, brands): the missing-names choice is asked alongside, so the user sees both at once
      // and one Accept settles both. Answering it keeps the field (applyPatch). Enums have nothing more to ask.
      if (fd.ref?.mode !== "must_exist") continue;
    }

    // Names a must-exist list doesn't have: one required decision for the column (add them in Distru and
    // re-check, match each to an existing one, or leave them blank), never a silent blank.
    const missing = [...values].filter((v) => map[valueKey(v)] === null);
    const missId = `missing:${key}`;
    const prevMiss = plan.questions.find((q) => q.id === missId);
    if (own && fd.ref?.mode === "must_exist" && missing.length) {
      const one = label.replace(/ name$/i, "").toLowerCase().replace(/s$/, "");
      const noun = missing.length === 1 ? one : `${one}s`;
      questions.push({
        id: missId, kind: "map_value", blocking: true, ref: { field: key, source: m.sources[0] },
        prompt: `${missing.length} ${noun} in "${m.sources[0]}" ${missing.length === 1 ? "isn't" : "aren't"} in your Distru account yet. What should happen to ${missing.length === 1 ? "it" : "them"}?`,
        options: [
          { id: "add", label: "I'll add them in Distru, then re-check" },
          { id: "match", label: `Match to existing ${one}s` },
          { id: "blank", label: `Leave ${one} blank` },
        ],
        suggested: "match",
        values: missing,
        answer: prevMiss?.answer,
        ...(prevMiss?.answer === "add" ? { waiting: true } : {}),
      });
      // Adding or blanking covers every value; per-value picks only matter when matching.
      if (prevMiss?.answer === "add" || prevMiss?.answer === "blank") continue;
    }
    for (const v of values) {
      const k = valueKey(v);
      const id = `value:${key}:${k}`;
      const prior = plan.questions.find((q) => q.id === id);
      if (map[k] !== null && !prior) continue;
      questions.push({
        id, kind: "map_value", blocking: false, ref: { field: key, value: k }, values: [v],
        prompt: `"${v}" is not a ${fd.header ?? fd.name.replace(/_/g, " ")} in Distru. Map it to:`,
        options: [...nearest(v, allowed, 4).map((a) => ({ id: a, label: a })), { id: BLANK, label: fd.required ? "Mark row invalid" : "Leave blank" }],
        // Suggest a value only when it's genuinely close; "accept all" must never swap in a different company.
        suggested: (() => {
          const best = nearest(v, allowed, 1)[0];
          const a = normValue(v), b = best ? normValue(best) : "";
          return best && levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.2)) ? best : BLANK;
        })(),
        answer: prior?.answer,
      });
    }
  }

  // 6. Unresolved columns.
  const used = new Set(plan.fields.flatMap((m) => m.sources));
  const open = Object.values(target.fields).filter((f) => !mapped.has(f.name));
  const fieldLabel = (f: FieldDef) => (f.invert ? null : f.header) ?? f.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const rankFor = (source: string) => {
    const sig = colBy.get(source)?.typeSig ?? "text";
    const numeric = ["integer", "number", "money"].includes(sig);
    const fits = (f: FieldDef) => (numeric ? ["money", "number", "integer"].includes(f.type) || f.pattern === "quantity" || f.pattern === "potency" : !["money", "number", "integer"].includes(f.type));
    const byName = new Map(nearest(source, open.map(fieldLabel), open.length).map((l, i) => [l, i]));
    return [...open].sort((a, b) => Number(fits(b)) - Number(fits(a)) || (byName.get(fieldLabel(a)) ?? 99) - (byName.get(fieldLabel(b)) ?? 99));
  };

  // 5b. Suggestions (Jev mid band): mapped, but the user confirms them.
  for (const m of plan.fields) {
    if (!m.needsConfirm) continue;
    if (questions.some((q) => q.id === `check:${m.target}`)) continue; // the value check already asks about this column
    const src = m.sources[0];
    const fd = target.fields[m.target];
    const id = `confirm:${src}`;
    questions.push({
      id, kind: "map_column", blocking: false, ref: { source: src, field: m.target },
      prompt: `"${src}" looks like ${fieldLabel(fd)} (${Math.round(m.score * 100)}% from Jev). Is that right?`,
      options: [{ id: "yes", label: `Yes, ${fieldLabel(fd)}` }, ...rankFor(src).slice(0, 3).map((f) => ({ id: f.name, label: fieldLabel(f) })), { id: "ignore", label: "Ignore" }],
      suggested: "yes",
      guess: { method: m.method, score: m.score },
      answer: plan.questions.find((q) => q.id === id)?.answer,
    });
  }

  for (const ig of plan.ignoredColumns) {
    if (!ig.reason.startsWith("Not matched") || used.has(ig.source)) continue;
    const id = `column:${ig.source}`;
    // A model's best guess goes first and is pre-selected (with its confidence); then fields the values could
    // fill (numbers -> prices, weights, counts), then by name.
    const g = ig.guess;
    const who = g ? `${g.method === "jev" ? "Jev" : "LLM"} ${Math.round(g.score * 100)}%` : "";
    const guessField = g?.target ? open.find((f) => f.name === g.target) : undefined;
    const ranked = rankFor(ig.source).filter((f) => f !== guessField);
    const options = [
      ...(guessField ? [{ id: guessField.name, label: `${fieldLabel(guessField)} (${who})` }] : []),
      ...ranked.slice(0, guessField ? 4 : 5).map((f) => ({ id: f.name, label: fieldLabel(f) })),
      { id: "ignore", label: g && g.target === null ? `Ignore (${who}: not a field)` : "Ignore" },
    ];
    questions.push({
      id, kind: "map_column", blocking: false, ref: { source: ig.source },
      prompt: `What is "${ig.source}"?`,
      options,
      suggested: guessField ? guessField.name : "ignore",
      ...(g && (guessField || g.target === null) ? { guess: { method: g.method, score: g.score } } : {}),
      answer: plan.questions.find((q) => q.id === id)?.answer,
    });
  }

  // Columns still waiting for a model answer: no question yet, they show as "matching".
  const decided = new Set([...plan.fields.flatMap((m) => m.sources), ...plan.ignoredColumns.map((i) => i.source)]);
  const pendingColumns = (plan.pending?.columns ?? []).filter((c) => !decided.has(c));
  if (pendingColumns.length || pendingFields.size) plan.pending = { columns: pendingColumns, fields: [...pendingFields] };
  else delete plan.pending;

  // 7. Not a product list (§9b). Not while columns are still being matched: the name may be one of them.
  if (!pendingColumns.length && (!mappingFor(plan, target.nameField) || plan.fields.filter((m) => !derivedFrom(m)).length < 2)) {
    questions.push({
      id: "not_a_catalog", kind: "not_a_catalog", blocking: true,
      prompt: "This doesn't look like a product list. Which column is the product name?",
      options: [...plan.headers.map((h) => ({ id: `col:${h}`, label: h })), { id: "cancel", label: "Cancel import" }],
    });
  }

  // Keep sheet/header questions added at parse time.
  for (const q of plan.questions) if ((q.kind === "choose_sheet" || q.kind === "choose_header_row") && !questions.some((x) => x.id === q.id)) questions.push(q);
  plan.questions = questions;
  return plan;
}

function upsertDerived(plan: MappingPlan, m: FieldMapping) {
  const i = plan.fields.findIndex((x) => x.target === m.target);
  if (i >= 0) plan.fields[i] = m; else plan.fields.push(m);
}

export function upsertDefault(plan: MappingPlan, target: string, value: Json, reason: string, keepUser = false) {
  const i = plan.defaultsApplied.findIndex((d) => d.target === target);
  if (i >= 0) { if (!keepUser) plan.defaultsApplied[i] = { target, value, reason }; return; }
  plan.defaultsApplied.push({ target, value, reason });
}

function setAssumeUnit(plan: MappingPlan, source: string, unit: string) {
  for (const m of plan.fields) {
    if (!m.sources.includes(source)) continue;
    m.transforms = m.transforms.map((t) => (t.op === "parse_quantity" ? { ...t, assumeUnit: unit } : t));
  }
}

export function nearest(v: string, options: string[], n: number): string[] {
  const nv = normValue(v);
  return [...options]
    .map((o) => ({ o, s: jaroWinkler(nv, normValue(o)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.o);
}

/** Apply a structured patch (from the UI, the agent, or an answered question). Pure. */
export function applyPatch(prev: MappingPlan, patch: PlanPatch, target: TargetSchema, columns: ColumnProfile[]): { plan: MappingPlan; changed: string[] } {
  const plan: MappingPlan = structuredClone(prev);
  const changed: string[] = [];
  const colBy = new Map(columns.map((c) => [c.source, c]));
  const unmapSource = (src: string) => {
    plan.fields = plan.fields.filter((m) => !(m.sources.length === 1 && m.sources[0] === src));
    // The user decided this column; a model answer arriving later must not overwrite it.
    if (plan.pending) plan.pending.columns = plan.pending.columns.filter((c) => c !== src);
  };
  const setField = (targetName: string, sources: string[], transforms?: Transform[]) => {
    const fd = target.fields[targetName];
    if (!fd) throw new Error(`Unknown field "${targetName}"`);
    for (const s of sources) if (!plan.headers.includes(s)) throw new Error(`Unknown column "${s}"`);
    for (const s of sources) unmapSource(s);
    plan.fields = plan.fields.filter((m) => m.target !== targetName && m.rationale !== `derived:${targetName}`);
    plan.ignoredColumns = plan.ignoredColumns.filter((i) => !sources.includes(i.source));
    if (sources.length) {
      plan.fields.push({
        target: targetName, sources,
        transforms: transforms ?? (sources.length > 1 ? [{ op: "concat", sep: " " } as Transform, ...defaultTransforms(fd, colBy.get(sources[0]))] : defaultTransforms(fd, colBy.get(sources[0]))),
        score: 1, method: "user", rationale: "Set by user",
      });
    }
    changed.push(targetName);
  };

  for (const f of patch.fields ?? []) setField(f.target, f.sources, f.transforms);
  for (const src of patch.ignore ?? []) {
    unmapSource(src);
    plan.ignoredColumns = plan.ignoredColumns.filter((i) => i.source !== src);
    plan.ignoredColumns.push({ source: src, reason: "Ignored by user" });
    changed.push(src);
  }
  for (const [field, entries] of Object.entries(patch.valueMaps ?? {})) {
    const map = (plan.valueMaps[field] ??= {});
    for (const [k, v] of Object.entries(entries)) map[valueKey(k)] = v;
    changed.push(field);
  }
  for (const [field, value] of Object.entries(patch.defaults ?? {})) {
    upsertDefault(plan, field, value, "Set by user");
    changed.push(field);
  }
  for (const [src, unit] of Object.entries(patch.assumeUnit ?? {})) {
    if (!UNITS.includes(unit)) throw new Error(`Unknown unit "${unit}"`);
    if (!plan.fields.some((m) => m.sources.includes(src) && m.transforms.some((t) => t.op === "parse_quantity"))) throw new Error(`"${src}" isn't mapped as a size column`);
    setAssumeUnit(plan, src, unit);
    changed.push(src);
  }
  for (const field of patch.recheck ?? []) {
    // Forget values that found no match so they're matched again against the fresh list. Blanks the user
    // chose on purpose stay.
    const map = plan.valueMaps[field] ?? {};
    const chose = (k: string) => plan.questions.some((q) => q.id === `value:${field}:${k}` && q.answer !== undefined);
    for (const [k, v] of Object.entries(map)) if (v === null && !chose(k)) delete map[k];
    changed.push(field);
  }
  if (patch.clearBlanks !== undefined) plan.clearBlanks = patch.clearBlanks;
  if (patch.existingAction) plan.existingAction = patch.existingAction;

  for (const [qid, answer] of Object.entries(patch.answers ?? {})) {
    const q = plan.questions.find((x) => x.id === qid);
    if (!q) throw new Error(`Unknown question "${qid}"`);
    q.answer = answer;
    const [kind, a, ...rest] = qid.split(":");
    const b = rest.join(":");
    if (kind === "slang") {
      if (answer !== BLANK && parseQuantity(answer)?.kind !== "explicit") throw new Error(`"${answer}" is not a size with a unit`);
      (plan.valueMaps[`__slang:${a}`] ??= {})[b] = answer === BLANK ? null : answer;
    } else if (kind === "unit") {
      setAssumeUnit(plan, [a, b].filter(Boolean).join(":"), answer);
    } else if (kind === "value") {
      (plan.valueMaps[a] ??= {})[b] = answer === BLANK ? null : (answer as ValueMapEntry);
    } else if (kind === "confirm") {
      const src = [a, b].filter(Boolean).join(":");
      const m = plan.fields.find((x) => x.sources.length === 1 && x.sources[0] === src && !x.rationale.startsWith("derived:"));
      if (answer === "yes") { if (m) { m.needsConfirm = false; m.rationale = m.rationale.replace(", needs your confirm", ", confirmed by you"); } }
      else if (answer === "ignore") {
        if (m) unmapSource(src);
        plan.ignoredColumns.push({ source: src, reason: "Ignored by user" });
      } else setField(answer, [src]);
    } else if (kind === "potunit") {
      if (answer !== "PERCENT" && answer !== "MG") throw new Error(`Use PERCENT or MG for "${b ? `${a}:${b}` : a}"`);
      const src = [a, b].filter(Boolean).join(":");
      for (const m of plan.fields) {
        if (!m.sources.includes(src)) continue;
        m.transforms = m.transforms.map((t) => (t.op === "parse_potency" ? { ...t, assumeUnit: answer } : t));
      }
    } else if (kind === "missing") {
      if (!["add", "match", "blank"].includes(answer)) throw new Error(`Use add, match or blank for "${qid}"`);
    } else if (kind === "check") {
      const src = plan.fields.find((m) => m.target === a && !m.rationale.startsWith("derived:"))?.sources[0];
      if (src && answer === "ignore") {
        plan.fields = plan.fields.filter((m) => !m.sources.includes(src));
        plan.ignoredColumns.push({ source: src, reason: "Ignored by user" });
      } else if (src && answer !== "keep") setField(answer, [src]);
    } else if (kind === "column") {
      const src = [a, b].filter(Boolean).join(":");
      if (answer === "ignore") { plan.ignoredColumns = plan.ignoredColumns.map((i) => (i.source === src ? { ...i, reason: "Ignored by user" } : i)); }
      else setField(answer, [src]);
    } else if (qid === "not_a_catalog" && answer.startsWith("col:")) {
      setField(target.nameField, [answer.slice(4)]);
    }
    changed.push(qid);
  }
  // Deciding what to do with a list's missing names (or matching one of them) means the column is that field: an
  // open "is this really Vendor?" question is answered "keep" with it.
  for (const qid of Object.keys(patch.answers ?? {})) {
    const [kind, field] = qid.split(":");
    if (kind !== "missing" && kind !== "value") continue;
    const check = plan.questions.find((q) => q.id === `check:${field}`);
    if (check && check.answer === undefined && !(check.id in (patch.answers ?? {}))) check.answer = "keep";
  }
  return { plan, changed };
}

export function openBlocking(plan: MappingPlan): Question[] {
  return plan.questions.filter((q) => q.blocking && (q.answer === undefined || q.answer === null || q.waiting));
}

export function overallConfidence(plan: MappingPlan): number {
  const own = plan.fields.filter((m) => !m.rationale.startsWith("derived:"));
  if (!own.length) return 0;
  const mean = own.reduce((s, m) => s + m.score, 0) / own.length;
  return Math.round(mean * openPenalty(plan) * 100) / 100;
}

function openPenalty(plan: MappingPlan) {
  const open = plan.questions.filter((q) => q.answer === undefined || q.waiting).length;
  return Math.max(0.5, 1 - open * 0.05);
}

export { normalizeHeader };
