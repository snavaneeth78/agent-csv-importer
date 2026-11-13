# Decisions

The calls behind [system-design.md](system-design.md) and [tech-spec.md](tech-spec.md): what I picked, why, and what
I rejected. Then the finer design rules that came out of review, and the limits left in on purpose.

## Key decisions

| Decision | Why | Rejected |
|---|---|---|
| **The LLM returns a plan; code applies it to every row** | Scales to 10k+ rows at flat model cost, deterministic, reviewable at a gate. Prompt injection can at worst cause a wrong mapping. | LLM transforms the rows: slow, costly, unreviewable |
| **Matching cascade: rules → Jev** | Most columns are solved by names, synonyms and patterns in milliseconds. Jev handles bounded choices with real probabilities in < 1 s. What's left is a Gate 1 question. | LLM for every column: slower, pricier, no calibrated score |
| **LLM matching stage off by default** | No gain in the eval: with real Jev, precision is 94.8% with it off and 92.4% with `gpt-4o-mini` or `gpt-4o` (recall 93.6% either way). It decided 1-2 columns per run and got none right, and `gpt-4o-mini` adds 4-5 s before the review is final (see README, Eval results). Off makes matching effectively instant. The LLM stays for free-text edits. One switch (`disabledStages: []`) turns it back on. | Keep it on (cost and latency for no measured gain); remove it (loses the option once a model beats Jev) |
| **Two required gates: mapping, then import** | A wrong mapping is cheap to fix before rows are built. The import review is where duplicates and diffs show. Bulk writes to an ERP can't be undone. | One gate (mixes "is this right?" with "write it"); auto-approve on high confidence |
| **Harness as a separate Node service** sharing Distru's Postgres | LangGraph.js ecosystem, independent deploy and scaling, a model outage can't take down the ERP. No new datastore. | Inside the Distru API (outage coupling); its own cluster (new ops) |
| **LangGraph `PostgresSaver` + pg-boss** | Checkpoints and `interrupt()` for conversation state; pg-boss for retries, cron, singleton keys. All in Postgres. | Temporal (new infra for an MVP); Redis/BullMQ (new datastore) |
| **Typed workflow templates** | Unattended runs must be repeatable, fixture-tested, and declare their writes before enable. | Free-form agent plans at 2 a.m. |
| **Importer is a library; Distru owns the API, storage and auth** | Drops into Distru's existing GraphQL. One method per endpoint. | A separate importer service with its own API |
| **Sink is the existing `/upload-products`** | Reuses Distru's validation, chunking and error CSV. | Per-row MCP creates (slow, rate-limited) |
| **Catalog snapshot in Postgres for duplicates** | MCP `search-products` has no SKU filter; 10k per-row lookups don't scale. SQL joins are instant. | Per-row MCP search |
| **Create inactive, then finish over MCP** for fields the template may not take | A product is never live and half-finished. Removing the follow-up is a one-line schema change once the real template is confirmed. | Drop those fields; or create active and patch later |
| **Never convert units, never create vendors or brands** | Net weight is a regulated label value. Vendors are company records with more than a name. | Auto-convert; auto-create |
| **Durable event logs read by cursor** for UI updates | A reload or dropped connection just re-reads from the cursor. Boring and restart-proof. | SSE/websockets for everything (state lost on reconnect) |
| **Bulk vs small writes in workflows** | Bulk or irreversible writes gated every run; small reversible ones approved once at enable. Safe without alert fatigue. | Approve every write every run |
| **Review opens before the models answer** (Jev, and the LLM when on, in parallel) | The user starts on the easy columns immediately; the model wait overlaps their reading time. | Sequential cascade with a spinner |

## Design details

Rules that came out of review. They're correct but too fine-grained for the main docs.

### Harness

- **Actor token storage.** Never in `config.configurable` (LangGraph can copy configurable keys into checkpoint
  metadata), any table, job payload, prompt, tool result, log or trace. Background work mints a token for the run's
  owner: the workflow owner, the thread's user for a system-started turn, or the import's `created_by`. A deactivated
  owner fails the run and notifies the tenant's admins.
- **System-started Copilot turns** (e.g. the summary after an import) run as `harness.run` in a worker. They don't
  stream; the message lands in `run_events` and the chat picks it up on its next poll.
- **Tool list cache.** `list_tools` cached per connection for up to 1 h. Dropped on revoke, reconnect, scope change,
  or any unknown-tool error.
- **Effect tags.** A server's own `readOnlyHint` is untrusted; only Distru's curated list can mark an MCP tool `read`.
  Writes the model asks for in one step share one approval card with a checkbox each. The registry rejects a template
  write tagged *small* whose tool is on Distru's bulk list.
- **Check before write, for MCP tools.** Distru's curated list maps each write tool to its read tool and key. The
  harness wrapper runs that lookup and shows current vs new values. A write with no mapping shows *"Can't check for
  duplicates"* and is blocked in workflows. Customer MCP writes in templates are preceded by a lookup node.
- **The event tail is the only cross-tenant job.** It reads `(event id, type, import id)` plus `tenant_id`, never
  payloads, and handles each event inside `withTenant`. The retention cron is the only other `harness_system` job.
  LangGraph and pg-boss tables have no `tenant_id`; they're reached only via ids from `runs`, which has it.
- **Gate timeouts.** Copilot sends no reminder: the user started it on screen, and open imports are pinned at the top
  of Copilot. Workflows remind after 24 h.
- **Webhook triggers** verify a per-workflow signing secret.
- **Retention.** Checkpoints (they hold chat messages) and `tool_results` follow `retention.rowsDays` (90).

### Nightly sheet workflow

- The run stores a hash of the header row. When it changes, the notification says *"Columns changed since the last
  run"*.
- Replacing a parked run: confirmed Gate 1 answers survive in column memory; row edits in the replaced card don't
  (the sheet is the thing to fix). The old card says *"Replaced by a newer run"* and links to the new one.
- `workflow_rows` lives as long as the workflow. The new rows are written as a CSV to Distru storage, so the importer
  can't tell a workflow file from a chat upload.

### Audit and traces

- **`tool_calls` redaction:** secrets → `"[secret]"`; file bytes → `{ attachmentId, sha256, sizeBytes }`; strings
  over 256 chars → `{ sha256, length }`; emails and phones masked (`j***@acme.com`); ids, field names, enums and short
  business values kept, so support can tell what changed.
- **Traces** use an allowlist, so a new attribute is dropped until someone allows it. Never exported: file bytes,
  cells, samples, prompts, completions, tool arguments or results, messages, tokens. LangSmith is dev-only with
  fixture data.

### Importer

- **H/M field sources.** The help article lists labels, not exact header spellings, and leaves out fields the MCP
  has. Sending only H columns means an unconfirmed header can never fail an upload.
- **Follow-up cost.** At the default rate, 10k rows needing follow-up take ~17 min. A batch MCP update tool (cheap,
  per the brief) replaces per-row calls without touching the queue.
- **Snapshot cost.** A gate parked for days costs one resumable reload, not unbounded delta paging.
- **Distru ID** is checked against the tenant's own snapshot, so a file can't target another tenant's products.

## Calls made while building

- **Layout:** one package, a subpath per module. Stage matchers live in `scorers`, pg-boss handlers in `workers`;
  `core` owns cascade order, thresholds and the conflict rule.
- **Bytes are staged** in `import_files` until Gate 2 or cancel so jobs can re-read them (also for a sheet change).
  Distru should pass `{ url }` instead.
- **RLS:** `withTenant` switches to `csv_import_app` inside the transaction, so RLS applies even when the pool
  connects as the owner.
- **Parse and match run in one job:** a second queue hop cost up to one polling interval.
- **Model timeouts are total budgets:** Jev gets 2 s including its one retry. A timeout isn't retried; the column
  falls back to the LLM answer or becomes a question.
- **The LLM returns field and confidence only:** output tokens are most of its latency.
- **Structured output:** `jsonSchema` for Anthropic, because forced tool choice returns 400 on current Claude models.
- **Follow-up rate limit** is in-process per tenant. With N workers, divide the budget by N until it moves to
  Postgres.
- **Integration tests** use testcontainers, or `TEST_DATABASE_URL` to reuse the compose database.
- **UI** uses plain CSS instead of shadcn/ui to keep the package dependency-free; the components map 1:1.
- **Parsing** reads the whole file in memory (≤ 50 MB) instead of streaming.

## Known limitations

- **Rows are fixed one cell at a time at Gate 2.** With hundreds of rows sharing one cause (300 rows with no name)
  that's slow. Better: a bulk action per problem type ("skip them, or fill from another column"), plus an inline sheet
  of only the problem rows. The backend already takes batched cell edits. ~3–4 days.
- **The importer never creates vendors or brands.** The user adds them in Distru and presses Re-check. In the demo the
  mock lists are fixed, so Re-check never finds new names.
- **Match pickers show the 4 closest values**, not a searchable full list. Accounts with many vendors need search.
