import type { ImporterConfig } from "./config.ts";
import type { ImportRecord, Repos, RowPatch, RowRecord, TargetProfile } from "./ports.ts";
import type { RowAction } from "./types.ts";
import { validateRow } from "./validate.ts";
import { defaultAction, indexCatalog, markInFileDuplicates, matchCatalog, normSku } from "./duplicates.ts";
import { needsFollowup } from "./template.ts";
import { normValue } from "./normalize.ts";

/** Transform, validate and classify rows against the snapshot. Shared by csv.prepare and editRows. */
export async function prepareRows(r: Repos, imp: ImportRecord, profile: TargetProfile, rows: RowRecord[], config: ImporterConfig): Promise<RowPatch[]> {
  const plan = imp.plan!;
  const target = profile.target;
  const validated = rows.map((row) => ({ row, v: validateRow(row.raw, row.overrides, plan, profile, row.meta, imp.refs ?? {}) }));

  const ids = new Set<string>(), skus = new Set<string>(), names = new Set<string>();
  for (const { v } of validated) {
    if (target.idField && v.output[target.idField]) ids.add(String(v.output[target.idField]).trim());
    const s = normSku(v.output[target.uniqueKey]);
    if (s) skus.add(s);
    else if (v.output[target.nameField]) names.add(normValue(String(v.output[target.nameField])));
  }
  const catalog = indexCatalog(await r.snapshotLookup({ ids: [...ids], skus: [...skus], names: [...names] }));
  const history = await r.historyForSkus(imp.id, [...skus]);
  const mapped = new Set(plan.fields.map((m) => m.target));

  return validated.map(({ row, v }) => {
    const m = matchCatalog(target, v.output, catalog, mapped);
    const sku = normSku(v.output[target.uniqueKey]);
    const userAction = row.meta.userAction;
    const action: RowAction = userAction && v.valid ? userAction : defaultAction(m.dupClass, v.valid, plan.existingAction);
    return {
      rowIndex: row.rowIndex,
      output: v.output,
      issues: [...v.issues, ...m.issues],
      sku,
      distruId: m.distruId,
      dupClass: m.dupClass,
      action,
      status: v.valid ? "valid" : "invalid",
      followup: needsFollowup(target, v.output, action, config.sink.uploadSupportsUpdate, m.diff.filter((d) => !d.blocked).map((d) => d.field)),
      // null clears a key on merge (the store merges meta).
      meta: {
        diff: m.diff,
        blankWithValue: m.blankWithValue,
        history: (sku && history.get(sku)) || null,
        possibleDuplicate: m.possibleDuplicate ?? null,
        firstRowIndex: null,
      } as unknown as RowRecord["meta"],
    };
  });
}

/** Whole-file pass after all prepare chunks: first row wins for repeated SKUs / Distru IDs. */
export async function markFileDuplicates(r: Repos, importId: string): Promise<number> {
  const keys = (await r.rowKeys(importId)).filter((k) => k.status !== "invalid");
  const dups = markInFileDuplicates(keys);
  const patches: RowPatch[] = [...dups].map(([rowIndex, first]) => ({
    rowIndex, dupClass: "dup_in_file", action: "skip", followup: false, meta: { firstRowIndex: first },
  }));
  if (patches.length) await r.updateRows(importId, patches);
  return patches.length;
}
