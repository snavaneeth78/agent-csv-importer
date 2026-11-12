# CSV Importer: API integration

Distru owns the API. The library ships SQL migrations and one method per endpoint; Distru adds thin
endpoints (REST below, or GraphQL with the same shapes) in its existing API. Each endpoint:

1. authenticates the user and resolves `tenantId` and `actor` (never from the request body);
2. calls the library method with `{ tenantId, actor }` as the first argument;
3. maps errors: `ConflictError` (stale `planVersion`) to 409, `StateError` to 400 (404 when the message says "not found").

`demo/server/index.ts` is a working reference, mounted under `/api`. It has every endpoint below except `POST /imports` and `GET /imports?threadId=` (the demo starts and lists imports through the agent tools via `/api/chat`), and adds demo-only `/retry`, `/summary` and `/export.json|csv`.

## Setup

```ts
import { createImporter } from "@distru/csv-importer/workers";
import { createDistruProductProfile } from "@distru/csv-importer/distru";

const importer = createImporter({
  pool,                                 // pg.Pool on the shared cluster
  boss,                                 // started PgBoss; Distru owns its lifecycle
  profiles: [createDistruProductProfile({
    uploadUrl: "https://<internal>/upload-products",
    mcp: (ctx, tool, args) => mcpClientFor(ctx).callTool({ name: tool, arguments: args }),
    uploadHeaders: (ctx) => ({ authorization: `Bearer ${mintActorToken(ctx)}` }),
  })],
  scorer: jev,                          // ChoiceScorer (Jev)
  llm,                                  // LlmMatcher, e.g. new LangChainLlm(chatModel)
  config: {},                           // Partial<ImporterConfig>, tech spec §5.1
});
await importer.migrate();               // csv_import schema + pg-boss queues
await importer.work();                  // only in processes with ROLE=worker
```

The database role that runs migrations must be able to `CREATE ROLE`; the library switches to the
`csv_import_app` role inside every transaction so row-level security applies.

## Endpoints

All paths are under `/imports`. Bodies and responses are JSON unless noted.

| Method | Path | Library call | Body | Response |
|---|---|---|---|---|
| POST | `/imports` | `start(ctx, { input, filename, targetId, threadId })` | `{ attachmentId, threadId? }`; Distru resolves the attachment to `{ url }` (preferred) or `{ bytes }` | `{ importId, status, reused }` |
| GET | `/imports/:id` | `get(ctx, id)` | | `ImportView`: status, plan, planVersion, openQuestions, counts, progress, followupEstimate, error |
| GET | `/imports/:id/events?afterId=` | `events(ctx, id, { afterId, limit })` | | `ImportEvent[]` ordered by id |
| GET | `/imports/:id/rows?status=&dupClass=&action=&cursor=&limit=` | `listRows(ctx, id, q)` | | `{ rows, nextCursor }` (comma-separated filters, limit <= 1000) |
| POST | `/imports/:id/revise` | `revise(ctx, id, args)` | `{ planVersion, patch }` or `{ planVersion, instruction }` | `{ planVersion, changed, status, openQuestions, blockingQuestions }` |
| POST | `/imports/:id/edit-rows` | `editRows(ctx, id, args)` | `{ planVersion, edits: [{ rowIndex, field, value }] }` | `{ planVersion, rows }` |
| POST | `/imports/:id/row-actions` | `setRowActions(ctx, id, args)` | `{ planVersion, existingAction?, rowOverrides?, clearBlanks? }` | `{ planVersion }` |
| POST | `/imports/:id/confirm-mapping` | `confirmMapping(ctx, id, args)` | `{ planVersion }` | `{ status, planVersion }` |
| POST | `/imports/:id/confirm-commit` | `confirmCommit(ctx, id, args)` | `{ planVersion }` | `{ status }` |
| POST | `/imports/:id/cancel` | `cancel(ctx, id)` | | `{ status }` |
| POST | `/imports/:id/retry-followups` | `retryFollowups(ctx, id)` | | `{ requeued }` |
| GET | `/imports/:id/errors.csv` | `errorCsv(ctx, id)` | | `text/csv` stream: original columns + `Import Row`, `Import Status`, `Import Errors` |
| GET | `/imports?threadId=` | `openImports(ctx, threadId)` | | open imports, pinned at the top of Copilot |

`PlanPatch` (revise): `answers` (questionId to option id), `fields` (`[{ target, sources, transforms? }]`),
`ignore` (column names), `valueMaps` (`{ field: { rawValue: allowedValue | { create } | null } }`),
`defaults` (`{ field: value }`), `assumeUnit` (`{ column: "g" | "mg" | "oz" | "lb" | "ml" }`), `sheet`, `headerRow`.
A revise at Gate 2 returns the import to Gate 1.

## Gates

Gate endpoints are called by the import card buttons. The agent passes the same gates through
`import_csv_confirm_mapping` / `import_csv_confirm_commit`, which record the confirming message id. Nothing
moves past `mapping_review` or `commit_review` any other way.

## Polling

The card polls `GET /imports/:id/events?afterId=<last id>` every 1 s while work is active and backs off at a
gate, then re-reads `GET /imports/:id` when events arrive. A reload only needs the import id.

## What the library calls on Distru

| Call | Used for | Assumed contract (adjust in `csv-importer/src/distru/profile.ts`) |
|---|---|---|
| `POST /upload-products?mode=create\|update` | creates; updates when `sink.uploadSupportsUpdate` | body `text/csv` in `templateHeaders` order, bools `TRUE`/`FALSE`, `##` clears; response is the error CSV (uploaded columns + `Row` 1-based + `Errors`), empty when all rows were accepted |
| MCP `distru-search-products` | catalog snapshot, delta refresh | `{ status: "ANY", limit, cursor, sortBy? }` to `{ items, nextCursor }` |
| MCP `distru-search-lookups` | category, group, tag, unit type values | `{ type }` to `{ items: [{ name }] }` |
| MCP `distru-search-companies`, `distru-search-users` | vendors, brands, owners | `{ relationship }` / `{}` to `{ items: [{ name }] }` |
| MCP `distru-mutate-product` | follow-up: M-only fields, updates | `{ action: "UPDATE", id, product }` |
