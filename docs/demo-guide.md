# Demo guide

## The flow

1. Drop `fixtures/messy-200.csv` on the chat. The agent calls `import_csv_start`; the card streams parse and mapping.
2. **Gate 1, mapping.** Answer the slang questions ("Read eighth as 3.5 g?") and the unknown vendor in the card, or say
   "accept all". Try "ignore Internal Ref". Confirm with the button or "yes".
3. **Gate 2, import.** Counts by new / update / skip / duplicate / invalid, diffs, the "Blank cells clear" option
   (off), and the follow-up estimate. Confirm with the button or "yes".
4. The card shows *Created* and *Details added*. When it finishes, the right pane shows the exact rows sent to
   `POST /upload-products` (Distru `templateHeaders` order) as JSON and CSV, the follow-up mutations, and the error
   CSV link. Reload at any point: the card rebuilds from the import id.

**Developer mode** (top right, on by default in the demo) shows how each answer was reached: the matching stage,
scores, "How it ran", the LLM suggestion chips, and the payload sent to Distru. Switch it off to see what a customer
sees. `ImportCard` takes it as the `devMode` prop and defaults to off.

## Chat only

"what do you need?" lists the open questions with lettered options; answer with "1b", "2: Kiva", "accept 3",
"accept all", or "Unknown Farms is Humboldt Growers". Also: "show mapping", "map Weight to Serving Size",
"ignore Notes", "set tracking method to package", and at Gate 2 "show problems", "update existing",
"clear blanks on", "set row 6 name to Blue Dream", then "yes".

"How it ran" in the card header opens a timeline: time per step and per cascade stage, and which columns rules, Jev,
the LLM or you decided.

**With and without the LLM:** say "llm off" (or "llm on"), then "rerun" to run the same file again; "llm status"
shows the setting. `LLM_STAGE=off` starts the demo with it off. For the eval, `EVAL_NO_LLM=1 npm run eval`.

## Fixtures

| File | Shows |
|---|---|
| `messy-200.csv` | slang units, unknown vendor, duplicates, invalid rows |
| `clean-100.csv` | the happy path |
| `duplicate-heavy.csv` | overlaps the 50-product mock catalog; try "update existing" |
| `template-exact.csv` | a file already in Distru's template (stage 0 fast path) |
| `slang-units.csv` | sizes like "8th", "quarter", "1/8 oz", "5pk 0.5g" |
| `eval-hard.csv`, `eval-ambiguous.csv` | eval only |

Regenerate with `npm run fixtures`.

## Real models

Without keys, Jev and the LLM are deterministic stubs. To use real ones, set `USE_REAL_MODELS=1` and the keys, either
on the `docker compose up` command line or in `.env` (copy `.env.example`).

- **LLM:** OpenAI by default (`LLM_PROVIDER=openai`, `OPENAI_API_KEY`, `LLM_MODEL=gpt-4o`, which beat `gpt-4o-mini`
  in the eval). `LLM_PROVIDER=openrouter` (`OPENROUTER_API_KEY`, e.g. `anthropic/claude-sonnet-4.5`) and
  `LLM_PROVIDER=anthropic` (`ANTHROPIC_API_KEY`) also work.
- **Jev:** TypeSafe directly by default (`JEV_PROVIDER=typesafe`, `TYPESAFE_API_KEY`, `JEV_MODEL=jev-latest`, one
  choice question per column). `JEV_PROVIDER=openrouter` calls the same model through OpenRouter
  (`typesafe/jev-1.14`); `JEV_PROVIDER=llm` uses a chat-model stand-in with the same contract.

The server logs which models it loaded; `npm run eval` prints them too. `npm run diag:models` calls both directly on
sample columns and prints the raw answers or the error.

## What the integration tests cover

Each file gets a fresh database and the real pg-boss workers. They cover both gates (including the agent's
one-message-per-gate rule), an upload that never succeeds, stale `planVersion`, chunk checkpoints (3 chunks for 120
rows at size 50 and for 25k rows at the default 10k), resume after a crash mid-commit with no duplicates, the
follow-up path (inactive until finished, 429/5xx retry, 4xx to `needs_attention`, Retry details, rate limit),
blank-cell clears, foreign Distru IDs, delta refresh before commit, snapshot cursor resume and delta overflow, column
memory, and the six agent tools.
