# Decisions and known limits

Calls the spec left open, made while building, and limits left in on purpose.

## Decisions

- **Layout.** One package, `@distru/csv-importer`, one subpath per module. Stage matchers live in `scorers` and
  pg-boss handlers in `workers`; `core` owns the cascade order, thresholds and conflict rule. The Distru profile is
  its own module (spec §11).
- **Bytes and streams** are staged in `csv_import.import_files` from `start()` until Gate 2 or cancel, so a
  job can re-read them (also for a sheet/header-row change). This is transient, not storage; Distru should
  pass `{ url }`.
- **Row status `uploaded`** is added: created inactive in Distru, waiting for its follow-up mutation.
- **`tenant_id` on every table** (`import_events`, `import_chunks`, `import_files` too), per system design §7.
  `withTenant` runs `SET LOCAL ROLE csv_import_app` + `app.tenant_id`, so RLS applies even when the pool
  connects as the owner. The owner role is the system role (event tail, retention).
- **Two extra transitions:** a sheet or header-row answer at Gate 1 goes `mapping_review -> parsing` and
  re-parses; Retry details goes `completed | partially_completed -> committing`.
- **Questions:** slang, a size column of bare numbers with no unit in its header, "not a product list",
  an unsure sheet/header row, and names missing from a must-exist list (new vendors, brands) are blocking.
  Missing names get one question per column: add them in Distru and re-check, match each to an existing
  one, or leave them blank. A column whose header is the Distru field's own name (`Vendor`) is never asked
  "is this really Vendor?" unless its values belong to another Distru list. Unmatched columns are not
  blocking: unanswered, the column is ignored.
- **Bare sizes:** `Weight (oz)` reads bare numbers as oz and lists that under Defaults applied; otherwise
  the user is asked. `mg` inside product names is treated as potency, never as net weight.
- **Derived defaults** (listed at Gate 1, editable): product type from category/name keywords, unit type
  by product type (flower is Gram, else Each), category from product type when the file has none.
- **Created product ids** are read back with a delta snapshot refresh after each upload (by SKU, by name
  when there is no SKU), because the upload returns only an error CSV.
- **Crash resume:** on a retried commit chunk, a create whose SKU appeared in Distru after the chunk's first
  attempt started is treated as created by that attempt; anything older is a new duplicate and skipped.
- **Unverified Distru ID** is a warning (the row falls back to SKU matching) and is listed in the error CSV.
- **A file in Distru's own template** keeps its empty columns mapped, so "Blank cells clear" can act on them.
- **Column memory** stores only a column's single primary mapping, never derived units or sizes copied
  from names.
- **Upload and MCP contracts** are assumptions (listed in `docs/api-integration.md`), isolated in
  `csv-importer/src/distru/profile.ts`. Jev uses TypeSafe's documented API, directly or through OpenRouter (`JevClient`).
- **LLM output** uses `withStructuredOutput` with `functionCalling` for OpenAI/OpenRouter and `jsonSchema` for
  Anthropic (forced tool choice returns 400 on current Claude models); `LLM_STRUCTURED_METHOD` overrides.
- **Gates and the agent:** an agent passes a gate only by relaying a user message id, and one message passes
  one gate (`ImportService.gateMessage`), so a single "yes" can't confirm the mapping and start the write.
  In the demo chat a confirmation must be the whole message; "yes, but ignore Notes" is treated as an edit.
- **A job that fails for good** marks the rows it never finished (`job_failed`, or `needs_attention` for
  follow-ups), so an import can't end as completed with rows missing.
- **Follow-up rate limit** is per tenant and in-process. With N worker processes, set
  `sink.followupRatePerSecond` to the tenant budget divided by N until it moves to Postgres.
- **Integration tests** use testcontainers, or `TEST_DATABASE_URL` to reuse the compose database.
- **UI** uses plain CSS instead of shadcn/ui to keep the package dependency-free; the components map 1:1.
- **Parsing** reads the whole file in memory (capped at 50 MB) instead of streaming.

## Known limitations

- **Rows to fix are fixed one cell at a time.** Gate 2 lists each problem row with a Fix button per cell.
  With hundreds of rows that share one cause (say 300 rows with no name), that's slow. The better design
  has two parts. First, a bulk action on each problem type ("300 rows have no name: skip them, or fill from
  another column"). Second, a sheet of only the problem rows and error columns, edited inline. Warnings
  already settled at Gate 1 (a vendor left blank) would show once instead of on every row. The backend
  already takes a batch of cell edits and re-checks only those rows. The sheet needs batched saves, since
  every edit bumps the plan version. Rough cost: 3–4 days, or 5–6 with paste from Excel, fill-down and
  undo. Left out for time: the per-cell Fix works, so this is a speed-up, not a missing step.
- **The importer never creates vendors or brands.** In Distru these are company records with more than a
  name, and the assumed MCP contract has no create tool. Instead, the user adds them in Distru and presses
  Re-check, which fetches the list again and re-matches the column. In the demo the mock lists are fixed, so
  Re-check never finds new names there.
- **Match pickers offer the 4 closest existing values**, not the whole list, to keep each picker short. A
  searchable full list is the fix for accounts with many vendors.
