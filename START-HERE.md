# Distru CSV Importer: start here

**What I built.** Drop any product CSV or XLSX into the Distru Copilot chat and it becomes Distru products. Rules
and Jev map the columns in under a second, the user answers only what they can't decide, and nothing is written
until the user confirms twice: once for the mapping (Gate 1), once for the import (Gate 2). It ships as a TypeScript
library (state machine, matching cascade, Postgres store, pg-boss jobs, six agent tools, React import card) plus a
working demo with a mock Distru.

**Loom walkthrough (about 14 min, on Google Drive):** https://drive.google.com/file/d/1arqX4CuObCXxuJfFqg3V2kD-TUQbHKbM/view?usp=sharing

## Run it in 2 commands

Needs Docker. No API keys needed: Jev and the LLM run as deterministic stubs.

```bash
cd distru-csv-importer        # this folder, wherever you unzipped or downloaded it
bash start.sh                 # builds, waits until the demo answers, then opens it in your browser
```

It uses http://localhost:5173, or the next free port if 5173 is taken. Ctrl+C stops it. Without the script (e.g. on
Windows): `docker compose up --build`, then open http://localhost:5173.

## What to try first

1. Click **messy-200.csv** under **Samples** at the top. It has junk rows above the header, slang sizes and an unknown vendor.
2. **Gate 1:** answer the questions in the card ("Read eighth as 3.5 g?"), or type "accept all". Then "yes".
3. **Gate 2:** review new / skipped / invalid rows. Then "yes". The right pane shows the exact rows sent to Distru.
4. Then click **duplicate-heavy.csv**, say "update existing", and switch **Developer mode** off to see the customer view.

## Where to go next

| Read | For |
|---|---|
| [README.md](README.md) | Overview, run options, the library's modules, eval results |
| [docs/system-design.md](docs/system-design.md) | The agent harness: chat now, workflows later |
| [docs/tech-spec.md](docs/tech-spec.md) | The importer spec, written for a coding agent |
| [docs/decisions.md](docs/decisions.md) | Key decisions, alternatives rejected, known limits |
| [docs/demo-guide.md](docs/demo-guide.md) | Every chat command, all fixtures, real-model setup |
| [docs/screenshots/](docs/screenshots) | The four demo screens |

## Numbers (real Jev, from the README)

- Column matching: **94.8% precision, 93.6% recall** on 81 labelled columns; the hardest fixture is **72.7% / 72.7%**.
- Rules resolve 85% of columns in about 3 ms; Jev answers in about 0.2 s (p95).
- Turning on the LLM matching step lowered precision to 92.4% with both `gpt-4o-mini` and `gpt-4o`, so it is off by
  default. It still handles free-text edits.
- 150 tests (`npm test`); `npm run eval` reproduces the numbers.

The same code is also on GitHub: https://github.com/snavaneeth78/agent-csv-importer
