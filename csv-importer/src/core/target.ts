import type { FieldDef, FieldType, Json, SkuWarning, TargetSchema, ValuePattern } from "./types.ts";

class FieldBuilder {
  def: Omit<FieldDef, "name">;
  constructor(type: FieldType) {
    this.def = { type, src: "H", synonyms: [] };
  }
  header(h: string) { this.def.header = h; return this; }
  src(s: FieldDef["src"]) { this.def.src = s; return this; }
  required() { this.def.required = true; return this; }
  default(v: Json) { this.def.default = v; return this; }
  synonyms(s: string[]) { this.def.synonyms = s; return this; }
  invertedSynonyms(s: string[]) { this.def.invertedSynonyms = s; return this; }
  max(n: number) { this.def.max = n; return this; }
  warnIf(w: SkuWarning[]) { this.def.warnIf = w; return this; }
  invert() { this.def.invert = true; return this; }
  values(v: string[]) { this.def.enumValues = v; return this; }
  ref(kind: string, mode: "auto_create" | "must_exist") { this.def.ref = { kind, mode }; return this; }
  group(g: string) { this.def.group = g; return this; }
  pattern(p: ValuePattern) { this.def.pattern = p; return this; }
  unitField(f: string) { this.def.unitField = f; return this; }
  servingField(f: string) { this.def.servingField = f; return this; }
  extractFrom(f: string) { this.def.extractFrom = f; return this; }
}

export const f = {
  string: () => new FieldBuilder("string"),
  number: () => new FieldBuilder("number"),
  integer: () => new FieldBuilder("integer"),
  money: () => new FieldBuilder("money").pattern("money"),
  bool: () => new FieldBuilder("bool").pattern("bool"),
  enum: (values: string[]) => new FieldBuilder("enum").values(values),
  ref: (kind: string, mode: "auto_create" | "must_exist") => new FieldBuilder("ref").ref(kind, mode),
  refList: (kind: string, mode: "auto_create" | "must_exist") => new FieldBuilder("ref_list").ref(kind, mode),
  currency: () => new FieldBuilder("currency").pattern("currency"),
};

export function defineTarget(input: Omit<TargetSchema, "fields"> & { fields: Record<string, FieldBuilder> }): TargetSchema {
  const fields: Record<string, FieldDef> = {};
  for (const [name, b] of Object.entries(input.fields)) fields[name] = { name, ...b.def };
  for (const h of input.templateHeaders) {
    if (!Object.values(fields).some((fd) => fd.header === h)) throw new Error(`templateHeader "${h}" has no field`);
  }
  return { ...input, fields };
}

/** Field groups: every field in a group is uploaded together or sent via follow-up together. */
export function groupsOf(target: TargetSchema): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const fd of Object.values(target.fields)) if (fd.group) (out[fd.group] ??= []).push(fd.name);
  return out;
}

/**
 * A field goes in the upload template only if its header is a template header AND every field in its
 * group is too (groups are atomic). Everything else with a value is applied via follow-up.
 */
export function templateFields(target: TargetSchema): Set<string> {
  const groups = groupsOf(target);
  const inTemplate = (fd: FieldDef) => !!fd.header && fd.src === "H" && target.templateHeaders.includes(fd.header);
  const out = new Set<string>();
  for (const fd of Object.values(target.fields)) {
    if (!inTemplate(fd)) continue;
    if (fd.group && !groups[fd.group].every((n) => inTemplate(target.fields[n]))) continue;
    out.add(fd.name);
  }
  return out;
}

/** Fields that are written through the follow-up path (M-only fields and whole groups containing one). */
export function followupFields(target: TargetSchema): Set<string> {
  const tpl = templateFields(target);
  const out = new Set<string>();
  for (const fd of Object.values(target.fields)) {
    if (fd.src === "importer" || tpl.has(fd.name) || fd.name === target.idField) continue;
    out.add(fd.name);
  }
  return out;
}
