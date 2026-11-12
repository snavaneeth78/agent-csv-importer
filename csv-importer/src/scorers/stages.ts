import {
  addUsage, type ModelUsage, closeSpelling, jaroWinkler, nearest, normValue, normalizeHeader, sigCompatible, tokenSet, toUnit, tokens, valueKey,
  type Candidate, type ChoiceScorer, type ColumnProfile, type FieldDef, type LlmMatcher, type MatchStage,
  type ImporterConfig, type TypeSig, type ValueStage,
} from "../core/index.ts";
import { gateway } from "./gateway.ts";

const names = (f: FieldDef) => [f.name.replace(/_/g, " "), f.header ?? "", ...f.synonyms, ...(f.invertedSynonyms ?? [])].filter(Boolean).map(normalizeHeader);

/** Can a column with this value signature feed this field? */
export function typeCompatible(f: FieldDef, sig: TypeSig): boolean {
  if (sig === "empty") return true;
  if (f.pattern === "quantity") return ["quantity", "number", "integer", "text"].includes(sig);
  if (f.pattern === "potency") return ["percent", "number", "integer", "text"].includes(sig);
  if (f.pattern === "upc") return ["upc", "integer", "number", "text"].includes(sig);
  switch (f.type) {
    case "money": return ["money", "number", "integer"].includes(sig);
    case "number": return ["number", "integer", "quantity", "percent"].includes(sig);
    case "integer": return ["integer", "number"].includes(sig);
    case "bool": return ["bool", "text", "integer"].includes(sig);
    case "currency": return ["currency", "text"].includes(sig);
    case "string": return true;
    case "enum": return ["text", "bool"].includes(sig);
    default: return ["text", "bool", "integer", "quantity", "currency"].includes(sig);
  }
}

/** Stage 0: every header is a known template header. */
export function templateStage(): MatchStage {
  return {
    method: "template",
    threshold: 1,
    async run({ columns, fields, target }) {
      const byHeader = new Map(fields.filter((f) => f.header && target.templateHeaders.includes(f.header)).map((f) => [normalizeHeader(f.header!), f]));
      if (!columns.every((c) => byHeader.has(c.headerNorm))) return { candidates: [] };
      return {
        final: true,
        candidates: columns.map((c) => ({ source: c.source, target: byHeader.get(c.headerNorm)!.name, score: 1, rationale: "Distru template header" })),
      };
    },
  };
}

/** Stage 1: tenant column memory, with a value-type check. */
export function memoryStage(config: ImporterConfig): MatchStage {
  return {
    method: "memory",
    threshold: config.matching.thresholds.memory,
    async run({ columns, fields, memory }) {
      const open = new Set(fields.map((f) => f.name));
      const out: Candidate[] = [];
      for (const c of columns) {
        const m = memory.find((x) => x.headerNorm === c.headerNorm);
        if (!m || !open.has(m.targetField)) continue;
        // Same kind of values as last time, and values that can fill the field at all.
        if (!sigCompatible(m.typeSig, c.typeSig)) continue;
        const fd = fields.find((f) => f.name === m.targetField);
        if (!fd || !typeCompatible(fd, c.typeSig)) continue;
        out.push({ source: c.source, target: m.targetField, score: 0.95, transforms: m.transforms, rationale: `Confirmed on an earlier import (${m.hits}x)` });
      }
      return { candidates: out };
    },
  };
}

/**
 * Stage 2: exact / normalized name or synonym. No type gate: an exact header is the strongest signal, and dirty
 * values (text in a price column) become row errors at Gate 2 instead of pushing the column to a guessing stage.
 */
export function exactStage(): MatchStage {
  return {
    method: "exact",
    threshold: 1,
    async run({ columns, fields }) {
      const out: Candidate[] = [];
      for (const c of columns) {
        const f = fields.find((x) => names(x).includes(c.headerNorm));
        if (f) out.push({ source: c.source, target: f.name, score: 1, rationale: `Header "${c.source}" is a name for ${f.header ?? f.name}` });
      }
      return { candidates: out };
    },
  };
}

function signalFor(c: ColumnProfile): FieldDef["pattern"] | undefined {
  const s = c.signals;
  const T = 0.95;
  if (s.upc >= T) return "upc";
  if (s.percent >= T || s.mg >= T) return "potency";
  if (s.quantity + s.slang >= T && s.quantity > 0) return "quantity";
  if (s.bare >= T && c.unitHint) return "quantity";
  if (s.currencySymbol >= T) return "money";
  if (s.currency >= T) return "currency";
  if (s.bool >= T && s.integer < T) return "bool";
  return undefined;
}

/** Stage 3: value patterns (regex, inferred type, unit parser) on >= 95% of non-blank values. */
export function patternStage(config: ImporterConfig): MatchStage {
  return {
    method: "pattern",
    threshold: config.matching.thresholds.pattern,
    async run({ columns, fields }) {
      const out: Candidate[] = [];
      for (const c of columns) {
        const sig = signalFor(c);
        if (!sig) continue;
        let cands = fields.filter((f) => f.pattern === sig);
        if (cands.length > 1) {
          const hdr = new Set(tokens(c.source));
          const hinted = cands.filter((f) => names(f).some((n) => n.split(" ").some((t) => hdr.has(t))));
          cands = hinted.length ? hinted : cands;
        }
        if (cands.length > 1 && sig === "potency" && !tokens(c.source).includes("cbd")) {
          const thc = cands.find((f) => f.name === "total_thc");
          if (thc) {
            out.push({ source: c.source, target: thc.name, score: 0.86, rationale: `Values are potency (${c.samples.slice(0, 2).join(", ")}); THC unless the header says CBD` });
            continue;
          }
        }
        if (cands.length !== 1) continue;
        out.push({ source: c.source, target: cands[0].name, score: 0.9, rationale: `Values look like ${sig} (${c.samples.slice(0, 2).join(", ")})` });
      }
      return { candidates: out };
    },
  };
}

/** Stage 4: typo-level header similarity (Jaro-Winkler + edit budget) or reordered words, gated by type. */
export function fuzzyStage(config: ImporterConfig): MatchStage {
  return {
    method: "fuzzy",
    threshold: config.matching.thresholds.fuzzy,
    async run({ columns, fields }) {
      const out: Candidate[] = [];
      for (const c of columns) {
        let best: Candidate | null = null;
        for (const f of fields) {
          if (!typeCompatible(f, c.typeSig)) continue;
          for (const n of names(f)) {
            const reordered = tokenSet(c.headerNorm, n) === 1 ? 0.95 : 0;
            const s = Math.max(closeSpelling(c.headerNorm, n, config.matching.fuzzyMin), reordered);
            if (s >= config.matching.fuzzyMin && (!best || s > best.score)) best = { source: c.source, target: f.name, score: s, rationale: reordered ? `"${c.source}" has the same words as "${n}"` : `"${c.source}" is a close spelling of "${n}"` };
          }
        }
        if (best) out.push(best);
      }
      return { candidates: out };
    },
  };
}

/** What kind of values a field holds, so Jev/LLM can tell options apart (TypeSafe: distinct, one-line criteria). */
export function describeField(f: FieldDef): string {
  const kind =
    f.pattern === "quantity" ? "net weight or volume of one unit, e.g. 3.5, 7g, 1/8 oz"
    : f.pattern === "potency" ? "cannabinoid potency, e.g. 22% or 100mg"
    : f.pattern === "upc" ? "barcode, 8-14 digits"
    : f.type === "money" ? "a price or cost in dollars, e.g. 45, $12.50"
    : f.type === "integer" ? "a whole-number count"
    : f.type === "number" ? "a number"
    : f.type === "bool" ? "yes/no flag"
    : f.type === "enum" ? `one of: ${(f.enumValues ?? []).slice(0, 12).join(", ")}`
    : f.ref?.mode === "must_exist" ? "the name of an existing record in Distru"
    : f.ref ? "a short label shared by many products"
    : "free text";
  return [kind, f.synonyms.length ? `also called ${f.synonyms.slice(0, 6).join(", ")}` : ""].filter(Boolean).join("; ");
}

const fieldOption = (f: FieldDef) => ({ id: f.name, label: f.header ?? f.name.replace(/_/g, " "), hint: describeField(f) });

/** Stage 5: Jev picks from unclaimed fields + none for each unresolved column. */
export function jevStage(jev: ChoiceScorer, config: ImporterConfig): MatchStage {
  return {
    method: "jev",
    model: jev.modelId,
    threshold: config.matching.thresholds.jev,
    async run({ columns, fields }) {
      let error: string | undefined;
      let usage: ModelUsage | undefined;
      const probs = await gateway("jev", config.scorers.timeoutMs.jev, () =>
        jev.choose(columns.map((c) => ({
          id: c.source,
          state: { header: c.source, samples: c.samples, valueType: c.typeSig },
          options: [...fields.map(fieldOption), { id: "none", label: "Not a product field" }],
        })), { onUsage: (u) => (usage = addUsage(usage, u)) }),
      ).catch((e) => { error = redact(e); return null; });
      if (!probs) return { candidates: [], error, usage };
      const out: Candidate[] = [];
      for (const c of columns) {
        const p = probs[c.source];
        if (!p) continue;
        const [top, score] = Object.entries(p).sort((a, b) => b[1] - a[1])[0] ?? [];
        if (!top) continue;
        // >= jev threshold: accept. jevSuggest..jev on a real field: a suggestion to confirm (skips the LLM).
        // Below that, or "none" on top: left for the LLM.
        const suggest = top !== "none" && score < config.matching.thresholds.jev && score >= config.matching.thresholds.jevSuggest;
        out.push({
          source: c.source, target: top === "none" ? null : top, score, suggest,
          rationale: top === "none" ? "Jev: not a product field" : suggest ? `Suggested by Jev (${Math.round(score * 100)}%), needs your confirm` : `Jev picked ${top} (p=${score.toFixed(2)})`,
        });
      }
      return { candidates: out, usage };
    },
  };
}

/** Error text for the run log: no keys, short. */
export function redact(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\b(sk|pk|tsk|ts)[-_][A-Za-z0-9_*-]{6,}/g, "[key]").replace(/\b(Bearer\s+|(?:api[-_ ]?)?key\s*(?:provided)?[=:]\s*)\S+/gi, "$1[key]").split("\n")[0].slice(0, 200);
}

/** Stage 6: the LLM sees only what is still unresolved (headers + samples). */
export function llmStage(llm: LlmMatcher, config: ImporterConfig): MatchStage {
  return {
    method: "llm",
    model: llm.modelId,
    threshold: config.matching.thresholds.llm,
    async run({ columns, fields }) {
      let error: string | undefined;
      let usage: ModelUsage | undefined;
      const res = await gateway("llm", config.scorers.timeoutMs.llm, () =>
        llm.mapColumns({
          columns: columns.map((c) => ({ source: c.source, samples: c.samples.slice(0, 5), typeSig: c.typeSig })),
          fields: fields.map((f) => ({ name: f.name, label: f.header ?? f.name, type: describeField(f), synonyms: f.synonyms })),
        }, { onUsage: (u) => (usage = addUsage(usage, u)) }),
      ).catch((e) => { error = redact(e); return null; });
      if (!res) return { candidates: [], error, usage };
      const open = new Set(fields.map((f) => f.name));
      return {
        usage,
        candidates: res
          .filter((r) => columns.some((c) => c.source === r.source) && (r.target === null || open.has(r.target)))
          // An unsure answer is a suggestion the user confirms at Gate 1; an unsure "not a field" drops nothing.
          .map((r) => ({ source: r.source, target: r.target, score: Math.max(0, Math.min(1, r.confidence)), suggest: r.target !== null, rationale: `LLM: ${r.rationale}` })),
      };
    },
  };
}

export function defaultStages(deps: { config: ImporterConfig; jev?: ChoiceScorer; llm?: LlmMatcher }): MatchStage[] {
  const s = [templateStage(), memoryStage(deps.config), exactStage(), patternStage(deps.config), fuzzyStage(deps.config)];
  if (deps.jev) s.push(jevStage(deps.jev, deps.config));
  if (deps.llm) s.push(llmStage(deps.llm, deps.config));
  return s;
}

// ---------------------------------------------------------------- value maps

export function exactValueStage(): ValueStage {
  return {
    method: "exact",
    async run({ values, allowed, aliases }) {
      const byNorm = new Map(allowed.map((a) => [normValue(a), a]));
      const out = [];
      for (const v of values) {
        // Unit fields alias the short unit ("g"); any spelling the size parser knows ("gm", "gr") reaches it too.
        const unit = toUnit(v);
        const alias = aliases[valueKey(v)] ?? aliases[normValue(v)] ?? (unit ? aliases[unit] : undefined);
        const hit = (alias && byNorm.get(normValue(alias))) ?? byNorm.get(normValue(v));
        if (hit) out.push({ value: v, match: hit, score: 1 });
      }
      return out;
    },
  };
}

export function fuzzyValueStage(min = 0.92): ValueStage {
  return {
    method: "fuzzy",
    async run({ values, allowed }) {
      const out = [];
      for (const v of values) {
        const [best] = nearest(v, allowed, 1);
        // Typos only: "Green Leaf Farms" must not become "Green Valley Farms" (Jaro-Winkler 0.93).
        const s = best ? closeSpelling(normValue(v), normValue(best), min) : 0;
        if (best && s > 0) out.push({ value: v, match: best, score: s });
      }
      return out;
    },
  };
}

export function jevValueStage(jev: ChoiceScorer, config: ImporterConfig): ValueStage {
  return {
    method: "jev",
    async run({ field, values, allowed }, opts) {
      if (!allowed.length || !values.length) return [];
      const items = values.map((v) => ({ id: v, state: { field: field.header ?? field.name, value: v }, options: [...nearest(v, allowed, 5).map((a) => ({ id: a, label: a })), { id: "none", label: "None of these" }] }));
      const probs = await gateway("jev", config.scorers.timeoutMs.jev, () => jev.choose(items, opts)).catch(() => null);
      if (!probs) return [];
      const out = [];
      for (const v of values) {
        const [top, p] = Object.entries(probs[v] ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
        if (top && top !== "none" && allowed.includes(top) && p >= config.matching.thresholds.jev) out.push({ value: v, match: top, score: p });
      }
      return out;
    },
  };
}

export function llmValueStage(llm: LlmMatcher, config: ImporterConfig): ValueStage {
  return {
    method: "llm",
    async run({ field, values, allowed }, opts) {
      if (!allowed.length || !values.length) return [];
      const res = await gateway("llm", config.scorers.timeoutMs.llm, () => llm.mapValues({ field: field.header ?? field.name, values, allowed }, opts)).catch(() => null);
      if (!res) return [];
      return values.filter((v) => res[v] && allowed.includes(res[v]!)).map((v) => ({ value: v, match: res[v]!, score: 0.8 }));
    },
  };
}

export function defaultValueStages(deps: { config: ImporterConfig; jev?: ChoiceScorer; llm?: LlmMatcher }): ValueStage[] {
  const s = [exactValueStage(), fuzzyValueStage()];
  if (deps.jev) s.push(jevValueStage(deps.jev, deps.config));
  if (deps.llm) s.push(llmValueStage(deps.llm, deps.config));
  return s;
}
