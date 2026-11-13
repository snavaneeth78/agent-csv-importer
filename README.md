# Distru CSV Importer

Drop any product CSV or XLSX into the Distru Copilot chat and it becomes Distru products. The AI maps the columns,
asks only what it can't decide, and nothing is written until the user confirms twice: once for the mapping, once
for the import.

![Gate 1: the user reviews the mapping](docs/screenshots/1-gate1-mapping.png)

## Deliverables

| | |
|---|---|
| **1. UX mockup** | The demo below is the working mockup. Screenshots: [mapping](docs/screenshots/1-gate1-mapping.png), [import review](docs/screenshots/2-gate2-review.png), [finished](docs/screenshots/3-finished.png), [customer view](docs/screenshots/4-customer-view.png) |
| **2. System design** | [docs/system-design.md](docs/system-design.md): the agent harness, for chat now and workflows later |
| **3. Tech spec** | [docs/tech-spec.md](docs/tech-spec.md): the importer, ready for a coding agent |
| **4. Loom** | `<LOOM_LINK>` |

Key decisions, the alternatives I rejected, and known limits: [docs/decisions.md](docs/decisions.md).

## Run it

Needs Docker.

```bash
bash start.sh
```

It builds, waits until the demo answers, and opens http://localhost:5173 in your browser (or the next free port if
5173 is taken). Ctrl+C stops it. Plain `docker compose up --build` works too; then open the page yourself. Jev and the LLM run as deterministic stubs by default, and the LLM matching step is off
(see [decisions](docs/decisions.md)). To use real models:

```bash
USE_REAL_MODELS=1 OPENAI_API_KEY=sk-... TYPESAFE_API_KEY=... bash start.sh
```

To choose the port yourself: `WEB_PORT=5174 bash start.sh` (or `WEB_PORT=5174 docker compose up --build`). Postgres stays inside Docker's network, so a second copy of this folder doesn't clash with the first.

Without Docker for the app (Node 22.22+, Docker still runs Postgres on localhost:54329): `npm install && npm run demo`.
That way always uses port 5173. To start over with an empty database and chat (no past imports or mapping memory):
`npm run demo:fresh` (or `npm run demo:reset` with the demo stopped, then `npm run demo`).

## Try it

1. Click **messy-200.csv** under **Samples** at the top (or drop [`fixtures/messy-200.csv`](fixtures/messy-200.csv) on the
   chat). **slang-units.csv** and **duplicate-heavy.csv** load the other two demo files the same way.
2. **Gate 1:** answer the questions in the card ("Read eighth as 3.5 g?", an unknown vendor), or type "accept all". Then "yes".
3. **Gate 2:** review new / skipped / invalid rows. Then "yes".
4. The right pane shows exactly what was sent to Distru's `POST /upload-products`, plus the error CSV.

Switch **Developer mode** off (top right) to see what a customer sees. More chat commands, other fixtures and model
setup: [docs/demo-guide.md](docs/demo-guide.md).

## Use the library

Copy [`csv-importer/`](csv-importer) into your repo as a workspace package. It is TypeScript source with no build
step, so the host needs a TS-aware bundler or runtime (Vite, tsx, Next.js `transpilePackages`), plus `@types/pg` and
`@types/papaparse` for type checking. One package, a subpath per module:

| Import | What it is |
|---|---|
| `@distru/csv-importer/core` | `ImportService` (state machine, both gates), parser, column profiles, units, transforms, validation, duplicates, template output |
| `@distru/csv-importer/scorers` | Column matchers (template, memory, exact, pattern, fuzzy, Jev, LLM) and the model gateway |
| `@distru/csv-importer/pg` | Postgres store (Kysely, row-level security); migrations in `csv-importer/migrations/` |
| `@distru/csv-importer/workers` | `createImporter` and the pg-boss jobs: parse, match, prepare, commit, follow-up, snapshot |
| `@distru/csv-importer/langgraph` | The six `import_csv_*` agent tools and `awaitGate` |
| `@distru/csv-importer/distru` | Distru product schema, upload/MCP profile, `MockDistru` |
| `@distru/csv-importer/ui` | React `ImportCard` and its parts (+ `ui/styles.css`) |

How a host app wires it up: [docs/api-integration.md](docs/api-integration.md).

## Tests and eval

```bash
npm install
npm test            # 150 tests; integration tests start Postgres with testcontainers
npm run eval        # column-matching precision/recall per fixture and per stage, latency vs targets
npm run typecheck
```

## Eval results

Column matching on the 7 fixtures: 81 labelled columns, 26 of them from `template-exact`. One column is about 1.2
points, so read these as a small sample. Measured 2026-11-12 with TypeSafe `jev-latest` and OpenAI models, two runs per
configuration. Accuracy was the same in both runs; latency is shown as the range.

**Per fixture.** *Real* is what the demo runs with keys: real Jev, LLM step off (the default). *Stubs* is what
`docker compose up` runs without keys.

| Fixture | Columns | What makes it hard | Real: precision / recall | Stubs: precision / recall |
|---|---|---|---|---|
| `template-exact` | 26 | Nothing: Distru's own template | 100% / 100% | 100% / 100% |
| `clean-100` | 12 | Plain headers | 100% / 100% | 100% / 100% |
| `messy-200` | 12 | Junk rows above the header, POS headers, a column to ignore | 100% / 100% | 100% / 100% |
| `duplicate-heavy` | 5 | Rows that overlap the catalog | 100% / 100% | 100% / 100% |
| `slang-units` | 4 | Sizes like "8th" and "5pk 0.5g" | 100% / 100% | 100% / 100% |
| `eval-ambiguous` | 10 | Short headers: "Amt", "Wt", "Label" | 88.9% / 80.0% | 88.9% / 80.0% |
| **`eval-hard`** | 12 | Abbreviated headers that could mean two fields | **72.7% / 72.7%** | 90.0% / 81.8% |
| **All** | 81 | | **94.8% / 93.6%** | 97.4% / 94.9% |

The stubs score higher on `eval-hard` only because the stub Jev declines a column the real one gets wrong. The real
column is the one that counts.

**Share of columns resolved per stage** (real Jev, LLM off):

| Stage | Columns | Share | Precision |
|---|---|---|---|
| 0. Template (file is already Distru's template) | 26 | 32.1% | 100% |
| 2. Exact name or synonym | 41 | 50.6% | 95.1% |
| 3. Value pattern | 2 | 2.5% | 100% |
| 5. Jev, auto-accepted (≥ 75%) | 7 | 8.6% | 85.7% |
| 5. Jev, suggested (40-75%, the user confirms at Gate 1) | 1 | 1.2% | 0% |
| Not mapped (a Gate 1 question, or ignored) | 4 | 4.9% | 3 of 4 correct |

**Latency** (p95 over the 7 files):

| Step | Goal | Measured |
|---|---|---|
| Stages 0-4 (rules) | < 300 ms | 2-3 ms |
| Jev | < 1 s | 155-238 ms |
| LLM, `gpt-4o` | < 5 s | 0.9-1.5 s |
| LLM, `gpt-4o-mini` | < 5 s | 4.3-5.4 s (missed the goal in one run) |
| Columns that reach the LLM | < 20% | 1.2-2.5% |

**LLM step on vs off** (real Jev in all three):

| | Precision | Recall | Columns the LLM decided | Of those, right | LLM p95 |
|---|---|---|---|---|---|
| **LLM off** (default) | **94.8%** | **93.6%** | 0 | n/a | n/a |
| `gpt-4o-mini` | 92.4% | 93.6% | 1-2 | 0 | 4.3-5.4 s |
| `gpt-4o` | 92.4% | 93.6% | 2 | 0 | 0.9-1.5 s |

The LLM only sees what rules and Jev leave, and on this set it got those wrong: "Amt" became `threshold_max` (should
be `unit_price`; with the LLM off it stays a Gate 1 question) and "Internal Ref" became `external_name` (should be
ignored). Both models made the same calls; `gpt-4o` was 3-5x faster. That is why the LLM matching step is off by
default. It still handles free-text edits like "the Size column is in ounces".

**Every miss with real models**, all visible at Gate 1 before anything is written:

- `eval-hard` "Producer" → `vendor`, labelled `brand`. A synonym match; the header really could mean either.
- `eval-hard` "Inv Category" → `product_type`, labelled `category`. Jev was unsure, so it was a suggestion for the user.
- `eval-hard` "On Menu" (Y/N) → `active`, labelled `featured`. Jev was confident and wrong: the one bad auto-accept.
- `eval-ambiguous` "Label" → `brand`, labelled `group`. A synonym match.
- `eval-ambiguous` "Amt" → not mapped (a Gate 1 question), labelled `unit_price`.

Reproduce (needs `TYPESAFE_API_KEY`, plus `OPENAI_API_KEY` for the LLM runs):

```bash
USE_REAL_MODELS=0 npm run eval                                    # stubs
USE_REAL_MODELS=1 npm run eval                                    # real Jev, LLM off
USE_REAL_MODELS=1 EVAL_LLM=1 LLM_MODEL=gpt-4o-mini npm run eval   # real Jev + LLM
```

## What's built and what isn't

**Built:** the library above, the demo (chat + import card + mock Distru), 150 tests, the matching eval, and 7
fixtures.

**Not built:** the LangGraph agent loop (the demo agent is rule-based but calls the real six tools), the workflow path
(nightly Google Sheet sync; designed in the system design doc), retention cron and usage metering, auth in the demo,
streaming parse for very large files, Playwright E2E.

**Next:** confirm header spellings against the real Distru template; add `find-products-by-skus` and a batch update
tool to the Distru MCP; a Postgres-backed rate limiter for follow-ups; grow the eval past 81 columns and tune
the Jev thresholds on its misses.
